import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { headSha, pullRequestPayload, REPO, signedRequest, TEST_SECRET, type SignedRequestOptions } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

// The test of the ticket, from the signed request to the row in `jobs`, against Postgres.

interface JobRow {
  pr_number: number
  head_sha: string
  base_ref: string | null
  state: string
  level: string
  kind: string
  github_delivery_id: string
}

describe('POST /webhooks/github against Postgres', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let router: ReturnType<typeof createAppRouter>
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
      webhook: {
        secret: TEST_SECRET,
        trustedBotsFor: async () => new Set(['sakuga-agent[bot]']),
        apply: createWebhookStore(database.db),
      },
    })
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  beforeEach(async () => {
    await sql`truncate orgs, repos, jobs, reviews cascade`
    await seedEnabledRepo(sql)
  })

  function nextDelivery(): string {
    delivery++
    return `00000000-0000-0000-0000-${delivery.toString().padStart(12, '0')}`
  }

  async function post(payload: unknown, options: SignedRequestOptions = {}) {
    let response = await router.fetch(signedRequest(payload, { deliveryId: nextDelivery(), ...options }))
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  function jobRows() {
    return sql<JobRow[]>`
      select pr_number, head_sha, base_ref, state, level, kind, github_delivery_id from jobs order by created_at, id`
  }

  it('1. a push creates one queued review job with the head of the push', async () => {
    let { status, body } = await post(pullRequestPayload({ action: 'synchronize', head: headSha(1) }))
    assert.equal(status, 202)
    assert.equal(body.outcome, 'queued')

    let rows = await jobRows()
    assert.equal(rows.length, 1)
    assert.deepEqual(
      { ...rows[0]!, github_delivery_id: undefined },
      { pr_number: 24, head_sha: headSha(1), base_ref: 'main', state: 'queued', level: 'lite', kind: 'review', github_delivery_id: undefined },
    )
    let [repo] = await sql`select full_name, enabled from repos`
    assert.equal(repo!.full_name, 'sakuga-software/sakuga-review')
    assert.equal(repo!.enabled, true)
    let [org] = await sql`select github_installation_id, login from orgs`
    assert.equal(Number(org!.github_installation_id), 1001)
  })

  it('2. a second push cancels the job of the first head', async () => {
    await post(pullRequestPayload({ head: headSha(1) }))
    let { body } = await post(pullRequestPayload({ head: headSha(2) }))
    assert.equal(body.cancelled, 1)

    let rows = await jobRows()
    assert.deepEqual(
      rows.map((row) => [row.head_sha, row.state]),
      [
        [headSha(1), 'cancelled'],
        [headSha(2), 'queued'],
      ],
    )
    let [cancelled] = await sql`select finished_at, failure_reason from jobs where head_sha = ${headSha(1)}`
    assert.notEqual(cancelled!.finished_at, null)
    assert.equal(cancelled!.failure_reason, 'superseded by a newer push')
  })

  it('a push cancels a running job of the pull request, and leaves other pull requests alone', async () => {
    await post(pullRequestPayload({ number: 24, head: headSha(1) }))
    await post(pullRequestPayload({ number: 25, head: headSha(5) }))
    await sql`update jobs set state = 'running' where head_sha = ${headSha(1)}`
    await post(pullRequestPayload({ number: 24, head: headSha(2) }))

    let rows = await jobRows()
    assert.deepEqual(
      rows.map((row) => [row.pr_number, row.state]),
      [
        [24, 'cancelled'],
        [25, 'queued'],
        [24, 'queued'],
      ],
    )
  })

  it('3. a wrong signature returns 401 and creates nothing', async () => {
    let { status } = await post(pullRequestPayload(), { secret: `${TEST_SECRET}-wrong` })
    assert.equal(status, 401)
    let [counts] = await sql`select (select count(*)::int from jobs) as jobs, (select count(*)::int from orgs) as orgs, (select count(*)::int from repos) as repos`
    // The org and the repository of the seed only.
    assert.deepEqual({ ...counts }, { jobs: 0, orgs: 1, repos: 1 })
  })

  it('4. a redelivery creates no second job and cancels nothing', async () => {
    let payload = pullRequestPayload({ head: headSha(1) })
    let deliveryId = nextDelivery()
    let first = await post(payload, { deliveryId })
    let second = await post(payload, { deliveryId })
    assert.equal(first.body.outcome, 'queued')
    assert.deepEqual(second.body, { outcome: 'duplicate', reason: 'delivery already created a job' })
    let rows = await jobRows()
    assert.deepEqual(rows.map((row) => row.state), ['queued'])
  })

  it('a redelivery of an older push does not cancel the newer job', async () => {
    let olderDelivery = nextDelivery()
    await post(pullRequestPayload({ head: headSha(1) }), { deliveryId: olderDelivery })
    await post(pullRequestPayload({ head: headSha(2) }))
    let replay = await post(pullRequestPayload({ head: headSha(1) }), { deliveryId: olderDelivery })
    assert.equal(replay.body.outcome, 'duplicate')
    let rows = await jobRows()
    assert.deepEqual(rows.map((row) => [row.head_sha, row.state]), [
      [headSha(1), 'cancelled'],
      [headSha(2), 'queued'],
    ])
  })

  it('a captured request replayed with a new delivery id queues no second review of the head', async () => {
    let payload = pullRequestPayload({ head: headSha(1) })
    await post(payload)
    let replay = await post(payload)
    assert.deepEqual(replay.body, { outcome: 'duplicate', reason: 'head already had a review job' })
    for (let state of ['done', 'failed']) {
      await sql`update jobs set state = ${state}::job_state`
      assert.equal((await post(payload)).body.outcome, 'duplicate', state)
    }
    assert.equal((await jobRows()).length, 1)
  })

  it('a replay of an older push with a new delivery id neither re-queues it nor cancels the current head', async () => {
    let older = pullRequestPayload({ head: headSha(1) })
    await post(older)
    await post(pullRequestPayload({ head: headSha(2) }))
    let replay = await post(older)
    assert.deepEqual(replay.body, { outcome: 'duplicate', reason: 'head already had a review job' })
    assert.deepEqual((await jobRows()).map((row) => [row.head_sha, row.state]), [
      [headSha(1), 'cancelled'],
      [headSha(2), 'queued'],
    ])
  })

  it('two deliveries of the same pull request at once leave one queued job', async () => {
    await Promise.all([post(pullRequestPayload({ head: headSha(1) })), post(pullRequestPayload({ head: headSha(2) }))])
    let rows = await jobRows()
    assert.equal(rows.length, 2)
    assert.equal(rows.filter((row) => row.state === 'queued').length, 1)
  })

  it('the same delivery twice at once creates one job', async () => {
    let deliveryId = nextDelivery()
    let payload = pullRequestPayload({ head: headSha(1) })
    let results = await Promise.all([post(payload, { deliveryId }), post(payload, { deliveryId })])
    assert.deepEqual(results.map((result) => result.status), [202, 202])
    assert.equal((await jobRows()).length, 1)
  })

  it('a draft, a fork and an untrusted bot create no job', async () => {
    await post(pullRequestPayload({ draft: true }))
    await post(pullRequestPayload({ headRepoId: 9999 }))
    await post(pullRequestPayload({ sender: { login: 'dependabot[bot]', type: 'Bot' } }))
    assert.equal((await jobRows()).length, 0)
  })

  it('a new base of the pull request goes to its queued and failed jobs, not to a finished review', async () => {
    // A stacked pull request: GitHub moves it to main when its parent merges and the branch of the
    // parent is deleted. A job that still names the old branch fails its clone (fruitback #724).
    let parent = 'fru-popup/fru-525-popup-layout-parent'
    await post(pullRequestPayload({ head: headSha(1), baseRef: parent }))
    await sql`update jobs set state = 'done' where head_sha = ${headSha(1)}`
    await post(pullRequestPayload({ head: headSha(2), baseRef: parent }))
    await sql`update jobs set state = 'failed' where head_sha = ${headSha(2)}`
    await post(pullRequestPayload({ head: headSha(3), baseRef: parent }))
    assert.deepEqual((await jobRows()).map((row) => [row.head_sha, row.state, row.base_ref]), [
      [headSha(1), 'done', parent],
      [headSha(2), 'failed', parent],
      [headSha(3), 'queued', parent],
    ])

    let { status, body } = await post(pullRequestPayload({ action: 'edited', head: headSha(3), baseRef: 'main', changes: { base: { ref: { from: parent } } } }))
    assert.equal(status, 202)
    assert.deepEqual(body, { outcome: 'retargeted', jobs: 2 })
    assert.deepEqual((await jobRows()).map((row) => [row.head_sha, row.state, row.base_ref]), [
      [headSha(1), 'done', parent],
      [headSha(2), 'failed', 'main'],
      [headSha(3), 'queued', 'main'],
    ])

    // An edit of the title moves nothing.
    let title = await post(pullRequestPayload({ action: 'edited', head: headSha(3), baseRef: 'main', changes: { title: { from: 'old' } } }))
    assert.equal(title.body.outcome, 'ignored')
  })

  it('a closed pull request cancels its queued job, and a reopen on the same head queues it again', async () => {
    await post(pullRequestPayload({ head: headSha(1) }))
    let { body } = await post(pullRequestPayload({ action: 'closed', head: headSha(1) }))
    assert.deepEqual(body, { outcome: 'cancelled', cancelled: 1 })
    assert.deepEqual((await jobRows()).map((row) => row.state), ['cancelled'])

    let reopened = await post(pullRequestPayload({ action: 'reopened', head: headSha(1) }))
    assert.equal(reopened.body.outcome, 'queued')
    assert.deepEqual((await jobRows()).map((row) => [row.head_sha, row.state]), [
      [headSha(1), 'cancelled'],
      [headSha(1), 'queued'],
    ])
    // The queued job blocks a replay of the reopen with a new delivery id.
    let replay = await post(pullRequestPayload({ action: 'reopened', head: headSha(1) }))
    assert.equal(replay.body.outcome, 'duplicate')
  })

  it('a close waits for an enqueue of the same repository that has not committed yet', async () => {
    await post(pullRequestPayload({ head: headSha(1) }))
    let [repo] = await sql<{ id: string }[]>`select id from repos`

    // An enqueue in flight: it holds the lock of the repository row and has inserted its job, but
    // has not committed yet. It commits only when the close is blocked by it, or when the close
    // has already answered (no lock: the close did not see the job, and the test fails). No fixed
    // delay: the order is the same on a slow and on a fast machine.
    let close: Promise<unknown> | undefined
    let blocked = false
    await sql.begin(async (tx) => {
      await tx`select id from repos where id = ${repo!.id} for update`
      let [holder] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`
      await tx`update jobs set state = 'cancelled', failure_reason = 'superseded by a newer push'
               where repo_id = ${repo!.id} and pr_number = 24 and head_sha = ${headSha(1)}`
      await tx`insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id)
               values (${repo!.id}, 'lite', 24, ${headSha(2)}, 'in-flight')`
      let settled = false
      close = post(pullRequestPayload({ action: 'closed', head: headSha(2) })).finally(() => (settled = true))
      let deadline = Date.now() + 10_000
      while (!settled && Date.now() < deadline) {
        // Only a backend that this transaction blocks counts: the close, waiting on the row lock.
        let [waiting] = await sql<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where ${holder!.pid}::int = any(pg_blocking_pids(pid))`
        if (waiting!.count > 0) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    })
    let { body } = (await close) as { body: { cancelled: number } }

    assert.equal(blocked, true, 'the close did not wait for the lock of the repository row')
    assert.equal(body.cancelled, 1)
    assert.deepEqual((await jobRows()).map((row) => [row.head_sha, row.state]), [
      [headSha(1), 'cancelled'],
      [headSha(2), 'cancelled'],
    ])
  })

  it('a captured push replayed after the close queues nothing; the reopen does', async () => {
    let push = pullRequestPayload({ head: headSha(1) })
    await post(push)
    await post(pullRequestPayload({ action: 'closed', head: headSha(1) }))
    let replay = await post(push)
    assert.deepEqual(replay.body, { outcome: 'skipped', reason: 'pull request is closed' })
    assert.deepEqual((await jobRows()).map((row) => row.state), ['cancelled'])

    assert.equal((await post(pullRequestPayload({ action: 'reopened', head: headSha(1) }))).body.outcome, 'queued')
    assert.equal((await post(pullRequestPayload({ head: headSha(2) }))).body.outcome, 'queued')
  })

  it('a reopen after a close of a reviewed head queues nothing: the review is done', async () => {
    await post(pullRequestPayload({ head: headSha(1) }))
    await sql`update jobs set state = 'done'`
    await post(pullRequestPayload({ action: 'closed', head: headSha(1) }))
    let reopened = await post(pullRequestPayload({ action: 'reopened', head: headSha(1) }))
    assert.equal(reopened.body.outcome, 'duplicate')
  })

  it('an event never changes enabled: a new repository comes in disabled, and a disabled one gets no job', async () => {
    let account = { id: 2001, login: 'sakuga-software', type: 'Organization' }
    let repositories = [
      { id: 3001, name: 'sakuga-review', full_name: 'sakuga-software/sakuga-review' },
      { id: 3002, name: 'fruitback', full_name: 'sakuga-software/fruitback' },
    ]
    await post({ action: 'created', installation: { id: 1001, account }, repositories }, { event: 'installation' })
    let rows = await sql<{ full_name: string; enabled: boolean }[]>`select full_name, enabled from repos order by full_name`
    assert.deepEqual(rows.map((row) => [row.full_name, row.enabled]), [
      ['sakuga-software/fruitback', false],
      // Enabled on the Repos screen (the seed): the installation event keeps it.
      ['sakuga-software/sakuga-review', true],
    ])

    let fruitback = { ...REPO, id: 3002, full_name: 'sakuga-software/fruitback' }
    let { body } = await post(pullRequestPayload({ repo: fruitback, head: headSha(1) }))
    assert.deepEqual(body, { outcome: 'skipped', reason: 'repository is not enabled' })

    // Disabled on the screen: the next push of sakuga-review creates nothing either.
    await sql`update repos set enabled = false where github_repo_id = 3001`
    assert.equal((await post(pullRequestPayload({ head: headSha(2) }))).body.outcome, 'skipped')
    assert.equal((await jobRows()).length, 0)
    assert.deepEqual((await sql`select enabled from repos where github_repo_id = 3001`)[0], { enabled: false })
  })

  it('the job takes the default level of the repository', async () => {
    await post(pullRequestPayload({ head: headSha(1) }))
    await sql`update repos set default_level = 'balanced'`
    await post(pullRequestPayload({ head: headSha(2) }))
    assert.deepEqual((await jobRows()).map((row) => row.level), ['lite', 'balanced'])
  })

  describe('installation events', () => {
    let account = { id: 2001, login: 'sakuga-software', type: 'Organization' }
    let installation = { id: 1001, account }
    let review = { id: 3001, name: 'sakuga-review', full_name: 'sakuga-software/sakuga-review' }
    let fruitback = { id: 3002, name: 'fruitback', full_name: 'sakuga-software/fruitback' }

    async function repoNames() {
      let rows = await sql<{ full_name: string }[]>`select full_name from repos order by full_name`
      return rows.map((row) => row.full_name)
    }

    it('created records the org and its repositories, and a second delivery changes nothing', async () => {
      let payload = { action: 'created', installation, repositories: [review, fruitback] }
      let deliveryId = nextDelivery()
      await post(payload, { event: 'installation', deliveryId })
      await post(payload, { event: 'installation', deliveryId })
      assert.deepEqual(await repoNames(), ['sakuga-software/fruitback', 'sakuga-software/sakuga-review'])
      let orgs = await sql`select login, suspended_at from orgs`
      assert.equal(orgs.length, 1)
      assert.equal(orgs[0]!.suspended_at, null)
    })

    it('installation_repositories adds, renames and removes repositories', async () => {
      await post({ action: 'created', installation, repositories: [review] }, { event: 'installation' })
      await post(
        { action: 'added', installation, repositories_added: [fruitback] },
        { event: 'installation_repositories' },
      )
      assert.deepEqual(await repoNames(), ['sakuga-software/fruitback', 'sakuga-software/sakuga-review'])

      await post(
        { action: 'added', installation, repositories_added: [{ ...fruitback, full_name: 'sakuga-software/fruitback-2' }] },
        { event: 'installation_repositories' },
      )
      assert.deepEqual(await repoNames(), ['sakuga-software/fruitback-2', 'sakuga-software/sakuga-review'])

      await post(
        { action: 'removed', installation, repositories_removed: [fruitback] },
        { event: 'installation_repositories' },
      )
      assert.deepEqual(await repoNames(), ['sakuga-software/sakuga-review'])
    })

    it('a suspended installation gets no job, and its queued jobs are cancelled', async () => {
      await post(pullRequestPayload({ head: headSha(1) }))
      let suspend = await post({ action: 'suspend', installation }, { event: 'installation' })
      assert.equal(suspend.body.cancelled, 1)

      let push = await post(pullRequestPayload({ head: headSha(2) }))
      assert.deepEqual(push.body, { outcome: 'skipped', reason: 'installation is suspended' })

      await post({ action: 'unsuspend', installation, repositories: [] }, { event: 'installation' })
      // The head whose job the suspension cancelled can be reviewed again.
      assert.equal((await post(pullRequestPayload({ action: 'reopened', head: headSha(1) }))).body.outcome, 'queued')
      assert.equal((await post(pullRequestPayload({ head: headSha(3) }))).body.outcome, 'queued')
    })

    it('a deleted installation keeps its rows and cancels its jobs', async () => {
      await post(pullRequestPayload({ head: headSha(1) }))
      await post({ action: 'deleted', installation }, { event: 'installation' })
      assert.deepEqual(await repoNames(), ['sakuga-software/sakuga-review'])
      assert.deepEqual((await jobRows()).map((row) => row.state), ['cancelled'])
      let [org] = await sql`select suspended_at from orgs`
      assert.notEqual(org!.suspended_at, null)
    })
  })
})
