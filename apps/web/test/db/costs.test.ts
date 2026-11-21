// KNT-188. What the Costs screen reads for one org, against a real Postgres: the org only, the sums
// by day, repository, level and model, the period before, and the same total as the dashboard.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { projectMonth } from '../../app/costs/period.ts'
import { createCostsStore, REPO_LIMIT, type CostsStore } from '../../app/costs/store.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { readOrgCosts } from '../../app/db/costs.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createTestDatabase, insertOrg } from './helpers.ts'

describe('the costs of an org by period (KNT-188)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let store: CostsStore
  let org: string
  let otherOrg: string
  let repos: string[] = []
  let sha = 0

  /** Noon UTC of the day `daysAgo` days before today: never across a day line, whatever the hour of the test. */
  const NOON = (daysAgo: number) => `date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '${daysAgo} days' + interval '12 hours'`

  async function run(fields: { repo: string; level: string; kind?: 'review' | 'resolve'; usd: number | null; model: string | null; daysAgo: number; pr?: number }) {
    let sql = database.sql
    let head = (sha++).toString(16).padStart(40, '0')
    let kind = fields.kind ?? 'review'
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, attempts)
      values (${fields.repo}, ${kind}, ${fields.level}, 'done', ${fields.pr ?? 1}, ${head}, 'main', 1) returning id`
    let at = sql.unsafe(NOON(fields.daysAgo))
    if (kind === 'review') {
      await sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, created_at)
        values (${job!.id}, ${fields.repo}, ${fields.pr ?? 1}, ${head}, 4, ${fields.model ?? 'm'}, ${fields.usd},
          ${JSON.stringify({ verdict: 'COMMENT', findings: [], costSource: 'provider' })}::text::jsonb, ${at})`
    } else {
      await sql`
        insert into resolutions (job_id, repo_id, pr_number, head_sha, model, cost_usd, result, created_at)
        values (${job!.id}, ${fields.repo}, ${fields.pr ?? 1}, ${head}, ${fields.model}, ${fields.usd},
          ${JSON.stringify({ threads: [], costSource: 'provider' })}::text::jsonb, ${at})`
    }
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    store = createCostsStore(database)
    let sql = database.sql
    org = await insertOrg(sql, 'sakuga-software', 91)
    otherOrg = await insertOrg(sql, 'orchard', 92)
    for (let i = 1; i <= REPO_LIMIT + 2; i++) {
      let [row] = await sql<{ id: string }[]>`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
        values (${org}, (select id from installations where org_id = ${org} limit 1), ${5000 + i}, ${`sakuga-software/repo-${String(i).padStart(2, '0')}`}, true)
        returning id`
      repos.push(row!.id)
    }
    let [other] = await sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${otherOrg}, (select id from installations where org_id = ${otherOrg} limit 1), 6001, 'orchard/app', true) returning id`

    // Yesterday: repo-NN costs NN × $0.10, lite and model-small, but repo-10 heavy and model-large.
    for (let [i, repo] of repos.entries()) {
      let heavy = i === repos.length - 1
      await run({ repo, level: heavy ? 'heavy' : 'lite', usd: (i + 1) / 10, model: heavy ? 'model-large' : 'model-small', daysAgo: 1, pr: 10 + i })
    }
    // A resolution of repo-01 with no model call, and a review of repo-03 whose cost the runner did not know.
    await run({ repo: repos[0]!, level: 'balanced', kind: 'resolve', usd: 0.05, model: null, daysAgo: 1 })
    await run({ repo: repos[2]!, level: 'lite', usd: null, model: 'model-small', daysAgo: 1 })
    // 40 days ago: in the 30 days before the last 30 days.
    await run({ repo: repos[0]!, level: 'lite', usd: 2, model: 'model-small', daysAgo: 40 })
    // The other org: never on the screen of this one.
    await run({ repo: other!.id, level: 'heavy', usd: 100, model: 'model-large', daysAgo: 1 })
  })

  after(async () => {
    await database.close()
    await test.drop()
  })

  it('sums the 30 days of the org only, against the 30 days before', async () => {
    let report = await store.report(org, '30d')
    assert.equal(report.totalUsd, 5.55)
    assert.equal(report.previousTotalUsd, 2)
    assert.equal(report.count, 12)
    assert.equal(report.unknown, 1)
    assert.equal(report.days.length, 30)
    // Yesterday holds all the costs of the period; 40 days ago sits at the same place in the period before.
    assert.equal(report.days.at(-2)!.usd, 5.55)
    assert.equal(report.days.reduce((sum, day) => sum + day.usd, 0).toFixed(6), '5.550000')
    assert.equal(report.days[19]!.previousUsd, 2)
    let other = await store.report(otherOrg, '30d')
    assert.equal(other.totalUsd, 100)
    assert.equal(other.byRepo.length, 1)
  })

  it('splits by repo with the smallest ones in one "Other" row, by level and by model', async () => {
    let report = await store.report(org, '30d')
    assert.equal(report.byRepo.length, REPO_LIMIT + 1)
    assert.deepEqual(
      report.byRepo.slice(0, 2).map((row) => [row.label, row.usd, row.count]),
      [
        ['sakuga-software/repo-10', 1, 1],
        ['sakuga-software/repo-09', 0.9, 1],
      ],
    )
    // repo-03 holds a review of unknown cost: it counts, at $0.
    assert.deepEqual(
      report.byRepo.find((row) => row.label === 'sakuga-software/repo-03'),
      { key: repos[2], label: 'sakuga-software/repo-03', usd: 0.3, count: 2 },
    )
    // repo-02 ($0.20) and repo-01 ($0.10 and a resolution of $0.05).
    assert.deepEqual(report.byRepo.at(-1), { key: null, label: 'Other 2 repos', usd: 0.35, count: 3 })
    assert.equal(report.byRepo.reduce((sum, row) => sum + row.usd, 0).toFixed(6), '5.550000')

    assert.deepEqual(
      report.byLevel.map((row) => [row.label, row.usd, row.count]),
      [
        ['lite', 4.5, 10],
        ['balanced', 0.05, 1],
        ['heavy', 1, 1],
      ],
    )
    assert.deepEqual(
      report.byModel.map((row) => [row.label, row.usd, row.count]),
      [
        ['model-small', 4.5, 10],
        ['model-large', 1, 1],
        ['No model call', 0.05, 1],
      ],
    )
  })

  it('lists the most expensive runs with a known cost, the most expensive first', async () => {
    let report = await store.report(org, '30d')
    assert.equal(report.top.length, 10)
    assert.deepEqual(
      report.top.slice(0, 2).map((run) => [run.repo, run.prNumber, run.kind, run.level, run.model, run.usd]),
      [
        ['sakuga-software/repo-10', 19, 'review', 'heavy', 'model-large', 1],
        ['sakuga-software/repo-09', 18, 'review', 'lite', 'model-small', 0.9],
      ],
    )
    assert.ok(report.top.every((run) => run.repo.startsWith('sakuga-software/')))
  })

  it('gives "this month" the same total as the dashboard and the cap, and a projection', async () => {
    let report = await store.report(org, 'month')
    let dashboard = await readOrgCosts(database.db, org)
    assert.equal(report.totalUsd, dashboard.monthUsd)
    assert.equal(report.count >= 0, true)
    // The math of the projection is in app/costs/period.test.ts; here, the report uses it for this month only.
    let monthDays = new Date(Date.UTC(report.start.getUTCFullYear(), report.start.getUTCMonth() + 1, 0)).getUTCDate()
    assert.equal(report.projectionUsd, projectMonth(report.totalUsd, report.start, report.now, monthDays))
    // The other periods have no projection.
    assert.equal((await store.report(org, '90d')).projectionUsd, null)
  })

  it('reads the caps of the org', async () => {
    await database.sql`update orgs set monthly_cap_usd = 25, cap_alert_pct = 70 where id = ${org}`
    let report = await store.report(org, 'last-month')
    assert.deepEqual(report.caps, { dailyCapUsd: null, monthlyCapUsd: 25, alertPct: 70 })
  })

  it('ranks a repo whose costs are all unknown as $0, with the $0 repos by name (Kentō #b5e005)', async () => {
    let sql = database.sql
    let add = async (name: string, id: number) => {
      let [row] = await sql<{ id: string }[]>`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
        values (${otherOrg}, (select id from installations where org_id = ${otherOrg} limit 1), ${id}, ${name}, true) returning id`
      return row!.id
    }
    await run({ repo: await add('orchard/zero', 6002), level: 'lite', usd: 0, model: 'model-small', daysAgo: 1 })
    await run({ repo: await add('orchard/a-unknown', 6003), level: 'lite', usd: null, model: 'model-small', daysAgo: 1 })
    let report = await store.report(otherOrg, '30d')
    assert.deepEqual(
      report.byRepo.map((row) => [row.label, row.usd]),
      [
        ['orchard/app', 100],
        ['orchard/a-unknown', 0],
        ['orchard/zero', 0],
      ],
    )
  })

  it('runs three queries at most at once for one report (Fable P3)', async () => {
    // A query of postgres.js runs when it is awaited: count the ones whose `then` ran and did not end.
    // A fragment (the CTE of the costs) is never awaited, so it is not counted.
    let running = 0
    let most = 0
    let counted = new Proxy(database.sql, {
      apply(target, self, args) {
        let query = Reflect.apply(target, self, args) as PromiseLike<unknown> & { then: PromiseLike<unknown>['then'] }
        let then = query.then.bind(query)
        query.then = ((resolve?: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => {
          running += 1
          most = Math.max(most, running)
          return then(
            (value) => ((running -= 1), resolve ? resolve(value) : value),
            (error) => {
              running -= 1
              if (reject) return reject(error)
              throw error
            },
          )
        }) as typeof query.then
        return query
      },
    })
    let counting = createCostsStore({ sql: counted })
    let report = await counting.report(org, '90d')
    assert.equal(report.totalUsd, (await store.report(org, '90d')).totalUsd)
    assert.ok(most > 1, `the queries still run in parallel: ${most}`)
    assert.ok(most <= 3, `at most three at once: ${most}`)
  })
})
