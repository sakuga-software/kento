import { parseJob, RUNNER_TOKEN_PREFIX, type Job, type ReviewPayload } from '@sakuga-review/protocol'
import { findingKey } from '@sakuga-review/engine/findings'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import type { MintInstallationToken } from '../../app/github/installation-token.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import type { RunnerApiDependencies } from '../../app/runner/controller.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { hashToken } from '../../app/runner/tokens.ts'
import { createTestDatabase } from './helpers.ts'

const REGISTRATION_TOKEN = 'registration-token-for-the-tests-0123456789'
const HEAD = 'b'.repeat(40)
const BASE = 'a'.repeat(40)

describe('runner API', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let repoId: string
  let mints: { installationId: number; githubRepoId: number | null }[]
  let mintFails: boolean

  let mint: MintInstallationToken = async (target) => {
    mints.push(target)
    if (mintFails) throw new Error('GitHub answered 404: Not Found')
    return { token: 'ghs_installation_token', expiresAt: '2027-01-15T09:00:00Z' }
  }

  function router(overrides: Partial<RunnerApiDependencies> = {}) {
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 2 }),
      version: 'test',
      commit: null,
      webhook: disabledWebhook,
      runner: {
        store: createRunnerStore(database.sql),
        registrationToken: REGISTRATION_TOKEN,
        mintInstallationToken: mint,
        providerApiKey: 'sk-or-service-key',
        claimWaitMs: 0,
        claimPollMs: 50,
        ...overrides,
      },
    })
  }

  function call(path: string, options: { token?: string | null; body?: unknown; app?: ReturnType<typeof router> } = {}) {
    let headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    return (options.app ?? router()).fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body ?? {}),
      }),
    )
  }

  async function register(name = 'runner-1'): Promise<{ runnerId: string; token: string }> {
    let response = await call('/api/runner/register', {
      token: REGISTRATION_TOKEN,
      body: { name, labels: ['linux'], version: '0.1.0' },
    })
    assert.equal(response.status, 201)
    return response.json()
  }

  async function queueJob(options: { headSha?: string; baseRef?: string | null } = {}): Promise<string> {
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref)
      values (${repoId}, 'lite', 28, ${options.headSha ?? HEAD}, ${options.baseRef === undefined ? 'main' : options.baseRef})
      returning id`
    return job!.id
  }

  // By default, a runner with its own model key: it may take any job.
  function claim(token: string, body: unknown = { hasProviderKey: true }, app?: ReturnType<typeof router>) {
    return call('/api/runner/jobs/claim', { token, body, app })
  }

  function review(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
    return {
      level: 'lite',
      base: BASE,
      head: HEAD,
      score: 4,
      verdict: 'COMMENT',
      model: 'anthropic/claude-haiku-5.5',
      provider: 'Anthropic',
      costUsd: 0.0123,
      promptTokens: 1000,
      completionTokens: 200,
      summary: 'Summary',
      risk: 'Low',
      diagram: null,
      deeperReview: null,
      findings: [],
      notReviewed: [],
      skipped: [],
      ...overrides,
    }
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 12 })
    let [org] = await database.sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id)
      insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 77, 2001, 'sakuga-software' from org returning org_id as id`
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 3001, 'sakuga-software/sakuga-review', true) returning id`
    repoId = repo!.id
  })

  beforeEach(async () => {
    mints = []
    mintFails = false
    await database.sql`delete from jobs`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  describe('register', () => {
    it('gives a runner token once, and keeps only its hash', async () => {
      let { runnerId, token } = await register()
      assert.ok(token.startsWith(RUNNER_TOKEN_PREFIX))
      let [row] = await database.sql<{ token_hash: string; trusted: boolean; labels: string[] }[]>`
        select token_hash, trusted, labels from runners where id = ${runnerId}`
      assert.equal(row!.token_hash, hashToken(token))
      assert.equal(row!.trusted, false, 'a registration never makes a trusted runner')
      assert.deepEqual(row!.labels, ['linux'])
      let [stored] = await database.sql<{ count: number }[]>`
        select count(*)::int as count from runners where token_hash = ${token} or name = ${token}`
      assert.equal(stored!.count, 0, 'the token itself is not in the database')
    })

    it('refuses a wrong or missing registration token, and a closed registration', async () => {
      let body = { name: 'x', labels: [], version: '1' }
      assert.equal((await call('/api/runner/register', { token: 'wrong', body })).status, 401)
      assert.equal((await call('/api/runner/register', { body })).status, 401)
      let closed = router({ registrationToken: null })
      assert.equal((await call('/api/runner/register', { token: REGISTRATION_TOKEN, body, app: closed })).status, 401)
    })

    it('refuses a body that is not the schema', async () => {
      let response = await call('/api/runner/register', {
        token: REGISTRATION_TOKEN,
        body: { name: 'a b', labels: [], version: '1', trusted: true },
      })
      assert.equal(response.status, 400)
      let body = await response.json()
      assert.deepEqual(body.errors.sort(), ['$.name: has a wrong format', '$.trusted: is not allowed'])
    })
  })

  describe('authentication', () => {
    it('answers 401 on claim, heartbeat and result without a valid token', async () => {
      let jobId = await queueJob()
      let { runnerId, token } = await register()
      for (let bad of [null, 'kento_rt_wrong', `${token}x`, REGISTRATION_TOKEN]) {
        assert.equal((await claim(bad as string)).status, 401, String(bad))
        assert.equal((await call(`/api/runner/jobs/${jobId}/heartbeat`, { token: bad, body: { attempt: 1 } })).status, 401)
        assert.equal(
          (await call(`/api/runner/jobs/${jobId}/result`, { token: bad, body: { outcome: 'failed', attempt: 1, reason: 'x' } })).status,
          401,
        )
      }
      let [job] = await database.sql<{ state: string }[]>`select state from jobs where id = ${jobId}`
      assert.equal(job!.state, 'queued', 'no refused call changed the job')
      assert.ok(runnerId)
    })

    it('refuses a revoked token at the next call', async () => {
      let { runnerId, token } = await register()
      assert.equal((await claim(token)).status, 204)
      await database.sql`update runners set revoked_at = now() where id = ${runnerId}`
      await queueJob()
      let response = await claim(token)
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer')
      let [job] = await database.sql<{ state: string }[]>`select state from jobs`
      assert.equal(job!.state, 'queued')
    })
  })

  describe('claim', () => {
    it('gives the oldest queued job with an installation token for its repository', async () => {
      let { runnerId, token } = await register()
      let first = await queueJob()
      await queueJob()
      let response = await claim(token)
      assert.equal(response.status, 200)
      let job: Job = await response.json()
      assert.equal(job.id, first)
      assert.equal(job.attempt, 1)
      assert.deepEqual(job.repo, {
        fullName: 'sakuga-software/sakuga-review',
        cloneUrl: 'https://github.com/sakuga-software/sakuga-review.git',
      })
      assert.deepEqual(job.pullRequest, { number: 28, headSha: HEAD, baseRef: 'main' })
      assert.deepEqual(job.installationToken, { token: 'ghs_installation_token', expiresAt: '2027-01-15T09:00:00Z' })
      assert.deepEqual(mints, [{ installationId: 77, githubRepoId: 3001 }])
      assert.equal(job.provider, null, 'an untrusted runner never gets the key of the service')

      let [row] = await database.sql<{ state: string; runner_id: string; attempts: number; lease: number }[]>`
        select state, runner_id, attempts,
          extract(epoch from lease_expires_at - now())::int as lease
        from jobs where id = ${first}`
      assert.equal(row!.state, 'running')
      assert.equal(row!.runner_id, runnerId)
      assert.equal(row!.attempts, 1)
      assert.ok(row!.lease > 100 && row!.lease <= 120, `lease of ${row!.lease} s`)
    })

    it('gives one job to one runner only, when ten runners claim it at the same time', async () => {
      let tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => register(`r${i}`).then((r) => r.token)))
      let jobId = await queueJob()
      let responses = await Promise.all(tokens.map((token) => claim(token)))
      let statuses = responses.map((r) => r.status).sort()
      assert.deepEqual(statuses, [200, 204, 204, 204, 204, 204, 204, 204, 204, 204])
      let [row] = await database.sql<{ attempts: number }[]>`select attempts from jobs where id = ${jobId}`
      assert.equal(row!.attempts, 1)
    })

    it('gives five jobs to five different claims among twenty at the same time', async () => {
      let tokens = await Promise.all(Array.from({ length: 4 }, (_, i) => register(`r${i}`).then((r) => r.token)))
      let jobIds = await Promise.all(Array.from({ length: 5 }, () => queueJob()))
      let responses = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(tokens[i % 4]!)))
      let claimed: string[] = []
      for (let response of responses) {
        if (response.status === 200) claimed.push(((await response.json()) as Job).id)
        else assert.equal(response.status, 204)
      }
      assert.deepEqual(claimed.sort(), jobIds.sort())
      let rows = await database.sql<{ attempts: number }[]>`select attempts from jobs`
      assert.deepEqual(rows.map((r) => r.attempts), [1, 1, 1, 1, 1])
    })

    it('gives the clone URL of the configured GitHub server', async () => {
      let { token } = await register()
      await queueJob()
      let job = (await (await claim(token, undefined, router({ githubUrl: 'https://ghe.example.com' }))).json()) as Job
      assert.equal(job.repo.cloneUrl, 'https://ghe.example.com/sakuga-software/sakuga-review.git')
    })

    it('waits for a job during the long poll', async () => {
      let { token } = await register()
      let app = router({ claimWaitMs: 3000, claimPollMs: 50 })
      let start = Date.now()
      let pending = claim(token, undefined, app)
      await new Promise((resolve) => setTimeout(resolve, 300))
      let jobId = await queueJob()
      let response = await pending
      assert.equal(response.status, 200)
      assert.equal(((await response.json()) as Job).id, jobId)
      assert.ok(Date.now() - start < 2000)
    })

    it('gives no job to a runner revoked during its long poll', async () => {
      let { runnerId, token } = await register()
      let pending = claim(token, undefined, router({ claimWaitMs: 1500, claimPollMs: 50 }))
      await new Promise((resolve) => setTimeout(resolve, 200))
      await database.sql`update runners set revoked_at = now() where id = ${runnerId}`
      let jobId = await queueJob()
      assert.equal((await pending).status, 204)
      let [row] = await database.sql<{ state: string; runner_id: string | null }[]>`
        select state, runner_id from jobs where id = ${jobId}`
      assert.deepEqual({ ...row }, { state: 'queued', runner_id: null })
      assert.deepEqual(mints, [], 'no installation token was made')
    })

    it('reads the trust of the runner when it claims, not when its request began', async () => {
      let { runnerId, token } = await register()
      let pending = claim(token, { hasProviderKey: false }, router({ claimWaitMs: 1500, claimPollMs: 50 }))
      await new Promise((resolve) => setTimeout(resolve, 200))
      await database.sql`update runners set trusted = true where id = ${runnerId}`
      await queueJob()
      let job = (await (await pending).json()) as Job
      assert.deepEqual(job.provider, { kind: 'openrouter', apiKey: 'sk-or-service-key' })
    })

    it('answers 204 at the end of the wait when no job comes', async () => {
      let { token } = await register()
      let start = Date.now()
      let response = await claim(token, undefined, router({ claimWaitMs: 300, claimPollMs: 50 }))
      assert.equal(response.status, 204)
      assert.ok(Date.now() - start >= 300)
    })

    it('never gives a job without its base branch, nor a cancelled or running job', async () => {
      let { token } = await register()
      await queueJob({ baseRef: null })
      let cancelled = await queueJob()
      await database.sql`update jobs set state = 'cancelled' where id = ${cancelled}`
      assert.equal((await claim(token)).status, 204)
    })

    it('sends the key of the service only to a trusted runner without its own key', async () => {
      let { runnerId, token } = await register()
      await database.sql`update runners set trusted = true where id = ${runnerId}`

      await queueJob()
      let own = (await (await claim(token, { hasProviderKey: true })).json()) as Job
      assert.equal(own.provider, null)

      await queueJob()
      let shared = (await (await claim(token, { hasProviderKey: false })).json()) as Job
      assert.deepEqual(shared.provider, { kind: 'openrouter', apiKey: 'sk-or-service-key' })
    })

    it('counts only an OpenRouter key of the runner as its own key', async () => {
      let { runnerId, token } = await register()
      await queueJob()
      // An untrusted runner whose own provider is Ollama cannot run a job of the OpenRouter key.
      let ollama = { hasProviderKey: true, features: ['providers'], ownProvider: 'ollama' }
      assert.equal((await claim(token, ollama)).status, 204)

      await database.sql`update runners set trusted = true where id = ${runnerId}`
      let job = (await (await claim(token, ollama)).json()) as Job
      assert.equal(job.provider, null)
      assert.equal(job.providers?.[0]?.apiKey, 'sk-or-service-key', 'trusted: the key of the service')

      await queueJob()
      let own = (await (await claim(token, { hasProviderKey: true, features: ['providers'], ownProvider: 'openrouter' })).json()) as Job
      assert.equal(own.provider, null)
      assert.deepEqual(own.providers, [{ id: 'service', kind: 'openrouter', apiKey: null, baseUrl: null, models: [] }], 'its own key: no key sent')
    })

    it('gives a runner that reads providers the key of the service in providers, never in provider', async () => {
      let { runnerId, token } = await register()
      await database.sql`update runners set trusted = true where id = ${runnerId}`
      await queueJob()
      let job = (await (await claim(token, { hasProviderKey: true, features: ['providers'], ownProvider: 'ollama' })).json()) as Job
      assert.equal(job.provider, null)
      assert.deepEqual(job.providers, [{ id: 'service', kind: 'openrouter', apiKey: 'sk-or-service-key', baseUrl: null, models: [] }])

      // A runner of an earlier release gets no key that it does not know.
      await queueJob()
      let earlier = (await (await claim(token, { hasProviderKey: false })).json()) as Job
      assert.equal('providers' in earlier, false)
      assert.deepEqual(earlier.provider, { kind: 'openrouter', apiKey: 'sk-or-service-key' })
    })

    it('gives no job to a runner that has no model key to run it with, and leaves the job queued', async () => {
      let { runnerId, token } = await register()
      let jobId = await queueJob()

      // Not trusted yet, and no key of its own: it could only fail the job.
      let start = Date.now()
      assert.equal((await claim(token, { hasProviderKey: false }, router({ claimWaitMs: 300, claimPollMs: 50 }))).status, 204)
      assert.ok(Date.now() - start >= 300, 'the claim still waits, so the runner does not loop')

      // Trusted, but the service has no key to give.
      await database.sql`update runners set trusted = true where id = ${runnerId}`
      assert.equal((await claim(token, { hasProviderKey: false }, router({ providerApiKey: null }))).status, 204)

      let [row] = await database.sql<{ state: string; runner_id: string | null }[]>`
        select state, runner_id from jobs where id = ${jobId}`
      assert.deepEqual({ ...row }, { state: 'queued', runner_id: null })
      assert.deepEqual(mints, [])

      // With its own key, the same runner takes it.
      assert.equal((await claim(token, { hasProviderKey: true })).status, 200)
    })

    it('queues the job again when GitHub gives no installation token, and fails it at the last attempt', async () => {
      let { token } = await register()
      let jobId = await queueJob()
      mintFails = true
      assert.equal((await claim(token)).status, 204)
      let [first] = await database.sql<{ state: string; attempts: number; wait: number; failure_reason: string | null }[]>`
        select state, attempts, extract(epoch from not_before - now())::int as wait, failure_reason
        from jobs where id = ${jobId}`
      assert.equal(first!.state, 'queued')
      assert.equal(first!.attempts, 1)
      assert.ok(first!.wait > 20 && first!.wait <= 30, `backoff of ${first!.wait} s`)
      assert.equal(first!.failure_reason, null)
      assert.equal((await claim(token)).status, 204, 'not before the end of the backoff')

      await database.sql`update jobs set not_before = now() - interval '1 second' where id = ${jobId}`
      assert.equal((await claim(token)).status, 204)
      let [row] = await database.sql<{ state: string; attempts: number; failure_reason: string }[]>`
        select state, attempts, failure_reason from jobs where id = ${jobId}`
      assert.equal(row!.state, 'failed')
      assert.equal(row!.attempts, 2)
      assert.match(row!.failure_reason, /^installation token: GitHub answered 404/)
      assert.equal(mints.length, 2)
    })

    it('gives no job when the GitHub App is not configured, after the whole wait', async () => {
      let { token } = await register()
      await queueJob()
      let start = Date.now()
      let app = router({ mintInstallationToken: null, claimWaitMs: 300 })
      assert.equal((await claim(token, undefined, app)).status, 204)
      assert.ok(Date.now() - start >= 300, 'the claim waits, so a runner does not loop on the service')
      let [row] = await database.sql<{ state: string }[]>`select state from jobs`
      assert.equal(row!.state, 'queued')
    })
  })

  describe('heartbeat and result', () => {
    async function claimed() {
      let runner = await register()
      let jobId = await queueJob()
      assert.equal((await claim(runner.token)).status, 200)
      return { ...runner, jobId }
    }

    it('a heartbeat extends the lease of the runner that holds the job, and only that one', async () => {
      let { token, jobId } = await claimed()
      let other = await register('other')
      await database.sql`update jobs set lease_expires_at = now() + interval '5 seconds' where id = ${jobId}`

      let response = await call(`/api/runner/jobs/${jobId}/heartbeat`, { token, body: { attempt: 1 } })
      assert.equal(response.status, 200)
      let body = await response.json()
      assert.equal(body.cancel, false)
      assert.ok(new Date(body.leaseExpiresAt).getTime() - Date.now() > 100_000)

      let notHolder = await call(`/api/runner/jobs/${jobId}/heartbeat`, { token: other.token, body: { attempt: 1 } })
      assert.equal(notHolder.status, 409)
      assert.deepEqual(await notHolder.json(), { error: 'lease_lost' })
      let missing = await call(`/api/runner/jobs/${crypto.randomUUID()}/heartbeat`, { token, body: { attempt: 1 } })
      assert.equal(missing.status, 404)
      assert.equal((await call('/api/runner/jobs/not-a-uuid/heartbeat', { token, body: { attempt: 1 } })).status, 404)
      let noAttempt = await call(`/api/runner/jobs/${jobId}/heartbeat`, { token, body: {} })
      assert.equal(noAttempt.status, 400)
      assert.deepEqual((await noAttempt.json()).errors, ['$.attempt: is required'])
    })

    it('a heartbeat on a cancelled job tells the runner to stop', async () => {
      let { token, jobId } = await claimed()
      await database.sql`update jobs set state = 'cancelled' where id = ${jobId}`
      let body = await (await call(`/api/runner/jobs/${jobId}/heartbeat`, { token, body: { attempt: 1 } })).json()
      assert.equal(body.cancel, true)
      let result = await call(`/api/runner/jobs/${jobId}/result`, { token, body: { outcome: 'done', attempt: 1, review: review() } })
      assert.equal(result.status, 409)
      let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from reviews`
      assert.equal(count!.n, 0)
    })

    it('stores a valid review once, and marks the job done', async () => {
      let { token, jobId } = await claimed()
      let finding = {
        path: 'a.ts',
        start_line: 1,
        line: 2,
        severity: 'major' as const,
        category: 'bug' as const,
        confidence: 90,
        title: 't',
        scenario: 's',
        fix: 'f',
        suggestion: '',
        anchor: 2,
        blocking: true,
        suggestion_range: null,
      }
      let response = await call(`/api/runner/jobs/${jobId}/result`, {
        token,
        body: { outcome: 'done', attempt: 1, review: review({ score: 2, findings: [finding] }) },
      })
      assert.equal(response.status, 204)

      let [row] = await database.sql<
        { score: number; model: string; cost_usd: string; head_sha: string; pr_number: number; result: ReviewPayload }[]
      >`select score, model, cost_usd, head_sha, pr_number, result from reviews where job_id = ${jobId}`
      assert.equal(row!.score, 2)
      assert.equal(row!.model, 'anthropic/claude-haiku-5.5')
      assert.equal(row!.cost_usd, '0.012300')
      assert.equal(row!.head_sha, HEAD)
      assert.equal(row!.pr_number, 28)
      assert.deepEqual(row!.result.findings, [finding])
      let [job] = await database.sql<{ state: string; finished: boolean; lease: Date | null }[]>`
        select state, finished_at is not null as finished, lease_expires_at as lease from jobs where id = ${jobId}`
      assert.deepEqual(job, { state: 'done', finished: true, lease: null })

      let again = await call(`/api/runner/jobs/${jobId}/result`, { token, body: { outcome: 'done', attempt: 1, review: review() } })
      assert.equal(again.status, 409)
    })

    it('refuses the result of another runner, a body that is not the schema, and a review of another head', async () => {
      let { token, jobId } = await claimed()
      let other = await register('other')
      let url = `/api/runner/jobs/${jobId}/result`

      assert.equal((await call(url, { token: other.token, body: { outcome: 'done', attempt: 1, review: review() } })).status, 409)
      assert.equal((await call(url, { token, body: { outcome: 'done', attempt: 2, review: review() } })).status, 409, 'another attempt')

      let invalid = await call(url, { token, body: { outcome: 'done', attempt: 1, review: { ...review(), score: 9 } } })
      assert.equal(invalid.status, 400)
      assert.deepEqual((await invalid.json()).errors, ['$.review.score: must be from 1 to 5'])

      let wrongHead = await call(url, { token, body: { outcome: 'done', attempt: 1, review: review({ head: 'c'.repeat(40) }) } })
      assert.equal(wrongHead.status, 422)

      let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from reviews`
      assert.equal(count!.n, 0)
      let [job] = await database.sql<{ state: string }[]>`select state from jobs where id = ${jobId}`
      assert.equal(job!.state, 'running')
    })

    it('refuses a body over the size limit', async () => {
      let { token, jobId } = await claimed()
      let response = await call(`/api/runner/jobs/${jobId}/result`, {
        token,
        body: { outcome: 'failed', attempt: 1, reason: 'x'.repeat(1_100_000) },
      })
      assert.equal(response.status, 413)
    })

    it('stores a failure with its reason', async () => {
      let { token, jobId } = await claimed()
      let response = await call(`/api/runner/jobs/${jobId}/result`, {
        token,
        body: { outcome: 'failed', attempt: 1, reason: 'clone failed: exit 128' },
      })
      assert.equal(response.status, 204)
      let [job] = await database.sql<{ state: string; failure_reason: string }[]>`
        select state, failure_reason from jobs where id = ${jobId}`
      assert.deepEqual(job, { state: 'failed', failure_reason: 'clone failed: exit 128' })
    })
  })

  describe('reuse of the last review (REV-89)', () => {
    const PREVIOUS = 'd'.repeat(40)
    const KEY = 'e'.repeat(64)
    let finding = {
      path: 'a.ts',
      start_line: 1,
      line: 2,
      severity: 'major' as const,
      category: 'bug' as const,
      confidence: 90,
      title: 't',
      scenario: 's',
      fix: 'f',
      suggestion: '',
      anchor: 2,
      blocking: true,
      suggestion_range: null,
    }

    /** The review of PREVIOUS on GitHub (review 555), with its reuse key. */
    async function published(key: string | null = KEY): Promise<string> {
      let [job] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
        values (${repoId}, 'lite', 'done', 28, ${PREVIOUS}, 'main') returning id`
      let result = review({ head: PREVIOUS, score: 2, findings: [finding], ...(key ? { reuseKey: key, diffHash: '0123456789abcdef' } : {}) })
      let [row] = await database.sql<{ id: string }[]>`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        values (${job!.id}, ${repoId}, 28, ${PREVIOUS}, 2, 'anthropic/claude-haiku-5.5', 0.0123, ${JSON.stringify(result)}::jsonb, 555, now())
        returning id`
      return row!.id
    }

    const reader = { hasProviderKey: true, features: ['reuse'] }

    it('sends the head and the key of the last review on GitHub to a runner that reads them, for a push only', async () => {
      await published()
      let runner = await register()
      await queueJob()
      let job: Job = await (await claim(runner.token, reader)).json()
      assert.equal(job.kind, 'review')
      assert.deepEqual(job.kind === 'review' && job.reuse, { head: PREVIOUS, key: KEY })

      // A runner of an earlier release gets no key that it does not know.
      await queueJob()
      let old: Job = await (await claim(runner.token)).json()
      assert.ok(!('reuse' in old))

      // A command asks for a new review: no reuse.
      let [command] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, base_ref, level_source)
        values (${repoId}, 'lite', 28, ${HEAD}, 'main', 'command') returning id`
      let asked: Job = await (await claim(runner.token, reader)).json()
      assert.equal(asked.id, command!.id)
      assert.equal(asked.kind === 'review' && asked.reuse, null)
    })

    it('sends null when the last review has no key', async () => {
      await published(null)
      let runner = await register()
      await queueJob()
      let job: Job = await (await claim(runner.token, reader)).json()
      assert.equal(job.kind === 'review' && job.reuse, null)
    })

    it('stores the outcome unchanged as a copy of the earlier review, at no cost, and marks the job done', async () => {
      let sourceId = await published()
      let runner = await register()
      let jobId = await queueJob()
      assert.equal((await claim(runner.token, reader)).status, 200)
      let unchanged = { level: 'lite', base: BASE, head: HEAD, of: PREVIOUS, diffHash: '0123456789abcdef', reuseKey: KEY }
      let response = await call(`/api/runner/jobs/${jobId}/result`, { token: runner.token, body: { outcome: 'unchanged', attempt: 1, unchanged } })
      assert.equal(response.status, 204)

      let [row] = await database.sql<{ score: number; cost_usd: string; head_sha: string; github_review_id: string | null; result: any }[]>`
        select score, cost_usd, head_sha, github_review_id, result from reviews where job_id = ${jobId}`
      assert.equal(row!.score, 2, 'the score of the earlier review')
      assert.equal(row!.cost_usd, '0.000000')
      assert.equal(row!.head_sha, HEAD)
      assert.equal(row!.github_review_id, null, 'the publisher writes it')
      assert.deepEqual(row!.result.findings, [finding], 'the findings of the earlier review')
      assert.equal(row!.result.head, HEAD)
      assert.equal(row!.result.promptTokens, 0)
      assert.deepEqual(row!.result.reusedFrom, { reviewId: sourceId, head: PREVIOUS, githubReviewId: 555 })
      let [job] = await database.sql<{ state: string }[]>`select state from jobs where id = ${jobId}`
      assert.equal(job!.state, 'done')
    })

    it('a copy of a copy that was posted as a review of its own is the source itself', async () => {
      // The copy at PREVIOUS names R0 (555), but its source was gone: the publisher posted it as review 777.
      let [job0] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
        values (${repoId}, 'lite', 'done', 28, ${PREVIOUS}, 'main') returning id`
      let copy = { ...review({ head: PREVIOUS, score: 2, findings: [finding], reuseKey: KEY }), reusedFrom: { reviewId: crypto.randomUUID(), head: 'f'.repeat(40), githubReviewId: 555 } }
      let [row0] = await database.sql<{ id: string }[]>`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        values (${job0!.id}, ${repoId}, 28, ${PREVIOUS}, 2, 'm', 0, ${JSON.stringify(copy)}::jsonb, 777, now())
        returning id`
      let runner = await register()
      let jobId = await queueJob()
      assert.equal((await claim(runner.token, reader)).status, 200)
      let unchanged = { level: 'lite', base: BASE, head: HEAD, of: PREVIOUS, diffHash: '0123456789abcdef', reuseKey: KEY }
      assert.equal((await call(`/api/runner/jobs/${jobId}/result`, { token: runner.token, body: { outcome: 'unchanged', attempt: 1, unchanged } })).status, 204)
      let [row] = await database.sql<{ result: any }[]>`select result from reviews where job_id = ${jobId}`
      assert.deepEqual(row!.result.reusedFrom, { reviewId: row0!.id, head: PREVIOUS, githubReviewId: 777 })
    })

    it('two pushes with no publication in between compare with the same key, and copy the same review', async () => {
      let sourceId = await published()
      let runner = await register()
      // Push 1: unchanged, stored, not published yet.
      let first = await queueJob()
      assert.equal((await claim(runner.token, reader)).status, 200)
      let unchanged = { level: 'lite', base: BASE, head: HEAD, of: PREVIOUS, diffHash: '0123456789abcdef', reuseKey: KEY }
      assert.equal((await call(`/api/runner/jobs/${first}/result`, { token: runner.token, body: { outcome: 'unchanged', attempt: 1, unchanged } })).status, 204)
      let [copy] = await database.sql<{ result: any; published: boolean }[]>`
        select result, published_at is not null as published from reviews where job_id = ${first}`
      assert.equal(copy!.published, false)
      assert.equal(copy!.result.reuseKey, KEY, 'the copy has the key of its source')

      // Push 2 before the publisher ran: the claim gives the source, with the same key as the copy.
      const NEXT = 'f'.repeat(40)
      let second = await queueJob({ headSha: NEXT })
      let job: Job = await (await claim(runner.token, reader)).json()
      assert.equal(job.id, second)
      assert.deepEqual(job.kind === 'review' && job.reuse, { head: PREVIOUS, key: copy!.result.reuseKey })
      assert.equal(
        (await call(`/api/runner/jobs/${second}/result`, { token: runner.token, body: { outcome: 'unchanged', attempt: 1, unchanged: { ...unchanged, head: NEXT } } })).status,
        204,
      )
      let [next] = await database.sql<{ result: any }[]>`select result from reviews where job_id = ${second}`
      assert.deepEqual(next!.result.reusedFrom, copy!.result.reusedFrom, 'both copies name the same review')
      assert.deepEqual(next!.result.reusedFrom, { reviewId: sourceId, head: PREVIOUS, githubReviewId: 555 })
      assert.deepEqual(next!.result.findings, copy!.result.findings)
    })

    it('a copy of a copy names the review that a model made, not the copy in between', async () => {
      let origin = { reviewId: crypto.randomUUID(), head: 'f'.repeat(40), githubReviewId: 555 }
      let [job0] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
        values (${repoId}, 'lite', 'done', 28, ${PREVIOUS}, 'main') returning id`
      let copy = { ...review({ head: PREVIOUS, score: 2, findings: [finding], reuseKey: KEY }), reusedFrom: origin }
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        values (${job0!.id}, ${repoId}, 28, ${PREVIOUS}, 2, 'm', 0, ${JSON.stringify(copy)}::jsonb, 555, now())`
      let runner = await register()
      let jobId = await queueJob()
      // The claim and the result name the same review: the published copy, with its own head.
      let claimed: Job = await (await claim(runner.token, reader)).json()
      assert.deepEqual(claimed.kind === 'review' && claimed.reuse, { head: PREVIOUS, key: KEY })
      let unchanged = { level: 'lite', base: BASE, head: HEAD, of: PREVIOUS, diffHash: '0123456789abcdef', reuseKey: KEY }
      assert.equal((await call(`/api/runner/jobs/${jobId}/result`, { token: runner.token, body: { outcome: 'unchanged', attempt: 1, unchanged } })).status, 204)
      let [row] = await database.sql<{ result: any }[]>`select result from reviews where job_id = ${jobId}`
      assert.deepEqual(row!.result.reusedFrom, origin)
    })

    it('publishes again only the last review on GitHub, never an older one of the pull request', async () => {
      await published()
      // A newer review, of another head, is now the last one on GitHub (a force-push came back).
      let [other] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
        values (${repoId}, 'lite', 'done', 28, ${'c'.repeat(40)}, 'main') returning id`
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        values (${other!.id}, ${repoId}, 28, ${'c'.repeat(40)}, 5, 'm', 0.01,
          ${JSON.stringify(review({ head: 'c'.repeat(40), score: 5, reuseKey: 'c'.repeat(64) }))}::jsonb, 556, now() + interval '1 second')`
      let runner = await register()
      let jobId = await queueJob()
      assert.equal((await claim(runner.token, reader)).status, 200)
      let unchanged = { level: 'lite', base: BASE, head: HEAD, of: PREVIOUS, diffHash: '0123456789abcdef', reuseKey: KEY }
      assert.equal((await call(`/api/runner/jobs/${jobId}/result`, { token: runner.token, body: { outcome: 'unchanged', attempt: 1, unchanged } })).status, 204)
      let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from reviews where job_id = ${jobId}`
      assert.equal(count!.n, 0, 'the older review is not copied')
      // The job goes back to the queue: the next claim reads the last review again.
      let [queued] = await database.sql<{ state: string; failure_reason: string | null; waits: boolean }[]>`
        select state, failure_reason, not_before > now() as waits from jobs where id = ${jobId}`
      assert.deepEqual(queued, { state: 'queued', failure_reason: null, waits: true })
      await database.sql`update jobs set not_before = null where id = ${jobId}`
      let again: Job = await (await claim(runner.token, reader)).json()
      assert.equal(again.id, jobId)
      assert.equal(again.attempt, 2)
      assert.equal(again.kind === 'review' && again.reuse, null, 'the new attempt reviews the whole pull request')
      assert.equal((await call(`/api/runner/jobs/${jobId}/result`, { token: runner.token, body: { outcome: 'done', attempt: 2, review: review() } })).status, 204)
      let [done] = await database.sql<{ state: string }[]>`select state from jobs where id = ${jobId}`
      assert.equal(done!.state, 'done')
    })

    it('sends at most 100 open findings in the delta, so that the runner accepts the job', async () => {
      let [j] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
        values (${repoId}, 'lite', 'done', 28, ${PREVIOUS}, 'main') returning id`
      // A row written outside the protocol (by hand, or by a release with another limit): 120 findings.
      let many = Array.from({ length: 120 }, (_, i) => ({ ...finding, line: i + 1, title: `finding ${i}`, fingerprint: i.toString(16).padStart(16, '0') }))
      let result = review({ head: PREVIOUS, score: 3, findings: many, reuseKey: KEY })
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        values (${j!.id}, ${repoId}, 28, ${PREVIOUS}, 3, 'm', 0.01, ${JSON.stringify(result)}::jsonb, 555, now())`
      let runner = await register()
      await queueJob()
      let raw = await (await claim(runner.token, { hasProviderKey: true, features: ['reuse', 'delta'] })).json()
      let checked = parseJob(raw)
      assert.ok(checked.ok, `the runner accepts the job: ${!checked.ok && checked.errors.join('; ')}`)
      assert.equal(raw.reuse.delta.findings.length, 100)
    })

    it('sends the patch of a carried finding only to a runner that claims the feature patch (REV-104)', async () => {
      let [j] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
        values (${repoId}, 'lite', 'done', 28, ${PREVIOUS}, 'main') returning id`
      let patch = '--- a/a.ts\n+++ b/a.ts\n@@ -2 +2 @@\n-a\n+b'
      let result = review({ head: PREVIOUS, score: 3, findings: [{ ...finding, fingerprint: '1111111111111111', patch }], reuseKey: KEY })
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        values (${j!.id}, ${repoId}, 28, ${PREVIOUS}, 3, 'm', 0.01, ${JSON.stringify(result)}::jsonb, 555, now())`
      let runner = await register()
      await queueJob()
      let raw = await (await claim(runner.token, { hasProviderKey: true, features: ['reuse', 'delta', 'patch'] })).json()
      assert.ok(parseJob(raw).ok)
      assert.equal(raw.reuse.delta.findings[0].patch, patch)
      await queueJob()
      let old = await (await claim(runner.token, { hasProviderKey: true, features: ['reuse', 'delta'] })).json()
      assert.ok(!('patch' in old.reuse.delta.findings[0]), 'a runner of an earlier release refuses the key')
    })

    it('takes the delta from the review of the level of the job, even when a review of another level is later', async () => {
      for (let [level, score, at] of [['lite', 3, '1 second'], ['heavy', 5, '2 seconds']] as const) {
        let [j] = await database.sql<{ id: string }[]>`
          insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
          values (${repoId}, ${level}, 'done', 28, ${PREVIOUS}, 'main') returning id`
        let result = review({ level, head: PREVIOUS, score, findings: [], reuseKey: KEY })
        await database.sql`
          insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
          values (${j!.id}, ${repoId}, 28, ${PREVIOUS}, ${score}, 'm', 0.01, ${JSON.stringify(result)}::jsonb, ${score === 3 ? 555 : 556}, now() + ${at}::interval)`
      }
      let runner = await register()
      await queueJob()
      let job: Job = await (await claim(runner.token, { hasProviderKey: true, features: ['reuse', 'delta'] })).json()
      assert.equal(job.kind === 'review' && job.reuse?.delta?.score, 3, 'the lite review, for a lite job')
    })

    it('sends the delta of the last review to a runner that reads it: score, open findings, settled ones (REV-88)', async () => {
      let open = { ...finding, title: 'open one', fingerprint: '1111111111111111' }
      let gone = { ...finding, title: 'dismissed one', fingerprint: '2222222222222222' }
      // A finding of a review stored before the fingerprint, settled since: found by its key.
      let { fingerprint: _none, ...unprinted } = { ...finding, path: 'b.ts', title: 'fixed one', fingerprint: '' }
      let [job0] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
        values (${repoId}, 'lite', 'done', 28, ${PREVIOUS}, 'main') returning id`
      // Two findings with the same path and title: the ledger settled one of them, by its fingerprint.
      let twinSettled = { ...finding, path: 'c.ts', title: 'twin', fingerprint: '4444444444444444' }
      let twinOpen = { ...finding, path: 'c.ts', line: 9, title: 'twin', fingerprint: '5555555555555555' }
      // A finding stored with the title of its rule (a key of the service), and one that an older
      // release stored with a fingerprint of another form: the runner would refuse the job with them.
      let ruled = { ...finding, path: 'd.ts', title: 'ruled', fingerprint: '6666666666666666', rule_title: 'No raw SQL' }
      let malformed = { ...finding, path: 'e.ts', title: 'old', fingerprint: 'not-hex' }
      let result = review({ head: PREVIOUS, score: 3, findings: [open, gone, unprinted, twinSettled, twinOpen, ruled, malformed], reuseKey: KEY })
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        values (${job0!.id}, ${repoId}, 28, ${PREVIOUS}, 3, 'm', 0.01, ${JSON.stringify(result)}::jsonb, 555, now())`
      await database.sql`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, first_seen_sha, last_seen_sha)
        values (${repoId}, 28, '2222222222222222', 'aaaaaaaaaaaa', 'a.ts', 2, 'dismissed one', 'major', 'bug', 90, 'dismissed', ${PREVIOUS}, ${PREVIOUS})`
      await database.sql`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, first_seen_sha, last_seen_sha)
        values (${repoId}, 28, '3333333333333333', ${findingKey(unprinted)}, 'b.ts', 7, 'fixed one', 'major', 'bug', 90, 'fixed', ${PREVIOUS}, ${PREVIOUS})`
      await database.sql`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, first_seen_sha, last_seen_sha)
        values (${repoId}, 28, '4444444444444444', ${findingKey(twinSettled)}, 'c.ts', 2, 'twin', 'major', 'bug', 90, 'wontfix', ${PREVIOUS}, ${PREVIOUS})`
      let runner = await register()
      await queueJob()
      let raw = await (await claim(runner.token, { hasProviderKey: true, features: ['reuse', 'delta'] })).json()
      let checked = parseJob(raw)
      assert.ok(checked.ok, `the runner accepts the job: ${!checked.ok && checked.errors.join('; ')}`)
      let job: Job = raw
      assert.ok(job.kind === 'review' && job.reuse)
      let delta = job.kind === 'review' ? job.reuse?.delta : undefined
      assert.equal(delta?.score, 3)
      assert.deepEqual(
        delta?.findings.map((f) => f.fingerprint ?? f.title),
        ['1111111111111111', '5555555555555555', '6666666666666666'],
        'the settled ones are not carried, the open twin is, and a finding that the runner would refuse is not',
      )
      assert.ok(!('rule_title' in delta!.findings[2]!), 'a key of the service is not sent')
      assert.deepEqual(delta?.settled.map((f) => f.title).sort(), ['dismissed one', 'fixed one', 'twin'])

      // A runner of REV-89 gets no delta.
      await queueJob()
      let old: Job = await (await claim(runner.token, reader)).json()
      assert.ok(old.kind === 'review' && old.reuse && !('delta' in old.reuse))

      // A job of another level reviews the whole pull request.
      await database.sql`
        insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'heavy', 28, ${HEAD}, 'main')`
      let heavy: Job = await (await claim(runner.token, { hasProviderKey: true, features: ['reuse', 'delta'] })).json()
      assert.ok(heavy.kind === 'review' && heavy.reuse && !('delta' in heavy.reuse))
    })

    it('sends every finding of the pull request and the last review of the level to a runner that reads them (REV-99)', async () => {
      // The findings of the earlier tests of this file stay in the database: this test starts without them.
      await database.sql`delete from findings where repo_id = ${repoId}`
      await published()
      let insert = (key: string, title: string, status: string, at: string, reason: string | null = null) => database.sql`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, status_reason,
          first_seen_sha, last_seen_sha, updated_at)
        values (${repoId}, 28, '1111111111111111', ${key}, 'app/lib/billing.server.ts', 372, ${title}, 'major', 'bug', 90, ${status}, ${reason},
          ${PREVIOUS}, ${PREVIOUS}, now() - ${at}::interval)`
      await insert('c7f3ec000000', 'Row written before Stripe, then a rollback on a Stripe error', 'fixed', '1 minute')
      await insert('4e989b000000', 'Paid account: the Stripe/config error is hidden', 'dismissed', '2 minutes', 'False: the not-billed case falls back to the database.')
      await insert('dbf9b7000000', '`start_date` of the current phase', 'open', '1 hour')
      // A row that the runner would refuse (a key of another form) stays out.
      await insert('not-a-key', 'old', 'open', '2 hours')
      let runner = await register()
      await queueJob()
      let raw = await (await claim(runner.token, { hasProviderKey: true, features: ['earlier'] })).json()
      let checked = parseJob(raw)
      assert.ok(checked.ok, `the runner accepts the job: ${!checked.ok && checked.errors.join('; ')}`)
      let job: Job = raw
      assert.ok(job.kind === 'review' && job.earlier)
      let earlier = job.kind === 'review' ? job.earlier! : null
      assert.deepEqual(
        earlier!.findings.map((f) => [f.key, f.status]),
        [['dbf9b7000000', 'open'], ['c7f3ec000000', 'fixed'], ['4e989b000000', 'dismissed']],
        'the open ones first, then the newest',
      )
      assert.equal(earlier!.findings[2]!.reason, 'False: the not-billed case falls back to the database.')
      assert.equal(earlier!.findings[0]!.commit, PREVIOUS)
      assert.deepEqual(earlier!.last, { head: PREVIOUS, score: 2 }, 'the last review of the level of the job')

      // A runner of an earlier release gets no key that it does not know.
      await queueJob()
      let old: Job = await (await claim(runner.token, { hasProviderKey: true })).json()
      assert.ok(!('earlier' in old))
      // A job of another level gets the findings, and no last review.
      await database.sql`
        insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'heavy', 28, ${HEAD}, 'main')`
      let heavy: Job = await (await claim(runner.token, { hasProviderKey: true, features: ['earlier'] })).json()
      assert.ok(heavy.kind === 'review' && heavy.earlier?.findings.length === 3 && heavy.earlier.last === null)
    })

    it('sends the head of the last review on GitHub, of any level, to a runner that reads it (REV-100)', async () => {
      let runner = await register()
      // Before the first review: null.
      await queueJob()
      let first: Job = await (await claim(runner.token, { hasProviderKey: true, features: ['reviewed'] })).json()
      assert.ok(first.kind === 'review' && first.reviewed === null)
      await published()
      // A later review of another level, published after: it is the last reviewed commit.
      let LATER = 'c'.repeat(40)
      let [j] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref)
        values (${repoId}, 'heavy', 'done', 28, ${LATER}, 'main') returning id`
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        values (${j!.id}, ${repoId}, 28, ${LATER}, 4, 'm', 0.01, ${JSON.stringify(review({ level: 'heavy', head: LATER, score: 4 }))}::jsonb, 557, now() + interval '1 second')`
      await queueJob()
      let raw = await (await claim(runner.token, { hasProviderKey: true, features: ['reviewed'] })).json()
      assert.ok(parseJob(raw).ok)
      assert.equal((raw as Job).kind === 'review' && (raw as Extract<Job, { kind: 'review' }>).reviewed, LATER)
      // A runner of an earlier release gets no key that it does not know.
      await queueJob()
      let old: Job = await (await claim(runner.token, { hasProviderKey: true })).json()
      assert.ok(!('reviewed' in old))
    })

    it('queues the job again when the review to publish again is not there, and fails it at the last attempt', async () => {
      await published()
      let runner = await register()
      let jobId = await queueJob()
      assert.equal((await claim(runner.token, reader)).status, 200)
      let unchanged = { level: 'lite', base: BASE, head: HEAD, of: PREVIOUS, diffHash: '0123456789abcdef', reuseKey: 'f'.repeat(64) }
      assert.equal((await call(`/api/runner/jobs/${jobId}/result`, { token: runner.token, body: { outcome: 'unchanged', attempt: 1, unchanged } })).status, 204)
      let [job] = await database.sql<{ state: string }[]>`select state from jobs where id = ${jobId}`
      assert.equal(job!.state, 'queued')
      await database.sql`update jobs set not_before = null where id = ${jobId}`
      let again: Job = await (await claim(runner.token, reader)).json()
      assert.equal(again.kind === 'review' && again.reuse, null, 'the new attempt reviews the whole pull request')
      // A runner that still sends `unchanged` on its last attempt fails the job.
      assert.equal((await call(`/api/runner/jobs/${jobId}/result`, { token: runner.token, body: { outcome: 'unchanged', attempt: 2, unchanged } })).status, 204)
      let [last] = await database.sql<{ state: string; failure_reason: string }[]>`select state, failure_reason from jobs where id = ${jobId}`
      assert.equal(last!.state, 'failed')
      assert.match(last!.failure_reason, /to publish again is gone/)
      let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from reviews where job_id = ${jobId}`
      assert.equal(count!.n, 0)
    })
  })
})
