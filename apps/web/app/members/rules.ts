// KNT-150. Who may change which membership of an org. Pure: the store calls these under the lock of
// the org, with the rows it read in the same transaction, and the screens call them to show only the
// forms that would pass.
import { canEdit } from '../auth/access.ts'
import type { InvitationRole, MembershipSource, OrgRole } from '../db/schema.ts'

/** A membership as the rules see it. */
export interface MemberFacts {
  userId: string
  role: OrgRole
  source: MembershipSource
}

/** Why a change of a membership is refused. Each one has its sentence on the screen. */
export type MemberRefusal =
  /** A member reads only. */
  | 'not_admin'
  /** Only an owner gives, takes or removes the owner role. */
  | 'not_owner'
  /** The org would have no active owner left. */
  | 'last_owner'
  /** GitHub decides the role and the membership of a person that it counts in the org. */
  | 'github'
  /** The role asked is the role the person has. */
  | 'same_role'

export type MemberChange = { kind: 'role'; role: OrgRole } | { kind: 'remove' } | { kind: 'leave' }

/**
 * Decides a change of `target` by `actor` in one org. `otherOwners`: the active owners of the org
 * other than the target.
 *
 * - A membership from GitHub follows GitHub between admin and member, and GitHub ends it: Kentō
 *   only gives `owner` to a GitHub admin, or takes it back. Nobody removes it, nor leaves it.
 * - A membership from an invitation is Kentō's: an owner or an admin sets member or admin, and
 *   removes it; the person leaves it.
 * - Only an owner gives `owner`, takes it, or removes an owner.
 * - No change leaves the org without an active owner.
 */
export function decideMemberChange(actor: MemberFacts, target: MemberFacts, change: MemberChange, otherOwners: number): MemberRefusal | null {
  let self = actor.userId === target.userId
  if (change.kind === 'leave') {
    if (!self) return 'not_admin'
    if (target.source === 'github') return 'github'
    return target.role === 'owner' && otherOwners === 0 ? 'last_owner' : null
  }
  if (!canEdit(actor.role)) return 'not_admin'
  let touchesOwner = target.role === 'owner' || (change.kind === 'role' && change.role === 'owner')
  if (touchesOwner && actor.role !== 'owner') return 'not_owner'
  if (change.kind === 'remove') {
    if (target.source === 'github') return 'github'
    return target.role === 'owner' && otherOwners === 0 ? 'last_owner' : null
  }
  if (change.role === target.role) return 'same_role'
  if (target.source === 'github') {
    // Between owner and admin only: GitHub says admin for an owner, and decides admin or member.
    let ownerStep = (target.role === 'admin' && change.role === 'owner') || (target.role === 'owner' && change.role === 'admin')
    if (!ownerStep) return 'github'
  }
  return target.role === 'owner' && otherOwners === 0 ? 'last_owner' : null
}

/** The roles that `actor` may set on `target` now, for the select of the screen. */
export function rolesFor(actor: MemberFacts, target: MemberFacts, otherOwners: number): OrgRole[] {
  let roles: OrgRole[] = ['owner', 'admin', 'member']
  return roles.filter((role) => role === target.role || decideMemberChange(actor, target, { kind: 'role', role }, otherOwners) === null)
}

/** Why an invitation is refused. */
export type InviteRefusal = 'not_admin' | 'unknown_login' | 'already_member' | 'already_invited' | 'bad_role'

/** An owner or an admin invites as a member or an admin. */
export function decideInvite(actor: { role: OrgRole }, role: string): InviteRefusal | null {
  if (!canEdit(actor.role)) return 'not_admin'
  return isInvitationRole(role) ? null : 'bad_role'
}

export function isInvitationRole(value: unknown): value is InvitationRole {
  return value === 'admin' || value === 'member'
}

/** An invitation lasts this long. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
