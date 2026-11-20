import type { Job, ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import { startLeaseSweeper, sweepExpiredLeases } from '../../app/runner/lease-sweeper.ts'
import { createRunnerStore, type RunnerStore } from '../../app/runner/store.ts'
import { createTestDatabase } from './helpers.ts'

// REV-6 against Postgres: expired leases, attempts, cancel of a running job, and no second result.

const REGISTRATION_TOKEN = 'registration-token-for-the-tests-0123456789'
const HEAD = 'b'.repeat(40)
const NEW_HEAD = 'c'.repeat(40)
const BASE = 'a'.repeat(40)
const INSTALLATION = { githubInstallationId: 77, githubAccountId: 2001, login: 'sakuga-software' }
const REPOSITORY = { githubRepoId: 3001, fullName: 'sakuga-software/sakuga-review' }

interface JobRow {
  state: string
  attempts: number
  runner_id: string | null
  failure_reason: string | null
  lease: boolean
  wait: number | null
}

describe('expired leases, attempts and cancel of a running job', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let store: RunnerStore
  let repoId: string
  let delivery = 0

  function router() {
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 3 }),
      version: 'test',
      commit: null,
      webhook: disabledWebhook,
      runner: {
        store,
        registrationToken: REGISTRATION_TOKEN,
        mintInstallationToken: async () => ({ token: 'ghs_installation_token', expiresAt: '2027-01-15T09:00:00Z' }),
        providerApiKey: null,
        claimWaitMs: 0,
        claimPollMs: 50,
      },
    })
  }

  function call(path: string, token: string, body: unknown) {
    return router().fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    )
  }

  async function register(name: string): Promise<string> {
    let response = await router().fetch(
      new Request('http://localhost/api/runner/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REGISTRATION_TOKEN}` },
        body: JSON.stringify({ name, labels: [], version: '0.1.0' }),
      }),
    )
    assert.equal(response.status, 201)
    return ((await response.json()) as { token: string }).token
  }

  async function claim(token: string): Promise<Job | null> {
    let response = await call('/api/runner/jobs/claim', token, { hasProviderKey: true })
    if (response.status === 204) return null
    assert.equal(response.status, 200)
    return response.json()
  }

  function heartbeat(token: string, job: { id: string; attempt: number }) {
    return call(`/api/runner/jobs/${job.id}/heartbeat`, token, { attempt: job.attempt })
  }

  function result(token: string, job: { id: string; attempt: number }, head = HEAD) {
    return call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: review(head) })
  }

  function review(head: string): ReviewPayload {
    return {
      level: 'lite',
      base: BASE,
      head,
      score: 4,
      verdict: 'COMMENT',
      model: 'anthropic/claude-haiku-5.5',
      provider: 'Anthropic',
      costUsd: 0.01,
      promptTokens: 10,
      completionTokens: 5,
      summary: 'Summary',
      risk: 'Low',
      diagram: null,
      deeperReview: null,
      findings: [],
      notReviewed: [],
      skipped: [],
    }
  }

  async function queueJob(headSha = HEAD): Promise<string> {
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref)
      values (${repoId}, 'lite', 28, ${headSha}, 'main')
      returning id`
    return job!.id
  }

  /** The lease of the job ended: the runner sent no heartbeat for 2 min. */
  function expireLease(jobId: string) {
    return database.sql`update jobs set lease_expires_at = now() - interval '1 second' where id = ${jobId}`
  }

  /** The backoff of the job is over. */
  function endBackoff(jobId: string) {
    return database.sql`update jobs set not_before = now() - interval '1 second' where id = ${jobId}`
  }

  async function jobRow(jobId: string): Promise<JobRow> {
    let [row] = await database.sql<JobRow[]>`
      select state, attempts, runner_id, failure_reason, lease_expires_at is not null as lease,
        extract(epoch from not_before - now())::int as wait
      from jobs where id = ${jobId}`
    return { ...row! }
  }

  async function reviewCount(jobId?: string): Promise<number> {
    let [row] = jobId
      ? await database.sql<{ n: number }[]>`select count(*)::int as n from reviews where job_id = ${jobId}`
      : await database.sql<{ n: number }[]>`select count(*)::int as n from reviews`
    return row!.n
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 12 })
    store = createRunnerStore(database.sql)
  })

  beforeEach(async () => {
    await database.sql`truncate orgs, repos, jobs, reviews, runners cascade`
    let [org] = await database.sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id)
      insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 77, 2001, 'sakuga-software' from org returning org_id as id`
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 3001, 'sakuga-software/sakuga-review', true) returning id`
    repoId = repo!.id
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('1. a job whose runner died goes back to the queue after the backoff, and another runner finishes it once', async () => {
    let dead = await register('dead')
    let alive = await register('alive')
    let jobId = await queueJob()
    let first = await claim(dead)
    assert.equal(first!.attempt, 1)

    // A lease that has not ended stays with its runner.
    assert.deepEqual(await sweepExpiredLeases(store), { requeued: [], failed: [] })

    await expireLease(jobId)
    let swept = await sweepExpiredLeases(store)
    assert.deepEqual(swept.requeued.map((j) => [j.id, j.attempts]), [[jobId, 1]])
    assert.deepEqual(swept.failed, [])
    let queued = await jobRow(jobId)
    assert.equal(queued.state, 'queued')
    assert.equal(queued.lease, false)
    assert.ok(queued.wait! > 20 && queued.wait! <= 30, `backoff of ${queued.wait} s`)

    assert.equal(await claim(alive), null, 'no claim before the end of the backoff')
    await endBackoff(jobId)
    let second = await claim(alive)
    assert.equal(second!.id, jobId)
    assert.equal(second!.attempt, 2)

    // The first runner comes back: it holds nothing any more.
    let lostBeat = await heartbeat(dead, first!)
    assert.equal(lostBeat.status, 409)
    assert.deepEqual(await lostBeat.json(), { error: 'lease_lost' })
    let lostResult = await result(dead, first!)
    assert.equal(lostResult.status, 409)
    assert.deepEqual(await lostResult.json(), { error: 'lease_lost' })

    assert.equal((await heartbeat(alive, second!)).status, 200)
    assert.equal((await result(alive, second!)).status, 204)
    assert.equal(await reviewCount(), 1, 'one review only')
    let done = await jobRow(jobId)
    assert.equal(done.state, 'done')
    assert.equal(done.attempts, 2)
  })

  it('2. a job whose two attempts expire fails with the reason, and stores nothing', async () => {
    let runner = await register('r')
    let jobId = await queueJob()
    let first = await claim(runner)
    await expireLease(jobId)
    await sweepExpiredLeases(store)
    await endBackoff(jobId)
    let second = await claim(runner)
    assert.equal(second!.attempt, 2)
    await expireLease(jobId)

    let swept = await sweepExpiredLeases(store)
    assert.deepEqual(swept.requeued, [])
    assert.deepEqual(swept.failed.map((j) => [j.id, j.attempts]), [[jobId, 2]])
    let row = await jobRow(jobId)
    assert.equal(row.state, 'failed')
    assert.equal(row.failure_reason, 'lease expired 2 times')
    assert.equal(row.lease, false)
    assert.equal(row.wait, null)

    assert.equal(await claim(runner), null, 'a failed job is never claimed again')
    for (let attempt of [first!, second!]) {
      assert.equal((await heartbeat(runner, attempt)).status, 409)
      assert.equal((await result(runner, attempt)).status, 409)
    }
    assert.equal(await reviewCount(), 0)
  })

  it('3. the same runner that claims the job again cannot send the result of its earlier attempt', async () => {
    let runner = await register('r')
    let jobId = await queueJob()
    let first = await claim(runner)
    await expireLease(jobId)
    await sweepExpiredLeases(store)
    await endBackoff(jobId)
    let second = await claim(runner)
    assert.equal(second!.attempt, 2)

    assert.equal((await heartbeat(runner, first!)).status, 409)
    assert.equal((await result(runner, first!)).status, 409)
    assert.equal((await jobRow(jobId)).state, 'running', 'the refused result changed nothing')
    assert.equal((await result(runner, second!)).status, 204)
    assert.equal(await reviewCount(jobId), 1)
  })

  it('4. a runner whose lease ended but that nobody took over keeps the job', async () => {
    let runner = await register('r')
    let jobId = await queueJob()
    let job = await claim(runner)
    await expireLease(jobId)
    let beat = await heartbeat(runner, job!)
    assert.equal(beat.status, 200, 'the heartbeat comes before the sweep: the runner is alive')
    assert.deepEqual(await sweepExpiredLeases(store), { requeued: [], failed: [] })
    assert.equal((await result(runner, job!)).status, 204)
  })

  it('5. the sweep leaves the queued, cancelled, done and failed jobs alone', async () => {
    let ids = await Promise.all(['queued', 'cancelled', 'done', 'failed'].map(() => queueJob()))
    await database.sql`
      update jobs set state = (array['queued','cancelled','done','failed'])[array_position(${ids}::uuid[], id)]::job_state,
        lease_expires_at = now() - interval '1 minute', attempts = 1`
    assert.deepEqual(await sweepExpiredLeases(store), { requeued: [], failed: [] })
    let rows = await database.sql<{ state: string }[]>`select state from jobs order by array_position(${ids}::uuid[], id)`
    assert.deepEqual(rows.map((r) => r.state), ['queued', 'cancelled', 'done', 'failed'])
  })

  it('6. a push during a review: the next heartbeat says cancel, the result is refused, only the new head is queued', async () => {
    let runner = await register('r')
    let apply = createWebhookStore(database.db)
    let push = (head: string) =>
      apply(
        {
          type: 'enqueue_review',
          action: 'synchronize',
          installation: INSTALLATION,
          repository: REPOSITORY,
          prNumber: 28,
          headSha: head,
          baseRef: 'main',
          author: null,
          labels: [],
        },
        `delivery-${++delivery}`,
      )
    let queued = await push(HEAD)
    assert.equal(queued.outcome, 'queued')
    let job = await claim(runner)
    assert.equal(job!.pullRequest.headSha, HEAD)

    let next = await push(NEW_HEAD)
    assert.deepEqual({ outcome: next.outcome, cancelled: next.outcome === 'queued' && next.cancelled }, { outcome: 'queued', cancelled: 1 })

    let beat = await heartbeat(runner, job!)
    assert.equal(beat.status, 200)
    assert.equal(((await beat.json()) as { cancel: boolean }).cancel, true)
    let refused = await result(runner, job!)
    assert.equal(refused.status, 409)
    assert.deepEqual(await refused.json(), { error: 'job_not_running' })
    let cancelled = await jobRow(job!.id)
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(cancelled.failure_reason, 'superseded by a newer push')

    // A cancelled job is never queued again by the sweep, even when its lease ends.
    await expireLease(job!.id)
    assert.deepEqual(await sweepExpiredLeases(store), { requeued: [], failed: [] })

    let newJob = await claim(runner)
    assert.equal(newJob!.pullRequest.headSha, NEW_HEAD)
    assert.equal((await result(runner, newJob!, NEW_HEAD)).status, 204)
    let heads = await database.sql<{ head_sha: string }[]>`select head_sha from reviews`
    assert.deepEqual(heads.map((r) => r.head_sha), [NEW_HEAD])
  })

  it('7. a result and a sweep at the same time: each job ends done with one review, or queued with none', async () => {
    let runner = await register('r')
    let jobs: Job[] = []
    for (let i = 0; i < 20; i++) {
      await queueJob()
      jobs.push((await claim(runner))!)
    }
    await database.sql`update jobs set lease_expires_at = now() - interval '1 second'`

    let [results] = await Promise.all([
      Promise.all(jobs.map((job) => result(runner, job).then((r) => r.status))),
      Promise.all(Array.from({ length: 4 }, () => sweepExpiredLeases(store))),
    ])

    let rows = await database.sql<{ id: string; state: string; reviews: number }[]>`
      select jobs.id, jobs.state, (select count(*)::int from reviews where job_id = jobs.id) as reviews from jobs`
    let byId = new Map(rows.map((r) => [r.id, r]))
    jobs.forEach((job, i) => {
      let row = byId.get(job.id)!
      if (results[i] === 204) assert.deepEqual([row.state, row.reviews], ['done', 1], `job ${i}`)
      else {
        assert.equal(results[i], 409, `job ${i}`)
        assert.deepEqual([row.state, row.reviews], ['queued', 0], `job ${i}`)
      }
    })
  })

  it('8. two sweeps at the same time never take the same job twice', async () => {
    let runner = await register('r')
    let ids: string[] = []
    for (let i = 0; i < 30; i++) {
      ids.push(await queueJob())
      await claim(runner)
    }
    await database.sql`update jobs set lease_expires_at = now() - interval '1 second'`
    let sweeps = await Promise.all(Array.from({ length: 6 }, () => store.expireLeases()))
    let requeued = sweeps.flatMap((s) => s.requeued.map((j) => j.id))
    assert.deepEqual([...requeued].sort(), [...ids].sort(), 'each job once, in one sweep only')
    let rows = await database.sql<{ state: string; attempts: number }[]>`select state, attempts from jobs`
    assert.ok(rows.every((r) => r.state === 'queued' && r.attempts === 1))
  })

  it('9. a cancel and a result at the same time: the job is cancelled with no review, or done with one', async () => {
    let runner = await register('r')
    let apply = createWebhookStore(database.db)
    for (let i = 0; i < 30; i++) {
      await database.sql`truncate jobs, reviews cascade`
      let head = i.toString(16).padStart(40, '0')
      await apply(
        { type: 'enqueue_review', action: 'synchronize', installation: INSTALLATION, repository: REPOSITORY, prNumber: 28, headSha: head, baseRef: 'main', author: null, labels: [] },
        `race-${++delivery}`,
      )
      let job = (await claim(runner))!
      let [status, closed] = await Promise.all([
        result(runner, job, head).then((r) => r.status),
        apply({ type: 'cancel_pull_request', installation: INSTALLATION, repository: REPOSITORY, prNumber: 28 }, `race-${++delivery}`),
      ])
      let row = await jobRow(job.id)
      let reviews = await reviewCount(job.id)
      if (status === 204) {
        assert.deepEqual([row.state, reviews, closed.outcome === 'cancelled' && closed.cancelled], ['done', 1, 0], `round ${i}`)
      } else {
        assert.equal(status, 409, `round ${i}`)
        assert.deepEqual([row.state, reviews], ['cancelled', 0], `round ${i}`)
      }
    }
  })

  it('10. the sweeper of the service runs on its timer', async () => {
    let runner = await register('r')
    let jobId = await queueJob()
    await claim(runner)
    await expireLease(jobId)
    let stop = startLeaseSweeper(store, 50)
    try {
      for (let i = 0; i < 40 && (await jobRow(jobId)).state === 'running'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } finally {
      await stop()
    }
    assert.equal((await jobRow(jobId)).state, 'queued')
  })
})
