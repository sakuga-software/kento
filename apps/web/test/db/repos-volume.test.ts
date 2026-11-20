// REV-36. The Repos screen of an org with 300 repositories and 50 000 jobs, against Postgres: one
// page of rows (25 since KNT-146), read for its own rows only. Before, the screen read every repository and the
// reviews of the whole database: 499 KB of HTML and 490 to 1 350 ms on the same data.
import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { cookieOf, fakeAuth, OCTOCAT, ORG } from '../../app/auth/test-helpers.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createReposStore } from '../../app/repos/store.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase } from './helpers.ts'

const COOKIE = '__Host-kento_session'
/**
 * The budget of the server, and of the HTML of one page. 50 enabled rows with their actions weigh
 * about 1.75 KB each, and a row with no action 1 KB: 60 KB, the first aim of the ticket, would hold
 * some 25 rows. The page measured 102 KB (499 KB before REV-36). KNT-146: 25 rows a page, each with
 * its icons.
 */
const MAX_MS = 150
const MAX_BYTES = 110_000

describe('the Repos screen with 300 repositories and 50 000 jobs', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let router: ReturnType<typeof createAppRouter>
  let cookie: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    sql = database.sql
    let [org] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (11, 900, 'sakuga-software') returning id`
    // Another org with the same history: its reviews must not cost the screen anything.
    let [other] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (12, 901, 'orchard') returning id`
    for (let [orgId, offset, owner] of [[org!.id, 0, 'sakuga-software'], [other!.id, 1000, 'orchard']] as const) {
      await sql`
        insert into repos (org_id, github_repo_id, full_name, enabled, private, default_branch, workflow, workflow_checked_at)
        select ${orgId}, ${offset} + g, ${owner} || '/service-' || lpad(g::text, 3, '0'), g % 5 < 2, g % 3 = 0, 'main',
          (array['none', 'reusable', 'copy'])[1 + g % 3]::workflow_mode, now()
        from generate_series(1, 300) g`
      // 50 000 jobs over 180 days on the enabled repositories, one in 12 failed, and a review for each done one.
      await sql`
        with r as (select id, row_number() over (order by full_name) as n from repos where org_id = ${orgId} and enabled),
             c as (select count(*) as k from r)
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, created_at, finished_at)
        select r.id, (array['lite', 'balanced', 'heavy'])[1 + g % 3]::review_level,
          (case when g % 12 = 0 then 'failed' else 'done' end)::job_state,
          1 + g % 900, md5(${owner} || g), 'main', now() - g * interval '311 seconds', now() - g * interval '311 seconds' + interval '110 seconds'
        from generate_series(1, 50000) g, c join r on true where r.n = 1 + g % c.k`
      await sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, github_review_id, published_at)
        select jobs.id, jobs.repo_id, jobs.pr_number, jobs.head_sha, 1 + jobs.pr_number % 5, 'anthropic/claude-sonnet-4.5',
          '{"summary":"ok","findings":[]}', ${offset * 1_000_000} + row_number() over (), jobs.finished_at
        from jobs join repos on repos.id = jobs.repo_id where repos.org_id = ${orgId} and jobs.state = 'done'`
    }
    await sql`analyze`

    let auth = fakeAuth({ orgs: [{ ...ORG, id: org!.id }] })
    auth.setRole({ ...ORG, id: org!.id }, OCTOCAT, 'admin')
    router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '0.1.0',
      commit: null,
      webhook: disabledWebhook,
      auth: auth.deps,
      repos: { store: createReposStore(sql), check: null, githubUrl: 'https://github.com' },
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

  async function load(path: string) {
    let started = performance.now()
    let response = await router.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }))
    let html = await response.text()
    return { status: response.status, html, bytes: Buffer.byteLength(html), ms: performance.now() - started }
  }

  it(`answers /repos in under ${MAX_MS} ms with under ${MAX_BYTES / 1000} KB of HTML, page after page`, async () => {
    let first = await load('/repos')
    assert.equal(first.status, 200)
    assert.match(first.html, /300 repos in the installation · 120 enabled/)
    assert.match(first.html, /1 to 25 of 300/)
    assert.equal((first.html.match(/<tr id="repo-/g) ?? []).length, 25)
    assert.ok(first.bytes < MAX_BYTES, `${first.bytes} bytes`)

    // The best of 5 loads: the budget is for the work of the screen, not for a busy machine.
    assert.match(first.html, /href="\/repos\?page=2" rel="next"/)
    for (let path of ['/repos', '/repos?page=2', '/repos?page=12', '/repos?filter=switching', '/repos?q=service-2']) {
      let runs = []
      for (let n = 0; n < 5; n++) runs.push(await load(path))
      let best = Math.min(...runs.map((run) => run.ms))
      assert.equal(runs[0]!.status, 200, path)
      assert.ok(best < MAX_MS, `${path}: ${best.toFixed(1)} ms`)
      assert.ok(runs[0]!.bytes < MAX_BYTES, `${path}: ${runs[0]!.bytes} bytes`)
    }
  })
})
