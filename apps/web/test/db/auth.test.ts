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

    let [membership] = await database.sql`select role from memberships`
    assert.equal(membership!.role, 'admin')
    // The verification of the sign-in (its state) is gone once used.
    assert.equal((await database.sql`select 1 from verifications`).length, 0)

    let screen = await request('/', cookie!)
    assert.equal(screen.status, 200)
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

  it('the table refuses a token of GitHub in an account', async () => {
    await insertOrgRow(database.sql, 'acme', 11)
    roles.set('acme/octocat', 'admin')
    await signIn()
    await assert.rejects(database.sql`update accounts set access_token = 'gho_x'`, /accounts_no_secret/)
  })
})
