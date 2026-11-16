import { randomBytes } from 'node:crypto'

import { defaultModels } from '@sakuga-review/engine/levels'
import type { Job } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createConfigProviders } from '../../app/providers/catalog.ts'
import { createSecretBox, type SecretBox } from '../../app/providers/secrets.ts'
import { createProvidersStore, type ProvidersStore } from '../../app/providers/store.ts'
import { effectiveLevel } from '../../app/repo-config/effective.ts'
import { jobConfig, resolveConfig, type ConfigOverrides } from '../../app/repo-config/model.ts'
import { createAppRouter } from '../../app/router.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { createTestDatabase } from './helpers.ts'

// REV-27. What Settings and Config show as "Next job" (app/repo-config/effective.ts) is what
// the claim of the service gives the runner: the same provider, and the same first model. Each case
// queues a job with the config of the org and of the repository, claims it as a trusted runner that
// reads the providers and the models, and compares.

const REGISTRATION_TOKEN = 'registration-token-for-the-tests-0123456789'
const HEAD = 'b'.repeat(40)
const RUNNER = { hasProviderKey: false, kinds: ['review'], features: ['providers', 'models'], ownProvider: null }

describe('"Next job" is the provider and the model of the claim (REV-27)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let box: SecretBox
  let store: ProvidersStore
  let orgId: string
  let repoId: string

  function app() {
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
      },
    })
  }

  async function call(path: string, token: string, body: unknown) {
    return app().fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    )
  }

  /** Queues a lite job with the config of the org and of the repository, claims it, and says what the screen says. */
  async function compare(org: ConfigOverrides, repo: ConfigOverrides) {
    let resolved = resolveConfig(org, repo)
    let catalog = await createConfigProviders(store, { serviceKey: true }).list(orgId)
    let screen = effectiveLevel('lite', resolved.models.lite, catalog)
    await database.sql`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref, config)
      values (${repoId}, 'lite', 28, ${HEAD}, 'main', ${JSON.stringify(jobConfig(resolved, 'lite', 1))}::jsonb)`
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'r', labels: [], version: '0.2.0' })
    let { runnerId, token } = await registered.json()
    await database.sql`update runners set org_id = ${orgId}, trusted = true where id = ${runnerId}`
    let response = await call('/api/runner/jobs/claim', token, RUNNER)
    assert.equal(response.status, 200)
    let job = (await response.json()) as Job
    let given = job.providers![0]!
    // The runner runs the models of the config when the job carries them, else those of its provider,
    // else those of the type of its provider.
    let models = job.models ? [job.models.model] : given.models.length > 0 ? given.models : defaultModels(given.kind, 'lite')
    return { screen, claimed: { provider: given.id, model: models[0] ?? null } }
  }

  async function add(label: string, extra: { kind?: 'anthropic' | 'openrouter'; models?: Record<string, string[]> } = {}) {
    return store.add({
      orgId,
      userId: null,
      kind: extra.kind ?? 'anthropic',
      label,
      baseUrl: null,
      apiKey: `sk-${label.toLowerCase()}-0123456789`,
      models: extra.models ?? {},
    })
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 6 })
    box = createSecretBox(randomBytes(32))
    store = createProvidersStore(database.sql, box)
    let [org] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (77, 2001, 'sakuga-software') returning id`
    orgId = org!.id
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled) values (${orgId}, 3001, 'sakuga-software/sakuga-review', true) returning id`
    repoId = repo!.id
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

  it('no provider, nothing chosen: OpenRouter with the key of the service, and the models of Kentō', async () => {
    let { screen, claimed } = await compare({}, {})
    assert.equal(screen.origin, 'service')
    assert.deepEqual(claimed, { provider: screen.provider.id, model: screen.model })
  })

  it('nothing chosen: the "Default" provider, with its own models', async () => {
    let def = await add('Default', { models: { lite: ['claude-haiku-4-5', 'claude-sonnet-4-5'] } })
    let { screen, claimed } = await compare({}, {})
    assert.equal(screen.origin, 'default')
    assert.equal(screen.provider.id, def.id)
    assert.deepEqual(claimed, { provider: def.id, model: 'claude-haiku-4-5' })
    assert.equal(screen.model, 'claude-haiku-4-5')
  })

  it('nothing chosen, a default provider without models: the models of its type', async () => {
    await add('Default')
    let { screen, claimed } = await compare({}, {})
    assert.deepEqual(claimed, { provider: screen.provider.id, model: screen.model })
    assert.equal(screen.model, defaultModels('anthropic', 'lite')[0])
  })

  it('the org chose "service": OpenRouter, even with a default provider', async () => {
    await add('Default')
    let { screen, claimed } = await compare({ models: { lite: { provider: 'service', model: 'anthropic/claude-haiku-5.5', fallback: null } } }, {})
    assert.equal(screen.origin, 'chosen')
    assert.deepEqual(claimed, { provider: 'service', model: 'anthropic/claude-haiku-5.5' })
    assert.deepEqual(claimed, { provider: screen.provider.id, model: screen.model })
  })

  it('the repository chose another provider than the default: that one, with the model of the config', async () => {
    await add('Default')
    let other = await add('Other', { kind: 'openrouter' })
    let { screen, claimed } = await compare(
      { models: { lite: { provider: 'service', model: 'anthropic/claude-haiku-5.5', fallback: null } } },
      { models: { lite: { provider: other.id, model: 'z-ai/glm-5.3', fallback: null } } },
    )
    assert.deepEqual(claimed, { provider: other.id, model: 'z-ai/glm-5.3' })
    assert.deepEqual(claimed, { provider: screen.provider.id, model: screen.model })
  })

  it('a config that names a provider removed since: OpenRouter with the key of the service', async () => {
    await add('Default')
    let { screen, claimed } = await compare({ models: { lite: { provider: '9e1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f', model: 'claude-x', fallback: null } } }, {})
    assert.equal(screen.origin, 'missing')
    assert.deepEqual(claimed, { provider: 'service', model: defaultModels('openrouter', 'lite')[0] })
    assert.deepEqual(claimed, { provider: screen.provider.id, model: screen.model })
  })
})
