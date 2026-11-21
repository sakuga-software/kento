// KNT-150. The members of an org and its invitations, in Postgres. Every change of a role, a removal,
// a departure and an acceptance runs in one transaction under the advisory lock of the owners of
// the org (the one of `AuthStore.withOrgLock`), and decides with the rows it read under that lock:
// two changes at the same time never leave an org without an active owner.
import type postgres from 'postgres'

import { OWNER_ACTIVE_MS } from '../auth/access.ts'
import { orgLockKey } from '../auth/store.ts'
import type { InvitationRole, MembershipSource, OrgRole } from '../db/schema.ts'
import { decideMemberChange, INVITATION_TTL_MS, type MemberChange, type MemberFacts, type MemberRefusal } from './rules.ts'

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

export type InviteOutcome = 'invited' | 'already_member' | 'already_invited'
export type ChangeOutcome = { ok: true; role: OrgRole | null } | { ok: false; reason: MemberRefusal | 'not_found' }

export interface MembersStore {
  /** The members of an org, owners first, then by login; and its pending invitations, newest first. */
  list(orgId: string, now: number): Promise<{ members: MemberView[]; invitations: InvitationView[] }>
  /** Invites a GitHub account. A pending invitation that expired is canceled first. */
  invite(input: { orgId: string; githubId: number; githubLogin: string; role: InvitationRole; inviterId: string; now: number }): Promise<InviteOutcome>
  /** Cancels a pending invitation of the org. False: no such invitation in this org. */
  cancel(orgId: string, invitationId: string, now: number): Promise<boolean>
  /** A change of a membership of the org by a member of it, decided by `decideMemberChange`. */
  change(input: { orgId: string; actorUserId: string; membershipId: string | null; change: MemberChange; now: number }): Promise<ChangeOutcome>
  /** The pending invitations of a GitHub account, in the active orgs, not expired. */
  own(githubId: number, now: number): Promise<OwnInvitation[]>
  /**
   * Accepts a pending invitation of the GitHub account of `user`: the person becomes a member from
   * an invitation, with the role of the invitation. A person who is a member already keeps their
   * membership as it is. Null: no such pending invitation of this account.
   */
  accept(invitationId: string, user: { id: string; githubId: number }, now: number): Promise<{ orgId: string; role: OrgRole } | null>
  /** Declines a pending invitation of the GitHub account. */
  decline(invitationId: string, githubId: number, now: number): Promise<boolean>
}

export function createMembersStore(sql: postgres.Sql): MembersStore {
  /** Runs `work` in one transaction that holds the lock of the owners of the org. */
  async function locked<T>(orgId: string, work: (tx: postgres.Sql) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${orgLockKey(orgId)}, 0))`
      return work(tx as unknown as postgres.Sql)
    })) as T
  }

  /** drizzle shares this client and turns off its date conversion: a time goes and comes as text. */
  let at = (ms: number) => new Date(ms).toISOString()

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
        where i.org_id = ${orgId} and i.status = 'pending' and i.expires_at > ${at(now)}::timestamptz
        order by i.created_at desc
      `
      return {
        members: members.map((m) => ({ ...m, createdAt: new Date(m.createdAt) })),
        invitations: invitations.map((i) => ({ ...i, expiresAt: new Date(i.expiresAt), createdAt: new Date(i.createdAt) })),
      }
    },

    async invite({ orgId, githubId, githubLogin, role, inviterId, now }) {
      return locked(orgId, async (tx) => {
        let [member] = await tx`
          select 1 from memberships m join users u on u.id = m.user_id where m.org_id = ${orgId} and u.github_id = ${githubId}
        `
        if (member) return 'already_member'
        await tx`
          update invitations set status = 'canceled', responded_at = ${at(now)}::timestamptz
          where org_id = ${orgId} and github_id = ${githubId} and status = 'pending' and expires_at <= ${at(now)}::timestamptz
        `
        let inserted = await tx`
          insert into invitations (org_id, github_id, github_login, role, inviter_id, expires_at)
          values (${orgId}, ${githubId}, ${githubLogin}, ${role}, ${inviterId}, ${at(now + INVITATION_TTL_MS)}::timestamptz)
          on conflict (org_id, github_id) where status = 'pending' do nothing
          returning id
        `
        return inserted.length > 0 ? 'invited' : 'already_invited'
      })
    },

    async cancel(orgId, invitationId, now) {
      let rows = await sql`
        update invitations set status = 'canceled', responded_at = ${at(now)}::timestamptz
        where id = ${invitationId} and org_id = ${orgId} and status = 'pending'
        returning id
      `
      return rows.length > 0
    },

    async change({ orgId, actorUserId, membershipId, change, now }) {
      return locked(orgId, async (tx) => {
        let facts = (rows: { id: string; userId: string; role: OrgRole; source: MembershipSource }[]) => rows[0] ?? null
        let actor = facts(await tx`
          select id, user_id as "userId", role, source from memberships where org_id = ${orgId} and user_id = ${actorUserId} for update
        `)
        if (!actor) return { ok: false, reason: 'not_found' } as const
        let target =
          change.kind === 'leave'
            ? actor
            : membershipId === null
              ? null
              : facts(await tx`
                  select id, user_id as "userId", role, source from memberships where org_id = ${orgId} and id = ${membershipId} for update
                `)
        if (!target) return { ok: false, reason: 'not_found' } as const
        let since = at(now - OWNER_ACTIVE_MS)
        let [owners] = await tx<{ n: number }[]>`
          select count(*)::int as n from memberships m join users u on u.id = m.user_id
          where m.org_id = ${orgId} and m.role = 'owner' and m.id <> ${target.id}
            and (m.checked_at >= ${since}::timestamptz or coalesce(u.last_sign_in_at >= ${since}::timestamptz, false))
        `
        let refusal = decideMemberChange(actor as MemberFacts, target as MemberFacts, change, owners!.n)
        if (refusal) return { ok: false, reason: refusal } as const
        if (change.kind === 'role') {
          await tx`update memberships set role = ${change.role} where id = ${target.id}`
          return { ok: true, role: change.role } as const
        }
        await tx`delete from memberships where id = ${target.id}`
        return { ok: true, role: null } as const
      })
    },

    async own(githubId, now) {
      let rows = await sql<(Omit<OwnInvitation, 'expiresAt'> & { expiresAt: string })[]>`
        select i.id, i.org_id as "orgId", o.name as "orgName", i.role, u.login as "inviterLogin", i.expires_at as "expiresAt"
        from invitations i join orgs o on o.id = i.org_id left join users u on u.id = i.inviter_id
        where i.github_id = ${githubId} and i.status = 'pending' and i.expires_at > ${at(now)}::timestamptz
          and exists (select 1 from installations s where s.org_id = i.org_id and s.suspended_at is null)
        order by i.created_at
      `
      return rows.map((r) => ({ ...r, expiresAt: new Date(r.expiresAt) }))
    },

    async accept(invitationId, user, now) {
      let [found] = await sql<{ orgId: string }[]>`select org_id as "orgId" from invitations where id = ${invitationId}`
      if (!found) return null
      return locked(found.orgId, async (tx) => {
        let [invitation] = await tx<{ orgId: string; role: InvitationRole }[]>`
          update invitations set status = 'accepted', responded_at = ${at(now)}::timestamptz
          where id = ${invitationId} and github_id = ${user.githubId} and status = 'pending' and expires_at > ${at(now)}::timestamptz
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
        if (current) return { orgId: invitation.orgId, role: current.role }
        await tx`
          insert into memberships (user_id, org_id, role, source, checked_at)
          values (${user.id}, ${invitation.orgId}, ${invitation.role}, 'invitation', now())
        `
        return { orgId: invitation.orgId, role: invitation.role }
      })
    },

    async decline(invitationId, githubId, now) {
      let rows = await sql`
        update invitations set status = 'declined', responded_at = ${at(now)}::timestamptz
        where id = ${invitationId} and github_id = ${githubId} and status = 'pending'
        returning id
      `
      return rows.length > 0
    },
  }
}
