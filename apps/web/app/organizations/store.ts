// KNT-150. The org on screen, its name and its installations, in Postgres. A rename and a move run
// in one transaction under the advisory locks of the owners of the orgs that they touch, and decide
// with the rows read under those locks. Each one writes its rows of `org_audit` in that transaction.
//
// The order of the locks, everywhere an installation, its org or its repositories are written:
//   1. the advisory locks of the owners of the orgs, in the order of their ids (the members screen,
//      the checks of GitHub and the moves);
//   2. the row of the installation (the webhook updates it first, `upsertInstallation`);
//   3. the rows of the orgs, in the order of their ids (the webhook locks its org next; a rule and an
//      assignment rule of a repository lock the key of their org first, `rules/store.ts`,
//      `assignment/store.ts`);
//   4. the rows of the repositories, the memberships, the rules.
// Two transactions that take two of these locks take them in this order, and never wait on each other.
import type postgres from 'postgres'

import { orgLockKey } from '../auth/store.ts'
import type { MembershipSource, OrgRole } from '../db/schema.ts'
import { instance } from '../instance.ts'
import { decideMove, slugOf, type MoveTarget, type OrgRefusal } from './rules.ts'

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
  /** The members, by login: the confirmation of a deletion lists them. */
  members: { login: string; source: MembershipSource }[]
  /** The logins of the pending invitations, by login. */
  invitations: string[]
}

/**
 * What GitHub said, before the locks, about the installations that a move touches, by id of their
 * row. The store decides with these answers, and refuses (`changed`) when an installation that it
 * reads under the locks has none.
 */
export interface MoveChecks {
  /** The installations that GitHub answered about. */
  checked: ReadonlySet<string>
  /** Those whose account GitHub counts the person as an admin of. */
  adminOf: ReadonlySet<string>
  /** Those on a personal account. */
  personal: ReadonlySet<string>
}

export type OrgChangeOutcome = { ok: true; orgId: string; deleted: boolean } | { ok: false; reason: OrgRefusal }

export interface OrgsStore {
  view(orgId: string): Promise<OrgView | null>
  /** The orgs where the person is an owner, other than `exceptOrgId`, by name. */
  ownedOrgs(userId: string, exceptOrgId: string): Promise<{ id: string; name: string }[]>
  /** The active installations of an org, for the questions to GitHub before a move into it. */
  activeInstallations(orgId: string): Promise<OrgInstallationView[]>
  rename(orgId: string, actorUserId: string, name: string): Promise<OrgChangeOutcome>
  /**
   * Moves an installation of `fromOrgId`, with its repositories (and their rules, jobs and
   * reviews), to another org of the person, to a new org (`to.name`) of which they become the
   * owner, or to a new org with no member (`to.detach`), as `decideMove` allows with the answers of
   * GitHub (`checks`). The org left with no installation is deleted, with its members, invitations,
   * settings, providers, runners and org rules, only when `deleteEmpty`.
   */
  moveInstallation(input: {
    fromOrgId: string
    installationId: string
    to: { orgId: string } | { name: string } | { detach: true }
    actorUserId: string
    checks: MoveChecks
    deleteEmpty: boolean
  }): Promise<OrgChangeOutcome>
}

type AuditAction = 'rename' | 'move_out' | 'move_in' | 'delete'

/** An installation as a move reads it under the locks. */
interface LockedInstallation {
  id: string
  githubInstallationId: number
  githubAccountId: number
  login: string
  suspended: boolean
}

export function createOrgsStore(sql: postgres.Sql): OrgsStore {
  async function roleIn(tx: postgres.Sql, orgId: string, userId: string): Promise<OrgRole | null> {
    let [row] = await tx<{ role: OrgRole }[]>`select role from memberships where org_id = ${orgId} and user_id = ${userId} for update`
    return row?.role ?? null
  }

  /**
   * Inserts an org with a free slug: the slug of the name, then with -2, -3… The insert decides,
   * not a read before it: two new orgs of the same name at the same time get two slugs.
   */
  async function insertOrg(tx: postgres.Sql, name: string): Promise<string> {
    let base = slugOf(name)
    for (let n = 1; n <= 1000; n++) {
      let slug = n === 1 ? base : `${base}-${n}`
      let [created] = await tx<{ id: string }[]>`
        insert into orgs (name, slug, trusted_bots) values (${name}, ${slug}, ${[...instance().defaultTrustedBots]})
        on conflict (slug) do nothing
        returning id`
      if (created) return created.id
    }
    throw new Error(`no free slug for the org ${base}`)
  }

  /** One row of `org_audit`, in the transaction of the change. */
  async function audit(
    tx: postgres.Sql,
    orgId: string,
    actorUserId: string,
    action: AuditAction,
    target: { login: string; githubId: number } | null,
    detail: Record<string, unknown>,
  ) {
    await tx`
      insert into org_audit (org_id, org_name, actor_id, actor_login, action, target_login, target_github_id, detail)
      values (${orgId}, (select name from orgs where id = ${orgId}), ${actorUserId}, (select login from users where id = ${actorUserId}),
        ${action}, ${target?.login ?? null}, ${target?.githubId ?? null}, ${JSON.stringify(detail)}::jsonb)`
  }

  async function installationsOf(tx: postgres.Sql, orgId: string): Promise<OrgInstallationView[]> {
    return tx<OrgInstallationView[]>`
      select i.id, i.github_installation_id::float8 as "githubInstallationId", i.github_account_id::float8 as "githubAccountId",
        i.account_login as login, i.suspended_at is not null as suspended,
        (select count(*)::int from repos r where r.installation_id = i.id) as repos
      from installations i where i.org_id = ${orgId}
      order by i.suspended_at is not null, lower(i.account_login), i.github_installation_id
    `
  }

  return {
    async view(orgId) {
      let [org] = await sql<{ id: string; name: string; slug: string }[]>`select id, name, slug from orgs where id = ${orgId}`
      if (!org) return null
      let members = await sql<{ login: string; source: MembershipSource }[]>`
        select u.login, m.source from memberships m join users u on u.id = m.user_id where m.org_id = ${orgId} order by lower(u.login)`
      let invitations = await sql<{ login: string }[]>`
        select github_login as login from invitations where org_id = ${orgId} and status = 'pending' and expires_at > now()
        order by lower(github_login)`
      return { ...org, installations: await installationsOf(sql, orgId), members: [...members], invitations: invitations.map((i) => i.login) }
    },

    async ownedOrgs(userId, exceptOrgId) {
      return sql<{ id: string; name: string }[]>`
        select o.id, o.name from memberships m join orgs o on o.id = m.org_id
        where m.user_id = ${userId} and m.role = 'owner' and o.id <> ${exceptOrgId}
          and exists (select 1 from installations s where s.org_id = o.id and s.suspended_at is null)
        order by lower(o.name), o.id
      `
    },

    async activeInstallations(orgId) {
      return (await installationsOf(sql, orgId)).filter((i) => !i.suspended)
    },

    async rename(orgId, actorUserId, name) {
      return (await sql.begin(async (begun) => {
        let tx = begun as unknown as postgres.Sql
        await tx`select pg_advisory_xact_lock(hashtextextended(${orgLockKey(orgId)}, 0))`
        let role = await roleIn(tx, orgId, actorUserId)
        if (role !== 'owner') return { ok: false, reason: role === null ? 'not_found' : 'not_owner' }
        let [before] = await tx<{ name: string }[]>`select name from orgs where id = ${orgId} for update`
        await tx`update orgs set name = ${name}, updated_at = now() where id = ${orgId}`
        await audit(tx, orgId, actorUserId, 'rename', null, { before: before!.name, after: name })
        return { ok: true, orgId, deleted: false }
      })) as OrgChangeOutcome
    },

    async moveInstallation({ fromOrgId, installationId, to, actorUserId, checks, deleteEmpty }) {
      return (await sql.begin(async (begun) => {
        let tx = begun as unknown as postgres.Sql
        let targetId = 'orgId' in to ? to.orgId : null
        let orgIds = [...new Set([fromOrgId, ...(targetId ? [targetId] : [])])].sort()
        // 1. The advisory locks of the orgs, in the order of their ids: two moves in opposite ways
        // wait, and never on each other; nor a move and a rename, or a change of the members.
        for (let id of orgIds) await tx`select pg_advisory_xact_lock(hashtextextended(${orgLockKey(id)}, 0))`
        // 2. The row of the installation, before the rows of the orgs: the webhook takes them in this order too.
        let [installation] = await tx<LockedInstallation[]>`
          select id, github_installation_id::float8 as "githubInstallationId", github_account_id::float8 as "githubAccountId",
            account_login as login, suspended_at is not null as suspended
          from installations where id = ${installationId} and org_id = ${fromOrgId} for update
        `
        // A suspended installation gives no right on GitHub any more: it does not move.
        if (!installation || installation.suspended) return { ok: false, reason: 'not_found' }
        // 3. The rows of the orgs: the webhook locks the row of an org when an installation joins it,
        // and the insert of an installation holds a key lock on it. The installations read below are
        // all of them: a new one waits for this move.
        let locked = await tx<{ id: string }[]>`select id from orgs where id in ${tx(orgIds)} order by id for update`
        if (targetId && !locked.some((o) => o.id === targetId)) return { ok: false, reason: 'target_not_owner' }
        let others = await tx<(LockedInstallation & { orgId: string })[]>`
          select id, org_id as "orgId", github_installation_id::float8 as "githubInstallationId", github_account_id::float8 as "githubAccountId",
            account_login as login, suspended_at is not null as suspended
          from installations where org_id in ${tx(orgIds)} and id <> ${installationId}
        `
        // The installations left in the org: the active ones decide the confirmation (the org cannot
        // be reached without one), and any one, a suspended one too, keeps the org from being deleted.
        let fromLeft = others.filter((i) => i.orgId === fromOrgId)
        let fromActive = fromLeft.filter((i) => !i.suspended)
        let answered = (i: { id: string }) => checks.checked.has(i.id)
        let target: MoveTarget
        if (targetId) {
          let inTarget = others.filter((i) => i.orgId === targetId)
          let active = inTarget.filter((i) => !i.suspended)
          // GitHub was asked about each active installation of the target: one that joined since has no answer.
          if (targetId !== fromOrgId && !active.every(answered)) return { ok: false, reason: 'changed' }
          target = {
            kind: 'org',
            role: await roleIn(tx, targetId, actorUserId),
            active: active.length,
            adminOfOne: active.some((i) => checks.adminOf.has(i.id)),
            otherAccounts: inTarget.some((i) => i.githubAccountId !== installation.githubAccountId),
            personal: active.some((i) => checks.personal.has(i.id) && i.githubAccountId !== installation.githubAccountId),
          }
        } else {
          target = 'detach' in to ? { kind: 'detach' } : { kind: 'new' }
        }
        if (target.kind !== 'detach' && !answered(installation)) return { ok: false, reason: 'changed' }
        let refusal = decideMove({
          fromRole: await roleIn(tx, fromOrgId, actorUserId),
          to: target,
          sameOrg: targetId === fromOrgId,
          movedAdmin: checks.adminOf.has(installation.id),
          movedPersonal: checks.personal.has(installation.id),
          remainingAdmin: fromActive.some((i) => checks.adminOf.has(i.id)),
          last: fromActive.length === 0,
          deleteConfirmed: deleteEmpty,
        })
        if (refusal) return { ok: false, reason: refusal }
        let destination = targetId
        if (!destination) {
          destination = await insertOrg(tx, 'name' in to ? to.name : installation.login)
          // A new org: GitHub says that the person is an admin of the account, so a membership from
          // GitHub, owner, that GitHub keeps checking. A detach gives it no member: the next GitHub
          // admin of the account who signs in becomes its owner (`saveGitHubRole`).
          if ('name' in to) await tx`insert into memberships (user_id, org_id, role, source) values (${actorUserId}, ${destination}, 'owner', 'github')`
        }
        let [fromOrg] = await tx<{ name: string }[]>`select name from orgs where id = ${fromOrgId}`
        let [toOrg] = await tx<{ name: string }[]>`select name from orgs where id = ${destination}`
        // 4. The repositories follow: their foreign key to the installation carries the org, on update
        // cascade. Their own rules and assignment rules carry the org too: they follow them.
        await tx`update installations set org_id = ${destination}, updated_at = now() where id = ${installationId}`
        await tx`update rules set org_id = ${destination} where repo_id in (select id from repos where installation_id = ${installationId})`
        await tx`update assignment_rules set org_id = ${destination} where repo_id in (select id from repos where installation_id = ${installationId})`
        let [counted] = await tx<{ repos: number }[]>`select count(*)::int as repos from repos where installation_id = ${installationId}`
        let repos = counted!.repos
        let account = { login: installation.login, githubId: installation.githubAccountId }
        let moved = { installation: installation.githubInstallationId, repositories: repos, kind: target.kind }
        await audit(tx, fromOrgId, actorUserId, 'move_out', account, { ...moved, to: { id: destination, name: toOrg!.name } })
        await audit(tx, destination, actorUserId, 'move_in', account, { ...moved, from: { id: fromOrgId, name: fromOrg!.name } })
        let deleted = false
        if (fromLeft.length === 0) {
          // What goes with the org, for the row that stays (its org_id becomes null).
          let [took] = await tx<{ providers: number; runners: number; rules: number }[]>`
            select (select count(*)::int from providers where org_id = ${fromOrgId}) as providers,
              (select count(*)::int from runners where org_id = ${fromOrgId}) as runners,
              (select count(*)::int from rules where org_id = ${fromOrgId}) as rules`
          let members = await tx<{ login: string; role: OrgRole; source: MembershipSource }[]>`
            select u.login, m.role, m.source from memberships m join users u on u.id = m.user_id where m.org_id = ${fromOrgId} order by lower(u.login)`
          let invitations = await tx<{ login: string }[]>`
            select github_login as login from invitations where org_id = ${fromOrgId} and status = 'pending' order by lower(github_login)`
          await audit(tx, fromOrgId, actorUserId, 'delete', null, {
            members: members.map((m) => ({ ...m })),
            invitations: invitations.map((i) => i.login),
            ...took,
          })
          await tx`delete from orgs where id = ${fromOrgId}`
          deleted = true
        }
        return { ok: true, orgId: destination, deleted }
      })) as OrgChangeOutcome
    },
  }
}
