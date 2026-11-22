import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createKentoAuth, postgresAuthDatabase } from '../../app/auth/better-auth.ts'
import type { GitHubOAuth, GitHubProfile, GitHubRole } from '../../app/auth/github.ts'
import { createAssignmentStore } from '../../app/assignment/store.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { createReposStore } from '../../app/repos/store.ts'
import { createRulesStore } from '../../app/rules/store.ts'
import type { OrgRole } from '../../app/db/schema.ts'
import { createAuthStore } from '../../app/auth/store.ts'
import { cookiesOf, SESSION_COOKIE } from '../../app/auth/test-helpers.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createMembersStore, type MembersStore } from '../../app/members/store.ts'
import { MOVES_PER_MINUTE } from '../../app/organizations/rules.ts'
import { createOrgsStore, type MoveChecks } from '../../app/organizations/store.ts'
import { ROLE_TTL_MS } from '../../app/auth/access.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase, insertOrg } from './helpers.ts'

// KNT-150. The name and the installations of an org, through the screens, on Postgres: the rename,
// the move of an installation to another org or to a new one, and the deletion of an org left empty.

const PUBLIC_URL = new URL('https://kento.example.com')
const PEOPLE: Record<string, GitHubProfile> = {
  octocat: { id: 1, login: 'octocat', name: 'Octocat', avatarUrl: null },
  camille: { id: 2, login: 'camille', name: null, avatarUrl: null },
  guest: { id: 3, login: 'guest', name: null, avatarUrl: null },
  other: { id: 4, login: 'other', name: null, avatarUrl: null },
}

describe('the name and the installations of an org', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let store: MembersStore
  /** The store of the organization screen of the router: a test replaces one of its methods. */
  let orgsStore: ReturnType<typeof createOrgsStore>
  let router: ReturnType<typeof createAppRouter>
  let profile: GitHubProfile
  let roles: Map<string, GitHubRole | null>
  let clock: { now: number }
  /**
   * The offset of the clock of the test from the real one: the limits of `auth/asks.ts` follow it, on
   * the clock of Postgres, read a few milliseconds after the offset. A step past the end of a window
   * goes `PAST_THE_WINDOW_MS` further, so those milliseconds never decide.
   */
  let testClock = { offsetMs: () => clock.now - Date.now() }
  const PAST_THE_WINDOW_MS = 1000
  /** The accounts that GitHub says are a person (`User`), by login; GitHub failing for roles or types. */
  let people: Set<string>
  let gitHub = { calls: 0, failRoles: false, failTypes: false }
  let failSessionSwitch = false

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 10 })
    // The limits of the questions to GitHub run on the clock of Postgres, moved as the clock of the test.
    store = createMembersStore(database.sql, testClock)
    let realStore = createAuthStore(database.sql)
    // The session of a move switches orgs through this store; a test makes that switch fail.
    let authStore = {
      ...realStore,
      async setActiveOrg(sessionId: string, orgId: string) {
        if (failSessionSwitch) throw new Error('the database refused the update')
        return realStore.setActiveOrg(sessionId, orgId)
      },
    }
    let github: GitHubOAuth = {
      clientId: 'Iv1.test',
      clientSecret: 'client-secret-for-the-tests',
      authorizationUrl: 'https://github.test/login/oauth/authorize',
      tokenUrl: 'https://github.test/login/oauth/access_token',
      redirectUri: new URL('/auth/github/callback', PUBLIC_URL),
      async exchangeCode() {
        return { accessToken: 'gho_user_token' }
      },
      async readProfile() {
        return profile
      },
    }
    let lookupRole = async (installation: { login: string }, person: { login: string }) => {
      gitHub.calls++
      if (gitHub.failRoles) throw new Error('GitHub answered 502')
      return roles.get(`${installation.login}/${person.login}`) ?? null
    }
    let lookupAccountType = async (installation: { login: string }) => {
      gitHub.calls++
      if (gitHub.failTypes) throw new Error('GitHub answered 502')
      return people.has(installation.login) ? ('User' as const) : ('Organization' as const)
    }
    let secret = 'a-session-secret-for-the-tests-0123456789'
    clock = { now: Date.now() }
    let auth = createKentoAuth({ database: postgresAuthDatabase(database.db), publicUrl: PUBLIC_URL, secret, github, store: authStore, lookupRole, now: () => clock.now })
    orgsStore = createOrgsStore(database.sql, testClock)
    router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '1.2.3',
      commit: null,
      webhook: disabledWebhook,
      // Every request of these tests comes with no socket, so they share one limit: a high one.
      auth: { publicUrl: PUBLIC_URL, sessionSecrets: [secret], auth, store: authStore, lookupRole, now: () => clock.now, signInLimit: 1000 },
      organization: { store: orgsStore, lookupRole, lookupAccountType },
      members: {
        store,
        lookupRole,
        async lookupUser(_installation, login) {
          let person = PEOPLE[login.toLowerCase()]
          return person ? { id: person.id, login: person.login } : null
        },
      },
    })
  })

  after(async () => {
    await database.close()
    await test.drop()
  })

  let acme: string
  let globex: string

  beforeEach(async () => {
    await database.sql`truncate invitations, sessions, verifications, accounts, memberships, users, installations, orgs cascade`
    acme = await insertOrg(database.sql, 'acme', 11)
    globex = await insertOrg(database.sql, 'globex', 12)
    roles = new Map([
      ['acme/octocat', 'admin'],
      ['acme/camille', 'member'],
      ['globex/other', 'admin'],
    ])
    clock.now = Date.now()
    people = new Set()
    gitHub = { calls: 0, failRoles: false, failTypes: false }
    failSessionSwitch = false
  })

  /** The answers of a GitHub that counts the person as an admin of every account there is now, and no account as a person. */
  async function allAdmin(): Promise<MoveChecks> {
    let ids = new Set((await database.sql<{ id: string }[]>`select id from installations`).map((r) => r.id))
    return { checked: ids, adminOf: ids, personal: new Set() }
  }

  async function userId(login: string) {
    return (await database.sql<{ id: string }[]>`select id from users where login = ${login}`)[0]!.id
  }

  /** octocat, signed in, owner of acme from GitHub and of globex too: the moves between them pass. */
  async function ownerOfBoth() {
    await signIn('octocat')
    let actor = await userId('octocat')
    await database.sql`insert into memberships (user_id, org_id, role, source) values (${actor}, ${globex}, 'owner', 'github')`
    return actor
  }

  function request(path: string, cookie?: string | null, form?: Record<string, string>) {
    let headers = new Headers(cookie ? { Cookie: cookie } : {})
    if (form) {
      headers.set('Origin', PUBLIC_URL.origin)
      headers.set('Content-Type', 'application/x-www-form-urlencoded')
    }
    return router.fetch(new Request(new URL(path, 'http://localhost'), { method: form ? 'POST' : 'GET', headers, body: form ? new URLSearchParams(form) : undefined }))
  }

  async function signIn(login: keyof typeof PEOPLE) {
    profile = PEOPLE[login]!
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookiesOf(start))
    let cookie = callback.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))?.split(';')[0] ?? null
    return { callback, cookie }
  }

  async function csrfOf(cookie: string, path = '/settings/members') {
    let html = await (await request(path, cookie)).text()
    return /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
  }

  async function post(cookie: string, path: string, form: Record<string, string> = {}, page = path.startsWith('/invitations') ? '/invitations' : '/settings/members') {
    return request(path, cookie, { _csrf: await csrfOf(cookie, page), ...form })
  }

  async function membership(login: string, orgId: string) {
    let [row] = await database.sql<{ id: string; role: OrgRole; source: string }[]>`
      select m.id, m.role, m.source from memberships m join users u on u.id = m.user_id where u.login = ${login} and m.org_id = ${orgId}`
    return row ?? null
  }

  /** A second installation of acme, account acme-labs, with one repository and its rules. */
  async function secondInstallation() {
    let [installation] = await database.sql<{ id: string }[]>`
      insert into installations (org_id, github_installation_id, github_account_id, account_login)
      values (${acme}, 13, 1013, 'acme-labs') returning id`
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${acme}, ${installation!.id}, 5013, 'acme-labs/rocket', true) returning id`
    await database.sql`insert into rules (org_id, repo_id, title, body) values (${acme}, ${repo!.id}, 'Repo rule', 'Check it')`
    await database.sql`insert into rules (org_id, title, body) values (${acme}, 'Org rule', 'Stay')`
    await database.sql`insert into assignment_rules (org_id, repo_id, position, authors, action, level) values (${acme}, ${repo!.id}, 1, '{octocat}', 'review', 'lite')`
    return { installationId: installation!.id, repoId: repo!.id }
  }

  async function orgOf(table: 'repos' | 'rules' | 'assignment_rules' | 'installations', where: string) {
    let rows = await database.sql.unsafe(`select org_id as "orgId" from ${table} where ${where}`)
    return rows.map((r) => r.orgId as string)
  }

  it('an owner renames the org; an admin and a member cannot', async () => {
    roles.set('acme/camille', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let admin = (await signIn('camille')).cookie!
    assert.equal((await post(owner, '/settings/organization/name', { name: '  Acme   Labs ' })).headers.get('Location'), '/settings/organization?notice=renamed')
    assert.equal((await database.sql`select name from orgs where id = ${acme}`)[0]!.name, 'Acme Labs')
    assert.equal((await post(owner, '/settings/organization/name', { name: '' })).headers.get('Location'), '/settings/organization?notice=bad_name')
    assert.equal((await post(admin, '/settings/organization/name', { name: 'Taken over' })).status, 403)
    let html = await (await request('/settings/organization', admin)).text()
    assert.doesNotMatch(html, /action="\/settings\/organization\/name"|Move…/)
    assert.equal((await database.sql`select name from orgs where id = ${acme}`)[0]!.name, 'Acme Labs')
  })

  it('an owner of two orgs, admin of the account on GitHub, moves an installation with its repositories and their rules', async () => {
    roles.set('globex/octocat', 'admin')
    roles.set('acme-labs/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let { installationId, repoId } = await secondInstallation()
    let html = await (await request('/settings/organization', owner)).text()
    assert.match(html, /<option value="[0-9a-f-]+">globex<\/option>/)
    let moved = await post(owner, `/settings/organization/installations/${installationId}/move`, { to: globex })
    assert.equal(moved.headers.get('Location'), '/settings/organization?notice=moved')
    assert.deepEqual(await orgOf('installations', `id = '${installationId}'`), [globex])
    assert.deepEqual(await orgOf('repos', `id = '${repoId}'`), [globex])
    assert.deepEqual(await orgOf('rules', `repo_id = '${repoId}'`), [globex])
    assert.deepEqual(await orgOf('assignment_rules', `repo_id = '${repoId}'`), [globex])
    // The rules of the org stay with it, and so does its first installation.
    assert.deepEqual(await orgOf('rules', `repo_id is null`), [acme])
    assert.deepEqual(await orgOf('installations', `github_installation_id = 11`), [acme])
    // The session follows the installation.
    assert.match(await (await request('/settings/organization', owner)).text(), /<span class="member-login">acme-labs<\/span>/)
  })

  it('refuses a move without the owner role in both orgs, without GitHub admin, or of an installation of another org', async () => {
    roles.set('globex/other', 'admin')
    roles.set('acme-labs/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    await signIn('other')
    let { installationId } = await secondInstallation()
    // octocat is no owner of globex.
    assert.equal((await post(owner, `/settings/organization/installations/${installationId}/move`, { to: globex })).headers.get('Location'), '/settings/organization?notice=target_not_owner')
    // GitHub does not count octocat as an admin of acme-labs.
    roles.set('acme-labs/octocat', 'member')
    assert.equal((await post(owner, `/settings/organization/installations/${installationId}/move`, { to: 'new', name: 'Labs' })).headers.get('Location'), '/settings/organization?notice=not_github_admin')
    // The installation of globex, from the session of acme: nothing.
    let [globexInstallation] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${globex}`
    assert.equal((await post(owner, `/settings/organization/installations/${globexInstallation!.id}/move`, { to: 'new', name: 'Mine' })).headers.get('Location'), '/settings/organization?notice=not_found')
    // A member, or an admin who is not an owner: 403.
    let member = (await signIn('camille')).cookie!
    assert.equal((await post(member, `/settings/organization/installations/${installationId}/move`, { to: 'new', name: 'Mine' })).status, 403)
    assert.deepEqual(await orgOf('installations', `id = '${installationId}'`), [acme])
    assert.equal((await database.sql`select count(*)::int as n from orgs`)[0]!.n, 2)
  })

  it('a move that committed answers "moved" even when the switch of the session fails', async () => {
    roles.set('globex/octocat', 'admin')
    roles.set('acme-labs/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let { installationId } = await secondInstallation()
    failSessionSwitch = true
    assert.equal((await post(owner, `/settings/organization/installations/${installationId}/move`, { to: globex })).headers.get('Location'), '/settings/organization?notice=moved')
    assert.deepEqual(await orgOf('installations', `id = '${installationId}'`), [globex])
    // The session stays on acme.
    assert.match(await (await request('/', owner)).text(), /<span class="org-menu-name">acme<\/span>/)
  })

  it('moves an installation to a new org of which the person is the owner', async () => {
    roles.set('acme-labs/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let { installationId, repoId } = await secondInstallation()
    let moved = await post(owner, `/settings/organization/installations/${installationId}/move`, { to: 'new', name: 'Acme Labs' })
    assert.equal(moved.headers.get('Location'), '/settings/organization?notice=moved')
    let [created] = await database.sql<{ id: string; slug: string }[]>`select id, slug from orgs where name = 'Acme Labs'`
    assert.equal(created!.slug, 'acme-labs')
    assert.deepEqual(await orgOf('repos', `id = '${repoId}'`), [created!.id])
    assert.deepEqual({ ...(await membership('octocat', created!.id)), id: undefined }, { id: undefined, role: 'owner', source: 'github' })
    let html = await (await request('/', owner)).text()
    assert.match(html, /<span class="org-menu-name">Acme Labs<\/span>/)
  })

  it('the last installation moves only with the confirmation, and the empty org goes', async () => {
    roles.set('globex/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let [only] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${acme}`
    // A repository of that installation with its history: a job, its review, a finding source.
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${acme}, ${only!.id}, 5011, 'acme/history', true) returning id`
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id)
      values (${repo!.id}, 'lite', 7, 'abc1234', 'delivery-history') returning id`
    await database.sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
      values (${job!.id}, ${repo!.id}, 7, 'abc1234', 4, 'a-model', 0.01, ${JSON.stringify({ findings: [] })}::jsonb)`
    assert.equal((await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: globex })).headers.get('Location'), '/settings/organization?notice=last_installation')
    assert.equal((await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: globex, confirm: 'not the name' })).headers.get('Location'), '/settings/organization?notice=last_installation')
    assert.deepEqual(await orgOf('installations', `id = '${only!.id}'`), [acme])
    let moved = await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: globex, confirm: 'acme' })
    assert.equal(moved.headers.get('Location'), '/settings/organization?notice=moved')
    assert.equal((await database.sql`select count(*)::int as n from orgs where id = ${acme}`)[0]!.n, 0)
    assert.equal(await membership('octocat', acme), null)
    // The history of the repository went with it: nothing of it went with the org.
    assert.deepEqual(await orgOf('repos', `id = '${repo!.id}'`), [globex])
    assert.equal((await database.sql`select count(*)::int as n from jobs where repo_id = ${repo!.id}`)[0]!.n, 1)
    assert.equal((await database.sql`select count(*)::int as n from reviews where repo_id = ${repo!.id}`)[0]!.n, 1)
    assert.match(await (await request('/', owner)).text(), /<span class="org-menu-name">globex<\/span>/)
  })

  it('the last active installation asks for the confirmation; a suspended installation left keeps the org', async () => {
    roles.set('globex/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let [only] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${acme}`
    await database.sql`
      insert into installations (org_id, github_installation_id, github_account_id, account_login, suspended_at)
      values (${acme}, 15, 1015, 'acme-old', now())`
    let page = await (await request('/settings/organization', owner)).text()
    assert.match(page, /It is the last active installation: after the move nobody reaches acme\. Kentō keeps it, with its members, settings and suspended installations/)
    assert.doesNotMatch(page, /deleted with the last of them/)
    assert.equal((await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: globex })).headers.get('Location'), '/settings/organization?notice=last_installation')
    assert.equal((await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: globex, confirm: 'acme' })).headers.get('Location'), '/settings/organization?notice=moved')
    assert.deepEqual(await orgOf('installations', `id = '${only!.id}'`), [globex])
    // The org stays, with its suspended installation, and nobody reaches it.
    assert.equal((await database.sql`select count(*)::int as n from orgs where id = ${acme}`)[0]!.n, 1)
    assert.match(await (await request('/', owner)).text(), /<span class="org-menu-name">globex<\/span>/)
  })

  it('a new org follows GitHub: its creator demoted on GitHub becomes a member, and the next GitHub admin of the account its owner', async () => {
    roles.set('acme-labs/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let { installationId } = await secondInstallation()
    await post(owner, `/settings/organization/installations/${installationId}/move`, { to: 'new', name: 'Labs' })
    let [labs] = await database.sql<{ id: string }[]>`select id from orgs where name = 'Labs'`
    assert.equal((await membership('octocat', labs!.id))!.role, 'owner')
    // GitHub demotes octocat in acme-labs: at the next check, octocat is a member of Labs.
    roles.set('acme-labs/octocat', 'member')
    clock.now += ROLE_TTL_MS + 1000
    assert.equal((await request('/', owner)).status, 200)
    assert.equal((await membership('octocat', labs!.id))!.role, 'member')
    // camille, an admin of acme-labs on GitHub, signs in: Labs has no active owner, she is its owner.
    roles.set('acme-labs/camille', 'admin')
    await signIn('camille')
    assert.deepEqual({ ...(await membership('camille', labs!.id)), id: undefined }, { id: undefined, role: 'owner', source: 'github' })
  })

  it('an installation that the webhook adds during the move of the last one keeps the org', async () => {
    roles.set('globex/octocat', 'admin')
    await signIn('octocat')
    let [only] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${acme}`
    let [user] = await database.sql<{ id: string }[]>`select id from users where login = 'octocat'`
    // The webhook inserts a new installation of acme, and commits a moment later.
    let webhook = database.sql.begin(async (tx) => {
      await tx`insert into installations (org_id, github_installation_id, github_account_id, account_login) values (${acme}, 16, 1016, 'acme-new')`
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    let outcome = await createOrgsStore(database.sql).moveInstallation({
      fromOrgId: acme, installationId: only!.id, to: { orgId: globex }, actorUserId: user!.id, checks: await allAdmin(), deleteEmpty: true,
    })
    await webhook
    assert.deepEqual(outcome, { ok: true, orgId: globex, deleted: false })
    assert.deepEqual(await orgOf('installations', `github_installation_id = 16`), [acme])
  })

  it('knows every table that carries an org: a new one must say whether it follows a moved repository', async () => {
    // Every foreign key to orgs, whatever the name of its column, and the columns named org_id or
    // scope (an org id with no foreign key, as github_asks.scope, can only be found by its name).
    let rows = await database.sql<{ table: string; column: string }[]>`
      select table_name as table, column_name as column from information_schema.columns
      where table_schema = 'public' and column_name in ('org_id', 'scope')
      union
      select c.conrelid::regclass::text, a.attname::text from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'orgs'::regclass
      order by 1, 2`
    // repos, rules and assignment_rules follow a moved installation (moveInstallation); the others
    // belong to the org itself, and go with it when it is deleted. github_asks holds the id of an org
    // in its scope, with no foreign key: the move that deletes the org deletes its rows. A new table
    // with an org_id, a scope or a foreign key to orgs fails here until moveInstallation decides for
    // it. (accounts.scope is the scope of the GitHub sign-in, not an org. A deleted org sets
    // sessions.active_organization_id to null: the next request moves the session to another org.)
    assert.deepEqual(rows.map((r) => `${r.table}.${r.column}`), [
      'accounts.scope', 'assignment_rules.org_id', 'github_asks.scope', 'installations.org_id', 'invitations.org_id', 'memberships.org_id', 'org_audit.org_id',
      'providers.org_id', 'repos.org_id', 'rules.org_id', 'runner_registrations.org_id', 'runners.org_id', 'sessions.active_organization_id',
    ])
  })

  it('the store refuses by itself: a rename by an admin, an installation of another org', async () => {
    roles.set('acme/camille', 'admin')
    await signIn('octocat')
    await signIn('camille')
    let orgs = createOrgsStore(database.sql)
    let [camille] = await database.sql<{ id: string }[]>`select id from users where login = 'camille'`
    let [octocat] = await database.sql<{ id: string }[]>`select id from users where login = 'octocat'`
    assert.deepEqual(await orgs.rename(acme, camille!.id, 'Taken'), { ok: false, reason: 'not_owner' })
    let [globexInstallation] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${globex}`
    assert.deepEqual(
      await orgs.moveInstallation({ fromOrgId: acme, installationId: globexInstallation!.id, to: { name: 'Mine' }, actorUserId: octocat!.id, checks: await allAdmin(), deleteEmpty: true }),
      { ok: false, reason: 'not_found' },
    )
    assert.deepEqual(await orgOf('installations', `id = '${globexInstallation!.id}'`), [globex])
  })

  it('two moves in opposite ways at the same time both end, one after the other', async () => {
    roles.set('globex/octocat', 'admin')
    roles.set('acme-labs/octocat', 'admin')
    roles.set('globex-labs/octocat', 'admin')
    await signIn('octocat')
    let { installationId: fromAcme } = await secondInstallation()
    let [fromGlobex] = await database.sql<{ id: string }[]>`
      insert into installations (org_id, github_installation_id, github_account_id, account_login)
      values (${globex}, 14, 1014, 'globex-labs') returning id`
    let [user] = await database.sql<{ id: string }[]>`select id from users where login = 'octocat'`
    let orgs = createOrgsStore(database.sql)
    let checks = await allAdmin()
    let outcomes = await Promise.all([
      orgs.moveInstallation({ fromOrgId: acme, installationId: fromAcme, to: { orgId: globex }, actorUserId: user!.id, checks, deleteEmpty: false }),
      orgs.moveInstallation({ fromOrgId: globex, installationId: fromGlobex!.id, to: { orgId: acme }, actorUserId: user!.id, checks, deleteEmpty: false }),
    ])
    assert.deepEqual(outcomes.map((o) => o.ok), [true, true])
    assert.deepEqual(await orgOf('installations', `id = '${fromAcme}'`), [globex])
    assert.deepEqual(await orgOf('installations', `id = '${fromGlobex!.id}'`), [acme])
  })

  /** An org of its own for an account, as the webhook makes it, with the person as its owner from GitHub. */
  async function ownOrg(login: string, installation: number, account: number, owner: keyof typeof PEOPLE) {
    let orgId = await insertOrg(database.sql, login, installation, account)
    roles.set(`${login}/${owner}`, 'admin')
    await database.sql`insert into memberships (user_id, org_id, role, source, checked_at) values (${await userId(owner)}, ${orgId}, 'owner', 'github', now())`
    let [row] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${orgId}`
    return { orgId, installationId: row!.id }
  }

  async function invite(owner: string, login: keyof typeof PEOPLE, role: 'admin' | 'member') {
    await request('/settings/members/invite', owner, { _csrf: await csrfOf(owner), login, role })
    let cookie = (await signIn(login)).cookie!
    let [invitation] = await database.sql<{ id: string }[]>`select id from invitations where github_login = ${login} and status = 'pending' and org_id = ${acme}`
    await post(cookie, `/invitations/${invitation!.id}/accept`, {}, '/invitations')
    return cookie
  }

  async function switchTo(cookie: string, orgId: string) {
    await post(cookie, '/preferences/org', { orgId, returnTo: '/' })
  }

  it('a person who leaves the company keeps no right through a personal account: it never joins the org', async () => {
    let owner = (await signIn('octocat')).cookie!
    // octocat installed the App on his personal account too: an org of its own.
    let mine = await ownOrg('octocat', 21, PEOPLE.octocat!.id, 'octocat')
    people.add('octocat')
    await switchTo(owner, mine.orgId)
    let moved = await post(owner, `/settings/organization/installations/${mine.installationId}/move`, { to: acme, confirm: 'octocat' })
    assert.equal(moved.headers.get('Location'), '/settings/organization?notice=personal_account')
    assert.deepEqual(await orgOf('installations', `id = '${mine.installationId}'`), [mine.orgId])
    // GitHub removes octocat from acme: at the next check he is out of acme, whatever his own account.
    roles.delete('acme/octocat')
    roles.set('acme/camille', 'admin')
    clock.now += ROLE_TTL_MS + 1000
    await request('/', owner)
    assert.equal(await membership('octocat', acme), null)
    // And no other account joins the org of a personal account.
    let [globexInstallation] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${globex}`
    roles.set('globex/octocat', 'admin')
    await database.sql`insert into memberships (user_id, org_id, role, source, checked_at) values (${await userId('octocat')}, ${globex}, 'owner', 'github', now())`
    await database.sql`insert into installations (org_id, github_installation_id, github_account_id, account_login) values (${globex}, 24, 1024, 'globex-two')`
    roles.set('globex-two/octocat', 'admin')
    await switchTo(owner, globex)
    assert.equal(
      (await post(owner, `/settings/organization/installations/${globexInstallation!.id}/move`, { to: mine.orgId })).headers.get('Location'),
      '/settings/organization?notice=personal_account',
    )
  })

  it('an account of a person who leaves, moved into the org before, is detached by an owner who is an admin of the org on GitHub', async () => {
    let owner = (await signIn('octocat')).cookie!
    // octocat is an admin of acme and of another account, octo-labs, on GitHub; he moves octo-labs into acme.
    let labs = await ownOrg('octo-labs', 22, 1022, 'octocat')
    await switchTo(owner, labs.orgId)
    assert.equal((await post(owner, `/settings/organization/installations/${labs.installationId}/move`, { to: acme, confirm: 'octo-labs' })).headers.get('Location'), '/settings/organization?notice=moved')
    // He leaves the company: GitHub removes him from acme, camille is its admin now. octo-labs keeps him an admin of acme.
    roles.delete('acme/octocat')
    roles.set('acme/camille', 'admin')
    let camille = (await signIn('camille')).cookie!
    assert.equal((await membership('camille', acme))!.role, 'admin')
    // camille has no right on octo-labs: she cannot move it to an org of hers, but she detaches it.
    assert.equal((await post(camille, `/settings/members/reclaim`)).headers.get('Location'), '/settings/members?notice=reclaimed')
    assert.equal((await post(camille, `/settings/organization/installations/${labs.installationId}/move`, { to: 'new', name: 'Mine' })).headers.get('Location'), '/settings/organization?notice=not_github_admin')
    let page = await (await request('/settings/organization', camille)).text()
    assert.match(page, /<option value="detach">A new organization with no member \(detach\)<\/option>/)
    assert.equal((await post(camille, `/settings/organization/installations/${labs.installationId}/move`, { to: 'detach' })).headers.get('Location'), '/settings/organization?notice=detached')
    let [detached] = await database.sql<{ orgId: string }[]>`select org_id as "orgId" from installations where id = ${labs.installationId}`
    assert.notEqual(detached!.orgId, acme)
    assert.equal((await database.sql`select count(*)::int as n from memberships where org_id = ${detached!.orgId}`)[0]!.n, 0)
    // camille stays on acme; octocat's membership of acme ends at its next check.
    assert.match(await (await request('/', camille)).text(), /<span class="org-menu-name">acme<\/span>/)
    clock.now += ROLE_TTL_MS + 1000
    await request('/', owner)
    assert.equal(await membership('octocat', acme), null)
    // The next GitHub admin of octo-labs who signs in becomes the owner of its new org.
    await signIn('octocat')
    assert.deepEqual({ ...(await membership('octocat', detached!.orgId)), id: undefined }, { id: undefined, role: 'owner', source: 'github' })
  })

  it('an owner from an invitation brings no account of their own into the org', async () => {
    let owner = (await signIn('octocat')).cookie!
    let guest = await invite(owner, 'guest', 'admin')
    await post(owner, `/settings/members/${(await membership('guest', acme))!.id}/role`, { role: 'owner' })
    // guest owns a personal account and an org account with the App, each in an org of its own.
    let personal = await ownOrg('guest', 23, PEOPLE.guest!.id, 'guest')
    people.add('guest')
    let evil = await ownOrg('evilcorp', 25, 1025, 'guest')
    await switchTo(guest, personal.orgId)
    assert.equal((await post(guest, `/settings/organization/installations/${personal.installationId}/move`, { to: acme, confirm: 'guest' })).headers.get('Location'), '/settings/organization?notice=personal_account')
    await switchTo(guest, evil.orgId)
    assert.equal((await post(guest, `/settings/organization/installations/${evil.installationId}/move`, { to: acme, confirm: 'evilcorp' })).headers.get('Location'), '/settings/organization?notice=not_target_admin')
    assert.deepEqual(await database.sql`select account_login from installations where org_id = ${acme}`.then((r) => r.map((x) => x.account_login)), ['acme'])
    // guest leaves acme and signs in again: no account of guest gives a role in acme.
    await switchTo(guest, acme)
    await post(guest, '/settings/members/leave')
    await signIn('guest')
    assert.equal(await membership('guest', acme), null)
  })

  it('asks GitHub for at most MOVES_PER_MINUTE moves a minute per person, whatever the org', async () => {
    let owner = (await signIn('octocat')).cookie!
    let { installationId } = await secondInstallation()
    let path = `/settings/organization/installations/${installationId}/move`
    // GitHub does not count octocat as an admin of acme-labs: each move asks once, and is refused.
    for (let n = 0; n < MOVES_PER_MINUTE; n++) {
      assert.equal((await post(owner, path, { to: 'new', name: 'Labs' })).headers.get('Location'), '/settings/organization?notice=not_github_admin')
    }
    gitHub.calls = 0
    assert.equal((await post(owner, path, { to: 'new', name: 'Labs' })).headers.get('Location'), '/settings/organization?notice=move_wait')
    assert.equal(gitHub.calls, 0)
    // The next minute, GitHub is asked again.
    clock.now += 60 * 1000 + PAST_THE_WINDOW_MS
    assert.equal((await post(owner, path, { to: 'new', name: 'Labs' })).headers.get('Location'), '/settings/organization?notice=not_github_admin')
    assert.equal(gitHub.calls, 1)
  })

  it('refuses a move when GitHub fails, for the role or the type of an account; nothing moves', async () => {
    roles.set('globex/octocat', 'admin')
    roles.set('acme-labs/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let { installationId } = await secondInstallation()
    gitHub.failRoles = true
    assert.equal((await post(owner, `/settings/organization/installations/${installationId}/move`, { to: globex })).headers.get('Location'), '/settings/organization?notice=github_failed')
    assert.equal((await post(owner, `/settings/organization/installations/${installationId}/move`, { to: 'new', name: 'Labs' })).headers.get('Location'), '/settings/organization?notice=github_failed')
    assert.equal((await post(owner, `/settings/organization/installations/${installationId}/move`, { to: 'detach' })).headers.get('Location'), '/settings/organization?notice=github_failed')
    gitHub.failRoles = false
    gitHub.failTypes = true
    assert.equal((await post(owner, `/settings/organization/installations/${installationId}/move`, { to: globex })).headers.get('Location'), '/settings/organization?notice=github_failed')
    assert.deepEqual(await orgOf('installations', `id = '${installationId}'`), [acme])
    assert.equal((await database.sql`select count(*)::int as n from orgs`)[0]!.n, 2)
  })

  it('the store refuses a suspended installation, a target with no active installation, and answers about other installations', async () => {
    roles.set('acme-labs/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let { installationId } = await secondInstallation()
    let orgs = createOrgsStore(database.sql)
    let octocat = await userId('octocat')
    await database.sql`insert into memberships (user_id, org_id, role, source) values (${octocat}, ${globex}, 'owner', 'invitation')`
    // A suspended installation does not move, by the screen or by the store.
    await database.sql`update installations set suspended_at = now() where id = ${installationId}`
    assert.equal((await post(owner, `/settings/organization/installations/${installationId}/move`, { to: 'new', name: 'Labs' })).headers.get('Location'), '/settings/organization?notice=not_found')
    assert.deepEqual(await orgs.moveInstallation({ fromOrgId: acme, installationId, to: { name: 'Labs' }, actorUserId: octocat, checks: await allAdmin(), deleteEmpty: true }), { ok: false, reason: 'not_found' })
    await database.sql`update installations set suspended_at = null where id = ${installationId}`
    // globex has no active installation: nobody would reach what moves there.
    await database.sql`update installations set suspended_at = now() where org_id = ${globex}`
    assert.deepEqual(await orgs.moveInstallation({ fromOrgId: acme, installationId, to: { orgId: globex }, actorUserId: octocat, checks: await allAdmin(), deleteEmpty: false }), { ok: false, reason: 'target_inactive' })
    await database.sql`update installations set suspended_at = null where org_id = ${globex}`
    // An installation joined globex after GitHub was asked: no answer about it, no move.
    let checks = await allAdmin()
    await database.sql`insert into installations (org_id, github_installation_id, github_account_id, account_login) values (${globex}, 26, 1026, 'globex-new')`
    assert.deepEqual(await orgs.moveInstallation({ fromOrgId: acme, installationId, to: { orgId: globex }, actorUserId: octocat, checks, deleteEmpty: false }), { ok: false, reason: 'changed' })
    assert.deepEqual(await orgOf('installations', `id = '${installationId}'`), [acme])
  })

  it('writes the rename, the move and the deletion in org_audit; the deletion keeps its row and lists what it took', async () => {
    roles.set('globex/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    await invite(owner, 'guest', 'member')
    await request('/settings/members/invite', owner, { _csrf: await csrfOf(owner), login: 'other', role: 'admin' })
    await signIn('camille')
    await database.sql`insert into rules (org_id, title, body) values (${acme}, 'Org rule', 'Goes')`
    assert.equal((await post(owner, '/settings/organization/name', { name: 'Acme 2' })).headers.get('Location'), '/settings/organization?notice=renamed')
    let [only] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${acme}`
    let page = await (await request('/settings/organization', owner)).text()
    assert.match(page, /It is the last installation: Acme 2 is deleted with the move/)
    assert.match(page, /Its members from an invitation lose their access: guest\./)
    assert.match(page, /Its members from GitHub leave it: camille, octocat\./)
    assert.match(page, /Its pending invitations are canceled: other\./)
    assert.equal((await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: globex, confirm: 'Acme 2' })).headers.get('Location'), '/settings/organization?notice=moved')
    let rows = await database.sql`
      select action, org_id, org_name, actor_login, target_login, detail from org_audit
      where action in ('rename', 'move_out', 'move_in', 'delete') order by created_at, action`
    let byAction = Object.fromEntries(rows.map((r) => [r.action, { ...r }]))
    assert.deepEqual(byAction.rename, { action: 'rename', org_id: null, org_name: 'Acme 2', actor_login: 'octocat', target_login: null, detail: { before: 'acme', after: 'Acme 2' } })
    assert.deepEqual(byAction.move_out, {
      action: 'move_out', org_id: null, org_name: 'Acme 2', actor_login: 'octocat', target_login: 'acme',
      detail: { installation: 11, repositories: 0, kind: 'org', to: { id: globex, name: 'globex' } },
    })
    assert.equal(byAction.move_in.org_id, globex)
    assert.deepEqual(byAction.move_in.detail.from, { id: acme, name: 'Acme 2' })
    assert.deepEqual(byAction.delete, {
      action: 'delete', org_id: null, org_name: 'Acme 2', actor_login: 'octocat', target_login: null,
      detail: {
        members: [
          { login: 'camille', role: 'member', source: 'github' },
          { login: 'guest', role: 'member', source: 'invitation' },
          { login: 'octocat', role: 'owner', source: 'github' },
        ],
        invitations: ['other'],
        providers: 0,
        runners: 0,
        rules: 1,
      },
    })
  })

  it('refuses a name with an invisible character, and gives two new orgs of the same name at once two slugs', async () => {
    roles.set('acme-labs/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    assert.equal((await post(owner, '/settings/organization/name', { name: 'a\u200bcme' })).headers.get('Location'), '/settings/organization?notice=bad_name')
    assert.equal((await post(owner, '/settings/organization/name', { name: '\u202egloBex' })).headers.get('Location'), '/settings/organization?notice=bad_name')
    let { installationId } = await secondInstallation()
    let [other] = await database.sql<{ id: string }[]>`
      insert into installations (org_id, github_installation_id, github_account_id, account_login) values (${globex}, 14, 1014, 'globex-labs') returning id`
    await signIn('other')
    let orgs = createOrgsStore(database.sql)
    let checks = await allAdmin()
    let both = await Promise.all([
      orgs.moveInstallation({ fromOrgId: acme, installationId, to: { name: 'Labs' }, actorUserId: await userId('octocat'), checks, deleteEmpty: false }),
      orgs.moveInstallation({ fromOrgId: globex, installationId: other!.id, to: { name: 'Labs' }, actorUserId: await userId('other'), checks, deleteEmpty: false }),
    ])
    assert.deepEqual(both.map((o) => o.ok), [true, true])
    assert.deepEqual((await database.sql`select slug from orgs where name = 'Labs' order by slug`).map((r) => r.slug), ['labs', 'labs-2'])
  })

  it('a move and the webhook of the moved installation, at the same time, never wait on each other', async () => {
    let actor = await ownerOfBoth()
    let { installationId } = await secondInstallation()
    let orgs = createOrgsStore(database.sql)
    let apply = createWebhookStore(database.db)
    let installation = { githubInstallationId: 13, githubAccountId: 1013, login: 'acme-labs' }
    let checks = await allAdmin()
    let from = acme
    let errors: string[] = []
    let moves = 0
    for (let round = 0; round < 300; round++) {
      let to = from === acme ? globex : acme
      let results = await Promise.allSettled([
        apply({ type: 'add_repositories', installation, repositories: [{ githubRepoId: 9000 + (round % 4), fullName: `acme-labs/r${round % 4}` }] }, `delivery-${round}`),
        orgs.moveInstallation({ fromOrgId: from, installationId, to: { orgId: to }, actorUserId: actor, checks, deleteEmpty: false }),
      ])
      for (let result of results) if (result.status === 'rejected') errors.push(String((result.reason as { code?: string }).code ?? result.reason))
      let moved = results[1]!
      if (moved.status === 'fulfilled' && moved.value.ok) {
        from = to
        moves++
      }
    }
    assert.deepEqual(errors, [])
    assert.equal(moves, 300)
    let split = await database.sql`select count(*)::int as n from repos r join installations i on i.id = r.installation_id where r.org_id <> i.org_id`
    assert.equal(split[0]!.n, 0)
  })

  it('a move and a rule saved on a repository of the installation, at the same time, never wait on each other', async () => {
    let actor = await ownerOfBoth()
    let { installationId, repoId } = await secondInstallation()
    let orgs = createOrgsStore(database.sql)
    let rules = createRulesStore(database.sql)
    let assignment = createAssignmentStore(database.sql)
    let checks = await allAdmin()
    let from = acme
    let errors: string[] = []
    let moves = 0
    for (let round = 0; round < 60; round++) {
      let to = from === acme ? globex : acme
      let results = await Promise.allSettled([
        rules.create(from, repoId, actor, { title: `Rule ${round}`, body: 'Check it', paths: [], severityFloor: null }),
        assignment.create(from, repoId, actor, { authors: [`a${round}`], paths: [], labels: [], action: 'review', level: 'lite', mention: null }),
        orgs.moveInstallation({ fromOrgId: from, installationId, to: { orgId: to }, actorUserId: actor, checks, deleteEmpty: false }),
      ])
      for (let result of results) if (result.status === 'rejected') errors.push(String((result.reason as { code?: string }).code ?? result.reason))
      let moved = results[2]!
      if (moved.status === 'fulfilled' && moved.value.ok) {
        from = to
        moves++
      }
    }
    assert.deepEqual(errors, [])
    assert.equal(moves, 60)
    let stray = await database.sql`select count(*)::int as n from rules r join repos p on p.id = r.repo_id where r.org_id <> p.org_id`
    assert.equal(stray[0]!.n, 0)
  })

  it('a rename and a move of the same owner, at the same time, never wait on each other', async () => {
    let actor = await ownerOfBoth()
    let { installationId } = await secondInstallation()
    let orgs = createOrgsStore(database.sql)
    let checks = await allAdmin()
    let from = acme
    let errors: string[] = []
    let moves = 0
    for (let round = 0; round < 60; round++) {
      let to = from === acme ? globex : acme
      let results = await Promise.allSettled([
        orgs.rename(acme, actor, `acme ${round}`),
        orgs.rename(globex, actor, `globex ${round}`),
        orgs.moveInstallation({ fromOrgId: from, installationId, to: { orgId: to }, actorUserId: actor, checks, deleteEmpty: false }),
      ])
      for (let result of results) if (result.status === 'rejected') errors.push(String((result.reason as { code?: string }).code ?? result.reason))
      let moved = results[2]!
      if (moved.status === 'fulfilled' && moved.value.ok) {
        from = to
        moves++
      }
    }
    assert.deepEqual(errors, [])
    assert.equal(moves, 60)
  })

  it('a move waits for a webhook that holds the installation, then its org, as upsertInstallation does', async () => {
    let actor = await ownerOfBoth()
    let { installationId } = await secondInstallation()
    // The order of the webhook: the row of the installation, then the row of its org, a moment later.
    let webhook = database.sql.begin(async (tx) => {
      await tx`update installations set updated_at = now() where github_installation_id = 13`
      await new Promise((resolve) => setTimeout(resolve, 200))
      await tx`select id from orgs where id = ${acme} for update`
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    let outcome = await createOrgsStore(database.sql).moveInstallation({ fromOrgId: acme, installationId, to: { orgId: globex }, actorUserId: actor, checks: await allAdmin(), deleteEmpty: false })
    await webhook
    assert.deepEqual(outcome, { ok: true, orgId: globex, deleted: false })
  })

  for (let table of ['rules', 'assignment_rules'] as const) {
    it(`a move waits for a save of ${table} that holds the repository, and the save ends`, async () => {
      let actor = await ownerOfBoth()
      let { installationId, repoId } = await secondInstallation()
      // A lock of the table holds the insert of the save after its lock of the repository.
      let release!: () => void
      let held = new Promise<void>((resolve) => (release = resolve))
      let blocked = new Promise<void>((resolve) => {
        void database.sql.begin(async (tx) => {
          await tx.unsafe(`lock table ${table} in share mode`)
          resolve()
          await held
        })
      })
      await blocked
      let save =
        table === 'rules'
          ? createRulesStore(database.sql).create(acme, repoId, actor, { title: 'During the move', body: 'Check it', paths: [], severityFloor: null })
          : createAssignmentStore(database.sql).create(acme, repoId, actor, { authors: ['someone'], paths: [], labels: [], action: 'review', level: 'lite', mention: null })
      await new Promise((resolve) => setTimeout(resolve, 100))
      let move = createOrgsStore(database.sql).moveInstallation({ fromOrgId: acme, installationId, to: { orgId: globex }, actorUserId: actor, checks: await allAdmin(), deleteEmpty: false })
      await new Promise((resolve) => setTimeout(resolve, 100))
      release()
      let [saved, moved] = await Promise.allSettled([save, move])
      assert.equal(saved.status, 'fulfilled', String((saved as PromiseRejectedResult).reason))
      assert.equal(moved.status, 'fulfilled', String((moved as PromiseRejectedResult).reason))
      assert.deepEqual((moved as PromiseFulfilledResult<unknown>).value, { ok: true, orgId: globex, deleted: false })
      // The save came first: what it wrote moved with the repository.
      let stray = await database.sql.unsafe(`select count(*)::int as n from ${table} r join repos p on p.id = r.repo_id where r.org_id <> p.org_id`)
      assert.equal(stray[0]!.n, 0)
      assert.deepEqual(await orgOf(table, `repo_id = '${repoId}'`).then((ids) => [...new Set(ids)]), [globex])
    })
  }

  /**
   * KNT-173. Starts a move and holds it after it moved the installation and its repositories, with
   * the locks of the installation and of the orgs still taken: a lock of the table `rules` stops it
   * at its update of the rules. `release` lets it end.
   */
  async function heldMove(input: Parameters<ReturnType<typeof createOrgsStore>['moveInstallation']>[0]) {
    let release!: () => void
    let held = new Promise<void>((resolve) => (release = resolve))
    let locked = new Promise<void>((resolve) => {
      void database.sql.begin(async (tx) => {
        await tx`lock table rules in share mode`
        resolve()
        await held
      })
    })
    await locked
    let move = createOrgsStore(database.sql).moveInstallation(input)
    // The move reaches its update of the rules, and waits there.
    let waiting = async () => (await database.sql`select count(*)::int as n from pg_locks where not granted and relation = 'rules'::regclass`)[0]!.n > 0
    for (let tries = 0; !(await waiting()) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 20))
    return { move, release }
  }

  it('a check of the repositories during a move writes them in the org where the installation went', async () => {
    let actor = await ownerOfBoth()
    let { installationId } = await secondInstallation()
    let { move, release } = await heldMove({ fromOrgId: acme, installationId, to: { orgId: globex }, actorUserId: actor, checks: await allAdmin(), deleteEmpty: false })
    // The check read the installation in acme before the move.
    let saved = createReposStore(database.sql).saveCheck(installationId, [
      { githubRepoId: 5099, fullName: 'acme-labs/new-one', private: false, defaultBranch: 'main', workflow: { mode: 'none', path: null, ref: null } },
    ])
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    let [moved, checked] = await Promise.allSettled([move, saved])
    assert.equal(moved.status, 'fulfilled', String((moved as PromiseRejectedResult).reason))
    assert.equal(checked.status, 'fulfilled', String((checked as PromiseRejectedResult).reason))
    assert.deepEqual(await orgOf('repos', `github_repo_id = 5099`), [globex])
    assert.deepEqual(await orgOf('repos', `installation_id = '${installationId}'`).then((ids) => [...new Set(ids)]), [globex])
  })

  it('a new installation of an account whose last installation moves joins the org where it went', async () => {
    let actor = await ownerOfBoth()
    let [only] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${acme}`
    let { move, release } = await heldMove({ fromOrgId: acme, installationId: only!.id, to: { orgId: globex }, actorUserId: actor, checks: await allAdmin(), deleteEmpty: true })
    // The account of acme installs the App again while the move deletes acme.
    let apply = createWebhookStore(database.db)
    let reinstalled = apply({ type: 'upsert_installation', installation: { githubInstallationId: 99, githubAccountId: 1011, login: 'acme' }, repositories: [], suspended: false }, 'delivery-reinstall')
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    let [moved, webhook] = await Promise.allSettled([move, reinstalled])
    assert.deepEqual(moved.status === 'fulfilled' ? moved.value : moved.reason, { ok: true, orgId: globex, deleted: true })
    assert.equal(webhook.status, 'fulfilled', String((webhook as PromiseRejectedResult).reason))
    assert.deepEqual(await orgOf('installations', `github_installation_id = 99`), [globex])
  })

  const checkedRepo = (githubRepoId: number, fullName: string) => ({
    githubRepoId,
    fullName,
    private: false,
    defaultBranch: 'main',
    workflow: { mode: 'none' as const, path: null, ref: null },
  })

  it('a check of the repositories and a webhook that holds the org and writes one of them both end', async () => {
    let [installation] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${acme}`
    await database.sql`insert into repos (org_id, installation_id, github_repo_id, full_name) values (${acme}, ${installation!.id}, 7001, 'acme/old')`
    // The webhook, as upsertInstallation and upsertRepoRows: the org, then (later) the repository.
    let go!: () => void
    let gate = new Promise<void>((resolve) => (go = resolve))
    let ready!: () => void
    let holding = new Promise<void>((resolve) => (ready = resolve))
    let webhook = database.sql.begin(async (tx) => {
      await tx`update installations set updated_at = now() where github_installation_id = 11`
      await tx`select id from orgs where id = ${acme} for update`
      ready()
      await gate
      await tx`
        insert into repos (org_id, installation_id, github_repo_id, full_name) values (${acme}, ${installation!.id}, 7001, 'acme/old')
        on conflict (github_repo_id) do update set full_name = excluded.full_name, updated_at = now()`
    })
    await holding
    // The check finds the existing repository and a new one.
    let check = createReposStore(database.sql).saveCheck(installation!.id, [checkedRepo(7001, 'acme/old'), checkedRepo(7002, 'acme/new')])
    let waiting = async () => (await database.sql`select count(*)::int as n from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())`)[0]!.n > 0
    for (let tries = 0; !(await waiting()) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 20))
    go()
    let [written, checked] = await Promise.allSettled([webhook, check])
    assert.equal(written.status, 'fulfilled', String((written as PromiseRejectedResult).reason))
    assert.equal(checked.status, 'fulfilled', String((checked as PromiseRejectedResult).reason))
    assert.deepEqual(await orgOf('repos', `github_repo_id in (7001, 7002)`), [acme, acme])
  })

  it('a check of an installation that is gone writes nothing', async () => {
    await createReposStore(database.sql).saveCheck('00000000-0000-4000-8000-000000000000', [checkedRepo(7003, 'acme/lost')])
    assert.equal((await database.sql`select count(*)::int as n from repos where github_repo_id = 7003`)[0]!.n, 0)
  })

  it('counts the moves per person whatever the org: an org that a move deletes does not take the count', async () => {
    let owner = (await signIn('octocat')).cookie!
    // octocat moves the only installation of his org to a new org, again and again: each move deletes the org.
    let name = 'acme'
    for (let n = 0; n < MOVES_PER_MINUTE; n++) {
      let [only] = await database.sql<{ id: string }[]>`select i.id from installations i join orgs o on o.id = i.org_id where o.name = ${name}`
      let next = `Org ${n}`
      let moved = await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: 'new', name: next, confirm: name })
      assert.equal(moved.headers.get('Location'), '/settings/organization?notice=moved')
      name = next
    }
    let [only] = await database.sql<{ id: string }[]>`select i.id from installations i join orgs o on o.id = i.org_id where o.name = ${name}`
    gitHub.calls = 0
    assert.equal((await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: 'new', name: 'One more', confirm: name })).headers.get('Location'), '/settings/organization?notice=move_wait')
    assert.equal(gitHub.calls, 0)
  })

  it('gives the last slot of a limit to one request only, keeps each person apart, and answers gone for a person deleted', async () => {
    await signIn('octocat')
    await signIn('camille')
    let [octocat, camille] = [await userId('octocat'), await userId('camille')]
    let orgs = createOrgsStore(database.sql, testClock)
    let moves = await Promise.all(Array.from({ length: MOVES_PER_MINUTE + 5 }, () => orgs.askMove(octocat)))
    assert.equal(moves.filter((m) => m === 'allowed').length, MOVES_PER_MINUTE)
    assert.equal(await orgs.askMove(camille), 'allowed')
    let members = createMembersStore(database.sql, testClock)
    let reclaims = await Promise.all(Array.from({ length: 5 }, () => members.askReclaim(acme, octocat)))
    assert.deepEqual(reclaims.filter((r) => r === 'allowed').length, 1)
    // The take-back of another org has its own count; it counts only for a member of the org.
    assert.equal(await members.askReclaim(globex, octocat), 'gone')
    await database.sql`insert into memberships (user_id, org_id, role, source) values (${octocat}, ${globex}, 'member', 'invitation')`
    assert.equal(await members.askReclaim(globex, octocat), 'allowed')
    assert.equal((await database.sql`select count(*)::int as n from github_asks where scope = ${globex}`)[0]!.n, 1)
    // A person deleted while a request was under way: no 500.
    let [gone] = await database.sql<{ id: string }[]>`insert into users (github_id, login, email) values (99, 'gone', '99@users.github.invalid') returning id`
    await database.sql`delete from users where id = ${gone!.id}`
    assert.equal(await orgs.askMove(gone!.id), 'gone')
  })

  it('a move that deletes an org deletes the counts of the questions of that org', async () => {
    roles.set('globex/octocat', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let octocat = await userId('octocat')
    assert.equal(await createMembersStore(database.sql, testClock).askReclaim(acme, octocat), 'allowed')
    let [only] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${acme}`
    assert.equal((await post(owner, `/settings/organization/installations/${only!.id}/move`, { to: globex, confirm: 'acme' })).headers.get('Location'), '/settings/organization?notice=moved')
    assert.equal((await database.sql`select count(*)::int as n from github_asks where scope = ${acme}`)[0]!.n, 0)
  })

  it('a take-back counted while a move deletes its org leaves no row, and asks nothing', async () => {
    let actor = await ownerOfBoth()
    let [only] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${acme}`
    let { move, release } = await heldMove({ fromOrgId: acme, installationId: only!.id, to: { orgId: globex }, actorUserId: actor, checks: await allAdmin(), deleteEmpty: true })
    // The move holds the row of acme; the count of a take-back in acme waits for it.
    let asked = createMembersStore(database.sql, testClock).askReclaim(acme, actor)
    // The count reaches the lock of the org, and waits there (a row lock: the wait shows on the
    // statement, not as a lock of the table).
    let waiting = async () =>
      (await database.sql`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%insert into github_asks%'`)[0]!.n > 0
    let reached = false
    try {
      for (let tries = 0; !(reached = await waiting()) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      release()
    }
    assert.equal(reached, true, 'the count waits for the lock of the org')
    assert.deepEqual(await move, { ok: true, orgId: globex, deleted: true })
    assert.equal(await asked, 'gone')
    assert.equal((await database.sql`select count(*)::int as n from github_asks where scope = ${acme}`)[0]!.n, 0)
  })

  it('a move whose count answers gone asks GitHub nothing, says not found, and logs organizations.move_gone', async () => {
    let owner = (await signIn('octocat')).cookie!
    let { installationId } = await secondInstallation()
    let saved = orgsStore.askMove
    orgsStore.askMove = async () => 'gone'
    // A warn goes to stderr (app/log.ts).
    let lines: string[] = []
    let stderr = process.stderr.write.bind(process.stderr)
    try {
      gitHub.calls = 0
      let csrf = await csrfOf(owner)
      process.stderr.write = ((chunk: unknown) => lines.push(String(chunk)) > 0) as typeof process.stderr.write
      let response = await request(`/settings/organization/installations/${installationId}/move`, owner, { _csrf: csrf, to: 'new', name: 'Labs' })
      process.stderr.write = stderr
      assert.equal(response.headers.get('Location'), '/settings/organization?notice=not_found')
      assert.equal(gitHub.calls, 0)
    } finally {
      process.stderr.write = stderr
      orgsStore.askMove = saved
    }
    let events = lines.map((line) => JSON.parse(line) as { event: string }).map((line) => line.event)
    assert.ok(events.includes('organizations.move_gone'), events.join(', '))
    assert.ok(!events.includes('organizations.move_throttled'))
  })
})
