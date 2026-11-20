import { memoryAdapter } from 'better-auth/adapters/memory'

import type { AuthDependencies } from '../ui/pages.tsx'
import { createKentoAuth, type AuthDatabase } from './better-auth.ts'
import type { MembershipSource, OrgRole } from '../db/schema.ts'
import type { GitHubOAuth, GitHubProfile, GitHubRole, InstallationAccount, LookupRole } from './github.ts'
import type { AuthStore, MembershipRow, OrgRow, UserRow } from './store.ts'

export const ORG: OrgRow = {
  id: 'org-1',
  name: 'sakuga-software',
  installations: [{ id: 'installation-1', githubInstallationId: 11, githubAccountId: 900, login: 'sakuga-software' }],
}
export const OTHER_ORG: OrgRow = {
  id: 'org-2',
  name: 'orchard',
  installations: [{ id: 'installation-2', githubInstallationId: 12, githubAccountId: 901, login: 'orchard' }],
}

export const OCTOCAT: GitHubProfile = { id: 1, login: 'octocat', name: 'Octocat', avatarUrl: null }
export const CAMILLE: GitHubProfile = { id: 2, login: 'camille', name: null, avatarUrl: null }
export const STRANGER: GitHubProfile = { id: 3, login: 'stranger', name: null, avatarUrl: null }

/** The name of the session cookie of Better Auth on the https service of the tests. */
export const SESSION_COOKIE = '__Host-kento_session'

/**
 * The sign-in with a fake GitHub, Better Auth on a store in memory, and a clock that the test moves.
 * `roles` is what GitHub answers, by the login of the account of an installation then person login:
 * a role, null (not a member), or 'error'.
 */
export function fakeAuth(options: { orgs?: OrgRow[]; publicUrl?: string } = {}) {
  let orgs = options.orgs ?? [ORG]
  // The clock starts now: Better Auth checks the end of a session and of a sign-in on the real
  // clock, and Kentō on this one.
  let clock = { now: Date.now() }
  let roles = new Map<string, GitHubRole | null | 'error'>()
  let lookups: string[] = []
  /** The code exchanges that the fake GitHub received, as GitHub checks them. */
  let exchanges: { code: string; codeVerifier: string | null; redirectUri: string }[] = []
  let profile: GitHubProfile = OCTOCAT
  // The tables of Better Auth, in memory, under the model names of Kentō.
  let tables: Record<string, Record<string, unknown>[]> = {
    users: [],
    accounts: [],
    sessions: [],
    verifications: [],
    orgs: orgs.map((org) => ({ id: org.id, name: org.name, slug: org.name.toLowerCase(), createdAt: new Date() })),
    memberships: [],
  }
  type Row = { id: string; userId: string; orgId: string; role: OrgRole; source: MembershipSource; checkedAt: Date; createdAt: Date }
  let rows = () => tables.memberships as unknown as Row[]
  /** The memberships, by `<user id>/<org id>`, as the tests read them. */
  let memberships = {
    get(key: string) {
      return rows().find((m) => `${m.userId}/${m.orgId}` === key)
    },
    get size() {
      return rows().length
    },
  }
  // `failing`: the table of the sessions throws, as a database that does not answer.
  let failing = false
  let sessionRows = tables.sessions!
  Object.defineProperty(tables, 'sessions', {
    get() {
      if (failing) throw new Error('connect ECONNREFUSED')
      return sessionRows
    },
    set(rows: Record<string, unknown>[]) {
      sessionRows = rows
    },
  })
  let database: AuthDatabase = memoryAdapter(tables) as unknown as AuthDatabase

  function userRow(row: Record<string, unknown>): UserRow {
    return {
      id: String(row.id),
      githubId: Number(row.githubId),
      login: String(row.login),
      name: (row.name as string | null | undefined) ?? null,
      avatarUrl: (row.avatarUrl as string | null | undefined) ?? null,
    }
  }

  let store: AuthStore = {
    async findUser(id) {
      let row = tables.users!.find((u) => u.id === id)
      return row ? userRow(row) : null
    },
    async touchSignIn() {},
    async setActiveOrg(sessionId, orgId) {
      let row = tables.sessions!.find((s) => s.id === sessionId)
      if (row) row.activeOrganizationId = orgId
    },
    async deleteSession(sessionId) {
      tables.sessions = tables.sessions!.filter((s) => s.id !== sessionId)
    },
    async sweep() {
      return 0
    },
    async activeOrgs() {
      return orgs
    },
    async memberships(userId) {
      let found: MembershipRow[] = []
      for (let org of orgs) {
        let m = memberships.get(`${userId}/${org.id}`)
        if (m) found.push({ org, role: m.role, source: m.source, checkedAt: new Date(m.checkedAt) })
      }
      return found
    },
    async saveMembership(userId, orgId, role, source = 'github') {
      let m = memberships.get(`${userId}/${orgId}`)
      if (m) {
        Object.assign(m, {
          role: m.source === 'invitation' && source === 'github' ? m.role : role,
          source: source === 'invitation' ? 'invitation' : m.source,
          checkedAt: new Date(clock.now),
        })
        return m.role
      }
      rows().push({ id: `membership-${rows().length + 1}`, userId, orgId, role, source, checkedAt: new Date(clock.now), createdAt: new Date(clock.now) })
      return role
    },
    async invitedOrgs(githubId) {
      let user = tables.users!.find((u) => Number(u.githubId) === githubId)
      return user ? orgs.filter((org) => rows().some((m) => m.userId === user.id && m.orgId === org.id && m.source === 'invitation')) : []
    },
    async hasOwner(orgId, since) {
      return rows().some((m) => m.orgId === orgId && m.role === 'owner' && new Date(m.checkedAt as Date).getTime() >= since.getTime())
    },
    async withOrgLock(_orgId, work) {
      return work(store)
    },
    async deleteMembership(userId, orgId) {
      tables.memberships = rows().filter((m) => !(m.userId === userId && m.orgId === orgId))
    },
  }

  let lookupRole: LookupRole = async (installation, person) => {
    lookups.push(`${installation.login}/${person.login}`)
    let role = roles.get(`${installation.login}/${person.login}`) ?? null
    if (role === 'error') throw new Error('GitHub answered 502')
    return role
  }

  let github: GitHubOAuth = {
    clientId: 'Iv1.test',
    clientSecret: 'client-secret-for-the-tests',
    authorizationUrl: 'https://github.test/login/oauth/authorize',
    tokenUrl: 'https://github.test/login/oauth/access_token',
    redirectUri: new URL('/auth/github/callback', options.publicUrl ?? 'https://review.test'),
    async exchangeCode(exchange) {
      exchanges.push(exchange)
      if (exchange.code !== 'good') throw new Error('GitHub refused the code: 400 bad_verification_code')
      return { accessToken: 'gho_user_token' }
    },
    async readProfile() {
      return profile
    },
  }

  let publicUrl = new URL(options.publicUrl ?? 'https://review.test')
  let sessionSecrets = ['a-session-secret-for-the-tests-0123456789']
  let deps: AuthDependencies = {
    publicUrl,
    sessionSecrets,
    auth: createKentoAuth({ database, publicUrl, secret: sessionSecrets[0]!, github, store, lookupRole, now: () => clock.now }),
    store,
    lookupRole,
    now: () => clock.now,
  }

  return {
    deps,
    clock,
    tables,
    memberships,
    lookups,
    exchanges,
    /** The users that Better Auth wrote. */
    get users() {
      return tables.users!
    },
    /** The sessions cannot be read or written from now on, until `failSessions(false)`. */
    failSessions(on: boolean) {
      failing = on
    },
    /** The id of the user of a GitHub account, once it signed in. */
    userIdOf(person: GitHubProfile): string {
      let row = tables.users!.find((u) => Number(u.githubId) === person.id)
      if (!row) throw new Error(`${person.login} never signed in`)
      return String(row.id)
    },
    /** What GitHub answers for the role of `person` in the account of an installation (the first of `org`). */
    setRole(org: OrgRow | InstallationAccount, person: GitHubProfile, role: GitHubRole | null | 'error') {
      let login = 'installations' in org ? org.installations[0]!.login : org.login
      roles.set(`${login}/${person.login}`, role)
    },
    /** The account that the next sign-in comes back with. */
    as(next: GitHubProfile) {
      profile = next
    },
  }
}

/** Every `name=value` that a response sets and does not clear, as one Cookie header. */
export function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .filter((header) => !/;\s*max-age=0\b/i.test(header))
    .map((header) => header.split(';')[0]!)
    .join('; ')
}

/** The `name=value` of the first Set-Cookie of a response, for the Cookie header of the next request. */
export function cookieOf(response: Response, name: string): string | null {
  for (let header of response.headers.getSetCookie()) {
    let pair = header.split(';')[0]!
    if (pair.startsWith(`${name}=`)) return pair
  }
  return null
}
