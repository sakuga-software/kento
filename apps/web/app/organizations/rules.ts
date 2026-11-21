// KNT-150. Who may rename an org, and move one of its installations to another org or to a new one.
// Pure: the store decides with the rows it read under the locks of the orgs.
import type { OrgRole } from '../db/schema.ts'

/** Why a change of an org is refused. Each one has its sentence on the screen. */
export type OrgRefusal =
  /** Only an owner renames an org or moves its installations. */
  | 'not_owner'
  /** The person is not an owner of the org that would receive the installation. */
  | 'target_not_owner'
  /** GitHub does not say that the person is an admin of the account of the installation. */
  | 'not_github_admin'
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
  // No control character, no character of a direction override.
  if (name.length === 0 || name.length > ORG_NAME_MAX || /[\p{Cc}‪-‮⁦-⁩]/u.test(name)) return null
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

/**
 * Decides the move of an installation from `from` to `to` (null: a new org, of which the person
 * becomes the owner). The person must be an owner of both orgs, and GitHub must say that they are
 * an admin of the account of the installation: an owner given in Kentō alone does not move what
 * GitHub gave. The last installation of an org moves only when the form confirms that the org,
 * empty then, is deleted.
 */
export function decideMove(input: {
  fromRole: OrgRole | null
  toRole: OrgRole | null | 'new'
  sameOrg: boolean
  githubAdmin: boolean
  last: boolean
  deleteConfirmed: boolean
}): OrgRefusal | null {
  if (input.fromRole !== 'owner') return 'not_owner'
  if (input.sameOrg) return 'same_org'
  if (input.toRole !== 'new' && input.toRole !== 'owner') return 'target_not_owner'
  if (!input.githubAdmin) return 'not_github_admin'
  if (input.last && !input.deleteConfirmed) return 'last_installation'
  return null
}
