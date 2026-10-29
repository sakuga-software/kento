import { createOAuthProvider } from 'remix/auth'
import type { SessionStorage } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'

import type { AuthDependencies } from '../ui/pages.tsx'
import type { GitHubProfile, LookupRole, OrgRole } from './github.ts'
import { readSessionAuth } from './session-storage.ts'
import type { AuthStore, MembershipRow, OrgRow, UserRow } from './store.ts'

export const ORG: OrgRow = { id: 'org-1', githubInstallationId: 11, githubAccountId: 900, login: 'sakuga-software' }
export const OTHER_ORG: OrgRow = { id: 'org-2', githubInstallationId: 12, githubAccountId: 901, login: 'orchard' }

export const ALEX: GitHubProfile = { id: 1, login: 'alex', name: 'Alex', avatarUrl: null }
export const CAMILLE: GitHubProfile = { id: 2, login: 'camille', name: null, avatarUrl: null }
export const STRANGER: GitHubProfile = { id: 3, login: 'stranger', name: null, avatarUrl: null }

/**
 * The sign-in with a fake GitHub, a store in memory and a clock that the test moves. `roles` is
 * what GitHub answers, by org login then person login: a role, null (not a member), or 'error'.
 */
export function fakeAuth(options: { orgs?: OrgRow[]; publicUrl?: string } = {}) {
  let orgs = options.orgs ?? [ORG]
  let clock = { now: Date.parse('2026-10-28T12:00:00Z') }
  let roles = new Map<string, OrgRole | null | 'error'>()
  let users = new Map<string, UserRow>()
  let memberships = new Map<string, { role: OrgRole; checkedAt: Date }>()
  let lookups: string[] = []
  let profile: GitHubProfile = ALEX

  let store: AuthStore = {
    async upsertUser(p) {
      let existing = [...users.values()].find((u) => u.githubId === p.id)
      let user: UserRow = { id: existing?.id ?? `user-${p.id}`, githubId: p.id, login: p.login, name: p.name, avatarUrl: p.avatarUrl }
      users.set(user.id, user)
      return user
    },
    async findUser(id) {
      return users.get(id) ?? null
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

  let lookupRole: LookupRole = async (org, person) => {
    lookups.push(`${org.login}/${person.login}`)
    let role = roles.get(`${org.login}/${person.login}`) ?? null
    if (role === 'error') throw new Error('GitHub answered 502')
    return role
  }

  let provider = createOAuthProvider<GitHubProfile, 'github'>('github', {
    async createAuthorizationURL(transaction) {
      return new URL(`https://github.test/login/oauth/authorize?state=${transaction.state}`)
    },
    async handleCallback(context) {
      if (context.url.searchParams.get('code') !== 'good') throw new Error('GitHub refused the code: 400 bad_verification_code')
      return {
        provider: 'github',
        account: { provider: 'github', providerAccountId: String(profile.id) },
        profile,
        tokens: { accessToken: 'gho_user_token' },
      }
    },
  })

  let deps: AuthDependencies = {
    publicUrl: new URL(options.publicUrl ?? 'https://review.test'),
    sessionSecrets: ['a-session-secret-for-the-tests-0123456789'],
    sessionStorage: signInSessionsOnly(createMemorySessionStorage()),
    provider,
    store,
    lookupRole,
    now: () => clock.now,
  }

  return {
    deps,
    clock,
    users,
    memberships,
    lookups,
    /** What GitHub answers for the role of `person` in `org`. */
    setRole(org: OrgRow, person: GitHubProfile, role: OrgRole | null | 'error') {
      roles.set(`${org.login}/${person.login}`, role)
    },
    /** The account that the next sign-in comes back with. */
    as(next: GitHubProfile) {
      profile = next
    },
  }
}

/** The `name=value` of the first Set-Cookie of a response, for the Cookie header of the next request. */
export function cookieOf(response: Response, name: string): string | null {
  for (let header of response.headers.getSetCookie()) {
    let pair = header.split(';')[0]!
    if (pair.startsWith(`${name}=`)) return pair
  }
  return null
}

/**
 * A storage in memory with the rule of the Postgres one: only a signed-in session or a sign-in on
 * its way is kept, so a visit sets no cookie. The tests against Postgres prove the real one.
 */
function signInSessionsOnly(inner: SessionStorage): SessionStorage {
  return {
    read: (cookie) => inner.read(cookie),
    async save(session) {
      if (!session.destroyed && !readSessionAuth(session) && !session.has('__auth') && !session.deleteId) {
        return null
      }
      return inner.save(session)
    },
  }
}
