import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createKentoAuth, postgresAuthDatabase } from '../../app/auth/better-auth.ts'
import type { GitHubOAuth, GitHubProfile, GitHubRole } from '../../app/auth/github.ts'
import type { OrgRole } from '../../app/db/schema.ts'
import { saveGitHubRole } from '../../app/auth/access.ts'
import { createAuthStore } from '../../app/auth/store.ts'
import { cookiesOf, SESSION_COOKIE } from '../../app/auth/test-helpers.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createMembersStore, type MembersStore } from '../../app/members/store.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase, insertOrg } from './helpers.ts'

// KNT-150. The members and the invitations of an org, through the screens, on Postgres: who invites,
// who changes a role, the last owner, and a member of one org against another org.

const PUBLIC_URL = new URL('https://kento.example.com')
const PEOPLE: Record<string, GitHubProfile> = {
  octocat: { id: 1, login: 'octocat', name: 'Octocat', avatarUrl: null },
  camille: { id: 2, login: 'camille', name: null, avatarUrl: null },
  guest: { id: 3, login: 'guest', name: null, avatarUrl: null },
  other: { id: 4, login: 'other', name: null, avatarUrl: null },
}

describe('the members and the invitations of an org', () => {
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

  it('an owner invites a GitHub login; the person, in no org of the App, signs in, sees only the invitation, and accepts it', async () => {
    let owner = (await signIn('octocat')).cookie!
    let invited = await post(owner, '/settings/members/invite', { login: '@Guest', role: 'member' })
    assert.equal(invited.headers.get('Location'), '/settings/members?notice=invited')
    let html = await (await request('/settings/members?notice=invited', owner)).text()
    assert.match(html, /Invitation sent\./)
    assert.match(html, /<span class="member-login">guest<\/span>/)

    // Before the invitation, guest was refused; now guest signs in, with no org yet.
    let { cookie } = await signIn('guest')
    assert.ok(cookie)
    let home = await request('/', cookie)
    assert.equal(home.status, 303)
    assert.equal(home.headers.get('Location'), '/invitations')
    assert.equal((await request('/repos', cookie)).headers.get('Location'), '/invitations')
    // With a real CSRF token (from the page of the invitations): the 403 comes from the role check.
    assert.equal((await post(cookie!, '/repos/check', {}, '/invitations')).status, 403, 'no form of an org')
    assert.equal((await post(cookie!, '/preferences/org', { orgId: acme, returnTo: '/' }, '/invitations')).status, 403)
    assert.equal((await post(cookie!, '/settings/members/invite', { login: 'other', role: 'member' }, '/invitations')).status, 403)
    let page = await (await request('/invitations', cookie)).text()
    assert.match(page, /<span class="member-login">acme<\/span>/)
    assert.match(page, /action="\/logout"/, 'a person with no org can sign out')
    let [invitation] = await database.sql<{ id: string }[]>`select id from invitations where status = 'pending'`

    let accepted = await post(cookie!, `/invitations/${invitation!.id}/accept`)
    assert.equal(accepted.headers.get('Location'), '/')
    assert.deepEqual({ ...(await membership('guest', acme)) , id: undefined }, { id: undefined, role: 'member', source: 'invitation' })
    let screen = await (await request('/', cookie)).text()
    assert.match(screen, /<span class="org-menu-name">acme<\/span>/)
    assert.match(screen, /Read only/)
    // GitHub counts guest nowhere: the membership from the invitation stays.
    clock.now += 11 * 60 * 1000
    assert.equal((await request('/', cookie)).status, 200)
    // Used once.
    assert.equal((await post(cookie!, `/invitations/${invitation!.id}/accept`)).headers.get('Location'), '/invitations?notice=gone')
  })

  it('a person whose only access is an invitation signs out', async () => {
    let owner = (await signIn('octocat')).cookie!
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })
    let { cookie } = await signIn('guest')
    let out = await post(cookie!, '/logout', {}, '/invitations')
    assert.equal(out.headers.get('Location'), '/login?notice=signed_out')
    assert.equal((await request('/invitations', cookie)).status, 303)
    let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.login = 'guest'`
    assert.equal(count!.n, 0)
  })

  it('refuses a login that GitHub does not know, a person already a member or already invited, and an invitation from a member', async () => {
    let owner = (await signIn('octocat')).cookie!
    assert.equal((await post(owner, '/settings/members/invite', { login: 'nobody-here', role: 'member' })).headers.get('Location'), '/settings/members?notice=unknown_login&login=nobody-here')
    assert.equal((await post(owner, '/settings/members/invite', { login: 'bad login!', role: 'member' })).headers.get('Location'), '/settings/members?notice=unknown_login')
    await signIn('camille')
    assert.equal((await post(owner, '/settings/members/invite', { login: 'camille', role: 'admin' })).headers.get('Location'), '/settings/members?notice=already_member')
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })
    assert.equal((await post(owner, '/settings/members/invite', { login: 'guest', role: 'admin' })).headers.get('Location'), '/settings/members?notice=already_invited')
    assert.equal((await post(owner, '/settings/members/invite', { login: 'guest', role: 'owner' })).status, 400)
    let member = (await signIn('camille')).cookie!
    assert.equal((await post(member, '/settings/members/invite', { login: 'other', role: 'member' })).status, 403)
    assert.doesNotMatch(await (await request('/settings/members', member)).text(), /action="\/settings\/members\/invite"/)
    let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from invitations`
    assert.equal(count!.n, 1)
  })

  it('a member of one org reaches nothing of another org: members, invitations, roles', async () => {
    let owner = (await signIn('octocat')).cookie!
    let otherAdmin = (await signIn('other')).cookie!
    await post(otherAdmin, '/settings/members/invite', { login: 'guest', role: 'member' })
    let [globexInvitation] = await database.sql<{ id: string }[]>`select id from invitations where org_id = ${globex}`
    let otherMembership = (await membership('other', globex))!

    // The members page of acme lists only acme.
    let html = await (await request('/settings/members', owner)).text()
    assert.doesNotMatch(html, />other</)
    assert.doesNotMatch(html, />guest</)
    // The ids of globex in the forms of acme: nothing changes.
    assert.equal((await post(owner, `/settings/invitations/${globexInvitation!.id}/cancel`)).headers.get('Location'), '/settings/members?notice=not_found')
    assert.equal((await post(owner, `/settings/members/${otherMembership.id}/role`, { role: 'member' })).headers.get('Location'), '/settings/members?notice=not_found')
    assert.equal((await post(owner, `/settings/members/${otherMembership.id}/remove`)).headers.get('Location'), '/settings/members?notice=not_found')
    assert.equal((await database.sql`select status from invitations`)[0]!.status, 'pending')
    assert.equal((await membership('other', globex))!.role, 'owner')
    // An invitation for guest is not one for octocat.
    assert.equal((await post(owner, `/invitations/${globexInvitation!.id}/accept`)).headers.get('Location'), '/invitations?notice=gone')
    assert.equal((await post(owner, `/invitations/${globexInvitation!.id}/decline`)).headers.get('Location'), '/invitations?notice=gone')
    assert.equal(await membership('octocat', globex), null)
  })

  it('an owner cancels an invitation; the person declines one; an expired one is gone', async () => {
    let owner = (await signIn('octocat')).cookie!
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })
    let [first] = await database.sql<{ id: string }[]>`select id from invitations`
    assert.equal((await post(owner, `/settings/invitations/${first!.id}/cancel`)).headers.get('Location'), '/settings/members?notice=canceled')
    let refused = await signIn('guest')
    assert.equal(refused.cookie, null, 'no invitation left: refused')

    await post(owner, '/settings/members/invite', { login: 'guest', role: 'admin' })
    let { cookie } = await signIn('guest')
    let [second] = await database.sql<{ id: string }[]>`select id from invitations where status = 'pending'`
    assert.equal((await post(cookie!, `/invitations/${second!.id}/decline`)).headers.get('Location'), '/invitations?notice=declined')
    assert.equal(await membership('guest', acme), null)

    // An invitation of 8 days ago is not pending any more: not shown, not accepted, a new one is possible.
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })
    await database.sql`update invitations set expires_at = now() - interval '1 day' where status = 'pending'`
    let [third] = await database.sql<{ id: string }[]>`select id from invitations where status = 'pending'`
    assert.doesNotMatch(await (await request('/settings/members', owner)).text(), /<span class="member-login">guest<\/span>/)
    assert.equal((await signIn('guest')).cookie, null)
    assert.equal(await store.accept(third!.id, { id: 'x', githubId: 3 }), null)
    assert.equal((await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })).headers.get('Location'), '/settings/members?notice=invited')
  })

  it('the roles: an admin sets admin or member on an invited person, only an owner gives owner, GitHub keeps its own', async () => {
    roles.set('acme/camille', 'admin')
    let owner = (await signIn('octocat')).cookie!
    let admin = (await signIn('camille')).cookie!
    assert.equal((await membership('camille', acme))!.role, 'admin')
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })
    let guestCookie = (await signIn('guest')).cookie!
    let [invitation] = await database.sql<{ id: string }[]>`select id from invitations`
    await post(guestCookie, `/invitations/${invitation!.id}/accept`)
    let guest = (await membership('guest', acme))!

    assert.equal((await post(admin, `/settings/members/${guest.id}/role`, { role: 'admin' })).headers.get('Location'), '/settings/members?notice=role')
    assert.equal((await membership('guest', acme))!.role, 'admin')
    assert.equal((await post(admin, `/settings/members/${guest.id}/role`, { role: 'owner' })).headers.get('Location'), '/settings/members?notice=not_owner')
    let octocat = (await membership('octocat', acme))!
    assert.equal((await post(admin, `/settings/members/${octocat.id}/role`, { role: 'admin' })).headers.get('Location'), '/settings/members?notice=not_owner')
    // GitHub decides camille, a member from GitHub: an owner gives her owner, not member.
    let camille = (await membership('camille', acme))!
    assert.equal((await post(owner, `/settings/members/${camille.id}/role`, { role: 'member' })).headers.get('Location'), '/settings/members?notice=github')
    assert.equal((await post(owner, `/settings/members/${camille.id}/remove`)).headers.get('Location'), '/settings/members?notice=github')
    assert.equal((await post(owner, `/settings/members/${camille.id}/role`, { role: 'owner' })).headers.get('Location'), '/settings/members?notice=role')
    assert.equal((await membership('camille', acme))!.role, 'owner')
    // A member posts the form of an admin: 403.
    roles.set('acme/camille', 'member')
    let reader = (await signIn('camille')).cookie!
    assert.equal((await membership('camille', acme))!.role, 'member', 'GitHub demoted her: owner holds only while GitHub says admin')
    assert.equal((await post(reader, `/settings/members/${guest.id}/remove`)).status, 403)
    // The admin removes guest, who loses the access at the next request.
    assert.equal((await post(admin, `/settings/members/${guest.id}/remove`)).status, 403, 'camille is a member now')
    assert.equal((await post(owner, `/settings/members/${guest.id}/remove`)).headers.get('Location'), '/settings/members?notice=removed')
    assert.equal((await request('/', guestCookie)).status, 303)
  })

  it('the last owner: no demotion, removal or departure leaves the org without an active owner', async () => {
    let owner = (await signIn('octocat')).cookie!
    let octocat = (await membership('octocat', acme))!
    assert.equal((await post(owner, `/settings/members/${octocat.id}/role`, { role: 'admin' })).headers.get('Location'), '/settings/members?notice=last_owner')
    assert.equal((await membership('octocat', acme))!.role, 'owner')
    let page = await (await request('/settings/members', owner)).text()
    assert.doesNotMatch(page, new RegExp(`action="/settings/members/${octocat.id}/role"`), 'no role form for the last owner')

    // An invited owner leaves only when another active owner stays.
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'admin' })
    let guestCookie = (await signIn('guest')).cookie!
    let [invitation] = await database.sql<{ id: string }[]>`select id from invitations`
    await post(guestCookie, `/invitations/${invitation!.id}/accept`)
    let guest = (await membership('guest', acme))!
    await post(owner, `/settings/members/${guest.id}/role`, { role: 'owner' })
    // octocat goes quiet for 31 days: guest is the only active owner.
    await database.sql`update memberships set checked_at = now() - interval '31 days' where id = ${octocat.id}`
    await database.sql`update users set last_sign_in_at = now() - interval '31 days' where login = 'octocat'`
    assert.equal((await post(guestCookie, '/settings/members/leave')).headers.get('Location'), '/settings/members?notice=last_owner')
    await database.sql`update memberships set checked_at = now() where id = ${octocat.id}`
    assert.equal((await post(guestCookie, '/settings/members/leave')).headers.get('Location'), '/')
    assert.equal(await membership('guest', acme), null)
  })

  it('two owners who demote each other at the same time leave one owner', async () => {
    let owner = (await signIn('octocat')).cookie!
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'admin' })
    let guestCookie = (await signIn('guest')).cookie!
    let [invitation] = await database.sql<{ id: string }[]>`select id from invitations`
    await post(guestCookie, `/invitations/${invitation!.id}/accept`)
    let guest = (await membership('guest', acme))!
    await post(owner, `/settings/members/${guest.id}/role`, { role: 'owner' })
    let octocat = (await membership('octocat', acme))!
    let [octocatUser, guestUser] = await database.sql<{ id: string }[]>`select id from users where login in ('octocat', 'guest') order by login = 'guest'`
    let now = Date.now()
    let outcomes = await Promise.all([
      store.change({ orgId: acme, actorUserId: octocatUser!.id, membershipId: guest.id, change: { kind: 'role', role: 'admin' }, now }),
      store.change({ orgId: acme, actorUserId: guestUser!.id, membershipId: octocat.id, change: { kind: 'role', role: 'admin' }, now }),
    ])
    assert.deepEqual(outcomes.map((o) => o.ok).sort(), [false, true])
    let [owners] = await database.sql<{ n: number }[]>`select count(*)::int as n from memberships where org_id = ${acme} and role = 'owner'`
    assert.equal(owners!.n, 1)
  })

  it('accepting an invitation keeps a membership that exists already as it is, its role and its source', async () => {
    roles.set('acme/camille', 'admin')
    let owner = (await signIn('octocat')).cookie!
    await signIn('camille')
    assert.equal((await membership('camille', acme))!.role, 'admin')
    // An invitation made before camille joined from GitHub (the screen refuses one for a member).
    let [inviter] = await database.sql<{ id: string }[]>`select id from users where login = 'octocat'`
    let [invitation] = await database.sql<{ id: string }[]>`
      insert into invitations (org_id, github_id, github_login, role, inviter_id, expires_at)
      values (${acme}, 2, 'camille', 'member', ${inviter!.id}, now() + interval '7 days') returning id`
    let accepted = await store.accept(invitation!.id, { id: (await database.sql<{ id: string }[]>`select id from users where login = 'camille'`)[0]!.id, githubId: 2 })
    assert.deepEqual(accepted, { orgId: acme, role: 'admin' })
    // Still from GitHub: GitHub still demotes or ends it.
    assert.deepEqual({ ...(await membership('camille', acme)), id: undefined }, { id: undefined, role: 'admin', source: 'github' })
    assert.equal((await database.sql`select status from invitations where id = ${invitation!.id}`)[0]!.status, 'accepted')
    assert.ok(owner)
  })

  it('a check of GitHub that read the role before an owner changed it keeps the change', async () => {
    roles.set('acme/camille', 'admin')
    let owner = (await signIn('octocat')).cookie!
    await signIn('camille')
    let camille = (await membership('camille', acme))!
    assert.equal(camille.role, 'admin')
    let [user] = await database.sql<{ id: string }[]>`select id from users where login = 'camille'`
    // The owner gives camille the owner role; a check that read `admin` before writes after it.
    await post(owner, `/settings/members/${camille.id}/role`, { role: 'owner' })
    assert.equal(await saveGitHubRole(createAuthStore(database.sql), user!.id, acme, 'admin', 'admin', Date.now()), 'owner')
    assert.equal((await membership('camille', acme))!.role, 'owner')
  })

  it('a check of GitHub never brings back a membership removed while it ran; a sign-in joins', async () => {
    let owner = (await signIn('octocat')).cookie!
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })
    let guestCookie = (await signIn('guest')).cookie!
    let [invitation] = await database.sql<{ id: string }[]>`select id from invitations`
    await post(guestCookie, `/invitations/${invitation!.id}/accept`)
    let guest = (await membership('guest', acme))!
    let [user] = await database.sql<{ id: string }[]>`select id from users where login = 'guest'`
    // A check read the membership, then the owner removed it, then the check writes.
    await post(owner, `/settings/members/${guest.id}/remove`)
    let auth = createAuthStore(database.sql)
    assert.equal(await saveGitHubRole(auth, user!.id, acme, 'member', 'admin', Date.now()), null)
    assert.equal(await membership('guest', acme), null)
    // A person who joins from GitHub (nothing read before) gets a membership.
    assert.equal(await saveGitHubRole(auth, user!.id, acme, null, 'member', Date.now()), 'member')
  })

  /** guest invited to acme with `role`, signed in, accepted; returns guest's cookie and membership. */
  async function invitedGuest(owner: string, role: 'member' | 'admin', login: keyof typeof PEOPLE = 'guest') {
    await post(owner, '/settings/members/invite', { login, role })
    let cookie = (await signIn(login)).cookie!
    let [invitation] = await database.sql<{ id: string }[]>`select i.id from invitations i where i.github_login = ${login} and i.status = 'pending' and i.org_id = ${acme}`
    await post(cookie, `/invitations/${invitation!.id}/accept`)
    return { cookie, membership: (await membership(login, acme))! }
  }

  it('an owner from an invitation never demotes a GitHub admin, and a GitHub admin always takes the owner role back', async () => {
    let owner = (await signIn('octocat')).cookie!
    let guest = await invitedGuest(owner, 'admin')
    await post(owner, `/settings/members/${guest.membership.id}/role`, { role: 'owner' })
    let octocat = (await membership('octocat', acme))!
    // guest, owner from an invitation, tries to demote octocat, whom GitHub counts as an admin.
    assert.equal((await post(guest.cookie, `/settings/members/${octocat.id}/role`, { role: 'admin' })).headers.get('Location'), '/settings/members?notice=github_admin')
    assert.equal((await post(guest.cookie, `/settings/members/${octocat.id}/remove`)).headers.get('Location'), '/settings/members?notice=github')
    assert.equal((await membership('octocat', acme))!.role, 'owner')
    // An owner role lost another way (a release before this rule): octocat takes it back, after GitHub says admin.
    await database.sql`update memberships set role = 'admin' where id = ${octocat.id}`
    let page = await (await request('/settings/members', owner)).text()
    assert.match(page, /action="\/settings\/members\/reclaim"/)
    assert.equal((await post(owner, '/settings/members/reclaim')).headers.get('Location'), '/settings/members?notice=reclaimed')
    assert.equal((await membership('octocat', acme))!.role, 'owner')
    // Now an owner from GitHub, octocat removes guest.
    assert.equal((await post(owner, `/settings/members/${guest.membership.id}/remove`)).headers.get('Location'), '/settings/members?notice=removed')
    // A take-back needs GitHub to say admin now: camille, a member on GitHub, cannot.
    let camille = (await signIn('camille')).cookie!
    assert.doesNotMatch(await (await request('/settings/members', camille)).text(), /\/settings\/members\/reclaim/)
    assert.equal((await post(camille, '/settings/members/reclaim')).headers.get('Location'), '/settings/members?notice=not_github_admin')
    // And octocat, demoted on GitHub in between, cannot either.
    await database.sql`update memberships set role = 'admin' where id = ${octocat.id}`
    roles.set('acme/octocat', 'member')
    assert.equal((await post(owner, '/settings/members/reclaim')).headers.get('Location'), '/settings/members?notice=not_github_admin')
  })

  it('a person with roles in two orgs acts in the org of the session with the role they have there', async () => {
    let owner = (await signIn('octocat')).cookie!
    let guest = await invitedGuest(owner, 'member')
    // other: owner of globex from GitHub, invited as a member of acme; the session is on acme after the acceptance.
    await signIn('other')
    let other = await invitedGuest(owner, 'member', 'other')
    assert.match(await (await request('/', other.cookie)).text(), /<span class="org-menu-name">acme<\/span>/)
    assert.equal((await post(other.cookie, `/settings/members/${guest.membership.id}/role`, { role: 'admin' })).status, 403)
    assert.equal((await post(other.cookie, `/settings/members/${guest.membership.id}/remove`)).status, 403)
    assert.equal((await membership('guest', acme))!.role, 'member')
  })

  it('a member cannot cancel an invitation, even by the store', async () => {
    let owner = (await signIn('octocat')).cookie!
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })
    let [invitation] = await database.sql<{ id: string }[]>`select id from invitations`
    let member = (await signIn('camille')).cookie!
    assert.equal((await post(member, `/settings/invitations/${invitation!.id}/cancel`)).status, 403)
    let [camille] = await database.sql<{ id: string }[]>`select id from users where login = 'camille'`
    assert.equal(await store.cancel(acme, camille!.id, invitation!.id), 'not_admin')
    assert.equal(await store.invite({ orgId: acme, githubId: 4, githubLogin: 'other', role: 'member', inviterId: camille!.id }), 'not_admin')
    assert.equal((await database.sql`select status from invitations`)[0]!.status, 'pending')
  })

  it('writes who changed what in org_audit, and the target in the log', async () => {
    let owner = (await signIn('octocat')).cookie!
    let guest = await invitedGuest(owner, 'member')
    let lines: string[] = []
    let stdout = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => lines.push(String(chunk)) > 0) as typeof process.stdout.write
    try {
      await post(owner, `/settings/members/${guest.membership.id}/remove`)
    } finally {
      process.stdout.write = stdout
    }
    let changed = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'members.changed')
    assert.equal(changed.target, 'guest')
    let audit = await database.sql`select actor_login, action, target_login, role_before, role_after, org_name from org_audit order by created_at, action`
    assert.deepEqual(audit.map((r) => ({ ...r })), [
      { actor_login: 'octocat', action: 'invite', target_login: 'guest', role_before: null, role_after: 'member', org_name: 'acme' },
      { actor_login: 'guest', action: 'accept', target_login: 'guest', role_before: null, role_after: 'member', org_name: 'acme' },
      { actor_login: 'octocat', action: 'remove', target_login: 'guest', role_before: 'member', role_after: null, org_name: 'acme' },
    ])
  })

  it('caps the pending invitations of an org, and cancels those of a person who leaves the org', async () => {
    let owner = (await signIn('octocat')).cookie!
    let admin = await invitedGuest(owner, 'admin')
    await post(admin.cookie, '/settings/members/invite', { login: 'other', role: 'member' })
    assert.equal((await database.sql`select status from invitations where github_login = 'other'`)[0]!.status, 'pending')
    // guest, who invited other, is removed: the invitation goes with them.
    await post(owner, `/settings/members/${admin.membership.id}/remove`)
    assert.equal((await database.sql`select status from invitations where github_login = 'other'`)[0]!.status, 'canceled')
    // 50 pending invitations: the 51st is refused.
    let [octocat] = await database.sql<{ id: string }[]>`select id from users where login = 'octocat'`
    for (let n = 0; n < 50; n++) {
      await database.sql`insert into invitations (org_id, github_id, github_login, role, inviter_id, expires_at)
        values (${acme}, ${1000 + n}, ${`person-${n}`}, 'member', ${octocat!.id}, now() + interval '1 day')`
    }
    assert.equal((await post(owner, '/settings/members/invite', { login: 'other', role: 'member' })).headers.get('Location'), '/settings/members?notice=too_many')
  })

  it('a member sees the members and the invitations, with no form', async () => {
    let owner = (await signIn('octocat')).cookie!
    await post(owner, '/settings/members/invite', { login: 'guest', role: 'member' })
    let member = (await signIn('camille')).cookie!
    let html = await (await request('/settings/members', member)).text()
    assert.match(html, /<a href="\/users\/octocat" class="member-login">octocat<\/a>/)
    assert.match(html, /<span class="member-login">guest<\/span>/)
    assert.doesNotMatch(html, /\/role"|\/remove"|\/cancel"|\/invite"/)
    assert.match(html, /Read only/)
  })
})
