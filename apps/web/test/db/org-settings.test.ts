// REV-13 against Postgres: the cost limit of an org at the enqueue of a push and of a command, the
// trusted bots of the org, the deliveries of the webhook, the store of the settings screen, and the
// level that a repository inherits from its org. GitHub is the fake of test/fake-github.ts.
import { generateKeyPairSync } from 'node:crypto'

import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createCommandHandler } from '../../app/commands/handler.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { createInstallationTokenMinter, readPrivateKey } from '../../app/github/installation-token.ts'
import { headSha, issueCommentPayload, pullRequestPayload, REPO, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { CAP_CHECK_NAME, createCapNotice } from '../../app/org-settings/notice.ts'
import { createOrgSettingsStore } from '../../app/org-settings/store.ts'
import { createAppRouter } from '../../app/router.ts'
import { createFakeGitHub, type FakeGitHub } from '../fake-github.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

let pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const HEAD = headSha(0xabc)

describe('the settings of an org against Postgres (REV-13)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let fake: FakeGitHub
  let orgId: string
  let repoId: string
  let userId: string
  let delivery = 0
  let comment = 9000

  function router() {
    let mint = createInstallationTokenMinter({ appId: '12345', privateKey: readPrivateKey(pem), apiUrl: fake.apiUrl, fetch: fake.fetch })
    let settings = createOrgSettingsStore(sql)
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 11 }),
      version: 'test',
      commit: null,
      webhook: {
        secret: TEST_SECRET,
        trustedBotsFor: (id) => settings.trustedBotsFor(id),
        recordDelivery: (record) => settings.recordDelivery(record),
        apply: createWebhookStore(database.db, {
          onCapReached: createCapNotice({ mintInstallationToken: mint, apiUrl: fake.apiUrl, settingsUrl: 'https://review.sakuga.dev/settings#plafond', fetch: fake.fetch }),
          handleCommentCommand: createCommandHandler({ db: database.db, mintInstallationToken: mint, apiUrl: fake.apiUrl, fetch: fake.fetch }),
        }),
      },
    })
  }

  function nextDelivery() {
    delivery++
    return `00000000-0000-0000-0000-${delivery.toString().padStart(12, '0')}`
  }

  async function push(options: Parameters<typeof pullRequestPayload>[0] = {}) {
    let response = await router().fetch(signedRequest(pullRequestPayload({ head: headSha(++delivery + 0x1000), ...options }), { deliveryId: nextDelivery() }))
    return { status: response.status, body: (await response.json()) as { outcome: string; reason?: string; period?: string; jobId?: string } }
  }

  async function say(body: string) {
    let payload = issueCommentPayload({ body, commentId: ++comment })
    let response = await router().fetch(signedRequest(payload, { event: 'issue_comment', deliveryId: nextDelivery() }))
    return { status: response.status, body: (await response.json()) as { outcome: string; reason?: string }, commentId: payload.comment.id }
  }

  /** A review of the repository that cost `usd`, `daysAgo` days ago, through a provider or the key of the service. */
  async function spend(usd: number, options: { daysAgo?: number; providerId?: string | null; resolve?: boolean } = {}) {
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, pr_number, head_sha, base_ref, state, provider_id)
      values (${repoId}, ${options.resolve ? 'resolve' : 'review'}, 'lite', 1, ${headSha(Math.floor(Math.random() * 1e9))}, 'main', 'done', ${options.providerId ?? null})
      returning id`
    let at = sql`now() - make_interval(days => ${options.daysAgo ?? 0})`
    if (options.resolve) {
      await sql`insert into resolutions (job_id, repo_id, pr_number, head_sha, model, cost_usd, result, created_at)
        values (${job!.id}, ${repoId}, 1, ${HEAD}, 'm', ${usd}, '{}', ${at})`
    } else {
      await sql`insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, created_at)
        values (${job!.id}, ${repoId}, 1, ${HEAD}, 4, 'm', ${usd}, '{}', ${at})`
    }
  }

  const queuedJobs = () => sql<{ level: string }[]>`select level from jobs where state = 'queued' order by created_at`

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 8 })
    sql = database.sql
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  beforeEach(async () => {
    await sql`truncate orgs, repos, runners, jobs, reviews, resolutions, users, webhook_deliveries cascade`
    ;({ orgId, repoId } = await seedEnabledRepo(sql))
    let [user] = await sql<{ id: string }[]>`insert into users (github_id, login) values (1, 'alex') returning id`
    userId = user!.id
    fake = createFakeGitHub({ head: HEAD, pr: 28, repoId: REPO.id })
    fake.state.permissions.set('alex', 'admin')
  })

  describe('the cost limit at the enqueue', () => {
    it('a limit of 0,01 $ stops the next push, with the check « Kentō · plafond »; 8 $ lets the jobs go again', async () => {
      await spend(0.02)
      await sql`update orgs set daily_cap_usd = 0.01 where id = ${orgId}`
      let stopped = await push()
      assert.equal(stopped.status, 202)
      assert.equal(stopped.body.outcome, 'capped')
      assert.equal(stopped.body.period, 'day')
      assert.equal((await queuedJobs()).length, 0)
      assert.equal(fake.state.checkRuns.length, 1)
      let check = fake.state.checkRuns[0]!
      assert.equal(check.name, CAP_CHECK_NAME)
      assert.equal(check.conclusion, 'neutral')
      assert.match(check.output.title, /Plafond du jour atteint/)
      assert.match(check.output.summary, /0,02\s\$ dépensés sur 0,01\s\$/)

      await sql`update orgs set daily_cap_usd = 8 where id = ${orgId}`
      let again = await push()
      assert.equal(again.body.outcome, 'queued')
      assert.equal((await queuedJobs()).length, 1)
      assert.equal(fake.state.checkRuns.length, 1, 'no check under the limit')
    })

    it('counts the resolutions, every repository of the org, and nothing of the day before', async () => {
      await sql`update orgs set daily_cap_usd = 1 where id = ${orgId}`
      await spend(5, { daysAgo: 1 })
      await spend(0.6)
      assert.equal((await push()).body.outcome, 'queued')
      await spend(0.4, { resolve: true })
      assert.equal((await push()).body.outcome, 'capped')
    })

    it('a monthly limit stops a push when the month reached it, whatever the day', async () => {
      await sql`update orgs set monthly_cap_usd = 10 where id = ${orgId}`
      // The first of the month: the cost of yesterday may belong to the month before.
      let firstOfMonth = new Date().getUTCDate() === 1
      await spend(10, { daysAgo: firstOfMonth ? 0 : 1 })
      let result = await push()
      assert.equal(result.body.outcome, 'capped')
      assert.equal(result.body.period, 'month')
    })

    it('an org has its own limit: the limit of another org never stops it', async () => {
      await spend(3)
      await sql`insert into orgs (github_installation_id, github_account_id, login, daily_cap_usd) values (1002, 2002, 'orchard', 0)`
      assert.equal((await push()).body.outcome, 'queued')
    })

    it('a command is refused at the limit, with a reply on the pull request', async () => {
      await sql`update orgs set daily_cap_usd = 0 where id = ${orgId}`
      let answer = await say('@kento review heavy')
      assert.equal(answer.status, 202)
      assert.equal(answer.body.outcome, 'capped')
      assert.equal((await queuedJobs()).length, 0)
      assert.ok(fake.state.reactions.has(`${answer.commentId}:confused`))
      let reply = fake.state.issueComments.at(-1)!
      assert.match(reply.body, /^@alex Kentō ne lance pas de review : le plafond de coût du jour de l’organisation est atteint/)
    })

    it('a check that GitHub refuses is logged, and the delivery still answers « capped »', async () => {
      fake.state.appPermissions.delete('checks')
      await sql`update orgs set daily_cap_usd = 0 where id = ${orgId}`
      let result = await push()
      assert.equal(result.status, 202)
      assert.equal(result.body.outcome, 'capped')
      assert.equal(fake.state.checkRuns.length, 0)
    })
  })

  describe('the trusted bots of the org', () => {
    it('a pull request of renovate[bot] is ignored, then reviewed once the org trusts it', async () => {
      let renovate = { login: 'renovate[bot]', type: 'Bot' }
      let ignored = await push({ sender: renovate, author: renovate })
      assert.equal(ignored.body.outcome, 'ignored')
      assert.equal(ignored.body.reason, 'pushed by an untrusted bot')

      let store = createOrgSettingsStore(sql)
      let saved = await store.save(orgId, userId, 0, (current) => ({ ...current, trustedBots: [...current.trustedBots, 'renovate[bot]'] }))
      assert.deepEqual(saved, { kind: 'saved', version: 1 })
      assert.equal((await push({ sender: renovate, author: renovate })).body.outcome, 'queued')
    })

    it('a new org trusts sakuga-agent[bot]; the bots of another org never count', async () => {
      let store = createOrgSettingsStore(sql)
      assert.deepEqual([...(await store.trustedBotsFor(1001))], ['sakuga-agent[bot]'])
      assert.deepEqual([...(await store.trustedBotsFor(424242))], ['sakuga-agent[bot]'], 'an installation that Kentō does not know yet')
      await sql`insert into orgs (github_installation_id, github_account_id, login, trusted_bots) values (1002, 2002, 'orchard', '{renovate[bot]}')`
      let renovate = { login: 'renovate[bot]', type: 'Bot' }
      assert.equal((await push({ sender: renovate, author: renovate })).body.outcome, 'ignored')
    })
  })

  describe('the deliveries of the webhook', () => {
    it('keeps each signed delivery with its answer, for its installation; a bad signature leaves nothing', async () => {
      await push()
      await push({ draft: true })
      let bad = await router().fetch(signedRequest(pullRequestPayload(), { deliveryId: nextDelivery(), signature: 'sha256=00' }))
      assert.equal(bad.status, 401)
      let rows = await sql<{ event: string; action: string; status: number; outcome: string; installation: string }[]>`
        select event, action, status, outcome, github_installation_id::text as installation from webhook_deliveries order by received_at, id`
      assert.deepEqual(
        rows.map((r) => [r.event, r.action, r.status, r.outcome, r.installation]),
        [
          ['pull_request', 'synchronize', 202, 'queued', '1001'],
          ['pull_request', 'synchronize', 202, 'ignored', '1001'],
        ],
      )
      let view = await createOrgSettingsStore(sql).read(orgId)
      assert.equal(view!.deliveries.last!.outcome, 'ignored')
      assert.equal(view!.deliveries.lastPullRequest!.event, 'pull_request')
      assert.equal(view!.deliveries.total24h, 2)
      assert.equal(view!.deliveries.failures24h, 0)
    })

    it('counts the failures of the last 24 hours, and deletes the rows older than 30 days', async () => {
      let store = createOrgSettingsStore(sql)
      await sql`insert into webhook_deliveries (delivery_id, github_installation_id, event, status, outcome, received_at)
        values ('old', 1001, 'pull_request', 500, 'failed', now() - interval '31 days'),
               ('yesterday', 1001, 'pull_request', 500, 'failed', now() - interval '25 hours'),
               ('other-org', 1002, 'pull_request', 500, 'failed', now())`
      await store.recordDelivery({ deliveryId: 'x', githubInstallationId: 1001, event: 'issue_comment', action: 'created', status: 500, outcome: 'failed', reason: 'database is down' })
      let view = await store.read(orgId)
      assert.equal(view!.deliveries.failures24h, 1)
      assert.equal(view!.deliveries.lastFailure!.reason, 'database is down')
      let [old] = await sql<{ n: number }[]>`select count(*)::int as n from webhook_deliveries where delivery_id = 'old'`
      assert.equal(old!.n, 0)
    })
  })

  describe('the store of the screen', () => {
    it('reads the defaults of a new org, and adds the cost of the day per provider', async () => {
      let [provider] = await sql<{ id: string }[]>`
        insert into providers (id, org_id, kind, label, runner_held) values (gen_random_uuid(), ${orgId}, 'ollama', 'GPU du bureau', true) returning id`
      await spend(1.25, { providerId: provider!.id })
      await spend(0.5)
      await spend(0.25, { resolve: true })
      await spend(40, { daysAgo: 40 })
      let view = await createOrgSettingsStore(sql).read(orgId)
      assert.deepEqual(view!.caps, { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 })
      assert.deepEqual(view!.trustedBots, ['sakuga-agent[bot]'])
      assert.equal(view!.version, 0)
      assert.equal(view!.costs.dayUsd, 2)
      assert.ok(view!.costs.monthUsd >= 2 && view!.costs.monthUsd < 40)
      assert.deepEqual(
        view!.costs.dayByProvider.map((p) => [p.label, p.usd]),
        [
          ['GPU du bureau', 1.25],
          ['Clé du service', 0.75],
        ],
      )
      assert.deepEqual(view!.repos, { total: 1, enabled: 1 })
    })

    it('writes the next version and its author; a form from an older version writes nothing', async () => {
      let store = createOrgSettingsStore(sql)
      let saved = await store.save(orgId, userId, 0, (current) => ({ ...current, caps: { dailyCapUsd: 8, monthlyCapUsd: 150.5, alertPct: 75 } }))
      assert.deepEqual(saved, { kind: 'saved', version: 1 })
      let stale = await store.save(orgId, userId, 0, (current) => ({ ...current, caps: { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 } }))
      assert.equal(stale.kind, 'conflict')
      let view = await store.read(orgId)
      assert.deepEqual(view!.caps, { dailyCapUsd: 8, monthlyCapUsd: 150.5, alertPct: 75 })
      assert.equal(view!.updatedBy, 'alex')
      assert.deepEqual(await store.save('00000000-0000-4000-8000-000000000000', userId, 0, (c) => c), { kind: 'not_found' })
    })

    it('the database refuses a negative limit and an alert outside 1..100', async () => {
      await assert.rejects(sql`update orgs set daily_cap_usd = -1 where id = ${orgId}`)
      await assert.rejects(sql`update orgs set cap_alert_pct = 0 where id = ${orgId}`)
    })
  })

  describe('the level that a repository inherits', () => {
    it('a push takes the level of the org, unless the repository chose its own', async () => {
      await sql`update orgs set config = '{"level":"balanced"}' where id = ${orgId}`
      await push()
      await sql`update repos set config = '{"level":"heavy"}', default_level = 'heavy' where id = ${repoId}`
      await push()
      // A level that only an earlier release wrote, in the column: still the choice of the repository.
      await sql`update repos set config = '{}', default_level = 'lite' where id = ${repoId}`
      await push()
      let levels = await sql<{ level: string; config: { models: unknown } }[]>`select level, config from jobs order by created_at`
      assert.deepEqual(
        levels.map((j) => j.level),
        ['balanced', 'heavy', 'balanced'],
      )
    })
  })
})
