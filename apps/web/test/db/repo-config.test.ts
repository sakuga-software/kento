import type { Job } from '@kento-review/protocol'
import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore, enqueueCommandJob, type ListChangedFiles } from '../../app/db/webhook-store.ts'
import { disabledWebhook, headSha, pullRequestPayload, REPO, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { createRepoConfigStore } from '../../app/repo-config/store.ts'
import { createAppRouter } from '../../app/router.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { hashToken } from '../../app/runner/tokens.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

// REV-12 against Postgres: the versions of the config, and what the service does with it when it
// queues a job and when a runner claims it.

const SONNET = { provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: null }
const OPUS = { provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: null }

describe('the config of a repository against Postgres', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let orgId: string
  let repoId: string
  let userId: string
  let delivery = 0
  let changedFiles: string[] | Error | null = null
  let listed = 0

  let listChangedFiles: ListChangedFiles = async () => {
    listed++
    if (changedFiles instanceof Error) throw changedFiles
    return changedFiles
  }

  function webhookRouter() {
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '0.1.0',
      commit: null,
      webhook: { secret: TEST_SECRET, trustedBotsFor: async () => new Set(), apply: createWebhookStore(database.db, { listChangedFiles }) },
    })
  }

  async function push(options: Parameters<typeof pullRequestPayload>[0] = {}) {
    delivery++
    let deliveryId = `00000000-0000-0000-0000-${delivery.toString().padStart(12, '0')}`
    let response = await webhookRouter().fetch(signedRequest(pullRequestPayload(options), { deliveryId }))
    return response.json() as Promise<{ outcome: string; reason?: string; jobId?: string }>
  }

  async function setRepoConfig(config: unknown, version = 1) {
    await sql`update repos set config = ${JSON.stringify(config)}::jsonb, config_version = ${version} where id = ${repoId}`
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    sql = database.sql
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  beforeEach(async () => {
    await sql`truncate orgs, repos, jobs, reviews, resolutions, users, runners cascade`
    ;({ orgId, repoId } = await seedEnabledRepo(sql))
    let [user] = await sql<{ id: string }[]>`insert into users (github_id, login, email) values (1, 'octocat', '1@users.github.invalid') returning id`
    userId = user!.id
    changedFiles = null
    listed = 0
  })

  describe('the store of the screen', () => {
    it('starts at v0 with nothing set, then each save writes the next version, its author and its date', async () => {
      let store = createRepoConfigStore(database)
      let view = await store.read(orgId, repoId)
      assert.equal(view!.version, 0)
      assert.deepEqual(view!.config, {})
      assert.equal(view!.updatedBy, null)

      let saved = await store.save(orgId, repoId, userId, 0, (current) => ({ ...current, config: { models: { balanced: SONNET } } }))
      assert.deepEqual(saved, { kind: 'saved', version: 1, fullName: 'sakuga-software/sakuga-review' })
      let level = await store.save(orgId, repoId, userId, 1, (current) => ({ ...current, defaultLevel: 'heavy' }))
      assert.equal(level.kind === 'saved' && level.version, 2)

      view = await store.read(orgId, repoId)
      assert.equal(view!.version, 2)
      assert.deepEqual(view!.config, { models: { balanced: SONNET } })
      assert.equal(view!.defaultLevel, 'heavy')
      assert.equal(view!.updatedBy, 'octocat')
      assert.ok(view!.updatedAt && Date.now() - view!.updatedAt.getTime() < 60_000)
    })

    it('refuses a save from an older version, and writes nothing', async () => {
      let store = createRepoConfigStore(database)
      await store.save(orgId, repoId, userId, 0, (current) => ({ ...current, config: { trigger: 'command' } }))
      let stale = await store.save(orgId, repoId, userId, 0, (current) => ({ ...current, config: { trigger: 'push' } }))
      assert.equal(stale.kind, 'conflict')
      assert.equal(stale.kind === 'conflict' && stale.version, 1)
      assert.equal(stale.kind === 'conflict' && stale.updatedBy, 'octocat')
      assert.deepEqual((await store.read(orgId, repoId))!.config, { trigger: 'command' })
    })

    it('two saves from the same version at once: one is written, the other is refused', async () => {
      let store = createRepoConfigStore(database)
      let outcomes = await Promise.all([
        store.save(orgId, repoId, userId, 0, (current) => ({ ...current, config: { trigger: 'ready' } })),
        store.save(orgId, repoId, userId, 0, (current) => ({ ...current, config: { trigger: 'command' } })),
      ])
      assert.deepEqual(outcomes.map((o) => o.kind).sort(), ['conflict', 'saved'])
      assert.equal((await store.read(orgId, repoId))!.version, 1)
    })

    it('never reads nor writes the repository of another org', async () => {
      let store = createRepoConfigStore(database)
      let [other] = await sql<{ id: string }[]>`
        with org as (insert into orgs (name, slug) values ('orchard', lower('orchard')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 1002, 2002, 'orchard' from org returning org_id as id`
      assert.equal(await store.read(other!.id, repoId), null)
      assert.deepEqual(await store.save(other!.id, repoId, userId, 0, (c) => c), { kind: 'not_found' })
      assert.equal(await store.read(orgId, 'not-a-uuid'), null)
    })

    it('adds what the reviews and resolutions of the month cost, and nothing older', async () => {
      let [job] = await sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, base_ref, state) values (${repoId}, 'lite', 1, ${headSha(1)}, 'main', 'done') returning id`
      let [old] = await sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, base_ref, state) values (${repoId}, 'lite', 1, ${headSha(2)}, 'main', 'done') returning id`
      let [resolveJob] = await sql<{ id: string }[]>`
        insert into jobs (repo_id, kind, level, pr_number, head_sha, base_ref, state) values (${repoId}, 'resolve', 'lite', 1, ${headSha(3)}, 'main', 'done') returning id`
      await sql`insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
        values (${job!.id}, ${repoId}, 1, ${headSha(1)}, 4, 'm', 1.25, '{}')`
      await sql`insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, created_at)
        values (${old!.id}, ${repoId}, 1, ${headSha(2)}, 4, 'm', 100, '{}', now() - interval '40 days')`
      await sql`insert into resolutions (job_id, repo_id, pr_number, head_sha, model, cost_usd, result)
        values (${resolveJob!.id}, ${repoId}, 1, ${headSha(3)}, 'm', 0.5, '{}')`
      assert.equal((await createRepoConfigStore(database).read(orgId, repoId))!.spentThisMonthUsd, 1.75)
    })
  })

  describe('the enqueue of a push', () => {
    it('freezes the models of the level in the job: the repository, else the org, else Kentō', async () => {
      await sql`update orgs set config = ${JSON.stringify({ models: { lite: OPUS } })}::jsonb where id = ${orgId}`
      assert.equal((await push({ head: headSha(1) })).outcome, 'queued')
      await setRepoConfig({ models: { lite: SONNET } }, 7)
      assert.equal((await push({ head: headSha(2) })).outcome, 'queued')
      await sql`update orgs set config = '{}' where id = ${orgId}`
      await setRepoConfig({}, 8)
      assert.equal((await push({ head: headSha(3) })).outcome, 'queued')

      let rows = await sql<{ head_sha: string; config: any }[]>`select head_sha, config from jobs order by created_at, id`
      assert.deepEqual(rows[0]!.config, { repoConfigVersion: 0, models: OPUS, source: 'org' })
      assert.deepEqual(rows[1]!.config, { repoConfigVersion: 7, models: SONNET, source: 'repo' })
      assert.deepEqual(rows[2]!.config, {
        repoConfigVersion: 8,
        models: { provider: 'service', model: 'anthropic/claude-haiku-5.5', fallback: 'z-ai/glm-5.3' },
        source: 'kento',
      })
    })

    it('"Ready for review": a push of the pull request creates nothing, its passage to ready creates a job', async () => {
      await setRepoConfig({ trigger: 'ready' })
      let draft = await push({ action: 'synchronize', draft: true, head: headSha(1) })
      assert.equal(draft.outcome, 'ignored', 'a draft never gets a job')
      let ready = await push({ action: 'ready_for_review', head: headSha(1) })
      assert.equal(ready.outcome, 'queued')
      let later = await push({ action: 'synchronize', head: headSha(2) })
      assert.deepEqual(later, { outcome: 'skipped', reason: 'trigger of the config is ready' })
      let rows = await sql<{ head_sha: string; state: string }[]>`select head_sha, state from jobs`
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [{ head_sha: headSha(1), state: 'queued' }],
        'the job of the ready head stays',
      )
    })

    it('"On request": no push creates a job, and a command still does, with the models of the config', async () => {
      await setRepoConfig({ trigger: 'command', models: { heavy: OPUS } }, 3)
      for (let action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
        assert.equal((await push({ action, head: headSha(1) })).outcome, 'skipped', action)
      }
      let command = await enqueueCommandJob(database.db, {
        installation: { githubInstallationId: 1001, githubAccountId: 2001, login: 'sakuga-software' },
        repository: { githubRepoId: REPO.id, fullName: REPO.full_name },
        prNumber: 24,
        headSha: headSha(1),
        baseRef: 'main',
        kind: 'review',
        level: 'heavy',
        force: false,
        commentId: 555,
        deliveryId: 'command-1',
      })
      assert.equal(command.outcome, 'queued')
      let [row] = await sql<{ level: string; config: any }[]>`select level, config from jobs`
      assert.equal(row!.level, 'heavy')
      assert.deepEqual(row!.config, { repoConfigVersion: 3, models: OPUS, source: 'repo' })
    })

    it('the monthly limit stops the automatic reviews once the month has cost it', async () => {
      await setRepoConfig({ monthlyCapUsd: 1 })
      let first = await push({ head: headSha(1) })
      assert.equal(first.outcome, 'queued')
      await sql`update jobs set state = 'done'`
      await sql`insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
        values (${first.jobId!}, ${repoId}, 24, ${headSha(1)}, 4, 'm', 1.0, '{}')`
      assert.deepEqual(await push({ head: headSha(2) }), { outcome: 'skipped', reason: 'monthly cost limit of the repository is reached' })
      // An org without a limit, and a repository that says "none", are not limited.
      await setRepoConfig({ monthlyCapUsd: null })
      await sql`update orgs set config = ${JSON.stringify({ monthlyCapUsd: 0.5 })}::jsonb where id = ${orgId}`
      assert.equal((await push({ head: headSha(3) })).outcome, 'queued')
    })

    it('the paths: a pull request outside them gets no job; GitHub that fails, or a file under them, gets one', async () => {
      // No paths: GitHub is not asked.
      assert.equal((await push({ number: 1, head: headSha(1) })).outcome, 'queued')
      assert.equal(listed, 0)

      await setRepoConfig({ paths: ['apps/web', '**/*.sql'] })
      changedFiles = ['README.md', 'packages/engine/src/levels.ts']
      assert.deepEqual(await push({ number: 2, head: headSha(2) }), { outcome: 'skipped', reason: 'no changed file under the paths of the config' })
      changedFiles = ['README.md', 'drizzle/0008_repo_config.sql']
      assert.equal((await push({ number: 3, head: headSha(3) })).outcome, 'queued')
      changedFiles = new Error('GitHub answered 502')
      assert.equal((await push({ number: 4, head: headSha(4) })).outcome, 'queued', 'a review too many rather than a review missed')
      changedFiles = null
      assert.equal((await push({ number: 5, head: headSha(5) })).outcome, 'queued')
      assert.equal(listed, 4)
    })
  })

  describe('the claim of a runner', () => {
    async function claim(body: unknown) {
      let token = 'kento_rt_ConfigTestRunnerToken_0123456789abcdef'
      await sql`insert into runners (name, token_hash, trusted) values ('r', ${hashToken(token)}, true) on conflict (token_hash) do nothing`
      let app = createAppRouter({
        checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 1 }),
        version: 'test',
        commit: null,
        webhook: disabledWebhook,
        runner: {
          store: createRunnerStore(sql),
          registrationToken: null,
          mintInstallationToken: async () => ({ token: 'ghs_installation_token', expiresAt: '2027-01-15T09:00:00Z' }),
          providerApiKey: 'sk-or-service-key',
          claimWaitMs: 0,
          claimPollMs: 50,
        },
      })
      let response = await app.fetch(
        new Request('http://localhost/api/runner/jobs/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
      )
      return response.status === 200 ? ((await response.json()) as Job) : null
    }

    it('sends the models of the job to a runner that reads them, and none to one of an earlier release', async () => {
      await setRepoConfig({ models: { lite: SONNET } }, 2)
      await push({ head: headSha(1) })
      let job = await claim({ hasProviderKey: true, kinds: ['review'], features: ['providers', 'models'], ownProvider: 'openrouter' })
      assert.deepEqual(job!.models, SONNET)

      await push({ number: 25, head: headSha(2) })
      let old = await claim({ hasProviderKey: true })
      assert.ok(old)
      assert.equal('models' in old!, false, 'a runner of an earlier release refuses a key that it does not know')
    })

    it('sends no models whose provider the job does not carry: the job runs the models of the engine', async () => {
      let orgProvider = { provider: '0b9c4a52-3f1e-4c55-9a43-2f1a3f0f6b11', model: 'claude-sonnet-5-5', fallback: null }
      await setRepoConfig({ models: { lite: orgProvider } }, 2)
      await push({ head: headSha(1) })
      let withProviders = await claim({ hasProviderKey: true, features: ['providers', 'models'], ownProvider: 'openrouter' })
      assert.ok(withProviders)
      assert.equal('models' in withProviders!, false)
      assert.deepEqual(withProviders!.providers?.map((p) => p.id), ['service'])

      await push({ number: 25, head: headSha(2) })
      let withoutProviders = await claim({ hasProviderKey: true, features: ['models'], ownProvider: 'openrouter' })
      assert.equal('models' in withoutProviders!, false)
    })

    it('sends no models for a job queued before the config existed', async () => {
      await sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', 9, ${headSha(9)}, 'main')`
      let job = await claim({ hasProviderKey: true, features: ['providers', 'models'], ownProvider: 'openrouter' })
      assert.equal('models' in job!, false)
    })
  })
})
