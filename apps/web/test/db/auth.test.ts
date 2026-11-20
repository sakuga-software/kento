import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import {
  createKentoAuth,
  githubEmail,
  postgresAuthDatabase,
  SESSION_TTL_MS,
  sessionTokenHash,
  type KentoAuth,
} from '../../app/auth/better-auth.ts'
import type { GitHubOAuth, GitHubProfile, GitHubRole } from '../../app/auth/github.ts'
import { createAuthStore, type AuthStore } from '../../app/auth/store.ts'
import { cookiesOf, SESSION_COOKIE } from '../../app/auth/test-helpers.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createAppRouter } from '../../app/router.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createTestDatabase, insertOrg as insertOrgRow } from './helpers.ts'

// KNT-150. The sign-in of Better Auth on the tables of Kentō, from the start at GitHub to the row in
// `sessions`, against Postgres.

const PUBLIC_URL = new URL('https://kento.example.com')

describe('the sign-in and the sessions in Postgres', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let store: AuthStore
  let auth: KentoAuth
  let profile: GitHubProfile
  let roles: Map<string, GitHubRole | null>
  let router: ReturnType<typeof createAppRouter>

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 2 })
    store = createAuthStore(database.sql)
    let github: GitHubOAuth = {
      clientId: 'Iv1.test',
      clientSecret: 'client-secret-for-the-tests',
      authorizationUrl: 'https://github.test/login/oauth/authorize',
      tokenUrl: 'https://github.test/login/oauth/access_token',
      redirectUri: new URL('/auth/github/callback', PUBLIC_URL),
      async exchangeCode({ code }) {
        if (code !== 'good') throw new Error('GitHub refused the code: 400 bad_verification_code')
        return { accessToken: 'gho_user_token' }
      },
      async readProfile() {
        return profile
      },
    }
    let lookupRole = async (installation: { login: string }, person: { login: string }) => roles.get(`${installation.login}/${person.login}`) ?? null
    let secret = 'a-session-secret-for-the-tests-0123456789'
    auth = createKentoAuth({ database: postgresAuthDatabase(database.db), publicUrl: PUBLIC_URL, secret, github, store, lookupRole })
    router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '1.2.3',
      commit: null,
      webhook: disabledWebhook,
      auth: { publicUrl: PUBLIC_URL, sessionSecrets: [secret], auth, store, lookupRole },
    })
  })

  after(async () => {
    await database.close()
    await test.drop()
  })

  beforeEach(async () => {
    await database.sql`truncate sessions, verifications, accounts, memberships, users, orgs cascade`
    profile = { id: 1, login: 'octocat', name: 'Octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }
    roles = new Map()
  })

  function request(path: string, cookie?: string) {
    return router.fetch(new Request(new URL(path, 'http://localhost'), { headers: cookie ? { Cookie: cookie } : {} }))
  }

  async function signIn() {
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookiesOf(start))
    let pair = callback.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0] ?? null
    return { callback, cookie: pair }
  }

  it('creates the user and its account, a session under the hash of its token, and no token of GitHub', async () => {
    let orgId = await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'admin')

    let { callback, cookie } = await signIn()
    assert.equal(callback.headers.get('Location'), '/')
    assert.ok(cookie)

    let [user] = await database.sql<{ id: string; githubId: number; login: string; name: string | null; email: string; lastSignInAt: unknown }[]>`
      select id, github_id::float8 as "githubId", login, name, email, last_sign_in_at as "lastSignInAt" from users`
    assert.deepEqual({ ...user, id: undefined, lastSignInAt: undefined }, {
      id: undefined, githubId: 1, login: 'octocat', name: 'Octocat', email: githubEmail(1), lastSignInAt: undefined,
    })
    assert.notEqual(user!.lastSignInAt, null)

    let accounts = await database.sql`select provider_id, account_id, access_token, refresh_token, id_token from accounts`
    assert.deepEqual(accounts.map((a) => ({ ...a })), [{ provider_id: 'github', account_id: '1', access_token: null, refresh_token: null, id_token: null }])
    assert.equal(JSON.stringify(await database.sql`select * from accounts`).includes('gho_user_token'), false)

    let [session] = await database.sql<{ tokenHash: string; userId: string; activeOrg: string; expiresAt: Date }[]>`
      select token_hash as "tokenHash", user_id as "userId", active_organization_id as "activeOrg", expires_at as "expiresAt" from sessions`
    let token = decodeURIComponent(cookie!.split('=')[1]!).split('.')[0]!
    assert.equal(session!.tokenHash, sessionTokenHash(token))
    assert.equal(JSON.stringify(await database.sql`select * from sessions`).includes(token), false, 'the token itself is not in the table')
    assert.equal(session!.userId, user!.id)
    assert.equal(session!.activeOrg, orgId)
    let ttl = new Date(session!.expiresAt).getTime() - Date.now()
    assert.ok(ttl > SESSION_TTL_MS - 60_000 && ttl <= SESSION_TTL_MS, 'seven days from the sign-in')

    let [membership] = await database.sql`select role, source from memberships`
    assert.deepEqual({ ...membership }, { role: 'owner', source: 'github' }, 'the first admin of an org with no owner')
    // The verification of the sign-in (its state) is gone once used.
    assert.equal((await database.sql`select 1 from verifications`).length, 0)

    let screen = await request('/', cookie!)
    assert.equal(screen.status, 200)
  })

  it('reads the session back with the token of the cookie, never its hash, and never signs a new cookie', async () => {
    await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'admin')
    let { cookie } = await signIn()
    let token = decodeURIComponent(cookie!.split('=')[1]!).split('.')[0]!
    for (let n = 0; n < 2; n++) {
      let found = await auth.api.getSession({ headers: new Headers({ Cookie: cookie! }), query: { disableCookieCache: true } })
      assert.equal(found?.session.token, token)
      let screen = await request('/', cookie!)
      assert.equal(screen.status, 200)
      // No refresh and no cookie cache: the cookie of the sign-in is the only one.
      assert.equal(screen.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`)), false)
    }
  })

  it('ends the sessions of a user by user id through Better Auth, and never hands out a hash as a token', async () => {
    await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'admin')
    let first = await signIn()
    let second = await signIn()
    let [user] = await database.sql<{ id: string }[]>`select id from users`
    assert.equal((await database.sql`select 1 from sessions`).length, 2, 'two browsers, two sessions')
    let context = await auth.$context
    await context.internalAdapter.deleteUserSessions(user!.id)
    assert.equal((await database.sql`select 1 from sessions`).length, 0)
    for (let cookie of [first.cookie, second.cookie]) assert.equal((await request('/', cookie!)).status, 303)
  })

  it('refuses a person outside of every org: no user, no account, no session', async () => {
    await insertOrgRow(database.sql, 'acme', 11)
    let { callback, cookie } = await signIn()
    assert.equal(callback.headers.get('Location'), '/login?notice=not_member')
    assert.equal(cookie, null)
    let [counts] = await database.sql<{ users: number; accounts: number; sessions: number }[]>`
      select (select count(*)::int from users) as users, (select count(*)::int from accounts) as accounts, (select count(*)::int from sessions) as sessions`
    assert.deepEqual({ ...counts }, { users: 0, accounts: 0, sessions: 0 })
  })

  it('signs the same GitHub account in to the same user, and follows its new login', async () => {
    await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'member')
    roles.set('acme/new-login', 'member')
    await signIn()
    profile = { ...profile, login: 'new-login', name: null }
    await signIn()
    let users = await database.sql`select login, name from users`
    assert.deepEqual(users.map((u) => ({ ...u })), [{ login: 'new-login', name: null }])
    assert.equal((await database.sql`select 1 from accounts`).length, 1)
  })

  it('a cookie with the hash of the token opens nothing, sign-out deletes the row, and the sweep deletes the expired ones', async () => {
    await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'admin')
    let { cookie } = await signIn()
    let [row] = await database.sql<{ tokenHash: string }[]>`select token_hash as "tokenHash" from sessions`
    // A copy of the table gives the hash: the hash in a cookie is not a session.
    assert.equal(await auth.api.getSession({ headers: new Headers({ Cookie: `${SESSION_COOKIE}=${row!.tokenHash}` }) }), null)

    let page = await (await request('/', cookie!)).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(page)![1]!
    let out = await router.fetch(
      new Request('http://localhost/logout', {
        method: 'POST',
        headers: { Cookie: cookie!, Origin: PUBLIC_URL.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf }),
      }),
    )
    assert.equal(out.status, 303)
    assert.equal((await database.sql`select 1 from sessions`).length, 0)
    assert.equal((await request('/', cookie!)).status, 303)

    await signIn()
    await database.sql`update sessions set expires_at = now() - interval '1 second'`
    await database.sql`insert into verifications (identifier, value, expires_at) values ('old', 'x', now() - interval '1 second')`
    assert.equal(await store.sweep(), 2)
  })

  it('lists the memberships in the orgs that are not suspended, and forgets a deleted user everywhere', async () => {
    let active = await insertOrgRow(database.sql, 'sakuga-software', 11)
    let suspended = await insertOrgRow(database.sql, 'orchard', 12, 1012, { suspended: true })
    roles.set('sakuga-software/octocat', 'admin')
    await signIn()
    let [user] = await database.sql<{ id: string }[]>`select id from users`
    await store.saveMembership(user!.id, suspended, 'member')
    await store.saveMembership(user!.id, active, 'member')

    let memberships = await store.memberships(user!.id)
    assert.deepEqual(
      memberships.map((m) => [m.org.name, m.role, m.org.installations.map((i) => i.githubInstallationId)]),
      [['sakuga-software', 'member', [11]]],
    )
    assert.deepEqual((await store.activeOrgs()).map((o) => o.name), ['sakuga-software'])

    await database.sql`delete from users where id = ${user!.id}`
    let [counts] = await database.sql<{ sessions: number; memberships: number; accounts: number }[]>`
      select (select count(*)::int from sessions) as sessions, (select count(*)::int from memberships) as memberships,
        (select count(*)::int from accounts) as accounts`
    assert.deepEqual({ ...counts }, { sessions: 0, memberships: 0, accounts: 0 })
  })

  it('KNT-150: switches the org on screen through Better Auth, only to an org of the person', async () => {
    let acme = await insertOrgRow(database.sql, 'acme', 11)
    let globex = await insertOrgRow(database.sql, 'globex', 12)
    let initech = await insertOrgRow(database.sql, 'initech', 13)
    roles.set('acme/octocat', 'admin')
    roles.set('globex/octocat', 'member')
    let { cookie } = await signIn()
    let active = async () => (await database.sql`select active_organization_id as id from sessions`)[0]!.id
    assert.equal(await active(), acme)
    let page = await (await request('/', cookie!)).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(page)![1]!
    let post = (orgId: string) =>
      router.fetch(
        new Request('http://localhost/preferences/org', {
          method: 'POST',
          headers: { Cookie: cookie!, Origin: PUBLIC_URL.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _csrf: csrf, orgId, returnTo: '/' }),
        }),
      )
    assert.equal((await post(globex)).status, 303)
    assert.equal(await active(), globex)
    let html = await (await request('/', cookie!)).text()
    assert.match(html, /<span class="org-menu-name">globex<\/span>/)
    assert.match(html, /Read only/)
    // An org where the person is not a member: nothing moves.
    assert.equal((await post(initech)).status, 303)
    assert.equal(await active(), globex)
    let [roles_] = await database.sql`select array_agg(role order by role) as roles from memberships`
    assert.deepEqual(roles_!.roles, ['member', 'owner'])
  })

  it('KNT-150: a write from GitHub never changes the role or the source of a membership from an invitation', async () => {
    let acme = await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'member')
    await signIn()
    let [user] = await database.sql<{ id: string }[]>`select id from users`
    await database.sql`update memberships set role = 'admin', source = 'invitation'`
    await store.saveMembership(user!.id, acme, 'member', 'github')
    let [row] = await database.sql`select role, source from memberships`
    assert.deepEqual({ ...row }, { role: 'admin', source: 'invitation' })
    // Kentō itself still changes it.
    await store.saveMembership(user!.id, acme, 'member', 'invitation')
    assert.equal((await database.sql`select role from memberships`)[0]!.role, 'member')
  })

  it('KNT-150: an invitation turns a membership from GitHub into one from an invitation, which GitHub then keeps', async () => {
    let acme = await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'member')
    await signIn()
    let [user] = await database.sql<{ id: string }[]>`select id from users`
    let row = async () => ({ ...(await database.sql`select role, source from memberships`)[0] })
    assert.deepEqual(await row(), { role: 'member', source: 'github' })
    // An admin of Kentō invites octocat as an admin: the row becomes Kentō's.
    await store.saveMembership(user!.id, acme, 'admin', 'invitation')
    assert.deepEqual(await row(), { role: 'admin', source: 'invitation' })
    // The next GitHub check says member: role and source stay.
    await store.saveMembership(user!.id, acme, 'member', 'github')
    assert.deepEqual(await row(), { role: 'admin', source: 'invitation' })
  })

  it('the table refuses a token of GitHub in an account', async () => {
    await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'admin')
    await signIn()
    await assert.rejects(database.sql`update accounts set access_token = 'gho_x'`, /accounts_no_secret/)
  })
})
