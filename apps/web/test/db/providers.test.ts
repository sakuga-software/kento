import { randomBytes } from 'node:crypto'

import type { Job, ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createSecretBox, type SecretBox } from '../../app/providers/secrets.ts'
import { createProvidersStore, type ProvidersStore } from '../../app/providers/store.ts'
import { createAppRouter } from '../../app/router.ts'
import type { RunnerApiDependencies } from '../../app/runner/controller.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { createTestDatabase } from './helpers.ts'

const REGISTRATION_TOKEN = 'registration-token-for-the-tests-0123456789'
const HEAD = 'b'.repeat(40)
const BASE = 'a'.repeat(40)
const ANTHROPIC_KEY = 'sk-ant-api03-key-of-the-db-test-0123456789-WXYZ'
const NEW_RUNNER = { hasProviderKey: false, kinds: ['review'], features: ['providers'], ownProvider: null }

describe('providers and their encrypted keys', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let box: SecretBox
  let store: ProvidersStore
  let orgId: string
  let otherOrgId: string
  let repoId: string
  let otherRepoId: string

  function router(overrides: Partial<RunnerApiDependencies> = {}) {
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 10 }),
      version: 'test',
      commit: null,
      webhook: disabledWebhook,
      runner: {
        store: createRunnerStore(database.sql),
        registrationToken: REGISTRATION_TOKEN,
        mintInstallationToken: async () => ({ token: 'ghs_installation_token', expiresAt: '2027-01-15T09:00:00Z' }),
        providerApiKey: 'sk-or-service-key',
        secrets: box,
        claimWaitMs: 0,
        claimPollMs: 50,
        ...overrides,
      },
    })
  }

  function call(path: string, token: string, body: unknown, app = router()) {
    return app.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    )
  }

  /** A runner of the org (or of the service with `orgId` null), trusted or not. */
  async function runner(options: { orgId?: string | null; trusted?: boolean } = {}): Promise<string> {
    let response = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'r', labels: [], version: '0.2.0' })
    let { runnerId, token } = await response.json()
    await database.sql`
      update runners set org_id = ${options.orgId === undefined ? orgId : options.orgId}, trusted = ${options.trusted ?? false}
      where id = ${runnerId}`
    return token
  }

  async function queueJob(repo = repoId): Promise<string> {
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repo}, 'lite', 28, ${HEAD}, 'main') returning id`
    return job!.id
  }

  async function claim(token: string, body: unknown = NEW_RUNNER, app?: ReturnType<typeof router>) {
    let response = await call('/api/runner/jobs/claim', token, body, app)
    return { status: response.status, job: response.status === 200 ? ((await response.json()) as Job) : null }
  }

  function review(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
    return {
      level: 'lite', base: BASE, head: HEAD, score: 4, verdict: 'COMMENT', model: 'claude-haiku-5-5', provider: 'Anthropic',
      costUsd: 0.0015, costSource: 'table', promptTokens: 10_000, completionTokens: 1000, summary: 'Résumé', risk: 'Faible',
      diagram: null, deeperReview: null, findings: [], notReviewed: [], skipped: [], ...overrides,
    }
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 12 })
    box = createSecretBox(randomBytes(32))
    store = createProvidersStore(database.sql, box)
    let orgs = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login)
      values (77, 2001, 'sakuga-software'), (78, 2002, 'orchard') returning id`
    orgId = orgs[0]!.id
    otherOrgId = orgs[1]!.id
    let repos = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${orgId}, 3001, 'sakuga-software/sakuga-review', true), (${otherOrgId}, 3002, 'orchard/app', true) returning id`
    repoId = repos[0]!.id
    otherRepoId = repos[1]!.id
  })

  beforeEach(async () => {
    await database.sql`delete from jobs`
    await database.sql`delete from runners`
    await database.sql`delete from providers`
  })

  after(async () => {
    await database.close()
    await test.drop()
  })

  describe('the store', () => {
    it('keeps no key in clear: a SELECT on providers shows only a ciphertext and the last 4 characters', async () => {
      let added = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'Anthropic', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      assert.equal(added.keyLast4, 'WXYZ')
      assert.equal(added.isDefault, true, 'the first provider of an org is its default')
      let rows = await database.sql`select * from providers`
      let dump = JSON.stringify(rows)
      assert.ok(!dump.includes(ANTHROPIC_KEY), 'no key in clear')
      assert.ok(!dump.includes(ANTHROPIC_KEY.slice(8, 30)), 'no part of the key either')
      assert.match(String(rows[0]!.key_ciphertext), /^v1:[0-9a-f]{16}:/)
      assert.equal((await store.withKey(orgId, added.id))!.apiKey, ANTHROPIC_KEY)
    })

    it('reads, replaces and removes only the providers of its org', async () => {
      let a = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      assert.equal(await store.withKey(otherOrgId, a.id), null)
      assert.equal(await store.replaceKey(otherOrgId, a.id, 'sk-ant-other-0123456789'), null)
      assert.equal(await store.setDefault(otherOrgId, a.id), null)
      assert.equal(await store.remove(otherOrgId, a.id), null)
      assert.equal((await store.list(orgId)).length, 1)
      // A ciphertext copied to a row of another org does not decrypt there.
      let b = await store.add({ orgId: otherOrgId, userId: null, kind: 'anthropic', label: 'B', baseUrl: null, apiKey: 'sk-ant-orchard-0123456789', models: {} })
      await database.sql`update providers set key_ciphertext = (select key_ciphertext from providers where id = ${a.id}) where id = ${b.id}`
      await assert.rejects(store.withKey(otherOrgId, b.id), /does not match its row/)
    })

    it('replaces a key and forgets the refusal of the old one', async () => {
      let a = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      await store.recordRefused(a.id, 401, '401 invalid x-api-key', a.keySetAt)
      await store.recordRefused(a.id, 401, 'again', a.keySetAt)
      let [refused] = await store.list(orgId)
      assert.equal(refused!.refusedStatus, 401)
      let first = refused!.refusedAt
      await store.recordRefused(a.id, 403, 'later', a.keySetAt)
      assert.deepEqual((await store.list(orgId))[0]!.refusedAt, first, 'the first refusal stays: « 401 depuis 9 h 40 »')
      let replaced = await store.replaceKey(orgId, a.id, 'sk-ant-new-key-0123456789-abcd')
      assert.equal(replaced!.keyLast4, 'abcd')
      assert.equal(replaced!.refusedAt, null)
    })

    it('« Tester » marks only the key that it used: a key replaced during the test keeps its state', async () => {
      let a = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let read = (await store.withKey(orgId, a.id))!
      await new Promise((resolve) => setTimeout(resolve, 5))
      await store.replaceKey(orgId, a.id, 'sk-ant-replaced-during-the-test-0123')
      await store.recordRefused(a.id, 401, '401 invalid x-api-key', read.provider.keySetAt)
      await store.recordOk(a.id, read.provider.keySetAt)
      let [state] = await store.list(orgId)
      assert.equal(state!.refusedAt, null)
      assert.equal(state!.lastOkAt, null)
      // With the key that is there now, it marks.
      await store.recordRefused(a.id, 401, '401', state!.keySetAt)
      assert.equal((await store.list(orgId))[0]!.refusedStatus, 401)
    })

    it('keeps one default per org, and the oldest one left takes over when the default goes', async () => {
      let a = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let b = await store.add({ orgId, userId: null, kind: 'ollama', label: 'B', baseUrl: 'http://gpu.lan:11434', apiKey: null, models: { lite: ['q'], balanced: ['q'], heavy: ['q'] } })
      assert.equal(b.isDefault, false)
      assert.equal(b.runnerHeld, true)
      await store.setDefault(orgId, b.id)
      let list = await store.list(orgId)
      assert.deepEqual(list.map((p) => [p.label, p.isDefault]), [['B', true], ['A', false]])
      await store.remove(orgId, b.id)
      assert.equal((await store.list(orgId))[0]!.id, a.id)
      assert.equal((await store.list(orgId))[0]!.isDefault, true)
    })

    it('refuses a key that is half there, and Ollama with a key held by the service', async () => {
      await assert.rejects(
        database.sql`insert into providers (id, org_id, kind, label, runner_held, key_ciphertext, key_last4) values (gen_random_uuid(), ${orgId}, 'anthropic', 'x', false, 'v1:x', null)`,
        /providers_last4_with_key/,
      )
      await assert.rejects(
        database.sql`insert into providers (id, org_id, kind, label, runner_held, key_ciphertext, key_last4) values (gen_random_uuid(), ${orgId}, 'ollama', 'x', false, 'v1:x', 'abcd')`,
        /providers_ollama_on_runner/,
      )
    })

    it('takes an id that is not a uuid as a provider that does not exist', async () => {
      for (let id of ['not-a-uuid', "1' or '1'='1"]) {
        assert.equal(await store.withKey(orgId, id), null)
        assert.equal(await store.replaceKey(orgId, id, 'sk-ant-0123456789'), null)
        assert.equal(await store.setDefault(orgId, id), null)
        assert.equal(await store.remove(orgId, id), null)
      }
    })

    it('keeps one default when two admins choose two providers at the same time', async () => {
      let a = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let b = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'B', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let c = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'C', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      for (let round = 0; round < 20; round++) {
        await Promise.all([store.setDefault(orgId, b.id), store.setDefault(orgId, c.id), store.setDefault(orgId, a.id)])
        let defaults = (await store.list(orgId)).filter((p) => p.isDefault)
        assert.equal(defaults.length, 1)
      }
    })

    it('stores no key without a master key', async () => {
      let without = createProvidersStore(database.sql, null)
      await assert.rejects(without.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} }), /KENTO_SECRETS_KEY/)
      let held = await without.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: null, models: {} })
      assert.equal(held.runnerHeld, true)
    })
  })

  describe('the claim of a job with the provider of its org', () => {
    it('gives the key of the provider, decrypted, to a trusted runner of the org only, and records the provider on the job', async () => {
      let provider = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: { heavy: ['claude-opus-5-5'] } })
      let jobId = await queueJob()

      let untrusted = await runner({ trusted: false })
      assert.equal((await claim(untrusted)).status, 204, 'an untrusted runner never gets the key')
      let otherOrg = await runner({ orgId: otherOrgId, trusted: true })
      assert.equal((await claim(otherOrg)).status, 204, 'a runner of another org never gets the job')

      let trusted = await runner({ trusted: true })
      let { job } = await claim(trusted)
      assert.equal(job!.id, jobId)
      assert.equal(job!.provider, null)
      assert.deepEqual(job!.providers, [{ id: provider.id, kind: 'anthropic', apiKey: ANTHROPIC_KEY, baseUrl: null, models: [] }])
      let [row] = await database.sql<{ provider_id: string }[]>`select provider_id from jobs where id = ${jobId}`
      assert.equal(row!.provider_id, provider.id)
    })

    it('gives a runner with its own key of that kind the job without the key', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      await queueJob()
      let own = await runner({ trusted: false })
      let { job } = await claim(own, { ...NEW_RUNNER, hasProviderKey: true, ownProvider: 'anthropic' })
      assert.equal(job!.providers![0]!.apiKey, null)
    })

    it('gives a job of a runner-held provider only to a runner that holds that kind', async () => {
      await store.add({ orgId, userId: null, kind: 'ollama', label: 'GPU', baseUrl: 'http://gpu.lan:11434', apiKey: null, models: { lite: ['qwen3:32b'], balanced: ['q'], heavy: ['q'] } })
      await queueJob()
      let trusted = await runner({ trusted: true })
      assert.equal((await claim(trusted)).status, 204, 'trusted, but without Ollama')
      let ollama = await runner({ trusted: false })
      let { job } = await claim(ollama, { ...NEW_RUNNER, hasProviderKey: true, ownProvider: 'ollama' })
      assert.deepEqual(job!.providers![0], { id: job!.providers![0]!.id, kind: 'ollama', apiKey: null, baseUrl: 'http://gpu.lan:11434', models: ['qwen3:32b'] })
    })

    it('gives no job of an org with a provider to a runner of an earlier release, and the key of the service for an org without one', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      await queueJob()
      let otherJob = await queueJob(otherRepoId)
      let serviceRunner = await runner({ orgId: null, trusted: true })
      let { job } = await claim(serviceRunner, { hasProviderKey: false })
      assert.equal(job!.id, otherJob, 'the earlier runner skips the job of the org with a provider')
      assert.deepEqual(job!.provider, { kind: 'openrouter', apiKey: 'sk-or-service-key' })
      assert.equal('providers' in job!, false)
      assert.equal((await claim(serviceRunner, { hasProviderKey: false })).status, 204)
    })

    it('never decrypts the key for a runner of another org, even if the claim gave it the job', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let jobId = await queueJob()
      let token = await runner({ trusted: true })
      let real = createRunnerStore(database.sql)
      // A claim that would be wrong: the check of the controller is the second line of defence.
      let wrong = { ...real, claimJob: async (...args: Parameters<typeof real.claimJob>) => {
        let job = await real.claimJob(...args)
        return job && { ...job, runnerOrgId: otherOrgId }
      } }
      let response = await call('/api/runner/jobs/claim', token, NEW_RUNNER, router({ store: wrong }))
      assert.equal(response.status, 204)
      assert.ok(!(await response.text()).includes(ANTHROPIC_KEY))
      let [row] = await database.sql<{ state: string; attempts: number }[]>`select state, attempts from jobs where id = ${jobId}`
      assert.deepEqual({ ...row }, { state: 'queued', attempts: 1 })
    })

    it('without its master key, the service gives no job that needs the key of a provider', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      await queueJob()
      let trusted = await runner({ trusted: true })
      assert.equal((await claim(trusted, NEW_RUNNER, router({ secrets: null }))).status, 204)
    })

    it('a key that the master key cannot decrypt gives the job back, and never sends a wrong key', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let jobId = await queueJob()
      let trusted = await runner({ trusted: true })
      let other = createSecretBox(randomBytes(32))
      assert.equal((await claim(trusted, NEW_RUNNER, router({ secrets: other }))).status, 204)
      let [row] = await database.sql<{ state: string; attempts: number }[]>`select state, attempts from jobs where id = ${jobId}`
      assert.deepEqual({ ...row }, { state: 'queued', attempts: 1 })
    })
  })

  describe('the provider that the config of the repository chose (REV-12)', () => {
    async function queueWithConfig(config: object): Promise<string> {
      let [job] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, base_ref, config)
        values (${repoId}, 'lite', 28, ${HEAD}, 'main', ${JSON.stringify(config)}::jsonb) returning id`
      return job!.id
    }

    it('takes the provider that the config names, even when it is not the default, and sends its models', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'Default', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let chosen = await store.add({ orgId, userId: null, kind: 'openrouter', label: 'Chosen', baseUrl: null, apiKey: 'sk-or-chosen-0123456789', models: {} })
      await queueWithConfig({ repoConfigVersion: 3, source: 'repo', models: { provider: chosen.id, model: 'anthropic/claude-opus-5.5', fallback: null } })
      let token = await runner({ trusted: true })
      let { job } = await claim(token, { ...NEW_RUNNER, features: ['providers', 'models'] })
      assert.equal(job!.providers![0]!.id, chosen.id)
      assert.equal(job!.providers![0]!.apiKey, 'sk-or-chosen-0123456789')
      assert.deepEqual(job!.models, { provider: chosen.id, model: 'anthropic/claude-opus-5.5', fallback: null })
    })

    it('a config that chose « service » runs on the key of the service, even with a default provider', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'Default', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      await queueWithConfig({ repoConfigVersion: 1, source: 'org', models: { provider: 'service', model: 'anthropic/claude-haiku-5.5', fallback: null } })
      let token = await runner({ trusted: true })
      let { job } = await claim(token, { ...NEW_RUNNER, features: ['providers', 'models'] })
      assert.deepEqual(job!.providers, [{ id: 'service', kind: 'openrouter', apiKey: 'sk-or-service-key', baseUrl: null, models: [] }])
      assert.equal(job!.models!.provider, 'service')
    })

    it('with no choice in the config (the values of Kentō), the default provider of the org, and its own models', async () => {
      let def = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'Default', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      await queueWithConfig({ repoConfigVersion: 0, source: 'kento', models: { provider: 'service', model: 'anthropic/claude-haiku-5.5', fallback: 'z-ai/glm-5.3' } })
      let token = await runner({ trusted: true })
      let { job } = await claim(token, { ...NEW_RUNNER, features: ['providers', 'models'] })
      assert.equal(job!.providers![0]!.id, def.id)
      assert.equal('models' in job!, false, 'the OpenRouter models of Kentō never go to Anthropic')
    })

    it('a provider of another org named in a config is never given', async () => {
      let other = await store.add({ orgId: otherOrgId, userId: null, kind: 'anthropic', label: 'Other org', baseUrl: null, apiKey: 'sk-ant-orchard-0123456789', models: {} })
      await queueWithConfig({ repoConfigVersion: 1, source: 'repo', models: { provider: other.id, model: 'claude-opus-5-5', fallback: null } })
      let token = await runner({ trusted: true })
      let { job } = await claim(token, { ...NEW_RUNNER, features: ['providers', 'models'] })
      assert.equal(job!.providers![0]!.id, 'service')
      assert.ok(!JSON.stringify(job).includes('sk-ant-orchard'))
    })
  })

  describe('the result marks the state of the provider', () => {
    it('a refused key: the provider shows « refusée, 401 », and the job fails with a clear reason', async () => {
      let provider = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'Anthropic de Sakuga', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let jobId = await queueJob()
      let token = await runner({ trusted: true })
      let { job } = await claim(token)
      let response = await call(`/api/runner/jobs/${jobId}/result`, token, {
        outcome: 'failed',
        attempt: job!.attempt,
        reason: 'no model gave a usable answer: ProviderError: Anthropic answered 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        providerStatus: 401,
      })
      assert.equal(response.status, 204)
      let [state] = await store.list(orgId)
      assert.equal(state!.refusedStatus, 401)
      assert.ok(state!.refusedAt)
      let [row] = await database.sql<{ failure_reason: string }[]>`select failure_reason from jobs where id = ${jobId}`
      assert.match(row!.failure_reason, /^the provider « Anthropic de Sakuga » refused its key \(401\): /)
      assert.equal(provider.id, state!.id)
    })

    it('a runner-held key that its provider refuses: the provider shows the refusal, and the next review clears it (REV-31)', async () => {
      let provider = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'Anthropic du runner', baseUrl: null, apiKey: null, models: {} })
      assert.equal(provider.keySetAt, null)
      let first = await queueJob()
      let token = await runner({ trusted: false })
      let held = { ...NEW_RUNNER, hasProviderKey: true, ownProvider: 'anthropic' }
      let { job } = await claim(token, held)
      assert.equal(job!.id, first)
      assert.equal(job!.providers![0]!.apiKey, null, 'the service never had this key')
      let [row] = await database.sql<{ provider_id: string | null }[]>`select provider_id from jobs where id = ${first}`
      assert.equal(row!.provider_id, provider.id, 'the job records its runner-held provider')
      let failed = await call(`/api/runner/jobs/${first}/result`, token, {
        outcome: 'failed',
        attempt: job!.attempt,
        reason: 'no model gave a usable answer: ProviderError: Anthropic answered 401: invalid x-api-key',
        providerStatus: 401,
      })
      assert.equal(failed.status, 204)
      let [refused] = await store.list(orgId)
      assert.ok(refused!.refusedAt, 'the screen can show the refusal')
      assert.equal(refused!.refusedStatus, 401)
      assert.match(refused!.refusedMessage!, /^runner « r » : 401 /, 'the runner that got the refusal is named')
      let [reason] = await database.sql<{ failure_reason: string }[]>`select failure_reason from jobs where id = ${first}`
      assert.match(reason!.failure_reason, /^the provider « Anthropic du runner » refused its key \(401\)/)

      let second = await queueJob()
      let next = await claim(token, held)
      assert.equal(next.job!.id, second)
      assert.equal((await call(`/api/runner/jobs/${second}/result`, token, { outcome: 'done', attempt: next.job!.attempt, review: review() })).status, 204)
      let [cleared] = await store.list(orgId)
      assert.equal(cleared!.refusedAt, null)
      assert.ok(cleared!.lastOkAt)
    })

    it('a runner-held provider follows the order of the jobs: an older job never overwrites a newer state (REV-31)', async () => {
      let provider = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'Anthropic du runner', baseUrl: null, apiKey: null, models: {} })
      let held = { ...NEW_RUNNER, hasProviderKey: true, ownProvider: 'anthropic' }
      let slow = await runner()
      let good = await runner()
      let first = await queueJob()
      let a = await claim(slow, held)
      assert.equal(a.job!.id, first)
      let second = await queueJob()
      let b = await claim(good, held)
      assert.equal(b.job!.id, second)
      await database.sql`update jobs set started_at = started_at + interval '1 second' where id = ${second}`
      // The newer job works, then the older one comes back with 401: the provider stays valid.
      assert.equal((await call(`/api/runner/jobs/${second}/result`, good, { outcome: 'done', attempt: b.job!.attempt, review: review() })).status, 204)
      assert.equal((await call(`/api/runner/jobs/${first}/result`, slow, { outcome: 'failed', attempt: a.job!.attempt, reason: 'Anthropic answered 401', providerStatus: 401 })).status, 204)
      let [state] = await store.list(orgId)
      assert.equal(state!.refusedAt, null, 'the refusal of the older job does not hide the newer success')
      assert.ok(state!.lastOkAt)

      // The other way: a refusal, then a success of a job that started before it, keeps the refusal.
      let third = await queueJob()
      let c = await claim(good, held)
      assert.equal(c.job!.id, third)
      let fourth = await queueJob()
      let d = await claim(slow, held)
      assert.equal(d.job!.id, fourth)
      await database.sql`update jobs set started_at = started_at + interval '1 second' where id = ${fourth}`
      await database.sql`update providers set last_ok_at = null where id = ${provider.id}`
      assert.equal((await call(`/api/runner/jobs/${fourth}/result`, slow, { outcome: 'failed', attempt: d.job!.attempt, reason: 'Anthropic answered 401', providerStatus: 401 })).status, 204)
      assert.ok((await store.list(orgId))[0]!.refusedAt)
      assert.equal((await call(`/api/runner/jobs/${third}/result`, good, { outcome: 'done', attempt: c.job!.attempt, review: review() })).status, 204)
      assert.ok((await store.list(orgId))[0]!.refusedAt, 'a success of an older job does not clear a newer refusal')
    })

    it('a review marks the provider valid, and clears a refusal', async () => {
      let provider = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      await store.recordRefused(provider.id, 401, 'old', provider.keySetAt)
      let jobId = await queueJob()
      let token = await runner({ trusted: true })
      let { job } = await claim(token)
      let response = await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'done', attempt: job!.attempt, review: review() })
      assert.equal(response.status, 204)
      let [state] = await store.list(orgId)
      assert.ok(state!.lastOkAt)
      assert.equal(state!.refusedAt, null)
      let [stored] = await database.sql<{ cost_usd: string; result: { costSource: string } }[]>`select cost_usd, result from reviews where job_id = ${jobId}`
      assert.equal(Number(stored!.cost_usd), 0.0015)
      assert.equal(stored!.result.costSource, 'table')
    })

    it('a resolve with no thread to answer called no model: the provider stays as it was', async () => {
      let provider = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      await runner({ trusted: true })
      let [r] = await database.sql<{ id: string }[]>`select id from runners limit 1`
      let [job] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, runner_id, attempts, provider_id, lease_expires_at)
        values (${repoId}, 'resolve', 'lite', 'running', 28, ${HEAD}, 'main', ${r!.id}, 1, ${provider.id}, now() + interval '2 minutes')
        returning id`
      let outcome = await createRunnerStore(database.sql).storeResult(job!.id, r!.id, 1, {
        outcome: 'resolved',
        resolve: { level: 'lite', head: HEAD, model: null, provider: null, costUsd: null, promptTokens: null, completionTokens: null, open: 0, waiting: 0, held: 0, threads: [] },
      })
      assert.equal(outcome, 'stored')
      assert.equal((await store.list(orgId))[0]!.lastOkAt, null)
    })

    it('a runner that called with its own key says nothing about the key of the org', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let jobId = await queueJob()
      let token = await runner({ trusted: true })
      let { job } = await claim(token, { ...NEW_RUNNER, hasProviderKey: true, ownProvider: 'anthropic' })
      assert.equal(job!.providers![0]!.apiKey, null)
      let [row] = await database.sql<{ provider_id: string | null }[]>`select provider_id from jobs where id = ${jobId}`
      assert.equal(row!.provider_id, null, 'the job is not the provider’s: the service gave no key')
      await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'failed', attempt: job!.attempt, reason: 'Anthropic answered 401', providerStatus: 401 })
      let [state] = await store.list(orgId)
      assert.equal(state!.refusedAt, null)
    })

    it('a result that the service refuses (another head) does not mark the provider valid', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let jobId = await queueJob()
      let token = await runner({ trusted: true })
      let { job } = await claim(token)
      let response = await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'done', attempt: job!.attempt, review: review({ head: 'd'.repeat(40) }) })
      assert.equal(response.status, 422)
      assert.equal((await store.list(orgId))[0]!.lastOkAt, null)
    })

    it('the answer to a key that an admin replaced during the job says nothing about the new key', async () => {
      let provider = await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let token = await runner({ trusted: true })
      let refusedJob = await queueJob()
      let first = await claim(token)
      await store.replaceKey(orgId, provider.id, 'sk-ant-the-new-key-0123456789')
      await call(`/api/runner/jobs/${refusedJob}/result`, token, { outcome: 'failed', attempt: first.job!.attempt, reason: 'Anthropic answered 401', providerStatus: 401 })
      assert.equal((await store.list(orgId))[0]!.refusedAt, null, 'the new key is not shown refused')

      let doneJob = await queueJob()
      let second = await claim(token)
      await store.replaceKey(orgId, provider.id, 'sk-ant-a-third-key-0123456789')
      await call(`/api/runner/jobs/${doneJob}/result`, token, { outcome: 'done', attempt: second.job!.attempt, review: review() })
      assert.equal((await store.list(orgId))[0]!.lastOkAt, null, 'nor valid')
    })

    it('a failure elsewhere (a clone) changes nothing on the provider', async () => {
      await store.add({ orgId, userId: null, kind: 'anthropic', label: 'A', baseUrl: null, apiKey: ANTHROPIC_KEY, models: {} })
      let jobId = await queueJob()
      let token = await runner({ trusted: true })
      let { job } = await claim(token)
      await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'failed', attempt: job!.attempt, reason: 'clone failed', providerStatus: null })
      let [state] = await store.list(orgId)
      assert.equal(state!.refusedAt, null)
      assert.equal(state!.lastOkAt, null)
    })
  })
})
