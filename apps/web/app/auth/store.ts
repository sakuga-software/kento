import type postgres from 'postgres'

import type { MembershipSource, OrgRole } from '../db/schema.ts'
import type { InstallationAccount } from './github.ts'

export interface UserRow {
  id: string
  githubId: number
  login: string
  name: string | null
  avatarUrl: string | null
}

/**
 * An org of Kentō that has at least one installation that is not suspended. GitHub gives the role of
 * a person in it through those installations.
 */
export interface OrgRow {
  id: string
  name: string
  installations: OrgInstallation[]
}

/** An installation of an org: its row in `installations`, and its GitHub account. */
export interface OrgInstallation extends InstallationAccount {
  id: string
}

export interface MembershipRow {
  org: OrgRow
  role: OrgRole
  source: MembershipSource
  /** When GitHub last confirmed a membership of `source = github`. */
  checkedAt: Date
}

/** What the sign-in and the screens read and write about people. Tests of the routes can pass a fake. */
export interface AuthStore {
  findUser(userId: string): Promise<UserRow | null>
  /** KNT-150. Better Auth writes the user; this keeps the time of the sign-in. */
  touchSignIn(userId: string): Promise<void>
  /** KNT-150. The org on screen of a session. */
  setActiveOrg(sessionId: string, orgId: string): Promise<void>
  /** KNT-150. Ends a session: a person with no org left, or a session that a new sign-in replaced. */
  deleteSession(sessionId: string): Promise<void>
  /** Deletes the expired sessions and sign-ins. The server calls it every hour. */
  sweep(): Promise<number>
  /** The orgs that have an installation of the App that is not suspended. */
  activeOrgs(): Promise<OrgRow[]>
  /** The memberships of a user, in the orgs that are still active, by org name. */
  memberships(userId: string): Promise<MembershipRow[]>
  /**
   * Writes the role of a user in an org, checked now. An invitation turns a membership from GitHub
   * into one from an invitation; a write from GitHub never changes the role nor the source of a
   * membership from an invitation. Gives the role that the row holds after the write.
   */
  saveMembership(userId: string, orgId: string, role: OrgRole, source?: MembershipSource): Promise<OrgRole>
  /**
   * KNT-150. The org has an active owner other than `exceptUserId`: one whose membership was
   * checked, or who signed in, at `since` or after.
   */
  hasOwner(orgId: string, since: Date, exceptUserId?: string): Promise<boolean>
  /** KNT-150. The role and the source of a membership, as stored. */
  membershipOf(userId: string, orgId: string): Promise<{ role: OrgRole; source: MembershipSource } | null>
  /** KNT-150. Runs `work` in one transaction that holds the lock of the owners of the org. */
  withOrgLock<T>(orgId: string, work: (store: AuthStore) => Promise<T>): Promise<T>
  /** KNT-150. The active orgs where the user of a GitHub account is a member from an invitation. */
  invitedOrgs(githubId: number): Promise<OrgRow[]>
  /** KNT-150. The pending invitations of a GitHub account, not expired, in the active orgs. */
  pendingInvitations(githubId: number): Promise<number>
  deleteMembership(userId: string, orgId: string): Promise<void>
}

/** KNT-150. The key of the advisory lock of the owners of an org: every change of a role takes it. */
export function orgLockKey(orgId: string): string {
  return `kento.org_owners:${orgId}`
}

/** `locked`: the org of the `withOrgLock` whose transaction this store runs in. */
export function createAuthStore(sql: postgres.Sql, locked: string | null = null): AuthStore {
  let store: AuthStore = {
    async findUser(userId) {
      let [row] = await sql<UserRow[]>`
        select id, github_id::float8 as "githubId", login, name, avatar_url as "avatarUrl"
        from users where id = ${userId}
      `
      return row ?? null
    },

    async touchSignIn(userId) {
      await sql`update users set last_sign_in_at = now() where id = ${userId}`
    },

    async setActiveOrg(sessionId, orgId) {
      await sql`update sessions set active_organization_id = ${orgId}, updated_at = now() where id = ${sessionId}`
    },

    async deleteSession(sessionId) {
      await sql`delete from sessions where id = ${sessionId}`
    },

    async sweep() {
      let sessions = await sql`delete from sessions where expires_at <= now() returning 1`
      let pending = await sql`delete from verifications where expires_at <= now() returning 1`
      return sessions.length + pending.length
    },

    async activeOrgs() {
      return readOrgs(sql, null)
    },

    async memberships(userId) {
      let rows = await sql<{ orgId: string; role: OrgRole; source: MembershipSource; checkedAt: Date }[]>`
        select org_id as "orgId", role, source, checked_at as "checkedAt" from memberships where user_id = ${userId}
      `
      let orgs = new Map((await readOrgs(sql, rows.map((r) => r.orgId))).map((org) => [org.id, org]))
      // drizzle shares this client and turns off its date conversion: a timestamp comes back as text.
      return rows
        .flatMap(({ orgId, role, source, checkedAt }) => {
          let org = orgs.get(orgId)
          return org ? [{ org, role, source, checkedAt: new Date(checkedAt) }] : []
        })
        .sort((a, b) => a.org.name.localeCompare(b.org.name))
    },

    async saveMembership(userId, orgId, role, source = 'github') {
      let [row] = await sql<{ role: OrgRole }[]>`
        insert into memberships (user_id, org_id, role, source, checked_at)
        values (${userId}, ${orgId}, ${role}, ${source}, now())
        on conflict (user_id, org_id) do update set
          role = case when memberships.source = 'invitation' and excluded.source = 'github' then memberships.role else excluded.role end,
          source = case when excluded.source = 'invitation' then 'invitation' else memberships.source end,
          checked_at = now()
        returning role
      `
      return row!.role
    },

    async invitedOrgs(githubId) {
      let rows = await sql<{ orgId: string }[]>`
        select m.org_id as "orgId" from memberships m join users u on u.id = m.user_id
        where u.github_id = ${githubId} and m.source = 'invitation'
      `
      return readOrgs(sql, rows.map((r) => r.orgId))
    },

    async membershipOf(userId, orgId) {
      let [row] = await sql<{ role: OrgRole; source: MembershipSource }[]>`
        select role, source from memberships where user_id = ${userId} and org_id = ${orgId}
      `
      return row ?? null
    },

    async pendingInvitations(githubId) {
      let [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from invitations i
        where i.github_id = ${githubId} and i.status = 'pending' and i.expires_at > now()
          and exists (select 1 from installations s where s.org_id = i.org_id and s.suspended_at is null)
      `
      return row!.n
    },

    async hasOwner(orgId, since, exceptUserId) {
      // drizzle shares this client and turns off its date conversion: the time goes as text.
      let [row] = await sql`
        select 1 from memberships m join users u on u.id = m.user_id
        where m.org_id = ${orgId} and m.role = 'owner' ${exceptUserId ? sql`and m.user_id <> ${exceptUserId}` : sql``}
          and (m.checked_at >= ${since.toISOString()}::timestamptz or u.last_sign_in_at >= ${since.toISOString()}::timestamptz)
        limit 1
      `
      return row !== undefined
    },

    async withOrgLock(orgId, work) {
      // The store of a `withOrgLock` is in its transaction already: it takes the lock of this org
      // there too (the lock of the same org again is a no-op), and runs.
      if (locked !== null) {
        // One org per transaction: a second lock could be taken in another order by another
        // request, and the two would wait on each other.
        if (orgId !== locked) throw new Error(`withOrgLock: the lock of ${locked} is held, not the one of ${orgId}`)
        return work(store)
      }
      return (await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${orgLockKey(orgId)}, 0))`
        return work(createAuthStore(tx as unknown as postgres.Sql, orgId))
      })) as Awaited<ReturnType<typeof work>>
    },

    async deleteMembership(userId, orgId) {
      await sql`delete from memberships where user_id = ${userId} and org_id = ${orgId}`
      // KNT-150. The invitations that the person made there and nobody answered yet go with them.
      await sql`
        update invitations set status = 'canceled', responded_at = now()
        where org_id = ${orgId} and inviter_id = ${userId} and status = 'pending'`
    },
  }
  return store
}

/**
 * The orgs with at least one installation that is not suspended, by name, each one with those
 * installations. `ids`: only these orgs; null: every one.
 */
async function readOrgs(sql: postgres.Sql, ids: string[] | null): Promise<OrgRow[]> {
  if (ids !== null && ids.length === 0) return []
  let rows = await sql<{ orgId: string; name: string; id: string; githubInstallationId: number; githubAccountId: number; login: string }[]>`
    select o.id as "orgId", o.name, i.id, i.github_installation_id::float8 as "githubInstallationId",
           i.github_account_id::float8 as "githubAccountId", i.account_login as login
    from orgs o join installations i on i.org_id = o.id
    where i.suspended_at is null ${ids === null ? sql`` : sql`and o.id in ${sql(ids)}`}
    order by o.name, o.id, i.github_installation_id
  `
  let orgs = new Map<string, OrgRow>()
  for (let { orgId, name, ...installation } of rows) {
    let org = orgs.get(orgId) ?? { id: orgId, name, installations: [] }
    org.installations.push(installation)
    orgs.set(orgId, org)
  }
  return [...orgs.values()]
}
