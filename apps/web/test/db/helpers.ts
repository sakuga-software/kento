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
 * The org of installation `installationId` and its repository `sakuga-software/sakuga-review` (3001),
 * enabled, as an admin leaves it on the Repos screen. An event of GitHub never enables a repository.
 */
export async function seedEnabledRepo(sql: postgres.Sql, installationId = 1001): Promise<{ orgId: string; repoId: string }> {
  let [org] = await sql<{ id: string }[]>`
    insert into orgs (github_installation_id, github_account_id, login)
    values (${installationId}, 2001, 'sakuga-software')
    on conflict (github_installation_id) do update set login = excluded.login
    returning id`
  let [repo] = await sql<{ id: string }[]>`
    insert into repos (org_id, github_repo_id, full_name, enabled)
    values (${org!.id}, 3001, 'sakuga-software/sakuga-review', true)
    on conflict (github_repo_id) do update set enabled = true
    returning id`
  return { orgId: org!.id, repoId: repo!.id }
}
