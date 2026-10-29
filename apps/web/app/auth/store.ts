import type postgres from 'postgres'

import type { GitHubProfile, OrgAccount, OrgRole } from './github.ts'

export interface UserRow {
  id: string
  githubId: number
  login: string
  name: string | null
  avatarUrl: string | null
}

export interface OrgRow extends OrgAccount {
  id: string
}

export interface MembershipRow {
  org: OrgRow
  role: OrgRole
  checkedAt: Date
}

/** What the sign-in and the screens read and write about people. Tests of the routes can pass a fake. */
export interface AuthStore {
  /** Creates the user of a GitHub account, or updates its login, name and avatar. */
  upsertUser(profile: GitHubProfile): Promise<UserRow>
  findUser(userId: string): Promise<UserRow | null>
  /** The orgs where the App is installed and not suspended. */
  activeOrgs(): Promise<OrgRow[]>
  /** The memberships of a user, in the orgs that are still active, by org login. */
  memberships(userId: string): Promise<MembershipRow[]>
  /** Writes the role of a user in an org, checked now. */
  saveMembership(userId: string, orgId: string, role: OrgRole): Promise<void>
  deleteMembership(userId: string, orgId: string): Promise<void>
}

export function createAuthStore(sql: postgres.Sql): AuthStore {
  return {
    async upsertUser(profile) {
      let [row] = await sql<UserRow[]>`
        insert into users (github_id, login, name, avatar_url, last_sign_in_at)
        values (${profile.id}, ${profile.login}, ${profile.name}, ${profile.avatarUrl}, now())
        on conflict (github_id) do update
          set login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
              last_sign_in_at = now(), updated_at = now()
        returning id, github_id::float8 as "githubId", login, name, avatar_url as "avatarUrl"
      `
      return row!
    },

    async findUser(userId) {
      let [row] = await sql<UserRow[]>`
        select id, github_id::float8 as "githubId", login, name, avatar_url as "avatarUrl"
        from users where id = ${userId}
      `
      return row ?? null
    },

    async activeOrgs() {
      return sql<OrgRow[]>`
        select id, github_installation_id::float8 as "githubInstallationId",
               github_account_id::float8 as "githubAccountId", login
        from orgs where suspended_at is null
        order by login
      `
    },

    async memberships(userId) {
      let rows = await sql<
        { role: OrgRole; checkedAt: Date; id: string; githubInstallationId: number; githubAccountId: number; login: string }[]
      >`
        select m.role, m.checked_at as "checkedAt", o.id, o.github_installation_id::float8 as "githubInstallationId",
               o.github_account_id::float8 as "githubAccountId", o.login
        from memberships m join orgs o on o.id = m.org_id
        where m.user_id = ${userId} and o.suspended_at is null
        order by o.login
      `
      // drizzle shares this client and turns off its date conversion: a timestamp comes back as text.
      return rows.map(({ role, checkedAt, ...org }) => ({ role, checkedAt: new Date(checkedAt), org }))
    },

    async saveMembership(userId, orgId, role) {
      await sql`
        insert into memberships (user_id, org_id, role, checked_at)
        values (${userId}, ${orgId}, ${role}, now())
        on conflict (user_id, org_id) do update set role = excluded.role, checked_at = now()
      `
    },

    async deleteMembership(userId, orgId) {
      await sql`delete from memberships where user_id = ${userId} and org_id = ${orgId}`
    },
  }
}
