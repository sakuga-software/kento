import { errorMessage, log } from '../log.ts'
import type { GitHubProfile, LookupRole, OrgRole } from './github.ts'
import type { AuthStore, MembershipRow, OrgRow, UserRow } from './store.ts'

/** A role read from GitHub is read again after this. A role removed on GitHub ends within it. */
export const ROLE_TTL_MS = 10 * 60 * 1000
/** While GitHub does not answer, a role read before stays valid this long, then the access ends. */
export const ROLE_GRACE_MS = 60 * 60 * 1000

export type SignInDecision =
  /**
   * `unconfirmed`: the orgs where GitHub failed. Their memberships stay as they were, with their old
   * `checked_at`, so the first request asks GitHub again.
   */
  | { kind: 'allowed'; roles: { org: OrgRow; role: OrgRole }[]; unconfirmed: OrgRow[] }
  /** GitHub counts the person in none of the orgs of the App. */
  | { kind: 'refused' }
  /** GitHub failed for every org where the answer could have let the person in. */
  | { kind: 'unknown' }

/** Asks GitHub for the role of a GitHub account in every org of the App, before anything is written. */
export async function decideSignIn(
  store: AuthStore,
  lookupRole: LookupRole,
  profile: GitHubProfile,
): Promise<SignInDecision> {
  let orgs = await store.activeOrgs()
  let results = await Promise.all(
    orgs.map(async (org) => {
      try {
        return { org, role: await lookupRole(org, { githubId: profile.id, login: profile.login }), failed: false }
      } catch (error) {
        log('warn', 'auth.role_check_failed', { org: org.login, login: profile.login, error: errorMessage(error) })
        return { org, role: null, failed: true }
      }
    }),
  )
  let roles = results.flatMap(({ org, role }) => (role ? [{ org, role }] : []))
  if (roles.length > 0) {
    return { kind: 'allowed', roles, unconfirmed: results.flatMap(({ org, failed }) => (failed ? [org] : [])) }
  }
  return results.some((result) => result.failed) ? { kind: 'unknown' } : { kind: 'refused' }
}

/**
 * Writes the roles of a sign-in, and forgets the orgs where GitHub answered that the person is not
 * a member. An org where GitHub failed (`unconfirmed`) keeps its membership as it was.
 */
export async function saveSignInRoles(
  store: AuthStore,
  user: UserRow,
  roles: { org: OrgRow; role: OrgRole }[],
  unconfirmed: OrgRow[] = [],
) {
  let kept = new Set([...roles, ...unconfirmed.map((org) => ({ org }))].map(({ org }) => org.id))
  for (let membership of await store.memberships(user.id)) {
    if (!kept.has(membership.org.id)) await store.deleteMembership(user.id, membership.org.id)
  }
  for (let { org, role } of roles) await store.saveMembership(user.id, org.id, role)
}

/**
 * The memberships of a signed-in person, each one read again from GitHub when it is older than
 * `ROLE_TTL_MS`. A membership that GitHub removed is deleted. One that GitHub cannot confirm keeps
 * its row and its old `checked_at`, so the next request asks GitHub again; it counts until
 * `ROLE_GRACE_MS`, then it is left out of `memberships` and counted in `unconfirmed`: the access
 * fails closed, and comes back as soon as GitHub answers.
 */
export async function currentMemberships(
  store: AuthStore,
  lookupRole: LookupRole,
  user: UserRow,
  now: number,
): Promise<{ memberships: MembershipRow[]; unconfirmed: number }> {
  let memberships = await store.memberships(user.id)
  let current: MembershipRow[] = []
  let unconfirmed = 0
  for (let membership of memberships) {
    let age = now - membership.checkedAt.getTime()
    if (age < ROLE_TTL_MS) {
      current.push(membership)
      continue
    }
    try {
      let role = await lookupRole(membership.org, { githubId: user.githubId, login: user.login })
      if (role === null) {
        await store.deleteMembership(user.id, membership.org.id)
        log('info', 'auth.access_lost', { login: user.login, org: membership.org.login })
        continue
      }
      await store.saveMembership(user.id, membership.org.id, role)
      current.push({ ...membership, role, checkedAt: new Date(now) })
    } catch (error) {
      log('warn', 'auth.role_check_failed', { org: membership.org.login, login: user.login, error: errorMessage(error) })
      if (age < ROLE_GRACE_MS) current.push(membership)
      else unconfirmed++
    }
  }
  return { memberships: current, unconfirmed }
}
