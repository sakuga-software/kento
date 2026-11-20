import { errorMessage, log } from '../log.ts'
import type { OrgRole } from '../db/schema.ts'
import type { GitHubProfile, GitHubRole, LookupRole } from './github.ts'
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
  | { kind: 'allowed'; roles: { org: OrgRow; role: GitHubRole }[]; unconfirmed: OrgRow[] }
  /** GitHub counts the person in none of the orgs of the App. */
  | { kind: 'refused' }
  /** GitHub failed for every org where the answer could have let the person in. */
  | { kind: 'unknown' }

/**
 * KNT-150. The role of a person in an org, from GitHub: the highest role that the accounts of its
 * installations give (`admin` over `member`). Null when every installation answers "not a member".
 * Throws when none gives a role and GitHub failed for at least one: the answer is unknown.
 */
export async function orgRole(
  lookupRole: LookupRole,
  org: OrgRow,
  person: { githubId: number; login: string },
): Promise<GitHubRole | null> {
  // The store gives only orgs with an installation that is not suspended. An org without one has no
  // account to ask: the answer is unknown, never "not a member".
  if (org.installations.length === 0) throw new Error(`the org ${org.name} has no installation to ask GitHub`)
  let role: GitHubRole | null = null
  let failure: unknown = null
  for (let installation of org.installations) {
    try {
      let found = await lookupRole(installation, person)
      if (found === 'admin') return 'admin'
      role = found ?? role
    } catch (error) {
      failure ??= error
    }
  }
  if (role === null && failure !== null) throw failure
  return role
}

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
        return { org, role: await orgRole(lookupRole, org, { githubId: profile.id, login: profile.login }), failed: false }
      } catch (error) {
        log('warn', 'auth.role_check_failed', { org: org.name, login: profile.login, error: errorMessage(error) })
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
 * KNT-150. The role in Kentō of a membership that GitHub confirms with `github`: GitHub decides
 * between `admin` and `member`; an owner, given in Kentō, stays an owner.
 */
export function roleFromGitHub(current: OrgRole | null, github: GitHubRole): OrgRole {
  return current === 'owner' ? 'owner' : github
}

/**
 * Writes the roles of a sign-in, and forgets the orgs where GitHub answered that the person is not
 * a member. An org where GitHub failed (`unconfirmed`) keeps its membership as it was. A membership
 * from an invitation is Kentō's: GitHub neither changes nor removes it.
 *
 * A person that GitHub counts in an org where they are not a member yet joins it. The first admin
 * on GitHub of an org that has no owner becomes its owner: a new installation gets one.
 */
export async function saveSignInRoles(
  store: AuthStore,
  user: UserRow,
  roles: { org: OrgRow; role: GitHubRole }[],
  unconfirmed: OrgRow[] = [],
) {
  let kept = new Set([...roles, ...unconfirmed.map((org) => ({ org }))].map(({ org }) => org.id))
  let existing = new Map((await store.memberships(user.id)).map((m) => [m.org.id, m]))
  for (let membership of existing.values()) {
    if (membership.source === 'github' && !kept.has(membership.org.id)) await store.deleteMembership(user.id, membership.org.id)
  }
  for (let { org, role } of roles) {
    let membership = existing.get(org.id)
    if (membership?.source === 'invitation') continue
    let next = membership
      ? roleFromGitHub(membership.role, role)
      : role === 'admin' && !(await store.hasOwner(org.id))
        ? 'owner'
        : role
    await store.saveMembership(user.id, org.id, next, 'github')
  }
}

/**
 * The memberships of a signed-in person. One from GitHub is read again when it is older than
 * `ROLE_TTL_MS`: a membership that GitHub removed is deleted. One that GitHub cannot confirm keeps
 * its row and its old `checked_at`, so the next request asks GitHub again; it counts until
 * `ROLE_GRACE_MS`, then it is left out of `memberships` and counted in `unconfirmed`: the access
 * fails closed, and comes back as soon as GitHub answers. One from an invitation is Kentō's alone.
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
    if (membership.source === 'invitation' || age < ROLE_TTL_MS) {
      current.push(membership)
      continue
    }
    try {
      let github = await orgRole(lookupRole, membership.org, { githubId: user.githubId, login: user.login })
      if (github === null) {
        await store.deleteMembership(user.id, membership.org.id)
        log('info', 'auth.access_lost', { login: user.login, org: membership.org.name })
        continue
      }
      let role = roleFromGitHub(membership.role, github)
      await store.saveMembership(user.id, membership.org.id, role, 'github')
      current.push({ ...membership, role, checkedAt: new Date(now) })
    } catch (error) {
      log('warn', 'auth.role_check_failed', { org: membership.org.name, login: user.login, error: errorMessage(error) })
      if (age < ROLE_GRACE_MS) current.push(membership)
      else unconfirmed++
    }
  }
  return { memberships: current, unconfirmed }
}

/** KNT-150. An owner or an admin of the org: they edit it. A member reads. */
export function canEdit(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin'
}
