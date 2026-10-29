import { RUNNER_TOKEN_PREFIX, type Job, type ReviewPayload } from '@sakuga-review/protocol'
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
      summary: 'Résumé',
      risk: 'Faible',
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
      insert into orgs (github_installation_id, github_account_id, login)
      values (77, 2001, 'sakuga-software') returning id`
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${org!.id}, 3001, 'sakuga-software/sakuga-review', true) returning id`
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
})
