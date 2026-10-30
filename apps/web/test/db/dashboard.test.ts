import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import * as schema from '../../app/db/schema.ts'
import { readOrgCosts, SERVICE_KEY_LABEL } from '../../app/db/costs.ts'
import { createDashboardStore, type DashboardStore } from '../../app/dashboard/store.ts'
import { createTestDatabase } from './helpers.ts'

const HEAD = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)

// REV-14: what the dashboard reads for one org, and « Relancer », against a real Postgres.
describe('the dashboard of an org', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let store: DashboardStore
  let org: string
  let otherOrg: string
  let repo: string
  let otherRepo: string
  let runner: string

  async function job(fields: {
    repoId?: string
    state?: string
    level?: string
    kind?: string
    pr?: number
    head?: string
    reason?: string | null
    attempts?: number
    createdAgo?: string
    finishedAgo?: string | null
    startedAgo?: string | null
    runnerId?: string | null
    providerId?: string | null
  }): Promise<string> {
    let [row] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, failure_reason, attempts,
        created_at, started_at, finished_at, runner_id, provider_id, lease_expires_at)
      values (${fields.repoId ?? repo}, ${fields.kind ?? 'review'}, ${fields.level ?? 'lite'}, ${fields.state ?? 'done'},
        ${fields.pr ?? 12}, ${fields.head ?? HEAD}, 'main', ${fields.reason ?? null}, ${fields.attempts ?? 1},
        now() - ${fields.createdAgo ?? '10 minutes'}::interval,
        case when ${fields.startedAgo ?? null}::text is null then null else now() - ${fields.startedAgo ?? '0 s'}::interval end,
        case when ${fields.finishedAgo ?? null}::text is null then null else now() - ${fields.finishedAgo ?? '0 s'}::interval end,
        ${fields.runnerId ?? null}, ${fields.providerId ?? null},
        case when ${fields.state ?? 'done'} = 'running' then now() + interval '2 minutes' end)
      returning id`
    return row!.id
  }

  async function review(jobId: string, fields: { cost?: number | null; publishedAgo?: string | null; createdAgo?: string; score?: number; costSource?: string } = {}) {
    let [j] = await database.sql<{ repoId: string; pr: number; head: string }[]>`
      select repo_id as "repoId", pr_number as pr, head_sha as head from jobs where id = ${jobId}`
    let result = { verdict: 'COMMENT', findings: [{}, {}, {}], costSource: fields.costSource ?? 'provider' }
    await database.sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at, created_at)
      values (${jobId}, ${j!.repoId}, ${j!.pr}, ${j!.head}, ${fields.score ?? 4}, 'm', ${fields.cost === undefined ? 0.1 : fields.cost},
        ${JSON.stringify(result)}::text::jsonb,
        case when ${fields.publishedAgo === undefined ? '1 minute' : fields.publishedAgo}::text is null then null
          else now() - ${fields.publishedAgo ?? '1 minute'}::interval end,
        now() - ${fields.createdAgo ?? '2 minutes'}::interval)`
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    store = createDashboardStore(database)
    let [a] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (91, 2001, 'sakuga-software') returning id`
    let [b] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (92, 2002, 'orchard') returning id`
    org = a!.id
    otherOrg = b!.id
    let [r1] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled, workflow) values (${org}, 4001, 'sakuga-software/app', true, 'reusable') returning id`
    let [r2] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled) values (${otherOrg}, 4002, 'orchard/app', true) returning id`
    repo = r1!.id
    otherRepo = r2!.id
    let [r] = await database.sql<{ id: string }[]>`
      insert into runners (org_id, name, token_hash, last_seen_at) values (${org}, 'runners-host', 'hash-1', now()) returning id`
    runner = r!.id
    await database.sql`insert into runners (org_id, name, token_hash, last_seen_at) values (${otherOrg}, 'not-mine', 'hash-2', now())`
  })

  beforeEach(async () => {
    await database.sql`delete from jobs`
    await database.sql`delete from providers`
  })

  after(async () => {
    await database.close()
    await test.drop()
  })

  it('reads the steps of « Mise en route » for the org only, until a review of the org is published (REV-26)', async () => {
    let setup = async () => (await store.screen(org)).setup
    assert.deepEqual(await setup(), { published: false, suspended: false, enabledRepos: 1, providers: 0, pendingRegistrations: 0 })

    await database.sql`
      insert into providers (id, org_id, kind, label, runner_held) values (gen_random_uuid(), ${org}, 'anthropic', 'Anthropic', true),
        (gen_random_uuid(), ${otherOrg}, 'anthropic', 'Other', true)`
    await database.sql`
      insert into runner_registrations (org_id, name, trusted, token_hash, expires_at) values
        (${org}, 'pending', true, 'reg-1', now() + interval '30 minutes'),
        (${org}, 'expired', true, 'reg-2', now() - interval '1 minute'),
        (${otherOrg}, 'other', true, 'reg-3', now() + interval '30 minutes')`
    // A review published in another org, and a review of the org that is not published yet.
    await review(await job({ repoId: otherRepo }))
    await review(await job({}), { publishedAgo: null })
    await database.sql`update orgs set suspended_at = now() where id = ${otherOrg}`
    assert.deepEqual(await setup(), { published: false, suspended: false, enabledRepos: 1, providers: 1, pendingRegistrations: 1 })

    await review(await job({ pr: 13 }))
    await database.sql`update orgs set suspended_at = now() where id = ${org}`
    let after = await setup()
    assert.equal(after.published, true)
    assert.equal(after.suspended, true)
    await database.sql`update orgs set suspended_at = null`
    await database.sql`delete from runner_registrations`
  })

  it('shows the last failure with its reason, the review that stays published, and the estimates', async () => {
    let ok = await job({ level: 'lite', createdAgo: '3 hours', startedAgo: '3 hours', finishedAgo: '179 minutes' })
    await review(ok, { cost: 0.002, publishedAgo: '170 minutes', createdAgo: '175 minutes', score: 3 })
    let bal = await job({ level: 'balanced', pr: 99, createdAgo: '2 hours', finishedAgo: '2 hours' })
    await review(bal, { cost: 0.1, publishedAgo: '2 hours', createdAgo: '2 hours' })
    let bal2 = await job({ level: 'balanced', pr: 98, createdAgo: '2 hours', finishedAgo: '2 hours' })
    await review(bal2, { cost: 0.2, publishedAgo: '2 hours', createdAgo: '2 hours' })
    let failed = await job({ state: 'failed', reason: 'lease expired 2 times', attempts: 2, runnerId: runner, createdAgo: '30 minutes', finishedAgo: '5 minutes' })
    // A failure of the other org never shows here.
    await job({ repoId: otherRepo, state: 'failed', reason: 'theirs', finishedAgo: '1 minute', createdAgo: '1 minute' })

    let screen = await store.screen(org)
    assert.equal(screen.banner?.id, failed)
    assert.equal(screen.banner?.runnerName, 'runners-host')
    assert.equal(screen.banner?.reason, 'lease expired 2 times')
    assert.equal(screen.banner?.previous?.score, 3)
    assert.equal(screen.banner?.retry, null)
    assert.equal(screen.banner?.estimates.lite, 0.002)
    assert.ok(Math.abs(screen.banner!.estimates.balanced! - 0.15) < 1e-9)
    assert.equal(screen.banner?.estimates.heavy, null)
    assert.deepEqual(screen.failures.map((f) => f.id), [failed])
    assert.deepEqual(screen.workflowRepos, ['sakuga-software/app'])
    assert.deepEqual(screen.runners.map((r) => r.name), ['runners-host'])
  })

  it('« Relancer » queues a review of the same head; the banner says it, then goes when its review is published', async () => {
    let failed = await job({ state: 'failed', reason: 'lease expired 3 times', attempts: 3, finishedAgo: '5 minutes', createdAgo: '30 minutes' })
    let outcome = await store.retry(org, failed, 'balanced', null)
    assert.equal(outcome.kind, 'queued')
    let jobId = (outcome as { jobId: string }).jobId
    let [queued] = await database.sql<{ state: string; level: string; head: string; baseRef: string; prNumber: number; config: { models: unknown } | null }[]>`
      select state, level, head_sha as head, base_ref as "baseRef", pr_number as "prNumber", config from jobs where id = ${jobId}`
    assert.equal(queued!.state, 'queued')
    assert.equal(queued!.level, 'balanced')
    assert.equal(queued!.head, HEAD)
    assert.equal(queued!.baseRef, 'main')
    assert.ok(queued!.config?.models, 'the job carries the config of today')

    // A second click finds the first job.
    assert.deepEqual(await store.retry(org, failed, 'balanced', null), { kind: 'already', jobId })

    let screen = await store.screen(org)
    assert.equal(screen.banner?.id, failed)
    assert.deepEqual(screen.banner?.retry, { id: jobId, level: 'balanced', state: 'queued' })
    assert.equal(screen.queue.queuedCount, 1)
    assert.equal(screen.queue.queued[0]!.id, jobId)

    // The runner takes it, and its review is published: the banner goes.
    await database.sql`update jobs set state = 'running', started_at = now(), runner_id = ${runner}, attempts = 1, lease_expires_at = now() + interval '2 minutes' where id = ${jobId}`
    let running = await store.screen(org)
    assert.equal(running.queue.runningCount, 1)
    assert.equal(running.queue.running[0]!.runnerName, 'runners-host')
    assert.equal(running.runners[0]!.running, 1)
    await database.sql`update jobs set state = 'done', finished_at = now(), lease_expires_at = null where id = ${jobId}`
    await review(jobId, { publishedAgo: '0 seconds', createdAgo: '0 seconds' })
    assert.equal((await store.screen(org)).banner, null)
  })

  it('« Relancer » freezes the models of the config of the org and of the repository in its job (REV-47)', async () => {
    // The retry reads the two `jsonb` configs through drizzle: they must reach readOverrides as objects.
    let opus = { provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: null }
    let sonnet = { provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: null }
    await database.sql`update orgs set config = ${JSON.stringify({ models: { lite: opus } })}::text::jsonb where id = ${org}`
    await database.sql`update repos set config = ${JSON.stringify({ models: { heavy: sonnet } })}::text::jsonb, config_version = 4 where id = ${repo}`
    try {
      let failed = await job({ state: 'failed', finishedAgo: '5 minutes', createdAgo: '20 minutes' })
      let lite = await store.retry(org, failed, 'lite', null)
      let heavy = await store.retry(org, failed, 'heavy', null)
      let configs = await database.sql<{ level: string; config: unknown }[]>`
        select level, config from jobs where id in (${(lite as { jobId: string }).jobId}, ${(heavy as { jobId: string }).jobId}) order by level desc`
      assert.deepEqual(configs.map((c) => [c.level, c.config]), [
        ['heavy', { repoConfigVersion: 4, models: sonnet, source: 'repo' }],
        ['lite', { repoConfigVersion: 4, models: opus, source: 'org' }],
      ])
    } finally {
      await database.sql`update orgs set config = '{}' where id = ${org}`
      await database.sql`update repos set config = '{}', config_version = 0 where id = ${repo}`
    }
  })

  it('refuses a retry of another org, of a job that did not fail, of a stale head, or of a disabled repository', async () => {
    let theirs = await job({ repoId: otherRepo, state: 'failed', finishedAgo: '1 minute' })
    assert.deepEqual(await store.retry(org, theirs, 'lite', null), { kind: 'not_found' })
    let done = await job({ state: 'done', finishedAgo: '1 minute' })
    assert.deepEqual(await store.retry(org, done, 'lite', null), { kind: 'not_found' })

    let failed = await job({ state: 'failed', finishedAgo: '5 minutes', createdAgo: '20 minutes' })
    await job({ state: 'queued', head: NEWER, createdAgo: '1 minute' })
    assert.deepEqual(await store.retry(org, failed, 'lite', null), { kind: 'stale' })

    await database.sql`delete from jobs`
    let again = await job({ state: 'failed', finishedAgo: '5 minutes' })
    await database.sql`update repos set enabled = false where id = ${repo}`
    try {
      assert.deepEqual(await store.retry(org, again, 'lite', null), { kind: 'not_found' })
    } finally {
      await database.sql`update repos set enabled = true where id = ${repo}`
    }
    let count = await database.sql`select 1 from jobs where state = 'queued'`
    assert.equal(count.length, 0)
  })

  it('queues no retry once the org reached its cost limit (REV-13)', async () => {
    let spent = await job({ pr: 40, createdAgo: '5 minutes' })
    await review(spent, { cost: 0.5, createdAgo: '1 minute' })
    let failed = await job({ state: 'failed', finishedAgo: '1 minute', createdAgo: '3 minutes' })
    await database.sql`update orgs set daily_cap_usd = 0.5 where id = ${org}`
    try {
      assert.deepEqual(await store.retry(org, failed, 'lite', HEAD), { kind: 'capped', period: 'day' })
      assert.equal((await database.sql`select 1 from jobs where state = 'queued'`).length, 0)
      await database.sql`update orgs set daily_cap_usd = 1 where id = ${org}`
      assert.equal((await store.retry(org, failed, 'lite', HEAD)).kind, 'queued')
    } finally {
      await database.sql`update orgs set daily_cap_usd = null where id = ${org}`
    }
  })

  it('refuses a retry when GitHub gives another head, and reads the target of the org only', async () => {
    let failed = await job({ state: 'failed', finishedAgo: '5 minutes', createdAgo: '20 minutes' })
    assert.deepEqual(await store.retryTarget(org, failed), {
      installationId: 91,
      githubRepoId: 4001,
      fullName: 'sakuga-software/app',
      prNumber: 12,
      headSha: HEAD,
    })
    assert.equal(await store.retryTarget(otherOrg, failed), null)
    // No job of the newer head in the database (a push on a disabled repository): GitHub knows it.
    assert.deepEqual(await store.retry(org, failed, 'lite', NEWER), { kind: 'stale' })
    assert.equal((await database.sql`select 1 from jobs where state = 'queued'`).length, 0)
    assert.equal((await store.retry(org, failed, 'lite', HEAD)).kind, 'queued')
  })

  // Constat P1 de la review balanced sur #65 : la jointure des jours avec les reviews publiées et
  // les échecs, et le fuseau de la session. Plusieurs reviews et plusieurs échecs le même jour, sous
  // une session à UTC+14.
  it('counts the week the same under a session that is not in UTC, with several reviews and failures a day', async () => {
    for (let pr of [30, 31, 32]) {
      let id = await job({ level: pr === 32 ? 'heavy' : 'lite', pr, createdAgo: '3 minutes', startedAgo: '3 minutes', finishedAgo: pr === 30 ? '2 minutes' : '1 minute' })
      await review(id, { publishedAgo: '30 seconds', createdAgo: '40 seconds' })
    }
    await job({ state: 'failed', pr: 33, finishedAgo: '20 seconds', createdAgo: '1 minute' })
    await job({ state: 'failed', pr: 34, finishedAgo: '10 seconds', createdAgo: '1 minute' })
    // A review not published, and a job not failed: neither counts.
    let unpublished = await job({ pr: 35, createdAgo: '2 minutes', startedAgo: '2 minutes', finishedAgo: '30 seconds' })
    await review(unpublished, { publishedAgo: null, createdAgo: '30 seconds' })

    let kiritimati = postgres(test.url, { max: 1, onnotice: () => {}, connection: { TimeZone: 'Pacific/Kiritimati' } })
    try {
      let [zone] = await kiritimati<{ tz: string }[]>`select current_setting('TimeZone') as tz`
      assert.equal(zone!.tz, 'Pacific/Kiritimati')
      for (let read of [store, createDashboardStore({ sql: kiritimati, db: drizzle(kiritimati, { schema }) })]) {
        let { week } = await read.screen(org)
        let [today] = await database.sql<{ day: string }[]>`select to_char(now() at time zone 'utc', 'YYYY-MM-DD') as day`
        let last = week.at(-1)!
        assert.equal(last.day, today!.day)
        assert.deepEqual(last.published, { lite: 2, balanced: 0, heavy: 1 })
        assert.equal(last.failed, 2)
        // Two jobs of 2 minutes, one of 1 minute: the mean of the three published reviews only.
        assert.ok(Math.abs(last.meanDurationMs! - 100_000) < 1000, String(last.meanDurationMs))
        assert.equal(week.slice(0, -1).reduce((n, d) => n + d.published.lite + d.published.heavy + d.failed, 0), 0)
      }
    } finally {
      await kiritimati.end()
    }
  })

  it('counts the week by day and level, the failures, and the mean duration', async () => {
    let a = await job({ level: 'lite', createdAgo: '10 minutes', startedAgo: '10 minutes', finishedAgo: '9 minutes' })
    await review(a, { publishedAgo: '9 minutes', createdAgo: '9 minutes' })
    let b = await job({ level: 'heavy', pr: 13, createdAgo: '10 minutes', startedAgo: '10 minutes', finishedAgo: '7 minutes' })
    await review(b, { publishedAgo: '7 minutes', createdAgo: '7 minutes' })
    // Not published: not counted in the chart, but listed in « Dernières reviews ».
    let c = await job({ level: 'lite', pr: 14, createdAgo: '5 minutes', finishedAgo: '4 minutes', startedAgo: '5 minutes' })
    await review(c, { publishedAgo: null, createdAgo: '4 minutes' })
    // Eight days ago: out of the week.
    let old = await job({ level: 'lite', pr: 15, createdAgo: '8 days', finishedAgo: '8 days', startedAgo: '8 days' })
    await review(old, { publishedAgo: '8 days', createdAgo: '8 days' })
    await job({ state: 'failed', pr: 16, finishedAgo: '1 minute', createdAgo: '1 minute' })

    let screen = await store.screen(org)
    assert.equal(screen.week.length, 7)
    let [today] = await database.sql<{ day: string }[]>`select to_char(now() at time zone 'utc', 'YYYY-MM-DD') as day`
    let last = screen.week.at(-1)!
    assert.equal(last.day, today!.day)
    // Near midnight UTC, the two reviews can fall on two days: the sum over the week holds either way.
    let sum = screen.week.reduce((n, d) => n + d.published.lite + d.published.balanced + d.published.heavy, 0)
    assert.equal(sum, 2)
    assert.equal(screen.week.reduce((n, d) => n + d.published.heavy, 0), 1)
    assert.equal(screen.week.reduce((n, d) => n + d.failed, 0), 1)
    let durations = screen.week.map((d) => d.meanDurationMs).filter((ms) => ms !== null)
    if (durations.length === 1) assert.ok(Math.abs(durations[0]! - 120_000) < 1000, String(durations[0]))

    assert.equal(screen.recent.length, 4)
    assert.equal(screen.recent[0]!.prNumber, 14)
    assert.equal(screen.recent[0]!.publishedAt, null)
    assert.equal(screen.recent[0]!.findings, 3)
    assert.equal(screen.recent[0]!.verdict, 'COMMENT')
  })

  it('makes the cost of the day the sum of the costs of the day in the database, per provider', async () => {
    let [provider] = await database.sql<{ id: string }[]>`
      insert into providers (id, org_id, kind, label, runner_held) values (gen_random_uuid(), ${org}, 'ollama', 'Ollama du bureau', true) returning id`
    let a = await job({ createdAgo: '5 minutes' })
    await review(a, { cost: 0.25, createdAgo: '1 minute' })
    let b = await job({ pr: 13, createdAgo: '5 minutes', providerId: provider!.id })
    await review(b, { cost: 0.125, createdAgo: '1 minute' })
    let c = await job({ pr: 14, createdAgo: '5 minutes' })
    await review(c, { cost: null, createdAgo: '1 minute', costSource: 'unknown' })
    let r = await job({ kind: 'resolve', pr: 15, createdAgo: '5 minutes' })
    await database.sql`
      insert into resolutions (job_id, repo_id, pr_number, head_sha, model, cost_usd, result)
      values (${r}, ${repo}, 15, ${HEAD}, 'm', 0.0625, '{}'::jsonb)`
    // The other org spends too: never in this sum.
    let theirs = await job({ repoId: otherRepo, createdAgo: '5 minutes' })
    await review(theirs, { cost: 9, createdAgo: '1 minute' })

    let costs = await readOrgCosts(database.db, org)
    let [truth] = await database.sql<{ total: string }[]>`
      select (select coalesce(sum(cost_usd), 0) from reviews join repos on repos.id = reviews.repo_id
          where repos.org_id = ${org} and reviews.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
        + (select coalesce(sum(cost_usd), 0) from resolutions join repos on repos.id = resolutions.repo_id
          where repos.org_id = ${org} and resolutions.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as total`
    assert.equal(costs.dayUsd, Number(truth!.total))
    assert.equal(costs.dayUsd, 0.4375)
    assert.equal(costs.monthUsd, 0.4375)
    assert.equal(costs.monthUnknown, 1)
    assert.deepEqual(
      costs.dayByProvider.map((p) => [p.label, p.usd]),
      [
        [SERVICE_KEY_LABEL, 0.3125],
        ['Ollama du bureau', 0.125],
      ],
    )
  })

  it('reads the cost limits of the org (REV-13)', async () => {
    assert.deepEqual((await store.screen(org)).caps, { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 })
    await database.sql`update orgs set daily_cap_usd = 5, cap_alert_pct = 60 where id = ${org}`
    try {
      assert.deepEqual((await store.screen(org)).caps, { dailyCapUsd: 5, monthlyCapUsd: null, alertPct: 60 })
    } finally {
      await database.sql`update orgs set daily_cap_usd = null, cap_alert_pct = 80 where id = ${org}`
    }
  })

  it('lists the queue of the org only, running first, with the attempts and the backoff', async () => {
    await job({ state: 'queued', pr: 20, attempts: 1, createdAgo: '3 minutes' })
    await job({ state: 'queued', pr: 21, createdAgo: '2 minutes' })
    await job({ state: 'running', pr: 22, attempts: 2, runnerId: runner, startedAgo: '1 minute', createdAgo: '4 minutes' })
    await job({ repoId: otherRepo, state: 'queued', pr: 23 })
    await database.sql`update jobs set not_before = now() + interval '1 minute' where pr_number = 20`
    let { queue } = await store.screen(org)
    assert.equal(queue.runningCount, 1)
    assert.equal(queue.queuedCount, 2)
    assert.deepEqual(queue.queued.map((j) => j.prNumber), [20, 21])
    assert.ok(queue.queued[0]!.notBefore)
    assert.equal(queue.queued[0]!.attempts, 1)
    assert.equal(queue.running[0]!.attempts, 2)
    assert.ok(queue.running[0]!.leaseExpiresAt)
  })

  it('counts the queued jobs of the org that wait for more than 10 min, from their backoff when they have one (REV-52)', async () => {
    let none = await store.screen(org)
    assert.equal(none.stall, null)
    await job({ state: 'queued', pr: 30, createdAgo: '12 minutes' })
    await job({ state: 'queued', pr: 31, createdAgo: '25 minutes' })
    await job({ state: 'queued', pr: 32, createdAgo: '3 minutes' })
    // Queued again after an expired lease: it waits since the end of its backoff, 2 min ago.
    await job({ state: 'queued', pr: 33, createdAgo: '40 minutes', attempts: 1 })
    await database.sql`update jobs set not_before = now() - interval '2 minutes' where pr_number = 33`
    await job({ repoId: otherRepo, state: 'queued', pr: 34, createdAgo: '50 minutes' })
    let { stall, now } = await store.screen(org)
    assert.equal(stall!.count, 2)
    let waited = (now.getTime() - stall!.since.getTime()) / 60_000
    assert.ok(waited > 24 && waited < 26, `the oldest waits since 25 min, not ${waited}`)
    assert.ok(stall!.lastRunnerSeenAt, 'the last call of a runner of the org')
  })

  it('bounds the card « Runners » in SQL and counts all the runners in service of the org and of the service (REV-37)', async () => {
    let sql = database.sql
    try {
      await sql`
        insert into runners (org_id, name, token_hash, last_seen_at)
        select ${org}, 'ci-' || lpad(g::text, 2, '0'), 'hash-ci-' || g, now() - (g || ' hours')::interval - interval '2 hours'
        from generate_series(1, 27) g`
      await sql`insert into runners (org_id, name, token_hash, last_seen_at) values (${org}, 'late-one', 'hash-late', now() - interval '10 minutes')`
      await sql`insert into runners (org_id, name, token_hash, last_seen_at, revoked_at) values (${org}, 'gone', 'hash-gone', now(), now())`
      await sql`insert into runners (name, token_hash, last_seen_at) values ('em-service', 'hash-service', null)`
      let screen = await store.screen(org)
      // runners-host online, late-one late, 27 ci runners and the service runner never seen offline.
      assert.deepEqual(screen.runnerCounts, { online: 1, late: 1, offline: 28 })
      // The same states as the screen: runnerState() of each runner of the list gives its group.
      let { runnerState } = await import('../../app/ui/runners.tsx')
      let byScreen = { online: 0, late: 0, offline: 0 }
      let all = await sql<{ lastSeenAt: Date | string | null }[]>`
        select last_seen_at as "lastSeenAt" from runners where (org_id = ${org} or org_id is null) and revoked_at is null`
      for (let row of all) {
        let state = runnerState({ revokedAt: null, lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt) }, screen.now)
        if (state !== 'revoked') byScreen[state]++
      }
      assert.deepEqual(screen.runnerCounts, byScreen)
      assert.deepEqual(
        screen.runners.map((r) => r.name),
        ['late-one', 'runners-host', 'ci-01', 'ci-02', 'ci-03', 'ci-04', 'ci-05'],
      )
    } finally {
      await sql`delete from runners where name like 'ci-%' or name in ('late-one', 'gone', 'em-service')`
    }
  })

  it('keeps a late runner on the card when more online runners than the limit are there (REV-37)', async () => {
    let sql = database.sql
    try {
      await sql`
        insert into runners (org_id, name, token_hash, last_seen_at)
        select ${org}, 'up-' || lpad(g::text, 2, '0'), 'hash-up-' || g, now() - (g || ' seconds')::interval
        from generate_series(1, 12) g`
      await sql`insert into runners (org_id, name, token_hash, last_seen_at) values (${org}, 'late-one', 'hash-late', now() - interval '10 minutes')`
      let screen = await store.screen(org)
      assert.deepEqual(screen.runnerCounts, { online: 13, late: 1, offline: 0 })
      assert.equal(screen.runners.length, 10)
      assert.equal(screen.runners[0]!.name, 'late-one')
    } finally {
      await sql`delete from runners where name like 'up-%' or name = 'late-one'`
    }
  })
})
