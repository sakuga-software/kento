import type postgres from 'postgres'

import type { GitHubProfile, InstallationAccount, OrgRole } from './github.ts'

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
  checkedAt: Date
}

/** What the sign-in and the screens read and write about people. Tests of the routes can pass a fake. */
export interface AuthStore {
  /** Creates the user of a GitHub account, or updates its login, name and avatar. */
  upsertUser(profile: GitHubProfile): Promise<UserRow>
  findUser(userId: string): Promise<UserRow | null>
  /** The orgs that have an installation of the App that is not suspended. */
  activeOrgs(): Promise<OrgRow[]>
  /** The memberships of a user, in the orgs that are still active, by org name. */
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
      return readOrgs(sql, null)
    },

    async memberships(userId) {
      let rows = await sql<{ orgId: string; role: OrgRole; checkedAt: Date }[]>`
        select org_id as "orgId", role, checked_at as "checkedAt" from memberships where user_id = ${userId}
      `
      let orgs = new Map((await readOrgs(sql, rows.map((r) => r.orgId))).map((org) => [org.id, org]))
      // drizzle shares this client and turns off its date conversion: a timestamp comes back as text.
      return rows
        .flatMap(({ orgId, role, checkedAt }) => {
          let org = orgs.get(orgId)
          return org ? [{ org, role, checkedAt: new Date(checkedAt) }] : []
        })
        .sort((a, b) => a.org.name.localeCompare(b.org.name))
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
