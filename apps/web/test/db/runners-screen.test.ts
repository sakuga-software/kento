import { RUNNER_TOKEN_PREFIX } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import type { MintInstallationToken } from '../../app/github/installation-token.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import { createRunnersAdminStore, type RunnersAdminStore } from '../../app/runner/admin.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { hashToken, newRegistrationToken } from '../../app/runner/tokens.ts'
import { createTestDatabase } from './helpers.ts'

const SERVICE_TOKEN = 'registration-token-for-the-tests-0123456789'
const HEAD = 'b'.repeat(40)

// REV-10: the registration tokens of the Runners screen, the runners of an org, the pool of a
// repository, the trust and the revocation, against a real Postgres.
describe('the runners of the Runners screen', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let admin: RunnersAdminStore
  let org: string
  let otherOrg: string
  let repo: string
  let otherRepo: string

  let mint: MintInstallationToken = async () => ({ token: 'ghs_installation_token', expiresAt: '2027-01-15T09:00:00Z' })

  function router() {
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 7 }),
      version: 'test',
      commit: null,
      webhook: disabledWebhook,
      runner: {
        store: createRunnerStore(database.sql),
        registrationToken: SERVICE_TOKEN,
        mintInstallationToken: mint,
        providerApiKey: 'sk-or-service-key',
        claimWaitMs: 0,
        claimPollMs: 50,
      },
    })
  }

  function call(path: string, token: string | null, body: unknown) {
    let headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    return router().fetch(new Request(new URL(path, 'http://localhost'), { method: 'POST', headers, body: JSON.stringify(body) }))
  }

  /** Makes a token as the screen does, and returns it in clear, as the admin sees it once. */
  async function makeToken(input: { orgId?: string; name?: string; labels?: string[]; trusted?: boolean } = {}) {
    let token = newRegistrationToken()
    let created = await admin.createRegistration({
      orgId: input.orgId ?? org,
      userId: null,
      name: input.name ?? 'runner-1',
      labels: input.labels ?? ['macos'],
      trusted: input.trusted ?? false,
      tokenHash: hashToken(token),
    })
    return { token, id: created.id }
  }

  async function register(token: string, body: unknown = { name: 'what-the-runner-says', labels: ['anything'], version: '0.1.0' }) {
    return call('/api/runner/register', token, body)
  }

  async function registered(input: Parameters<typeof makeToken>[0] = {}) {
    let { token } = await makeToken(input)
    let response = await register(token)
    assert.equal(response.status, 201)
    return (await response.json()) as { runnerId: string; token: string }
  }

  async function queueJob(repoId = repo): Promise<string> {
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref)
      values (${repoId}, 'lite', 28, ${HEAD}, 'main') returning id`
    return job!.id
  }

  function claim(token: string, hasProviderKey = true) {
    return call('/api/runner/jobs/claim', token, { hasProviderKey })
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 8 })
    admin = createRunnersAdminStore(database.sql)
    let [a] = await database.sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 77, 2001, 'sakuga-software' from org returning org_id as id`
    let [b] = await database.sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('orchard', lower('orchard')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 78, 2002, 'orchard' from org returning org_id as id`
    org = a!.id
    otherOrg = b!.id
    let [r1] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled) values (${org}, (select id from installations where org_id = ${org} order by created_at limit 1), 3001, 'sakuga-software/sakuga-review', true) returning id`
    let [r2] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled) values (${otherOrg}, (select id from installations where org_id = ${otherOrg} order by created_at limit 1), 3002, 'orchard/app', true) returning id`
    repo = r1!.id
    otherRepo = r2!.id
  })

  beforeEach(async () => {
    await database.sql`delete from jobs`
    await database.sql`delete from runner_registrations`
    await database.sql`delete from runners`
    await database.sql`update repos set default_runner_pool = null`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  describe('a registration token', () => {
    it('is kept only as a hash, and gives the runner the org, name, labels and trust of the token', async () => {
      let { token, id } = await makeToken({ name: 'runner-1', labels: ['macos', 'arm64'], trusted: true })
      let [row] = await database.sql<{ token_hash: string }[]>`select token_hash from runner_registrations where id = ${id}`
      assert.equal(row!.token_hash, hashToken(token))
      let all = JSON.stringify(await database.sql`select * from runner_registrations`)
      assert.ok(!all.includes(token), 'the token is not in the table')

      let response = await register(token)
      assert.equal(response.status, 201)
      let body = (await response.json()) as { runnerId: string; token: string }
      assert.ok(body.token.startsWith(RUNNER_TOKEN_PREFIX))
      let [runner] = await database.sql<{ org_id: string; name: string; labels: string[]; trusted: boolean; version: string }[]>`
        select org_id, name, labels, trusted, version from runners where id = ${body.runnerId}`
      assert.deepEqual({ ...runner }, { org_id: org, name: 'runner-1', labels: ['macos', 'arm64'], trusted: true, version: '0.1.0' })
      let [used] = await database.sql<{ used_at: Date | null; runner_id: string }[]>`
        select used_at, runner_id from runner_registrations where id = ${id}`
      assert.ok(used!.used_at)
      assert.equal(used!.runner_id, body.runnerId)
    })

    it('works once, even for two registrations at the same time', async () => {
      let { token } = await makeToken()
      let answers = await Promise.all(Array.from({ length: 5 }, () => register(token)))
      assert.deepEqual(answers.map((r) => r.status).sort(), [201, 401, 401, 401, 401])
      let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from runners`
      assert.equal(count!.n, 1)
      assert.equal((await register(token)).status, 401)
    })

    it('ends after its hour, and a discarded one at once', async () => {
      let expired = await makeToken()
      await database.sql`update runner_registrations set expires_at = now() - interval '1 second' where id = ${expired.id}`
      assert.equal((await register(expired.token)).status, 401)

      let discarded = await makeToken()
      assert.equal(await admin.discardRegistration(org, discarded.id), true)
      assert.equal((await register(discarded.token)).status, 401)
      let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from runners`
      assert.equal(count!.n, 0)
    })

    it('is renewed or discarded by its own org only', async () => {
      let { id, token } = await makeToken({ name: 'gpu', labels: ['gpu'] })
      assert.equal(await admin.discardRegistration(otherOrg, id), false)
      assert.equal(await admin.renewRegistration({ orgId: otherOrg, registrationId: id, userId: null, tokenHash: 'x' }), null)

      let next = newRegistrationToken()
      let renewed = await admin.renewRegistration({ orgId: org, registrationId: id, userId: null, tokenHash: hashToken(next) })
      assert.equal(renewed?.name, 'gpu')
      assert.deepEqual(renewed?.labels, ['gpu'])
      assert.equal((await register(token)).status, 401, 'the old token is gone')
      assert.equal((await register(next)).status, 201)
    })

    it('leaves the token of the environment as it was: a runner of the service, with no org', async () => {
      let response = await register(SERVICE_TOKEN, { name: 'shared-01', labels: ['linux'], version: '0.1.0' })
      assert.equal(response.status, 201)
      let [runner] = await database.sql<{ org_id: string | null; trusted: boolean }[]>`select org_id, trusted from runners`
      assert.deepEqual({ ...runner }, { org_id: null, trusted: false })
      // A token of the screen is never compared with the one of the environment.
      assert.equal((await register(`kento_reg_${SERVICE_TOKEN}`)).status, 401)
    })
  })

  describe('a claim', () => {
    it('gives a runner of an org the jobs of that org only; a runner of the service, every job', async () => {
      let mine = await registered()
      let theirs = await queueJob(otherRepo)
      assert.equal((await claim(mine.token)).status, 204)
      let ours = await queueJob(repo)
      let job = await (await claim(mine.token)).json()
      assert.equal(job.id, ours)

      let service = await (await register(SERVICE_TOKEN, { name: 'shared-01', labels: [], version: '0.1.0' })).json()
      assert.equal((await (await claim(service.token)).json()).id, theirs)
    })

    it('gives the job of a repository with a pool only to a runner with that label', async () => {
      await database.sql`update repos set default_runner_pool = 'gpu' where id = ${repo}`
      let job = await queueJob(repo)
      let mac = await registered({ name: 'mac', labels: ['macos'] })
      assert.equal((await claim(mac.token)).status, 204)
      let gpu = await registered({ name: 'gpu', labels: ['linux', 'gpu'] })
      assert.equal((await (await claim(gpu.token)).json()).id, job)
    })

    it('never sends the key of the service to a runner of an org, even trusted (REV-130)', async () => {
      let runner = await registered({ trusted: true })
      let job = await queueJob()
      assert.equal((await claim(runner.token, false)).status, 204)

      // The trust of a runner of the org changes from its own org only.
      let trusted = async () => (await database.sql<{ trusted: boolean }[]>`select trusted from runners where id = ${runner.runnerId}`)[0]!.trusted
      assert.equal(await admin.setTrusted(otherOrg, runner.runnerId, false), false, 'another org changes nothing')
      assert.equal(await trusted(), true)
      assert.equal(await admin.setTrusted(org, runner.runnerId, false), true)
      assert.equal(await trusted(), false)

      // The job waits for a trusted runner of the service, which gets the key.
      let service = await (await register(SERVICE_TOKEN, { name: 'service-runner', labels: [], version: '0.1.0' })).json()
      await database.sql`update runners set trusted = true where id = ${service.runnerId}`
      let given = await (await claim(service.token, false)).json()
      assert.equal(given.id, job)
      assert.deepEqual(given.provider, { kind: 'openrouter', apiKey: 'sk-or-service-key' })
    })

    it('a runner of the service cannot be trusted or revoked from the screen', async () => {
      let service = await (await register(SERVICE_TOKEN, { name: 'shared-01', labels: [], version: '0.1.0' })).json()
      assert.equal(await admin.setTrusted(org, service.runnerId, true), false)
      assert.equal(await admin.revoke(org, service.runnerId), null)
    })
  })

  describe('a revocation', () => {
    it('refuses the token at once, and puts the running job back in the queue without spending an attempt', async () => {
      let mac = await registered({ name: 'runner-1' })
      let jobId = await queueJob()
      let job = await (await claim(mac.token)).json()
      assert.equal(job.attempt, 1)

      assert.equal(await admin.revoke(otherOrg, mac.runnerId), null, 'another org cannot revoke it')
      let revoked = await admin.revoke(org, mac.runnerId)
      assert.deepEqual(revoked, { name: 'runner-1', requeued: [jobId] })
      assert.equal(await admin.revoke(org, mac.runnerId), null, 'twice is nothing')

      // The revoked runner: 401 on claim, heartbeat and result.
      assert.equal((await claim(mac.token)).status, 401)
      assert.equal((await call(`/api/runner/jobs/${jobId}/heartbeat`, mac.token, { attempt: 1 })).status, 401)
      assert.equal((await call(`/api/runner/jobs/${jobId}/result`, mac.token, { attempt: 1, outcome: 'failed', reason: 'x' })).status, 401)

      // Another runner takes the job at once, as its first attempt.
      let em = await (await register(SERVICE_TOKEN, { name: 'shared-01', labels: [], version: '0.1.0' })).json()
      let again = await (await claim(em.token)).json()
      assert.equal(again.id, jobId)
      assert.equal(again.attempt, 1)
    })

    it('of the silent runners revokes those still silent for 24 h, of the org only, and requeues their jobs (REV-37)', async () => {
      let ci1 = await registered({ name: 'ci-1' })
      let ci2 = await registered({ name: 'ci-2' })
      let fresh = await registered({ name: 'fresh' })
      let elsewhere = await registered({ name: 'elsewhere', orgId: otherOrg })
      let jobId = await queueJob()
      let job = await (await claim(ci1.token)).json()
      assert.equal(job.id, jobId)
      let silentIds = [ci1.runnerId, ci2.runnerId, elsewhere.runnerId]
      await database.sql`update runners set last_seen_at = now() - interval '25 hours' where id = any(${silentIds}::uuid[])`
      // ci-2 called again after the screen was read: it stays in service.
      await database.sql`update runners set last_seen_at = now() where id = ${ci2.runnerId}`

      let revoked = await admin.revokeSilent(org, [ci1.runnerId, ci2.runnerId, fresh.runnerId, elsewhere.runnerId])
      assert.deepEqual(revoked, { names: ['ci-1'], requeued: [jobId] })
      let states = await database.sql<{ name: string; revoked: boolean }[]>`
        select name, revoked_at is not null as revoked from runners order by name`
      assert.deepEqual(states.map((r) => `${r.name}:${r.revoked}`), ['ci-1:true', 'ci-2:false', 'elsewhere:false', 'fresh:false'])
      let [requeued] = await database.sql<{ state: string; attempts: number }[]>`select state, attempts from jobs where id = ${jobId}`
      assert.deepEqual({ ...requeued }, { state: 'queued', attempts: 0 })
      assert.deepEqual(await admin.revokeSilent(org, []), { names: [], requeued: [] })
      assert.deepEqual(await admin.revokeSilent(org, [ci1.runnerId]), { names: [], requeued: [] }, 'twice is nothing')
    })

    it('during a claim gives the job back: the claim and the revocation never both win', async () => {
      // Twenty rounds of a claim and a revocation at the same time: the job ends queued for nobody,
      // or claimed by the runner and then given back by the revocation. Never running on a revoked runner.
      for (let round = 0; round < 20; round++) {
        await database.sql`delete from jobs`
        let runner = await registered({ name: `r${round}` })
        let jobId = await queueJob()
        await Promise.all([claim(runner.token), admin.revoke(org, runner.runnerId)])
        let [row] = await database.sql<{ state: string; attempts: number }[]>`select state, attempts from jobs where id = ${jobId}`
        assert.deepEqual({ ...row }, { state: 'queued', attempts: 0 }, `round ${round}`)
      }
    })
  })

  describe('the screen', () => {
    it('lists the runners of the org and of the service, with the current job of the org only', async () => {
      let mine = await registered({ name: 'runner-1' })
      await registered({ orgId: otherOrg, name: 'their-runner' })
      let service = await (await register(SERVICE_TOKEN, { name: 'shared-01', labels: [], version: '0.1.0' })).json()
      await queueJob(repo)
      await claim(mine.token)
      await queueJob(otherRepo)
      await claim(service.token)
      await makeToken({ name: 'pending' })

      let screen = await admin.screen(org)
      assert.deepEqual(screen.runners.map((r) => r.name).sort(), ['runner-1', 'shared-01'])
      let mac = screen.runners.find((r) => r.name === 'runner-1')!
      assert.deepEqual(mac.currentJob && { repo: mac.currentJob.repo, pr: mac.currentJob.prNumber }, { repo: 'sakuga-software/sakuga-review', pr: 28 })
      assert.ok(mac.lastSeenAt)
      let em = screen.runners.find((r) => r.name === 'shared-01')!
      assert.equal(em.orgId, null)
      assert.equal(em.currentJob, null, 'the job of another org does not show')
      assert.deepEqual(screen.registrations.map((r) => r.name), ['pending'])
      assert.deepEqual((await admin.screen(otherOrg)).registrations, [])
    })

    it('counts the jobs of the last 24 hours', async () => {
      let mac = await registered()
      let id = await queueJob()
      await claim(mac.token)
      await database.sql`update jobs set state = 'done', finished_at = now() where id = ${id}`
      let old = await queueJob()
      await database.sql`update jobs set state = 'done', runner_id = ${mac.runnerId}, finished_at = now() - interval '25 hours' where id = ${old}`
      let [runner] = (await admin.screen(org)).runners
      assert.equal(runner!.jobs24h, 1)
    })
  })
})
