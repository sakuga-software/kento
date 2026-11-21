import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createKentoAuth, postgresAuthDatabase } from '../../app/auth/better-auth.ts'
import type { GitHubOAuth, GitHubProfile, GitHubRole } from '../../app/auth/github.ts'
import type { OrgRole } from '../../app/db/schema.ts'
import { createAuthStore } from '../../app/auth/store.ts'
import { cookiesOf, SESSION_COOKIE } from '../../app/auth/test-helpers.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createMembersStore, type MembersStore } from '../../app/members/store.ts'
import { createOrgsStore } from '../../app/organizations/store.ts'
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
  let router: ReturnType<typeof createAppRouter>
  let profile: GitHubProfile
  let roles: Map<string, GitHubRole | null>
  let clock: { now: number }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 3 })
    store = createMembersStore(database.sql)
    let authStore = createAuthStore(database.sql)
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
    let lookupRole = async (installation: { login: string }, person: { login: string }) => roles.get(`${installation.login}/${person.login}`) ?? null
    let secret = 'a-session-secret-for-the-tests-0123456789'
    clock = { now: Date.now() }
    let auth = createKentoAuth({ database: postgresAuthDatabase(database.db), publicUrl: PUBLIC_URL, secret, github, store: authStore, lookupRole, now: () => clock.now })
    router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '1.2.3',
      commit: null,
      webhook: disabledWebhook,
      // Every request of these tests comes with no socket, so they share one limit: a high one.
      auth: { publicUrl: PUBLIC_URL, sessionSecrets: [secret], auth, store: authStore, lookupRole, now: () => clock.now, signInLimit: 1000 },
      organization: { store: createOrgsStore(database.sql), lookupRole },
      members: {
        store,
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
  })

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
    assert.match(page, /It is the last active installation: nobody reaches acme after the move/)
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

  it('knows every table that carries an org: a new one must say whether it follows a moved repository', async () => {
    let rows = await database.sql<{ table: string }[]>`
      select table_name as table from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id' order by table_name`
    // repos, rules and assignment_rules follow a moved installation (moveInstallation); the others
    // belong to the org itself, and go with it when it is deleted. A new table with an org_id fails
    // here until moveInstallation decides for it.
    assert.deepEqual(rows.map((r) => r.table), [
      'assignment_rules', 'installations', 'invitations', 'memberships', 'org_audit', 'providers', 'repos', 'rules', 'runner_registrations', 'runners',
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
      await orgs.moveInstallation({ fromOrgId: acme, installationId: globexInstallation!.id, to: { name: 'Mine' }, actorUserId: octocat!.id, githubAdmin: true, deleteEmpty: true }),
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
    let outcomes = await Promise.all([
      orgs.moveInstallation({ fromOrgId: acme, installationId: fromAcme, to: { orgId: globex }, actorUserId: user!.id, githubAdmin: true, deleteEmpty: false }),
      orgs.moveInstallation({ fromOrgId: globex, installationId: fromGlobex!.id, to: { orgId: acme }, actorUserId: user!.id, githubAdmin: true, deleteEmpty: false }),
    ])
    assert.deepEqual(outcomes.map((o) => o.ok), [true, true])
    assert.deepEqual(await orgOf('installations', `id = '${fromAcme}'`), [globex])
    assert.deepEqual(await orgOf('installations', `id = '${fromGlobex!.id}'`), [acme])
  })
})
