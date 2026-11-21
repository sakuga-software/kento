// KNT-150. The org on screen, its name and its installations, in Postgres. A rename and a move run
// in one transaction under the advisory locks of the owners of the orgs that they touch, taken in
// the order of the org ids, and decide with the rows read under those locks.
import type postgres from 'postgres'

import { orgLockKey } from '../auth/store.ts'
import type { OrgRole } from '../db/schema.ts'
import { instance } from '../instance.ts'
import { decideMove, slugOf, type OrgRefusal } from './rules.ts'

export interface OrgInstallationView {
  id: string
  githubInstallationId: number
  githubAccountId: number
  login: string
  suspended: boolean
  repos: number
}

export interface OrgView {
  id: string
  name: string
  slug: string
  installations: OrgInstallationView[]
}

export type OrgChangeOutcome = { ok: true; orgId: string; deleted: boolean } | { ok: false; reason: OrgRefusal }

export interface OrgsStore {
  view(orgId: string): Promise<OrgView | null>
  /** The orgs where the person is an owner, other than `exceptOrgId`, by name. */
  ownedOrgs(userId: string, exceptOrgId: string): Promise<{ id: string; name: string }[]>
  rename(orgId: string, actorUserId: string, name: string): Promise<OrgChangeOutcome>
  /**
   * Moves an installation of `fromOrgId`, with its repositories (and their rules, jobs and
   * reviews), to another org of the person, or to a new org (`to.name`) of which they become the
   * owner. `githubAdmin`: GitHub says now that the person is an admin of the account. The org left
   * with no installation is deleted, with its settings, providers, runners and org rules, only when
   * `deleteEmpty`.
   */
  moveInstallation(input: {
    fromOrgId: string
    installationId: string
    to: { orgId: string } | { name: string }
    actorUserId: string
    githubAdmin: boolean
    deleteEmpty: boolean
  }): Promise<OrgChangeOutcome>
}

export function createOrgsStore(sql: postgres.Sql): OrgsStore {
  async function roleIn(tx: postgres.Sql, orgId: string, userId: string): Promise<OrgRole | null> {
    let [row] = await tx<{ role: OrgRole }[]>`select role from memberships where org_id = ${orgId} and user_id = ${userId} for update`
    return row?.role ?? null
  }

  /** A free slug for a name: the slug, then the slug with -2, -3… */
  async function freeSlug(tx: postgres.Sql, name: string): Promise<string> {
    let base = slugOf(name)
    let taken = new Set(
      (await tx<{ slug: string }[]>`select slug from orgs where slug = ${base} or slug like ${`${base}-%`}`).map((r) => r.slug),
    )
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }

  return {
    async view(orgId) {
      let [org] = await sql<{ id: string; name: string; slug: string }[]>`select id, name, slug from orgs where id = ${orgId}`
      if (!org) return null
      let installations = await sql<OrgInstallationView[]>`
        select i.id, i.github_installation_id::float8 as "githubInstallationId", i.github_account_id::float8 as "githubAccountId",
          i.account_login as login, i.suspended_at is not null as suspended,
          (select count(*)::int from repos r where r.installation_id = i.id) as repos
        from installations i where i.org_id = ${orgId}
        order by i.suspended_at is not null, lower(i.account_login), i.github_installation_id
      `
      return { ...org, installations }
    },

    async ownedOrgs(userId, exceptOrgId) {
      return sql<{ id: string; name: string }[]>`
        select o.id, o.name from memberships m join orgs o on o.id = m.org_id
        where m.user_id = ${userId} and m.role = 'owner' and o.id <> ${exceptOrgId}
          and exists (select 1 from installations s where s.org_id = o.id and s.suspended_at is null)
        order by lower(o.name), o.id
      `
    },

    async rename(orgId, actorUserId, name) {
      return (await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${orgLockKey(orgId)}, 0))`
        let role = await roleIn(tx as unknown as postgres.Sql, orgId, actorUserId)
        if (role !== 'owner') return { ok: false, reason: role === null ? 'not_found' : 'not_owner' }
        await tx`update orgs set name = ${name}, updated_at = now() where id = ${orgId}`
        return { ok: true, orgId, deleted: false }
      })) as OrgChangeOutcome
    },

    async moveInstallation({ fromOrgId, installationId, to, actorUserId, githubAdmin, deleteEmpty }) {
      return (await sql.begin(async (begun) => {
        let tx = begun as unknown as postgres.Sql
        // The locks of the two orgs, always in the same order: two moves in opposite ways wait,
        // and never on each other.
        let targetId = 'orgId' in to ? to.orgId : null
        for (let id of [fromOrgId, ...(targetId ? [targetId] : [])].sort()) {
          await tx`select pg_advisory_xact_lock(hashtextextended(${orgLockKey(id)}, 0))`
        }
        let [installation] = await tx<{ id: string }[]>`
          select id from installations where id = ${installationId} and org_id = ${fromOrgId} for update
        `
        if (!installation) return { ok: false, reason: 'not_found' }
        if (targetId) {
          let [exists] = await tx`select 1 from orgs where id = ${targetId}`
          if (!exists) return { ok: false, reason: 'target_not_owner' }
        }
        let [left] = await tx<{ n: number }[]>`select count(*)::int as n from installations where org_id = ${fromOrgId} and id <> ${installationId}`
        let refusal = decideMove({
          fromRole: await roleIn(tx, fromOrgId, actorUserId),
          toRole: targetId ? await roleIn(tx, targetId, actorUserId) : 'new',
          sameOrg: targetId === fromOrgId,
          githubAdmin,
          last: left!.n === 0,
          deleteConfirmed: deleteEmpty,
        })
        if (refusal) return { ok: false, reason: refusal }
        let destination = targetId
        if (!destination) {
          let name = (to as { name: string }).name
          let [created] = await tx<{ id: string }[]>`
            insert into orgs (name, slug, trusted_bots) values (${name}, ${await freeSlug(tx, name)}, ${[...instance().defaultTrustedBots]})
            returning id`
          destination = created!.id
          // GitHub says that the person is an admin of the account of the installation: a membership
          // from GitHub, owner of the new org, that GitHub keeps checking.
          await tx`insert into memberships (user_id, org_id, role, source) values (${actorUserId}, ${destination}, 'owner', 'github')`
        }
        // The repositories follow: their foreign key to the installation carries the org, on update
        // cascade. Their own rules and assignment rules carry the org too: they follow them.
        await tx`update installations set org_id = ${destination}, updated_at = now() where id = ${installationId}`
        await tx`update rules set org_id = ${destination} where repo_id in (select id from repos where installation_id = ${installationId})`
        await tx`update assignment_rules set org_id = ${destination} where repo_id in (select id from repos where installation_id = ${installationId})`
        let deleted = false
        if (left!.n === 0) {
          await tx`delete from orgs where id = ${fromOrgId}`
          deleted = true
        }
        return { ok: true, orgId: destination, deleted }
      })) as OrgChangeOutcome
    },
  }
}
