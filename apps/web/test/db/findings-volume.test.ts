// REV-18. The Findings screen of an org with 300 repositories and 100 000 findings, against Postgres:
// one page of 25 rows (KNT-148), the filters in SQL, the counts of the tabs in one more query.
// Another org holds as many findings: they must cost the screen nothing.
import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { cookieOf, fakeAuth, OCTOCAT, ORG } from '../../app/auth/test-helpers.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { precisionReport } from '../../app/findings/precision.ts'
import { createFindingsScreenStore } from '../../app/findings/screen.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase } from './helpers.ts'

const COOKIE = '__Host-kento_session'
/**
 * The budget of the server (REV-64): 250 ms, or 10 full reads of the two big tables timed in the same
 * run, whichever is more. A loaded runner slows the reads and the screen alike, so the budget grows
 * with it. A screen takes 2 to 4 full reads; a missing index takes thousands.
 */
const MAX_MS = 250
const MAX_FULL_READS = 10
/** KNT-148. The budget of the list alone: 100 ms, or 4 full reads, whichever is more. */
const MAX_LIST_MS = 100
const MAX_LIST_FULL_READS = 4
/**
 * The budget of the HTML of one page of 25 rows (KNT-148): it weighs 72 to 74 KB, about 1.5 KB a
 * row. 80 KB leaves room for a few hundred bytes more a row, not for a row twice as heavy.
 */
const MAX_BYTES = 80_000
const FINDINGS = 100_000

describe(`the Findings screen with 300 repositories and ${FINDINGS.toLocaleString('en')} findings`, () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let router: ReturnType<typeof createAppRouter>
  let cookie: string
  let repoId: string
  let orgId: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    sql = database.sql
    let [org] = await sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 11, 900, 'sakuga-software' from org returning org_id as id`
    let [other] = await sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('orchard', lower('orchard')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 12, 901, 'orchard' from org returning org_id as id`
    for (let [orgId, offset, owner] of [[org!.id, 0, 'sakuga-software'], [other!.id, 1000, 'orchard']] as const) {
      await sql`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
        select ${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), ${offset} + g, ${owner} || '/service-' || lpad(g::text, 3, '0'), true
        from generate_series(1, 300) g`
      await sql`
        insert into rules (org_id, title, body) select ${orgId}, 'Rule ' || g, 'Text.' from generate_series(1, 20) g`
      // One finding every 26 s over 30 days; one in 3 open, then fixed, dismissed, wontfix and stale.
      await sql`
        with r as (select id, row_number() over (order by full_name) as n from repos where org_id = ${orgId}),
             c as (select count(*) as k from r),
             ru as (select id, row_number() over (order by title) as n from rules where org_id = ${orgId})
        insert into findings (repo_id, pr_number, fingerprint, key, rule_id, path, line, title, severity, category, confidence,
          status, status_reason, first_seen_sha, last_seen_sha, created_at, updated_at)
        select r.id, 1 + g % 900, md5('f' || g), md5('k' || g), (select id from ru where ru.n = 1 + g % 20 and g % 7 = 0),
          'apps/web/app/module_' || (g % 400) || '/file_' || (g % 37) || '.ts', 1 + g % 500,
          'Finding number ' || g || ' on a null value with no check', (array['critical', 'major', 'minor'])[1 + g % 3],
          (array['bug', 'security', 'data', 'contract', 'test'])[1 + g % 5], 50 + g % 50,
          (array['open', 'open', 'open', 'fixed', 'fixed', 'dismissed', 'wontfix', 'stale'])[1 + g % 8]::finding_status,
          case when g % 8 in (5, 6) then (array['Off topic', 'False positive', 'Already known'])[1 + g % 3] end,
          md5('s' || g), md5('s' || (g - g % 4)), now() - g * interval '26 seconds', now() - g * interval '20 seconds'
        from generate_series(1, ${FINDINGS}) g, c join r on true where r.n = 1 + g % c.k`
    }
    // The event that closed each closed finding, at its last update: what the precision reads.
    await sql`
      insert into finding_events (finding_id, type, actor, reason, created_at)
      select id, status::text::finding_event_type, 'kento', status_reason, updated_at from findings where status <> 'open'`
    await sql`analyze`
    orgId = org!.id
    let [repo] = await sql<{ id: string }[]>`select id from repos where full_name = 'sakuga-software/service-042'`
    repoId = repo!.id

    let auth = fakeAuth({ orgs: [{ ...ORG, id: org!.id }] })
    auth.setRole({ ...ORG, id: org!.id }, OCTOCAT, 'admin')
    router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '0.1.0',
      commit: null,
      webhook: disabledWebhook,
      auth: auth.deps,
      findings: { store: createFindingsScreenStore(sql), githubUrl: 'https://github.com' },
    })
    auth.as(OCTOCAT)
    let start = await router.fetch(new Request('http://localhost/login/github'))
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await router.fetch(
      new Request(`http://localhost/auth/github/callback?code=good&state=${state}`, { headers: { Cookie: cookieOf(start, COOKIE)! } }),
    )
    cookie = cookieOf(callback, COOKIE)!
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  /**
   * The best of 5 timings of `run`. It stops at the first one under the budget, or at a second one far
   * over it: a first run on a cold cache gets another try.
   */
  async function timed<T>(run: () => Promise<T>, budget: number) {
    let best = Infinity
    let result!: T
    for (let n = 0; n < 5; n++) {
      let started = performance.now()
      result = await run()
      best = Math.min(best, performance.now() - started)
      if (best < budget || (n > 0 && best > 4 * budget)) break
    }
    return { best, result }
  }

  /** The budget now: 10 full reads of `findings` and `finding_events`, timed now, and 250 ms at least. */
  async function budget() {
    // The best of 5 full reads, all of them: `timed` would stop early.
    let fullRead = Infinity
    for (let n = 0; n < 5; n++) {
      let started = performance.now()
      await sql`select (select count(*) from findings where title ilike '%-%') + (select count(*) from finding_events where reason ilike '%-%')`
      fullRead = Math.min(fullRead, performance.now() - started)
    }
    return { ms: Math.max(MAX_MS, MAX_FULL_READS * fullRead), fullRead }
  }

  async function load(path: string) {
    let started = performance.now()
    let response = await router.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }))
    let html = await response.text()
    return { status: response.status, html, bytes: Buffer.byteLength(html), ms: performance.now() - started }
  }

  it(`answers /findings in under ${MAX_MS} ms (or ${MAX_FULL_READS} full reads) with under ${MAX_BYTES / 1000} KB of HTML, page after page and filter after filter`, async () => {
    let first = await load('/findings')
    assert.equal(first.status, 200)
    assert.equal((first.html.match(/<tr id="finding-/g) ?? []).length, 25)
    assert.match(first.html, /1 to 25 of 37,500 findings/)
    assert.match(first.html, /href="\/findings\?page=2" rel="next"/)
    // The last page: the deepest offset of the tab.
    assert.match(first.html, /href="\/findings\?page=1500"/)

    let report: string[] = []
    for (let path of [
      '/findings',
      '/findings?page=2',
      '/findings?page=750',
      '/findings?page=1500',
      // The deepest offsets: the last page of "all" (99,975 rows before it) and of "closed".
      '/findings?status=all&page=4000',
      '/findings?status=closed&page=2500',
      '/findings?status=closed',
      '/findings?status=dismissed&priority=critical',
      `/findings?repo=${repoId}`,
      `/findings?status=all&repo=${repoId}&q=file_3`,
      '/findings?q=module_16%2F',
      '/findings?status=all&q=no-title-contains-this',
    ]) {
      let limit = await budget()
      let { best, result } = await timed(() => load(path), limit.ms)
      let line = `${path}: ${best.toFixed(1)} ms for a budget of ${limit.ms.toFixed(0)} ms (a full read: ${limit.fullRead.toFixed(1)} ms), ${(result.bytes / 1000).toFixed(1)} KB`
      report.push(line)
      assert.equal(result.status, 200, path)
      assert.ok(best < limit.ms, line)
      assert.ok(result.bytes < MAX_BYTES, `${path}: ${result.bytes} bytes`)
    }
    if (process.env.KENTO_VOLUME_REPORT) console.log(report.join('\n'))
  })

  // The screen also reads the precision, which takes most of its time: the list alone gets its own
  // budget, so that a slower list shows here.
  it(`reads a page of the list alone, the deepest included, in under ${MAX_LIST_MS} ms (or ${MAX_LIST_FULL_READS} full reads)`, async () => {
    let store = createFindingsScreenStore(sql)
    let report: string[] = []
    for (let query of [{}, { page: 1500 }, { view: 'all' as const, page: 4000 }, { view: 'closed' as const, page: 2500 }]) {
      let limit = await budget()
      let ms = Math.max(MAX_LIST_MS, MAX_LIST_FULL_READS * limit.fullRead)
      let { best, result } = await timed(() => store.list(orgId, query), ms)
      let line = `list ${JSON.stringify(query)}: ${best.toFixed(1)} ms for a budget of ${ms.toFixed(0)} ms, page ${result.page} of ${result.pages}`
      report.push(line)
      assert.equal(result.rows.length, result.page < result.pages ? 25 : result.matching - result.offset, line)
      assert.ok(best < ms, line)
    }
    if (process.env.KENTO_VOLUME_REPORT) console.log(report.join('\n'))
  })

  it(`reads the precision of the org, of its 300 repositories, of its rules and its reasons in under ${MAX_MS} ms (or ${MAX_FULL_READS} full reads)`, async () => {
    let limit = await budget()
    let { best, result: report } = await timed(() => precisionReport(sql, orgId), limit.ms)
    let line = `precision: ${best.toFixed(1)} ms for a budget of ${limit.ms.toFixed(0)} ms (a full read: ${limit.fullRead.toFixed(1)} ms), ${report.org.closed} closed findings`
    if (process.env.KENTO_VOLUME_REPORT) console.log(line)
    // One finding every 26 s, closed within 23 days: 3 in 8 are fixed or dismissed.
    assert.equal(report.org.closed, 37_500)
    assert.ok(report.repoCount > 200, `${report.repoCount}`)
    assert.equal(report.repos.length, 8)
    assert.ok(report.ruleCount > 10, `${report.ruleCount}`)
    assert.deepEqual(report.reasons.map((r) => r.reason).sort(), ['Already known', 'False positive', 'Off topic'])
    assert.ok(best < limit.ms, line)
  })
})
