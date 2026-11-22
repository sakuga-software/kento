// KNT-150. The members of an org and its invitations, in Postgres. Every change of a role, a removal,
// a departure and an acceptance runs in one transaction under the advisory lock of the owners of
// the org (the one of `AuthStore.withOrgLock`), and decides with the rows it read under that lock:
// two changes at the same time never leave an org without an active owner.
import type postgres from 'postgres'

import { canEdit, OWNER_ACTIVE_MS } from '../auth/access.ts'
import { shortenOrgAsk, takeOrgAsk } from '../auth/asks.ts'
import { orgLockKey } from '../auth/store.ts'
import type { InvitationRole, MembershipSource, OrgRole } from '../db/schema.ts'
import { decideMemberChange, decideReclaim, INVITATION_TTL_MS, MAX_PENDING_INVITATIONS, RECLAIM_COOLDOWN_MS, RECLAIM_RETRY_MS, type MemberChange, type MemberFacts, type MemberRefusal } from './rules.ts'

export interface MemberView {
  membershipId: string
  userId: string
  login: string
  name: string | null
  role: OrgRole
  source: MembershipSource
  /** An owner seen within `OWNER_ACTIVE_MS`: one who counts for the last-owner guard. */
  active: boolean
  createdAt: Date
}

export interface InvitationView {
  id: string
  githubLogin: string
  role: InvitationRole
  inviterLogin: string | null
  expiresAt: Date
  createdAt: Date
}

/** A pending invitation of the signed-in person. */
export interface OwnInvitation {
  id: string
  orgId: string
  orgName: string
  role: InvitationRole
  inviterLogin: string | null
  expiresAt: Date
}

export type InviteOutcome = 'invited' | 'already_member' | 'already_invited' | 'not_admin' | 'too_many'
/** `target`: the login of the person changed, for the log. */
export type ChangeOutcome = { ok: true; role: OrgRole | null; target: string } | { ok: false; reason: MemberRefusal | 'not_found'; target?: string }

/** A membership with its person, as the store reads it under the lock. */
interface Member extends MemberFacts {
  id: string
  login: string
  githubId: number
}

export interface MembersStore {
  /** The members of an org, owners first, then by login; and its pending invitations, newest first. */
  list(orgId: string, now: number): Promise<{ members: MemberView[]; invitations: InvitationView[] }>
  /** Invites a GitHub account. A pending invitation that expired is canceled first. */
  invite(input: { orgId: string; githubId: number; githubLogin: string; role: InvitationRole; inviterId: string }): Promise<InviteOutcome>
  /** Cancels a pending invitation of the org, by an owner or an admin of it. */
  cancel(orgId: string, actorUserId: string, invitationId: string): Promise<'canceled' | 'not_found' | 'not_admin'>
  /**
   * KNT-150. A person whom GitHub says, now, is an admin of an account of the org takes the owner
   * role (`decideReclaim`). `adminOf`: the installations whose account GitHub counts the person an
   * admin of, asked by the caller before the lock. KNT-199: under the lock, at least one of them must
   * still be an active installation of the org; when none is (a move took it away in between), the
   * refusal is `changed`.
   */
  reclaim(orgId: string, userId: string, adminOf: string[]): Promise<ChangeOutcome>
  /**
   * KNT-173. Counts a question to GitHub for the take-back, once per `RECLAIM_COOLDOWN_MS` per person
   * and org, for every process of the service, on the clock of Postgres. `over`: the person asked
   * within it; `gone`: the person, their membership or the org is gone, and nothing is written.
   */
  askReclaim(orgId: string, userId: string): Promise<'allowed' | 'over' | 'gone'>
  /** KNT-173. GitHub failed for the take-back: the person asks again after `RECLAIM_RETRY_MS`. */
  reclaimFailed(orgId: string, userId: string): Promise<void>
  /** A change of a membership of the org by a member of it, decided by `decideMemberChange`. */
  change(input: { orgId: string; actorUserId: string; membershipId: string | null; change: MemberChange; now: number }): Promise<ChangeOutcome>
  /** The pending invitations of a GitHub account, in the active orgs, not expired. */
  own(githubId: number): Promise<OwnInvitation[]>
  /**
   * Accepts a pending invitation of the GitHub account of `user`: the person becomes a member from
   * an invitation, with the role of the invitation. A person who is a member already keeps their
   * membership as it is. Null: no such pending invitation of this account.
   */
  accept(invitationId: string, user: { id: string; githubId: number }): Promise<{ orgId: string; role: OrgRole } | null>
  /** Declines a pending invitation of the GitHub account. */
  decline(invitationId: string, githubId: number): Promise<boolean>
}

/**
 * KNT-150. Cancels the pending invitations that a person made in an org: they go with the person.
 * Gives the logins of the invited accounts, for the audit.
 */
async function cancelInvitationsOf(tx: postgres.Sql, orgId: string, inviterId: string): Promise<string[]> {
  let rows = await tx<{ githubLogin: string }[]>`
    update invitations set status = 'canceled', responded_at = now()
    where org_id = ${orgId} and inviter_id = ${inviterId} and status = 'pending'
    returning github_login as "githubLogin"`
  return rows.map((r) => r.githubLogin).sort()
}

/** `clock`: the offset of the clock of the limits (`auth/asks.ts`); the tests move it. */
export function createMembersStore(sql: postgres.Sql, clock: { offsetMs(): number } = { offsetMs: () => 0 }): MembersStore {
  /** Runs `work` in one transaction that holds the lock of the owners of the org. */
  async function locked<T>(orgId: string, work: (tx: postgres.Sql) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${orgLockKey(orgId)}, 0))`
      return work(tx as unknown as postgres.Sql)
    })) as T
  }

  /** drizzle shares this client and turns off its date conversion: a time goes and comes as text. */
  let at = (ms: number) => new Date(ms).toISOString()

  /** The membership of a person in the org, with their login, locked for the transaction. */
  async function memberOf(tx: postgres.Sql, orgId: string, userId: string): Promise<Member | null> {
    let [row] = await tx<Member[]>`
      select m.id, m.user_id as "userId", m.role, m.source, u.login, u.github_id::float8 as "githubId"
      from memberships m join users u on u.id = m.user_id
      where m.org_id = ${orgId} and m.user_id = ${userId} for update of m`
    return row ?? null
  }

  /** One row of `org_audit`, in the transaction of the change. */
  async function audit(
    tx: postgres.Sql,
    orgId: string,
    actor: { userId: string; login: string },
    action: 'invite' | 'cancel' | 'role' | 'remove' | 'leave' | 'accept' | 'decline' | 'reclaim',
    target: { login: string; githubId: number } | null,
    invitationId: string | null,
    before: string | null,
    after: string | null,
    detail: Record<string, unknown> | null = null,
  ) {
    await tx`
      insert into org_audit (org_id, org_name, actor_id, actor_login, action, target_login, target_github_id, invitation_id, role_before, role_after, detail)
      values (${orgId}, (select name from orgs where id = ${orgId}), ${actor.userId}, ${actor.login}, ${action},
        ${target?.login ?? null}, ${target?.githubId ?? null}, ${invitationId}, ${before}, ${after}, ${detail === null ? null : JSON.stringify(detail)}::jsonb)`
  }

  return {
    async list(orgId, now) {
      let since = at(now - OWNER_ACTIVE_MS)
      let members = await sql<(Omit<MemberView, 'createdAt'> & { createdAt: string })[]>`
        select m.id as "membershipId", u.id as "userId", u.login, u.name, m.role, m.source,
          (m.checked_at >= ${since}::timestamptz or coalesce(u.last_sign_in_at >= ${since}::timestamptz, false)) as active,
          m.created_at as "createdAt"
        from memberships m join users u on u.id = m.user_id
        where m.org_id = ${orgId}
        order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(u.login)
      `
      let invitations = await sql<(Omit<InvitationView, 'expiresAt' | 'createdAt'> & { expiresAt: string; createdAt: string })[]>`
        select i.id, i.github_login as "githubLogin", i.role, u.login as "inviterLogin", i.expires_at as "expiresAt", i.created_at as "createdAt"
        from invitations i left join users u on u.id = i.inviter_id
        where i.org_id = ${orgId} and i.status = 'pending' and i.expires_at > now()
        order by i.created_at desc
      `
      return {
        members: members.map((m) => ({ ...m, createdAt: new Date(m.createdAt) })),
        invitations: invitations.map((i) => ({ ...i, expiresAt: new Date(i.expiresAt), createdAt: new Date(i.createdAt) })),
      }
    },

    async invite({ orgId, githubId, githubLogin, role, inviterId }) {
      return locked(orgId, async (tx) => {
        // The role of the person who invites, read again under the lock: GitHub was asked in between.
        let actor = await memberOf(tx, orgId, inviterId)
        if (!actor || !canEdit(actor.role)) return 'not_admin'
        let [member] = await tx`
          select 1 from memberships m join users u on u.id = m.user_id where m.org_id = ${orgId} and u.github_id = ${githubId}
        `
        if (member) return 'already_member'
        await tx`
          update invitations set status = 'canceled', responded_at = now()
          where org_id = ${orgId} and github_id = ${githubId} and status = 'pending' and expires_at <= now()
        `
        let [pending] = await tx<{ n: number }[]>`
          select count(*)::int as n from invitations where org_id = ${orgId} and status = 'pending' and expires_at > now()`
        if (pending!.n >= MAX_PENDING_INVITATIONS) return 'too_many'
        let inserted = await tx<{ id: string }[]>`
          insert into invitations (org_id, github_id, github_login, role, inviter_id, expires_at)
          values (${orgId}, ${githubId}, ${githubLogin}, ${role}, ${inviterId}, now() + ${`${INVITATION_TTL_MS} milliseconds`}::interval)
          on conflict (org_id, github_id) where status = 'pending' do nothing
          returning id
        `
        if (inserted.length === 0) return 'already_invited'
        await audit(tx, orgId, actor, 'invite', { login: githubLogin, githubId }, inserted[0]!.id, null, role)
        return 'invited'
      })
    },

    async cancel(orgId, actorUserId, invitationId) {
      return locked(orgId, async (tx) => {
        let actor = await memberOf(tx, orgId, actorUserId)
        if (!actor || !canEdit(actor.role)) return 'not_admin'
        let [canceled] = await tx<{ githubLogin: string; githubId: number; role: string }[]>`
          update invitations set status = 'canceled', responded_at = now()
          where id = ${invitationId} and org_id = ${orgId} and status = 'pending'
          returning github_login as "githubLogin", github_id::float8 as "githubId", role
        `
        if (!canceled) return 'not_found'
        await audit(tx, orgId, actor, 'cancel', { login: canceled.githubLogin, githubId: canceled.githubId }, invitationId, canceled.role, null)
        return 'canceled'
      })
    },

    async change({ orgId, actorUserId, membershipId, change, now }) {
      return locked(orgId, async (tx) => {
        let actor = await memberOf(tx, orgId, actorUserId)
        if (!actor) return { ok: false, reason: 'not_found' } as const
        let target =
          change.kind === 'leave'
            ? actor
            : membershipId === null
              ? null
              : ((
                  await tx<Member[]>`
                    select m.id, m.user_id as "userId", m.role, m.source, u.login, u.github_id::float8 as "githubId"
                    from memberships m join users u on u.id = m.user_id
                    where m.org_id = ${orgId} and m.id = ${membershipId} for update of m`
                )[0] ?? null)
        if (!target) return { ok: false, reason: 'not_found' } as const
        let since = at(now - OWNER_ACTIVE_MS)
        let [owners] = await tx<{ n: number }[]>`
          select count(*)::int as n from memberships m join users u on u.id = m.user_id
          where m.org_id = ${orgId} and m.role = 'owner' and m.id <> ${target.id}
            and (m.checked_at >= ${since}::timestamptz or coalesce(u.last_sign_in_at >= ${since}::timestamptz, false))
        `
        let refusal = decideMemberChange(actor as MemberFacts, target as MemberFacts, change, owners!.n)
        if (refusal) return { ok: false, reason: refusal, target: target.login } as const
        if (change.kind === 'role') {
          await tx`update memberships set role = ${change.role} where id = ${target.id}`
          await audit(tx, orgId, actor, 'role', target, null, target.role, change.role)
          return { ok: true, role: change.role, target: target.login } as const
        }
        await tx`delete from memberships where id = ${target.id}`
        let canceled = await cancelInvitationsOf(tx, orgId, target.userId)
        await audit(tx, orgId, actor, change.kind, target, null, target.role, null, canceled.length > 0 ? { canceledInvitations: canceled } : null)
        return { ok: true, role: null, target: target.login } as const
      })
    },

    async reclaim(orgId, userId, adminOf) {
      return locked(orgId, async (tx) => {
        let actor = await memberOf(tx, orgId, userId)
        // A move of an installation takes the lock of its org first: the installations read here
        // are the ones of the org until this transaction ends.
        if (actor && adminOf.length > 0) {
          let [still] = await tx<{ n: number }[]>`
            select count(*)::int as n from installations where org_id = ${orgId} and suspended_at is null and id in ${tx(adminOf)}`
          if (still!.n === 0) return { ok: false, reason: 'changed' } as const
        }
        let refusal = decideReclaim(actor, adminOf.length > 0)
        if (refusal) return { ok: false, reason: refusal } as const
        // GitHub said admin: the membership is GitHub's from now on, checked as every other one.
        await tx`update memberships set role = 'owner', source = 'github', checked_at = now() where id = ${actor!.id}`
        await audit(tx, orgId, actor!, 'reclaim', actor!, null, actor!.role, 'owner', actor!.source === 'invitation' ? { sourceBefore: 'invitation' } : null)
        return { ok: true, role: 'owner', target: actor!.login } as const
      })
    },

    async askReclaim(orgId, userId) {
      return takeOrgAsk(sql, { userId, orgId, action: 'reclaim', limit: 1, windowMs: RECLAIM_COOLDOWN_MS, offsetMs: clock.offsetMs() })
    },

    async reclaimFailed(orgId, userId) {
      await shortenOrgAsk(sql, { userId, orgId, action: 'reclaim', windowMs: RECLAIM_COOLDOWN_MS, retryMs: RECLAIM_RETRY_MS, offsetMs: clock.offsetMs() })
    },

    async own(githubId) {
      let rows = await sql<(Omit<OwnInvitation, 'expiresAt'> & { expiresAt: string })[]>`
        select i.id, i.org_id as "orgId", o.name as "orgName", i.role, u.login as "inviterLogin", i.expires_at as "expiresAt"
        from invitations i join orgs o on o.id = i.org_id left join users u on u.id = i.inviter_id
        where i.github_id = ${githubId} and i.status = 'pending' and i.expires_at > now()
          and exists (select 1 from installations s where s.org_id = i.org_id and s.suspended_at is null)
        order by i.created_at
      `
      return rows.map((r) => ({ ...r, expiresAt: new Date(r.expiresAt) }))
    },

    async accept(invitationId, user) {
      let [found] = await sql<{ orgId: string }[]>`select org_id as "orgId" from invitations where id = ${invitationId}`
      if (!found) return null
      return locked(found.orgId, async (tx) => {
        let [invitation] = await tx<{ orgId: string; role: InvitationRole }[]>`
          update invitations set status = 'accepted', responded_at = now()
          where id = ${invitationId} and github_id = ${user.githubId} and status = 'pending' and expires_at > now()
            and exists (select 1 from installations s where s.org_id = invitations.org_id and s.suspended_at is null)
          returning org_id as "orgId", role
        `
        if (!invitation) return null
        let [current] = await tx<{ role: OrgRole }[]>`
          select role from memberships where user_id = ${user.id} and org_id = ${invitation.orgId} for update
        `
        // Already a member (from GitHub, since the invitation was sent): the membership stays as it
        // is, its role and its source. An invitation never takes a membership away from GitHub,
        // nor changes a role outside of the rules of the members screen.
        let [person] = await tx<{ login: string }[]>`select login from users where id = ${user.id}`
        let who = { userId: user.id, login: person?.login ?? '', githubId: user.githubId }
        // `kept`: the person was a member already; the acceptance granted nothing.
        await audit(tx, invitation.orgId, who, 'accept', who, invitationId, current?.role ?? null, current?.role ?? invitation.role, current ? { kept: true } : null)
        if (current) return { orgId: invitation.orgId, role: current.role }
        await tx`
          insert into memberships (user_id, org_id, role, source, checked_at)
          values (${user.id}, ${invitation.orgId}, ${invitation.role}, 'invitation', now())
        `
        return { orgId: invitation.orgId, role: invitation.role }
      })
    },

    async decline(invitationId, githubId) {
      let [found] = await sql<{ orgId: string }[]>`select org_id as "orgId" from invitations where id = ${invitationId}`
      if (!found) return false
      // Under the lock of the org, as an acceptance: the two never cross.
      return locked(found.orgId, async (tx) => {
        let [declined] = await tx<{ orgId: string; login: string; role: string }[]>`
          update invitations set status = 'declined', responded_at = now()
          where id = ${invitationId} and github_id = ${githubId} and status = 'pending'
          returning org_id as "orgId", github_login as login, role
        `
        if (!declined) return false
        // The person who declines is signed in: their row exists.
        let [person] = await tx<{ id: string; login: string }[]>`select id, login from users where github_id = ${githubId}`
        if (!person) return false
        let who = { userId: person.id, login: person.login, githubId }
        await audit(tx, declined.orgId, who, 'decline', who, invitationId, declined.role, null)
        return true
      })
    },
  }
}
