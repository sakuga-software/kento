// KNT-150. Who may rename an org, and move one of its installations to another org or to a new one.
// Pure: the store decides with the rows it read under the locks of the orgs.
import type { OrgRole } from '../db/schema.ts'

/** Why a change of an org is refused. Each one has its sentence on the screen. */
export type OrgRefusal =
  /** Only an owner renames an org or moves its installations. */
  | 'not_owner'
  /** The person is not an owner of the org that would receive the installation. */
  | 'target_not_owner'
  /** The org that would receive the installation has no active installation: nobody reaches it. */
  | 'target_inactive'
  /** GitHub does not say that the person is an admin of the account of the installation. */
  | 'not_github_admin'
  /** GitHub does not say that the person is an admin of an account already in the org that would receive it. */
  | 'not_target_admin'
  /** An installation on a personal account lives in an org of its own: no other account joins it. */
  | 'personal_account'
  /** A detach needs an owner whom GitHub counts as an admin of another account of the org. */
  | 'not_remaining_admin'
  /** The installations changed while Kentō asked GitHub: the answers are about other ones. */
  | 'changed'
  /** The installation is in that org already. */
  | 'same_org'
  /** The last installation of an org: moving it deletes the org, and the form did not confirm it. */
  | 'last_installation'
  | 'bad_name'
  | 'not_found'

/** The longest name of an org. */
export const ORG_NAME_MAX = 60

/** The name of an org as typed: trimmed, one line, 1 to 60 characters. Null when it is not one. */
export function readOrgName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let name = value.trim().replace(/\s+/g, ' ')
  // No control character, and no format character: a direction override or a zero-width space
  // would make two names look the same.
  if (name.length === 0 || name.length > ORG_NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(name)) return null
  return name
}

/** The slug of a name: lowercase letters, digits and dashes. */
export function slugOf(name: string): string {
  let slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'org'
}

/** Where a move sends an installation. */
export type MoveTarget =
  /** An org that exists. `active`: its installations that are not suspended. */
  | {
      kind: 'org'
      role: OrgRole | null
      active: number
      /** GitHub says now that the person is an admin of the account of one of its active installations. */
      adminOfOne: boolean
      /** It holds an installation of another account than the one that moves (suspended or not). */
      otherAccounts: boolean
      /** One of its active installations is on a personal account of another person. */
      personal: boolean
    }
  /** A new org, of which the person becomes the owner. */
  | { kind: 'new' }
  /** A new org with no member: the next GitHub admin of the account who signs in becomes its owner. */
  | { kind: 'detach' }

/**
 * KNT-150. Decides the move of an installation out of the org `from`. The rights that GitHub gives
 * in an org never come from an account that is not the org's:
 *
 * - The person is an owner of the org that the installation leaves.
 * - Into an org that exists: the person is an owner of it, it has an active installation, and
 *   GitHub says now that the person is an admin of both the account that moves and an account
 *   already in it. An owner from an invitation brings no account of their own.
 * - An installation on a personal account lives in an org of its own: it joins no org that holds
 *   another account, and no other account joins its org.
 * - Into a new org: GitHub says now that the person is an admin of the account that moves.
 * - A detach (a new org with no member) needs no right on the account that leaves: an owner whom
 *   GitHub counts as an admin of another active account of the org takes any account out. The
 *   memberships that only that account gave end at their next check.
 * - The last active installation moves only when the form confirms that the org goes with it.
 */
export function decideMove(input: {
  fromRole: OrgRole | null
  to: MoveTarget
  sameOrg: boolean
  /** GitHub says now that the person is an admin of the account of the installation. */
  movedAdmin: boolean
  /** The account of the installation is a person. */
  movedPersonal: boolean
  /** GitHub says now that the person is an admin of the account of another active installation of `from`. */
  remainingAdmin: boolean
  last: boolean
  deleteConfirmed: boolean
}): OrgRefusal | null {
  let { to } = input
  if (input.fromRole !== 'owner') return 'not_owner'
  if (to.kind === 'detach') return input.remainingAdmin ? null : 'not_remaining_admin'
  if (to.kind === 'org') {
    if (input.sameOrg) return 'same_org'
    if (to.role !== 'owner') return 'target_not_owner'
    if (to.active === 0) return 'target_inactive'
    if (!input.movedAdmin) return 'not_github_admin'
    if (to.personal || (input.movedPersonal && to.otherAccounts)) return 'personal_account'
    if (!to.adminOfOne) return 'not_target_admin'
  } else if (!input.movedAdmin) {
    return 'not_github_admin'
  }
  if (input.last && !input.deleteConfirmed) return 'last_installation'
  return null
}
