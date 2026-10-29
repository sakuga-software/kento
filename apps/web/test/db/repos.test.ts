// The Repos screen against Postgres (REV-9): the switch counter, enable and disable, and the check
// of GitHub. The three steps of the ticket, from the signed webhook to the counter.
import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { headSha, pullRequestPayload, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { createReposStore, type ReposStore } from '../../app/repos/store.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase } from './helpers.ts'

const ORCHARD = { id: 5001, name: 'orchard', full_name: 'sakuga-software/orchard', owner: { id: 2001, login: 'sakuga-software' } }

describe('the Repos screen against Postgres', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let store: ReposStore
  let router: ReturnType<typeof createAppRouter>
  let orgId: string
  let delivery = 0

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    sql = database.sql
    store = createReposStore(sql)
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
    let [org] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (1001, 2001, 'sakuga-software') returning id`
    orgId = org!.id
    // orchard as an installation event leaves it: known, and disabled.
    await sql`insert into repos (org_id, github_repo_id, full_name) values (${orgId}, ${ORCHARD.id}, ${ORCHARD.full_name})`
  })

  async function push(n: number, number = 7) {
    delivery++
    let response = await router.fetch(
      signedRequest(pullRequestPayload({ repo: ORCHARD, head: headSha(n), number }), {
        deliveryId: `00000000-0000-0000-0000-${delivery.toString().padStart(12, '0')}`,
      }),
    )
    return (await response.json()) as { outcome: string; jobId?: string }
  }

  async function orchard() {
    return (await store.list(orgId)).find((repo) => repo.fullName === ORCHARD.full_name)!
  }

  /** A review of a job that Kentō published on GitHub. */
  async function publish(jobId: string, minutesAgo: number, githubReviewId: number | null = 900 + minutesAgo) {
    await sql`update jobs set state = 'done', finished_at = now() - ${`${minutesAgo} minutes`}::interval where id = ${jobId}`
    await sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, github_review_id, published_at)
      select id, repo_id, pr_number, head_sha, 4, 'anthropic/claude-haiku-5.5', '{}'::jsonb, ${githubReviewId}, now() - ${`${minutesAgo} minutes`}::interval
      from jobs where id = ${jobId}`
  }

  it('1. enabled on the screen, orchard gets a job on the next push; disabled, the next push creates nothing and the review stays', async () => {
    assert.deepEqual(await push(1), { outcome: 'skipped', reason: 'repository is not enabled' })

    let repo = await orchard()
    assert.equal(repo.enabled, false)
    assert.deepEqual(await store.setEnabled(orgId, repo.id, true), { fullName: ORCHARD.full_name, cancelled: 0 })
    let queued = await push(2)
    assert.equal(queued.outcome, 'queued')
    await publish(queued.jobId!, 5)
    let queuedAgain = await push(3)
    assert.equal(queuedAgain.outcome, 'queued')

    // Disable: the job still in the queue is cancelled; the published review stays.
    assert.deepEqual(await store.setEnabled(orgId, repo.id, false), { fullName: ORCHARD.full_name, cancelled: 1 })
    let [cancelled] = await sql<{ state: string; failure_reason: string }[]>`select state, failure_reason from jobs where id = ${queuedAgain.jobId!}`
    assert.deepEqual(cancelled, { state: 'cancelled', failure_reason: 'repository disabled' })
    assert.equal((await push(4)).outcome, 'skipped')
    assert.equal((await sql`select count(*)::int as n from jobs`)[0]!.n, 2)
    let after = await orchard()
    assert.equal(after.lastReview?.prNumber, 7)
    assert.equal(after.lastReview?.model, 'anthropic/claude-haiku-5.5')
    assert.equal(after.streak, 1)
  })

  it('2. a running job is not cancelled by a disable: its review can still come', async () => {
    let repo = await orchard()
    await store.setEnabled(orgId, repo.id, true)
    let { jobId } = await push(1)
    await sql`update jobs set state = 'running' where id = ${jobId!}`
    assert.equal((await store.setEnabled(orgId, repo.id, false))!.cancelled, 0)
    assert.equal((await sql`select state from jobs where id = ${jobId!}`)[0]!.state, 'running')
  })

  it('3. a failed job on a repository at 3/20 brings the counter back to 0/20; the next reviews count again', async () => {
    let repo = await orchard()
    await store.setEnabled(orgId, repo.id, true)
    for (let n = 1; n <= 3; n++) await publish((await push(n, n)).jobId!, 60 - n)
    assert.deepEqual([(await orchard()).streak, (await orchard()).resetBy], [3, null])

    let failed = await push(10, 10)
    await sql`update jobs set state = 'failed', failure_reason = 'lease expired 2 times', finished_at = now() - interval '30 minutes' where id = ${failed.jobId!}`
    assert.deepEqual([(await orchard()).streak, (await orchard()).resetBy], [0, 'failure'])

    await publish((await push(11, 11)).jobId!, 10)
    assert.deepEqual([(await orchard()).streak, (await orchard()).resetBy], [1, 'failure'])
  })

  it('a review that was skipped, not published, does not count', async () => {
    let repo = await orchard()
    await store.setEnabled(orgId, repo.id, true)
    await publish((await push(1)).jobId!, 5, null)
    assert.equal((await orchard()).streak, 0)
    assert.equal((await orchard()).lastReview, null)
  })

  it('a second review of the same head and level for a push is a double publication; a `force` command is not', async () => {
    let repo = await orchard()
    await store.setEnabled(orgId, repo.id, true)
    let first = await push(1)
    await publish(first.jobId!, 20)
    // A second job of the same head, as a bug would make it: same level, no comment.
    let [twin] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref, github_delivery_id)
      select repo_id, level, pr_number, head_sha, base_ref, 'twin' from jobs where id = ${first.jobId!} returning id`
    await publish(twin!.id, 10)
    assert.deepEqual([(await orchard()).streak, (await orchard()).resetBy], [0, 'double'])

    await sql`delete from jobs where id = ${twin!.id}`
    let [forced] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref, github_comment_id)
      select repo_id, level, pr_number, head_sha, base_ref, 777 from jobs where id = ${first.jobId!} returning id`
    await publish(forced!.id, 10)
    assert.deepEqual([(await orchard()).streak, (await orchard()).resetBy], [2, null])
  })

  it('changes a repository of its own org only', async () => {
    let [other] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (1002, 2002, 'orchard') returning id`
    let repo = await orchard()
    assert.equal(await store.setEnabled(other!.id, repo.id, true), null)
    assert.equal(await store.setEnabled(orgId, 'not-a-uuid', true), null)
    assert.equal((await orchard()).enabled, false)
    assert.deepEqual(await store.list(other!.id), [])
  })

  it('a check writes the mode and the visibility, adds a new repository disabled, and keeps enabled and the level', async () => {
    let repo = await orchard()
    await store.setEnabled(orgId, repo.id, true)
    await sql`update repos set default_level = 'balanced' where id = ${repo.id}`
    await store.saveCheck(orgId, [
      {
        githubRepoId: ORCHARD.id, fullName: ORCHARD.full_name, private: true, defaultBranch: 'main',
        workflow: { mode: 'reusable', path: '.github/workflows/sakuga-review.yml', ref: 'stable' },
      },
      { githubRepoId: 5002, fullName: 'sakuga-software/boo', private: false, defaultBranch: 'trunk', workflow: { mode: 'copy', path: '.github/workflows/r.yml', ref: null } },
    ])
    let rows = await store.list(orgId)
    assert.deepEqual(
      rows.map((r) => [r.fullName, r.enabled, r.defaultLevel, r.private, r.workflow, r.workflowRef, r.defaultBranch, r.workflowCheckedAt instanceof Date]),
      [
        ['sakuga-software/boo', false, 'lite', false, 'copy', null, 'trunk', true],
        ['sakuga-software/orchard', true, 'balanced', true, 'reusable', 'stable', 'main', true],
      ],
    )
  })
})
