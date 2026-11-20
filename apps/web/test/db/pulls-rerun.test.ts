// REV-17. "Run again at <level>" against Postgres: a job of the last head, the cases that refuse it,
// and a newer push that cancels it.
import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { headSha, pullRequestPayload, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { readEstimates, rerunReview } from '../../app/pulls/rerun.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

describe('rerun of a pull request', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let router: ReturnType<typeof createAppRouter>
  let orgId: string
  let repoId: string
  let delivery = 0

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    sql = database.sql
    router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '0.1.0',
      commit: null,
      webhook: { secret: TEST_SECRET, trustedBotsFor: async () => new Set(), apply: createWebhookStore(database.db) },
    })
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  beforeEach(async () => {
    await sql`truncate orgs, repos, jobs, reviews cascade`
    ;({ orgId, repoId } = await seedEnabledRepo(sql))
  })

  async function push(head: string) {
    delivery++
    let response = await router.fetch(signedRequest(pullRequestPayload({ action: 'synchronize', head }), { deliveryId: `00000000-0000-0000-0000-${String(delivery).padStart(12, '0')}` }))
    assert.equal(response.status, 202)
  }

  async function finishAll() {
    await sql`update jobs set state = 'done', finished_at = now() where state in ('queued', 'running')`
  }

  it('queues a review of the last head at the level asked, then a newer push cancels it', async () => {
    await push(headSha(1))
    await finishAll()
    let outcome = await rerunReview(sql, { orgId, repoId, prNumber: 24, level: 'heavy', githubHead: headSha(1) })
    assert.equal(outcome.kind, 'queued')
    let [job] = await sql`select head_sha, base_ref, level, state, config is not null as config from jobs where id = ${(outcome as { jobId: string }).jobId}`
    assert.deepEqual({ ...job }, { head_sha: headSha(1), base_ref: 'main', level: 'heavy', state: 'queued', config: true })

    // The same level again while it waits: no second job.
    assert.equal((await rerunReview(sql, { orgId, repoId, prNumber: 24, level: 'heavy', githubHead: null })).kind, 'already')

    await push(headSha(2))
    let [after] = await sql`select state, failure_reason from jobs where id = ${(outcome as { jobId: string }).jobId}`
    assert.deepEqual({ ...after }, { state: 'cancelled', failure_reason: 'superseded by a newer push' })
  })

  it('refuses a head that GitHub has moved past, a disabled repository, another org, and a pull request with no job', async () => {
    await push(headSha(1))
    assert.equal((await rerunReview(sql, { orgId, repoId, prNumber: 24, level: 'lite', githubHead: headSha(9) })).kind, 'stale')
    assert.equal((await rerunReview(sql, { orgId, repoId, prNumber: 99, level: 'lite', githubHead: null })).kind, 'not_found')
    let [other] = await sql<{ id: string }[]>`with org as (insert into orgs (name, slug) values ('x', lower('x')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 7, 7, 'x' from org returning org_id as id`
    assert.equal((await rerunReview(sql, { orgId: other!.id, repoId, prNumber: 24, level: 'lite', githubHead: null })).kind, 'not_found')
    await sql`update repos set enabled = false where id = ${repoId}`
    assert.equal((await rerunReview(sql, { orgId, repoId, prNumber: 24, level: 'lite', githubHead: null })).kind, 'not_found')
  })

  it('does not pass the cost limit of the org', async () => {
    await push(headSha(1))
    await finishAll()
    await sql`update orgs set daily_cap_usd = 0 where id = ${orgId}`
    assert.deepEqual(await rerunReview(sql, { orgId, repoId, prNumber: 24, level: 'balanced', githubHead: null }), { kind: 'capped', period: 'day' })
  })

  it('estimates each level from the last reviews of the repository', async () => {
    await push(headSha(1))
    let [job] = await sql<{ id: string }[]>`select id from jobs limit 1`
    await sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
      values (${job!.id}, ${repoId}, 24, ${headSha(1)}, 4, 'm', 0.004, '{}'::jsonb)`
    assert.deepEqual(await readEstimates(sql, repoId), { lite: 0.004, balanced: null, heavy: null })
  })
})
