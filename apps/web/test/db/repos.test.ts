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
import { createTestDatabase, installationOf } from './helpers.ts'

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
      with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 1001, 2001, 'sakuga-software' from org returning org_id as id`
    orgId = org!.id
    // orchard as an installation event leaves it: known, and disabled.
    await sql`insert into repos (org_id, installation_id, github_repo_id, full_name) values (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), ${ORCHARD.id}, ${ORCHARD.full_name})`
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
    return (await store.list(orgId)).rows.find((repo) => repo.fullName === ORCHARD.full_name)!
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
    assert.equal((await orchard()).streak, 3)

    let failed = await push(10, 10)
    await sql`update jobs set state = 'failed', failure_reason = 'lease expired 2 times', finished_at = now() - interval '30 minutes' where id = ${failed.jobId!}`
    assert.equal((await orchard()).streak, 0)

    await publish((await push(11, 11)).jobId!, 10)
    assert.equal((await orchard()).streak, 1)
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
    assert.equal((await orchard()).streak, 0)

    await sql`delete from jobs where id = ${twin!.id}`
    let [forced] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref, github_comment_id)
      select repo_id, level, pr_number, head_sha, base_ref, 777 from jobs where id = ${first.jobId!} returning id`
    await publish(forced!.id, 10)
    assert.equal((await orchard()).streak, 2)
  })

  it('a failed job after a double publication sets the counter back, and a double after it does too (REV-36)', async () => {
    let repo = await orchard()
    await store.setEnabled(orgId, repo.id, true)
    let first = await push(1)
    await publish(first.jobId!, 50)
    let twin = async (minutesAgo: number) => {
      let [job] = await sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, base_ref, github_delivery_id)
        select repo_id, level, pr_number, head_sha, base_ref, ${`twin-${minutesAgo}`} from jobs where id = ${first.jobId!} returning id`
      await publish(job!.id, minutesAgo)
    }
    await twin(40)
    let failed = await push(10, 10)
    await sql`update jobs set state = 'failed', finished_at = now() - interval '30 minutes' where id = ${failed.jobId!}`
    await publish((await push(11, 11)).jobId!, 20)
    // The review after the failure counts; the double publication before it no longer does.
    assert.equal((await orchard()).streak, 1)

    await twin(10)
    assert.equal((await orchard()).streak, 0)
  })

  it('counts the streak up to its target: a failure before the last 20 reviews no longer counts (REV-36)', async () => {
    let repo = await orchard()
    await store.setEnabled(orgId, repo.id, true)
    let failed = await push(100, 100)
    await sql`update jobs set state = 'failed', finished_at = now() - interval '200 minutes' where id = ${failed.jobId!}`
    for (let n = 1; n <= 19; n++) await publish((await push(n, n)).jobId!, 120 - n)
    assert.equal((await orchard()).streak, 19)
    await publish((await push(20, 20)).jobId!, 50)
    assert.equal((await orchard()).streak, 20)
    await publish((await push(21, 21)).jobId!, 40)
    assert.deepEqual([(await orchard()).streak, (await orchard()).lastReview?.prNumber], [20, 21])
  })

  it('pages the list by 25 with ?page=n, the enabled repositories first, and counts the whole org (REV-36, KNT-146)', async () => {
    await sql`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled, workflow)
      select ${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 6000 + g, 'sakuga-software/svc-' || lpad(g::text, 3, '0'), g % 4 = 0,
        (case when g % 5 = 0 then 'copy' else 'none' end)::workflow_mode
      from generate_series(1, 119) g`
    // 120 repositories: orchard and 119 more, of which 29 enabled.
    let first = await store.list(orgId)
    assert.equal(first.rows.length, 25)
    assert.deepEqual(first.counts, { all: 120, enabled: 29, disabled: 91, switching: 23 })
    assert.equal(first.matching, 120)
    assert.equal(first.offset, 0)
    assert.equal(first.page, 1)
    assert.equal(first.pages, 5)
    assert.deepEqual(first.rows.slice(0, 3).map((r) => r.fullName), ['sakuga-software/svc-004', 'sakuga-software/svc-008', 'sakuga-software/svc-012'])
    assert.ok(first.rows.every((r) => r.enabled), 'the enabled ones first')

    let seen = first.rows.map((r) => r.id)
    for (let number = 2; number <= 5; number++) {
      let page = await store.list(orgId, { page: number })
      assert.equal(page.page, number)
      assert.equal(page.offset, seen.length)
      seen.push(...page.rows.map((r) => r.id))
    }
    assert.equal(seen.length, 120)
    assert.equal(new Set(seen).size, 120, 'no row twice, none left out')
    let pageTwo = await store.list(orgId, { page: 2 })
    assert.deepEqual(pageTwo.rows.map((r) => r.id), seen.slice(25, 50))
    assert.deepEqual(pageTwo.rows.slice(0, 4).map((r) => r.enabled), [true, true, true, true])
    assert.deepEqual(pageTwo.rows.slice(4).map((r) => r.enabled), Array(21).fill(false))

    // A page after the last one gives the last one; a page under 1 gives the first one.
    let past = await store.list(orgId, { page: 99 })
    assert.equal(past.page, 5)
    assert.equal(past.offset, 100)
    assert.deepEqual(past.rows.map((r) => r.id), seen.slice(100))
    assert.equal((await store.list(orgId, { page: 0 })).page, 1)
    assert.equal((await store.list(orgId, { page: -2 })).page, 1)
    assert.equal((await store.list(orgId, { page: 2.5 })).page, 1)

    // The page counts the filter and the search, not the whole org.
    let enabled = await store.list(orgId, { filter: 'enabled', page: 2 })
    assert.equal(enabled.matching, 29)
    assert.equal(enabled.pages, 2)
    assert.equal(enabled.rows.length, 4)
    assert.equal(enabled.offset, 25)
    let none = await store.list(orgId, { search: 'nothing-here', page: 3 })
    assert.deepEqual([none.page, none.pages, none.offset, none.rows.length], [1, 1, 0, 0])

    // A limit of a caller under 1 row is 1 row: the count of pages stays finite (Kentō #7ad4c1).
    for (let limit of [0, -5, 0.5]) {
      let one = await store.list(orgId, { limit, page: 3 })
      assert.deepEqual([one.rows.length, one.pages, one.page, one.offset], [1, 120, 3, 2], String(limit))
    }
    assert.equal((await store.list(orgId, { limit: Number.NaN })).rows.length, 25)
  })

  it('filters by state and searches the name, any case, with % and _ as plain characters (REV-36)', async () => {
    await sql`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled, workflow) values
        (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 7001, 'sakuga-software/Boo', true, 'reusable'),
        (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 7002, 'sakuga-software/boo_cli', false, 'copy'),
        (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 7003, 'sakuga-software/boox', false, 'none'),
        (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 7004, 'sakuga-software/100%-done', false, 'none')`
    let names = async (query: Parameters<ReposStore['list']>[1]) => (await store.list(orgId, query)).rows.map((r) => r.fullName)
    assert.deepEqual(await names({ filter: 'enabled' }), ['sakuga-software/Boo'])
    assert.deepEqual(await names({ filter: 'disabled' }), ['sakuga-software/100%-done', 'sakuga-software/boo_cli', 'sakuga-software/boox', 'sakuga-software/orchard'])
    assert.deepEqual(await names({ filter: 'switching' }), ['sakuga-software/Boo', 'sakuga-software/boo_cli'])
    assert.deepEqual(await names({ search: 'BOO' }), ['sakuga-software/Boo', 'sakuga-software/boo_cli', 'sakuga-software/boox'])
    assert.deepEqual(await names({ search: 'boo_' }), ['sakuga-software/boo_cli'])
    assert.deepEqual(await names({ search: '0%' }), ['sakuga-software/100%-done'])
    assert.deepEqual(await names({ search: 'boo', filter: 'disabled' }), ['sakuga-software/boo_cli', 'sakuga-software/boox'])
    let page = await store.list(orgId, { search: 'boo', filter: 'disabled' })
    assert.equal(page.matching, 2)
    assert.deepEqual(page.counts, { all: 5, enabled: 1, disabled: 4, switching: 2 })
  })

  it('changes a repository of its own org only', async () => {
    let [other] = await sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('orchard', lower('orchard')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 1002, 2002, 'orchard' from org returning org_id as id`
    let repo = await orchard()
    assert.equal(await store.setEnabled(other!.id, repo.id, true), null)
    assert.equal(await store.setEnabled(orgId, 'not-a-uuid', true), null)
    assert.equal((await orchard()).enabled, false)
    assert.deepEqual((await store.list(other!.id)).rows, [])
  })

  it('a check writes the mode and the visibility, adds a new repository disabled, and keeps enabled and the level', async () => {
    let repo = await orchard()
    await store.setEnabled(orgId, repo.id, true)
    await sql`update repos set default_level = 'balanced' where id = ${repo.id}`
    await store.saveCheck(await installationOf(sql, orgId), [
      {
        githubRepoId: ORCHARD.id, fullName: ORCHARD.full_name, private: true, defaultBranch: 'main',
        workflow: { mode: 'reusable', path: '.github/workflows/sakuga-review.yml', ref: 'stable' },
      },
      { githubRepoId: 5002, fullName: 'sakuga-software/boo', private: false, defaultBranch: 'trunk', workflow: { mode: 'copy', path: '.github/workflows/r.yml', ref: null } },
    ])
    let { rows } = await store.list(orgId)
    assert.deepEqual(
      rows.map((r) => [r.fullName, r.enabled, r.defaultLevel, r.private, r.workflow, r.workflowRef, r.defaultBranch, r.workflowCheckedAt instanceof Date]),
      [
        // The enabled repositories first (REV-36).
        ['sakuga-software/orchard', true, 'balanced', true, 'reusable', 'stable', 'main', true],
        ['sakuga-software/boo', false, 'lite', false, 'copy', null, 'trunk', true],
      ],
    )
  })
})
