import { randomBytes } from 'node:crypto'

import postgres from 'postgres'

/**
 * Creates an empty database for one test file on the server of `TEST_DATABASE_URL`, and drops it at
 * the end. The tests never touch the database of the URL itself.
 */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  let adminUrl = process.env.TEST_DATABASE_URL
  if (!adminUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start a Postgres container and set it, see apps/web/README.md.',
    )
  }
  let name = `kento_test_${randomBytes(6).toString('hex')}`
  let admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create database ${name}`)
  let url = new URL(adminUrl)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    async drop() {
      await admin.unsafe(`drop database if exists ${name} with (force)`)
      await admin.end({ timeout: 5 })
    },
  }
}

/**
 * KNT-150. A new org and its one installation of the App; returns the id of the org. The name and
 * the slug of the org are the login of the account.
 */
export async function insertOrg(
  sql: postgres.Sql,
  login: string,
  installationId: number,
  accountId: number = installationId + 1000,
  options: { suspended?: boolean } = {},
): Promise<string> {
  let [row] = await sql<{ id: string }[]>`
    with org as (insert into orgs (name, slug) values (${login}, ${login.toLowerCase()}) returning id)
    insert into installations (org_id, github_installation_id, github_account_id, account_login, suspended_at)
    select id, ${installationId}, ${accountId}, ${login}, ${options.suspended ? new Date().toISOString() : null} from org
    returning org_id as id`
  return row!.id
}

/** The installation of an org that `insertOrg` made: its id in `installations`. */
export async function installationOf(sql: postgres.Sql, orgId: string): Promise<string> {
  let [row] = await sql<{ id: string }[]>`select id from installations where org_id = ${orgId} order by created_at limit 1`
  return row!.id
}

/**
 * The same org and repository as `seedEnabledRepo`, on the schema before migration 0029 (KNT-150):
 * the installation is in `orgs`. For the tests of a migration that run an earlier release first.
 */
export async function seedEnabledRepoBefore0029(sql: postgres.Sql): Promise<{ orgId: string; repoId: string }> {
  let [org] = await sql<{ id: string }[]>`
    insert into orgs (github_installation_id, github_account_id, login) values (1001, 2001, 'sakuga-software') returning id`
  let [repo] = await sql<{ id: string }[]>`
    insert into repos (org_id, github_repo_id, full_name, enabled)
    values (${org!.id}, 3001, 'sakuga-software/sakuga-review', true) returning id`
  return { orgId: org!.id, repoId: repo!.id }
}

/**
 * The org of installation `installationId` and its repository `sakuga-software/sakuga-review` (3001),
 * enabled, as an admin leaves it on the Repos screen. An event of GitHub never enables a repository.
 */
export async function seedEnabledRepo(sql: postgres.Sql, installationId = 1001): Promise<{ orgId: string; repoId: string }> {
  let [known] = await sql<{ orgId: string }[]>`
    select org_id as "orgId" from installations where github_installation_id = ${installationId}`
  let orgId = known?.orgId ?? (await insertOrg(sql, 'sakuga-software', installationId, 2001))
  let [repo] = await sql<{ id: string }[]>`
    insert into repos (org_id, installation_id, installation_id, github_repo_id, full_name, enabled)
    values (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), ${await installationOf(sql, orgId)}, 3001, 'sakuga-software/sakuga-review', true)
    on conflict (github_repo_id) do update set enabled = true
    returning id`
  return { orgId, repoId: repo!.id }
}
