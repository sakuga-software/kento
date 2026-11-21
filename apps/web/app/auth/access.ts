import { errorMessage, log } from '../log.ts'
import type { OrgRole } from '../db/schema.ts'
import type { GitHubProfile, GitHubRole, LookupRole } from './github.ts'
import type { AuthStore, MembershipRow, OrgRow, UserRow } from './store.ts'

/** A role read from GitHub is read again after this. A role removed on GitHub ends within it. */
export const ROLE_TTL_MS = 10 * 60 * 1000
/** While GitHub does not answer, a role read before stays valid this long, then the access ends. */
export const ROLE_GRACE_MS = 60 * 60 * 1000
/**
 * KNT-150. An owner counts as the owner of an org while their membership was checked, or they
 * signed in, within this window. Past it, an owner who left and never came back no longer stops
 * the next GitHub admin from becoming the owner.
 */
export const OWNER_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000

export type SignInDecision =
  /**
   * `unconfirmed`: the orgs where GitHub failed. Their memberships stay as they were, with their old
   * `checked_at`, so the first request asks GitHub again.
   */
  | { kind: 'allowed'; roles: { org: OrgRow; role: GitHubRole }[]; unconfirmed: OrgRow[]; invited: OrgRow[]; pending?: number }
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
  // KNT-150. A person invited in Kentō signs in to the orgs of their invitations, whatever GitHub says.
  let invited = await store.invitedOrgs(profile.id)
  // A person with a pending invitation signs in to see it, even with no org yet.
  let pending = await store.pendingInvitations(profile.id)
  if (roles.length > 0 || invited.length > 0 || pending > 0) {
    return { kind: 'allowed', roles, unconfirmed: results.flatMap(({ org, failed }) => (failed ? [org] : [])), invited, pending }
  }
  return results.some((result) => result.failed) ? { kind: 'unknown' } : { kind: 'refused' }
}

/**
 * KNT-150. The role in Kentō of a membership from GitHub, once GitHub answered `github`: GitHub
 * decides between `admin` and `member`. `owner` holds only while GitHub says `admin`: an owner whom
 * GitHub demotes to `member` becomes a member, as an admin would.
 */
export function roleFromGitHub(current: OrgRole | null, github: GitHubRole): OrgRole {
  return current === 'owner' && github === 'admin' ? 'owner' : github
}

/**
 * KNT-150. Writes the role that GitHub gives to a membership from GitHub. A GitHub admin of an org
 * that has no active owner (`OWNER_ACTIVE_MS`) becomes its owner: a new installation gets one, and
 * so does an org whose owner left. The check and the write run under one lock of the org (the one
 * of the changes of the members screen too), and start from the role stored under that lock: an
 * owner given or taken in Kentō in between is not overwritten from a stale read. `read`, the role
 * that the caller saw: null for a person who joins. A membership that the caller saw and that is
 * gone under the lock (removed or left in between) stays gone: null, nothing written.
 */
export async function saveGitHubRole(
  store: AuthStore,
  userId: string,
  orgId: string,
  read: OrgRole | null,
  github: GitHubRole,
  now: number,
): Promise<OrgRole | null> {
  return store.withOrgLock(orgId, async (locked) => {
    let stored = await locked.membershipOf(userId, orgId)
    if (stored === null && read !== null) return null
    // A membership from an invitation is Kentō's: GitHub changes nothing of it.
    if (stored?.source === 'invitation') return stored.role
    let role = roleFromGitHub(stored?.role ?? null, github)
    // Another active owner, not this person: a second request of the same admin at the same time
    // finds its own row as owner, and keeps it.
    if (github === 'admin' && role !== 'owner' && !(await locked.hasOwner(orgId, new Date(now - OWNER_ACTIVE_MS), userId))) role = 'owner'
    return locked.saveMembership(userId, orgId, role, 'github')
  })
}

/**
 * Writes the roles of a sign-in, and forgets the orgs where GitHub answered that the person is not
 * a member. An org where GitHub failed (`unconfirmed`) keeps its membership as it was. A membership
 * from an invitation is Kentō's: GitHub neither changes nor removes it.
 *
 * A person that GitHub counts in an org where they are not a member yet joins it. A GitHub admin of
 * an org that has no active owner becomes its owner (`saveGitHubRole`).
 */
export async function saveSignInRoles(
  store: AuthStore,
  user: UserRow,
  roles: { org: OrgRow; role: GitHubRole }[],
  unconfirmed: OrgRow[] = [],
  now: number = Date.now(),
) {
  let kept = new Set([...roles, ...unconfirmed.map((org) => ({ org }))].map(({ org }) => org.id))
  let existing = new Map((await store.memberships(user.id)).map((m) => [m.org.id, m]))
  for (let membership of existing.values()) {
    if (membership.source === 'github' && !kept.has(membership.org.id)) await store.deleteMembership(user.id, membership.org.id)
  }
  for (let { org, role } of roles) {
    let membership = existing.get(org.id)
    if (membership?.source === 'invitation') continue
    await saveGitHubRole(store, user.id, org.id, membership?.role ?? null, role, now)
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
      let role = await saveGitHubRole(store, user.id, membership.org.id, membership.role, github, now)
      // Removed while GitHub was asked: the membership stays gone.
      if (role === null) continue
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
