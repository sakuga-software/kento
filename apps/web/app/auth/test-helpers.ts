import { memoryAdapter } from 'better-auth/adapters/memory'

import type { AuthDependencies } from '../ui/pages.tsx'
import { createKentoAuth, type AuthDatabase } from './better-auth.ts'
import type { GitHubOAuth, GitHubProfile, InstallationAccount, LookupRole, OrgRole } from './github.ts'
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

/** The name of the session cookie over plain HTTP (the tests of the routes run on http://localhost). */
export const SESSION_COOKIE = 'kento_session'

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
  let roles = new Map<string, OrgRole | null | 'error'>()
  let memberships = new Map<string, { role: OrgRole; checkedAt: Date }>()
  let lookups: string[] = []
  let profile: GitHubProfile = OCTOCAT
  // The tables of Better Auth, in memory, under the model names of Kentō.
  let tables: Record<string, Record<string, unknown>[]> = { users: [], accounts: [], sessions: [], verifications: [] }
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
      let rows: MembershipRow[] = []
      for (let org of orgs) {
        let m = memberships.get(`${userId}/${org.id}`)
        if (m) rows.push({ org, role: m.role, checkedAt: m.checkedAt })
      }
      return rows
    },
    async saveMembership(userId, orgId, role) {
      memberships.set(`${userId}/${orgId}`, { role, checkedAt: new Date(clock.now) })
    },
    async deleteMembership(userId, orgId) {
      memberships.delete(`${userId}/${orgId}`)
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
    redirectUri: new URL('/auth/github/callback', options.publicUrl ?? 'http://localhost'),
    async exchangeCode({ code }) {
      if (code !== 'good') throw new Error('GitHub refused the code: 400 bad_verification_code')
      return { accessToken: 'gho_user_token' }
    },
    async readProfile() {
      return profile
    },
  }

  let publicUrl = new URL(options.publicUrl ?? 'http://localhost')
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
    /** The users that Better Auth wrote. */
    get users() {
      return tables.users!
    },
    /** The id of the user of a GitHub account, once it signed in. */
    userIdOf(person: GitHubProfile): string {
      let row = tables.users!.find((u) => Number(u.githubId) === person.id)
      if (!row) throw new Error(`${person.login} never signed in`)
      return String(row.id)
    },
    /** What GitHub answers for the role of `person` in the account of an installation (the first of `org`). */
    setRole(org: OrgRow | InstallationAccount, person: GitHubProfile, role: OrgRole | null | 'error') {
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
