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
    with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id)
    insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 1001, 2001, 'sakuga-software' from org returning org_id as id`
  let [repo] = await database.sql<{ id: string }[]>`
    insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
    values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 3001, 'sakuga-software/sakuga-review', true) returning id`
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
      ['assignment_rules', 'feedback', 'feedback_requests', 'finding_events', 'findings', 'installations', 'jobs', 'memberships', 'orgs', 'providers', 'pull_authors', 'pull_closures', 'queue_notices', 'repos', 'resolutions', 'reviews', 'rules', 'runner_registrations', 'runners', 'sessions', 'user_prefs', 'users', 'webhook_deliveries'],
    )
  })

  it('creates the index of the Repos list on the published reviews (REV-53)', async () => {
    let [row] = await database.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'public' and indexname = 'reviews_repo_published_idx'`
    assert.equal(
      row?.indexdef,
      'CREATE INDEX reviews_repo_published_idx ON public.reviews USING btree (repo_id, published_at DESC, id DESC) WHERE (github_review_id IS NOT NULL)',
    )
  })

  it('indexes the jobs by runner and end, and has no index by runner alone (REV-54, REV-65)', async () => {
    let rows = await database.sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'jobs' and indexname like 'jobs_runner%' order by indexname`
    assert.deepEqual([...rows], [
      {
        indexname: 'jobs_runner_finished_idx',
        indexdef: 'CREATE INDEX jobs_runner_finished_idx ON public.jobs USING btree (runner_id, finished_at)',
      },
    ])
  })

  it('applied a second time, changes nothing and keeps every row', async () => {
    await seed(database)
    let before = await counts(database)
    assert.deepEqual(before, { orgs: 1, repos: 1, jobs: 1, reviews: 1, applied: 30 })

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

      assert.deepEqual(await counts(database), { orgs: 1, repos: 1, jobs: 1, reviews: 1, applied: 31 })
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
      assert.equal(row!.applied, 29)
    } finally {
      await a.close()
      await other.drop()
    }
  })

  it('0010 keeps a level other than lite as the choice of the repository, and trusts sakuga-agent[bot] (REV-13)', async () => {
    let other = await createTestDatabase()
    let earlier = await mkdtemp(path.join(tmpdir(), 'kento-migrations-'))
    let check = createDatabase(other.url, { max: 1 })
    try {
      // The release before REV-13: every migration up to 0009.
      await cp(migrationsFolder, earlier, { recursive: true })
      let journalPath = path.join(earlier, 'meta', '_journal.json')
      let journal = JSON.parse(await readFile(journalPath, 'utf8'))
      journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag < '0010')
      await writeFile(journalPath, JSON.stringify(journal))
      await runMigrations(other.url, earlier)
      let [org] = await check.sql<{ id: string }[]>`
        insert into orgs (github_installation_id, github_account_id, login) values (1001, 2001, 'sakuga-software') returning id`
      await check.sql`
        insert into repos (org_id, github_repo_id, full_name, default_level, config) values
          (${org!.id}, 1, 'sakuga-software/heavy', 'heavy', '{"trigger":"ready"}'),
          (${org!.id}, 2, 'sakuga-software/lite', 'lite', '{}')`

      await runMigrations(other.url)
      let repos = await check.sql<{ full_name: string; config: unknown }[]>`select full_name, config from repos order by full_name`
      assert.deepEqual(
        repos.map((r) => [r.full_name, r.config]),
        [
          ['sakuga-software/heavy', { trigger: 'ready', level: 'heavy' }],
          ['sakuga-software/lite', {}],
        ],
      )
      let [settings] = await check.sql<{ trusted_bots: string[]; daily_cap_usd: string | null; cap_alert_pct: number }[]>`
        select trusted_bots, daily_cap_usd, cap_alert_pct from orgs`
      assert.deepEqual({ ...settings }, { trusted_bots: ['sakuga-agent[bot]'], daily_cap_usd: null, cap_alert_pct: 80 })
    } finally {
      await check.close()
      await rm(earlier, { recursive: true, force: true })
      await other.drop()
    }
  })

  it('0029 gives each org its installation, and each repository the installation of its org (KNT-150)', async () => {
    let other = await createTestDatabase()
    let earlier = await mkdtemp(path.join(tmpdir(), 'kento-migrations-'))
    let check = createDatabase(other.url, { max: 1 })
    try {
      // The release before KNT-150: every migration up to 0028, with the data of a running service.
      await cp(migrationsFolder, earlier, { recursive: true })
      let journalPath = path.join(earlier, 'meta', '_journal.json')
      let journal = JSON.parse(await readFile(journalPath, 'utf8'))
      journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag < '0029')
      await writeFile(journalPath, JSON.stringify(journal))
      await runMigrations(other.url, earlier)
      let sql = check.sql
      // Acme installed the App, uninstalled it, and installed it again: two orgs with the same login.
      let orgs = await sql<{ id: string; login: string }[]>`
        insert into orgs (github_installation_id, github_account_id, login, suspended_at, created_at, daily_cap_usd, trusted_bots) values
          (101, 201, 'Acme', now() - interval '20 days', now() - interval '30 days', 5, '{renovate[bot]}'),
          (102, 201, 'acme', null, now() - interval '10 days', null, '{sakuga-agent[bot]}'),
          (103, 203, 'globex', now() - interval '1 day', now() - interval '5 days', null, '{}'),
          (104, 204, 'Initech', null, now(), null, '{}')
        returning id, login`
      let [first, second, globex, initech] = orgs.map((o) => o.id)
      await sql`
        insert into repos (org_id, github_repo_id, full_name, enabled) values
          (${first!}, 1, 'acme/old', false), (${second!}, 2, 'acme/api', true), (${second!}, 3, 'acme/web', true),
          (${globex!}, 4, 'globex/app', true)`
      let [user] = await sql<{ id: string }[]>`insert into users (github_id, login) values (7, 'octocat') returning id`
      await sql`insert into memberships (user_id, org_id, role) values (${user!.id}, ${second!}, 'admin'), (${user!.id}, ${globex!}, 'member')`
      await sql`insert into sessions (id_hash, user_id, data, expires_at) values ('hash', ${user!.id}, '[{},{}]', now() + interval '1 day')`
      await sql`insert into runners (org_id, name, token_hash) values (${second!}, 'runner-1', 'token-hash-1')`
      await sql`insert into rules (org_id, title, body) values (${second!}, 'No secret in the logs', 'No token.')`

      await runMigrations(other.url)

      let installations = await sql<{ orgId: string; githubInstallationId: string; githubAccountId: string; accountLogin: string; suspended: boolean }[]>`
        select org_id as "orgId", github_installation_id::text as "githubInstallationId", github_account_id::text as "githubAccountId",
          account_login as "accountLogin", suspended_at is not null as suspended
        from installations order by github_installation_id`
      assert.deepEqual(
        installations.map((i) => ({ ...i })),
        [
          { orgId: first!, githubInstallationId: '101', githubAccountId: '201', accountLogin: 'Acme', suspended: true },
          { orgId: second!, githubInstallationId: '102', githubAccountId: '201', accountLogin: 'acme', suspended: false },
          { orgId: globex!, githubInstallationId: '103', githubAccountId: '203', accountLogin: 'globex', suspended: true },
          { orgId: initech!, githubInstallationId: '104', githubAccountId: '204', accountLogin: 'Initech', suspended: false },
        ],
      )
      // Every org keeps its id and its settings; the later Acme takes its installation id as a suffix.
      let after = await sql<{ id: string; name: string; slug: string; dailyCapUsd: string | null; trustedBots: string[] }[]>`
        select id, name, slug, daily_cap_usd as "dailyCapUsd", trusted_bots as "trustedBots" from orgs order by created_at`
      assert.deepEqual(
        after.map((o) => ({ ...o })),
        [
          { id: first!, name: 'Acme', slug: 'acme', dailyCapUsd: '5.00', trustedBots: ['renovate[bot]'] },
          { id: second!, name: 'acme', slug: 'acme-102', dailyCapUsd: null, trustedBots: ['sakuga-agent[bot]'] },
          { id: globex!, name: 'globex', slug: 'globex', dailyCapUsd: null, trustedBots: [] },
          { id: initech!, name: 'Initech', slug: 'initech', dailyCapUsd: null, trustedBots: [] },
        ],
      )
      let repos = await sql<{ fullName: string; orgId: string; githubInstallationId: string }[]>`
        select repos.full_name as "fullName", repos.org_id as "orgId", installations.github_installation_id::text as "githubInstallationId"
        from repos join installations on installations.id = repos.installation_id order by repos.github_repo_id`
      assert.deepEqual(
        repos.map((r) => ({ ...r })),
        [
          { fullName: 'acme/old', orgId: first!, githubInstallationId: '101' },
          { fullName: 'acme/api', orgId: second!, githubInstallationId: '102' },
          { fullName: 'acme/web', orgId: second!, githubInstallationId: '102' },
          { fullName: 'globex/app', orgId: globex!, githubInstallationId: '103' },
        ],
      )
      // The rest of the data of the orgs stays as it was: members, sessions, runners, rules.
      let [kept] = await sql<{ memberships: number; sessions: number; runners: number; rules: number }[]>`
        select (select count(*)::int from memberships) as memberships, (select count(*)::int from sessions) as sessions,
          (select count(*)::int from runners where org_id = ${second!}) as runners, (select count(*)::int from rules where org_id = ${second!}) as rules`
      assert.deepEqual({ ...kept }, { memberships: 2, sessions: 1, runners: 1, rules: 1 })
      let columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_schema = 'public' and table_name = 'orgs'
          and column_name in ('github_installation_id', 'github_account_id', 'login', 'suspended_at')`
      assert.deepEqual([...columns], [], 'the installation columns left orgs')
      // A repository cannot take the installation of another org.
      let [globexInstallation] = await sql<{ id: string }[]>`select id from installations where org_id = ${globex!}`
      await assert.rejects(
        sql`insert into repos (org_id, installation_id, github_repo_id, full_name) values (${second!}, ${globexInstallation!.id}, 9, 'acme/x')`,
        /repos_installation_org_fk/,
      )
    } finally {
      await check.close()
      await rm(earlier, { recursive: true, force: true })
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
        assert.equal(row!.applied, 30)
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
    assert.equal(body.database.migrations, 29)
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
