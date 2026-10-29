import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { createDatabaseCheck } from '../../app/db/health.ts'
import { migrationsFolder, runMigrations } from '../../app/db/migrate.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase } from './helpers.ts'

async function counts(database: Database) {
  let [row] = await database.sql<{ orgs: number; repos: number; jobs: number; reviews: number; applied: number }[]>`
    select
      (select count(*)::int from orgs) as orgs,
      (select count(*)::int from repos) as repos,
      (select count(*)::int from jobs) as jobs,
      (select count(*)::int from reviews) as reviews,
      (select count(*)::int from drizzle.__drizzle_migrations) as applied
  `
  return row
}

async function seed(database: Database) {
  let [org] = await database.sql<{ id: string }[]>`
    insert into orgs (github_installation_id, github_account_id, login)
    values (1001, 2001, 'sakuga-software') returning id`
  let [repo] = await database.sql<{ id: string }[]>`
    insert into repos (org_id, github_repo_id, full_name, enabled)
    values (${org!.id}, 3001, 'sakuga-software/sakuga-review', true) returning id`
  let [job] = await database.sql<{ id: string }[]>`
    insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id)
    values (${repo!.id}, 'lite', 24, 'abc1234', 'delivery-1') returning id`
  await database.sql`
    insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
    values (${job!.id}, ${repo!.id}, 24, 'abc1234', 4, 'claude-haiku-5-5', 0.0123, ${JSON.stringify({ findings: [] })}::jsonb)`
}

describe('migrations', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database

  before(async () => {
    test = await createTestDatabase()
    database = createDatabase(test.url, { max: 2 })
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('creates the tables of M2 and of the sign-in on an empty database', async () => {
    await runMigrations(test.url)
    let tables = await database.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`
    assert.deepEqual(
      tables.map((t) => t.table_name),
      ['jobs', 'memberships', 'orgs', 'repos', 'resolutions', 'reviews', 'runner_registrations', 'runners', 'sessions', 'users'],
    )
  })

  it('applied a second time, changes nothing and keeps every row', async () => {
    await seed(database)
    let before = await counts(database)
    assert.deepEqual(before, { orgs: 1, repos: 1, jobs: 1, reviews: 1, applied: 7 })

    await runMigrations(test.url)

    assert.deepEqual(await counts(database), before)
  })

  it('a new migration at the next deploy keeps every row', async () => {
    // The folder of the next release: the migrations of this one, plus one that adds a column.
    let next = await mkdtemp(path.join(tmpdir(), 'kento-migrations-'))
    try {
      await cp(migrationsFolder, next, { recursive: true })
      let journalPath = path.join(next, 'meta', '_journal.json')
      let journal = JSON.parse(await readFile(journalPath, 'utf8'))
      let last = journal.entries.at(-1)
      journal.entries.push({
        idx: last.idx + 1,
        version: last.version,
        when: last.when + 1000,
        tag: '9999_test_next_release',
        breakpoints: true,
      })
      await writeFile(journalPath, JSON.stringify(journal))
      await writeFile(
        path.join(next, '9999_test_next_release.sql'),
        `ALTER TABLE "repos" ADD COLUMN "note" text DEFAULT 'kept' NOT NULL;`,
      )

      await runMigrations(test.url, next)
      await runMigrations(test.url, next)

      assert.deepEqual(await counts(database), { orgs: 1, repos: 1, jobs: 1, reviews: 1, applied: 8 })
      let [repo] = await database.sql<{ full_name: string; note: string }[]>`select full_name, note from repos`
      assert.deepEqual({ ...repo }, { full_name: 'sakuga-software/sakuga-review', note: 'kept' })
    } finally {
      await rm(next, { recursive: true, force: true })
    }
  })

  it('two instances that migrate together apply each migration once', async () => {
    let other = await createTestDatabase()
    let a = createDatabase(other.url, { max: 1 })
    try {
      await Promise.all([runMigrations(other.url), runMigrations(other.url)])
      let [row] = await a.sql<{ applied: number }[]>`select count(*)::int as applied from drizzle.__drizzle_migrations`
      assert.equal(row!.applied, 7)
    } finally {
      await a.close()
      await other.drop()
    }
  })

  it('a failed migration releases the lock for the next attempt', async () => {
    let other = await createTestDatabase()
    let broken = await mkdtemp(path.join(tmpdir(), 'kento-migrations-'))
    try {
      await cp(migrationsFolder, broken, { recursive: true })
      let first = (await readdir(broken)).find((name) => name.endsWith('.sql'))!
      await writeFile(path.join(broken, first), 'select * from table_that_does_not_exist;')

      await assert.rejects(runMigrations(other.url, broken), /table_that_does_not_exist/)

      // A lock left behind would make this call wait forever, and the test time out.
      await runMigrations(other.url)
      let check = createDatabase(other.url, { max: 1 })
      try {
        let [row] = await check.sql<{ applied: number }[]>`select count(*)::int as applied from drizzle.__drizzle_migrations`
        assert.equal(row!.applied, 7)
      } finally {
        await check.close()
      }
    } finally {
      await rm(broken, { recursive: true, force: true })
      await other.drop()
    }
  })
})

describe('GET /healthz against Postgres', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database

  before(async () => {
    test = await createTestDatabase()
    database = createDatabase(test.url, { max: 2 })
    await runMigrations(test.url)
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('returns 200 with the version and the number of applied migrations', async () => {
    let router = createAppRouter({
      checkDatabase: createDatabaseCheck(database.sql),
      version: '0.1.0',
      commit: null,
      webhook: disabledWebhook,
    })

    let response = await router.fetch(new URL('/healthz', 'http://localhost'))
    let body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.status, 'ok')
    assert.equal(body.version, '0.1.0')
    assert.equal(body.database.status, 'ok')
    assert.equal(body.database.migrations, 7)
  })

  it('returns 503 when the database was never migrated', async () => {
    let empty = await createTestDatabase()
    let emptyDatabase = createDatabase(empty.url, { max: 1 })
    try {
      let router = createAppRouter({
        checkDatabase: createDatabaseCheck(emptyDatabase.sql),
        version: '0.1.0',
        commit: null,
        webhook: disabledWebhook,
      })
      let response = await router.fetch(new URL('/healthz', 'http://localhost'))
      let body = await response.json()
      assert.equal(response.status, 503)
      // 42P01: the table of the applied migrations does not exist.
      assert.equal(body.database.error, '42P01')
    } finally {
      await emptyDatabase.close()
      await empty.drop()
    }
  })
})
