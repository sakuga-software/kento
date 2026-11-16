// REV-22. The preferences of a person for the reviews of their own pull requests, from the signed
// webhook to the row in `jobs`, and the screen of a user against Postgres. The three checks of the
// ticket are tests 1, 2 and 6.
import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore, enqueueCommandJob } from '../../app/db/webhook-store.ts'
import { listFindingScreen } from '../../app/findings/screen.ts'
import { headSha, pullRequestPayload, REPO, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import { createUsersStore, type UsersStore } from '../../app/users/store.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

const ORCHARD = { id: 3002, full_name: 'sakuga-software/orchard', owner: REPO.owner }
const ALEX = { login: 'alex', type: 'User', id: 101 }
const CAMILLE = { login: 'camille', type: 'User', id: 102 }

describe('the preferences of a user and their screen', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let router: ReturnType<typeof createAppRouter>
  let users: UsersStore
  let delivery = 0
  let orgId: string
  let reviewId: string
  let orchardId: string
  let alex: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    sql = database.sql
    users = createUsersStore(sql)
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
    await sql`truncate orgs, repos, jobs, reviews, users cascade`
    ;({ orgId, repoId: reviewId } = await seedEnabledRepo(sql))
    let [orchard] = await sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled) values (${orgId}, ${ORCHARD.id}, ${ORCHARD.full_name}, true) returning id`
    orchardId = orchard!.id
    let [user] = await sql<{ id: string }[]>`
      insert into users (github_id, login, name) values (101, 'alex', 'Alex Martin') returning id`
    alex = user!.id
    await sql`insert into memberships (user_id, org_id, role) values (${alex}, ${orgId}, 'admin')`
  })

  function nextDelivery(): string {
    delivery++
    return `00000000-0000-0000-0022-${delivery.toString().padStart(12, '0')}`
  }

  async function push(options: Parameters<typeof pullRequestPayload>[0] = {}) {
    let response = await router.fetch(signedRequest(pullRequestPayload({ author: ALEX, ...options }), { deliveryId: nextDelivery() }))
    return (await response.json()) as { outcome: string; reason?: string }
  }

  function command(repo: typeof REPO, number: number) {
    return enqueueCommandJob(database.db, {
      installation: { githubInstallationId: 1001, githubAccountId: 2001, login: 'sakuga-software' },
      repository: { githubRepoId: repo.id, fullName: repo.full_name },
      prNumber: number,
      headSha: headSha(number),
      baseRef: 'main',
      kind: 'review',
      level: 'balanced',
      force: false,
      commentId: 9000 + number,
      deliveryId: `command-${number}`,
      author: { githubId: ALEX.id, login: ALEX.login },
    })
  }

  it('1. auto-review off on orchard: a push of his pull request there queues nothing, a command does, and other repos are reviewed', async () => {
    assert.deepEqual(await users.savePref(orgId, alex, orchardId, { autoReview: false, level: null }), { outcome: 'saved' })

    let skipped = await push({ repo: ORCHARD, number: 7, head: headSha(7) })
    assert.equal(skipped.outcome, 'skipped')
    assert.equal(skipped.reason, 'automatic review is off for the author of the pull request')
    assert.equal((await sql`select 1 from jobs`).length, 0)

    assert.equal((await command(ORCHARD, 7)).outcome, 'queued')
    assert.equal((await sql`select 1 from jobs where pr_number = 7`).length, 1)

    // Another author on orchard, and Alex on another repository, still get their review.
    assert.equal((await push({ repo: ORCHARD, number: 8, head: headSha(8), author: CAMILLE })).outcome, 'queued')
    assert.equal((await push({ number: 9, head: headSha(9) })).outcome, 'queued')
  })

  it('2. a default level heavy on sakuga-review: his push gets heavy; the level of another repo, and of another author, stays the repo one', async () => {
    await users.savePref(orgId, alex, reviewId, { autoReview: true, level: 'heavy' })
    assert.equal((await push({ number: 10, head: headSha(10) })).outcome, 'queued')
    assert.equal((await push({ repo: ORCHARD, number: 11, head: headSha(11) })).outcome, 'queued')
    assert.equal((await push({ number: 12, head: headSha(12), author: CAMILLE })).outcome, 'queued')
    let rows = await sql<{ pr: number; level: string }[]>`select pr_number as pr, level from jobs order by pr_number`
    assert.deepEqual(
      rows.map((r) => [r.pr, r.level]),
      [
        [10, 'heavy'],
        [11, 'lite'],
        [12, 'lite'],
      ],
    )
  })

  it('3. the preferences of one repository win over those of every repository; « Remove » brings those back', async () => {
    await users.savePref(orgId, alex, null, { autoReview: false, level: null })
    await users.savePref(orgId, alex, reviewId, { autoReview: true, level: 'balanced' })
    assert.equal((await push({ repo: ORCHARD, number: 20, head: headSha(20) })).outcome, 'skipped')
    assert.equal((await push({ number: 21, head: headSha(21) })).outcome, 'queued')
    let [job] = await sql<{ level: string }[]>`select level from jobs where pr_number = 21`
    assert.equal(job!.level, 'balanced')

    await users.removePref(alex, reviewId)
    assert.equal((await push({ number: 22, head: headSha(22) })).outcome, 'skipped')
    // Saving twice keeps one row per scope.
    await users.savePref(orgId, alex, null, { autoReview: true, level: 'lite' })
    assert.equal((await sql`select 1 from user_prefs where user_id = ${alex}`).length, 1)
  })

  it('4. a repository of another org, or a disabled one, is no choice', async () => {
    let [other] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (2002, 3003, 'orchard') returning id`
    let [foreign] = await sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled) values (${other!.id}, 4004, 'orchard/app', true) returning id`
    assert.deepEqual(await users.savePref(orgId, alex, foreign!.id, { autoReview: false, level: null }), { outcome: 'not_found' })
    await sql`update repos set enabled = false where id = ${orchardId}`
    assert.deepEqual(await users.savePref(orgId, alex, orchardId, { autoReview: false, level: null }), { outcome: 'not_found' })
    let screen = await users.screen(orgId, 'ALEX')
    assert.deepEqual(
      screen!.addable.map((r) => r.fullName),
      ['sakuga-software/sakuga-review'],
    )
  })

  it('5. the screen: the member, the role, the preferences; a person outside the org is no screen', async () => {
    await users.savePref(orgId, alex, orchardId, { autoReview: false, level: 'heavy' })
    let screen = await users.screen(orgId, 'Alex')
    assert.equal(screen!.user.login, 'alex')
    assert.equal(screen!.role, 'admin')
    assert.equal(screen!.prefs.global, null)
    assert.deepEqual(screen!.prefs.repos, [{ repoId: orchardId, fullName: ORCHARD.full_name, autoReview: false, level: 'heavy' }])
    assert.equal(await users.screen(orgId, 'camille'), null)
  })

  it('6. « Findings received » are the counts of the Findings screen on his pull requests; « My reviewed PRs » lists them', async () => {
    // Pull request 30 of Alex (two reviews), 31 of Camille, 32 of Alex (closed, one review).
    assert.equal((await push({ number: 30, head: headSha(30) })).outcome, 'queued')
    assert.equal((await push({ number: 31, head: headSha(31), author: CAMILLE })).outcome, 'queued')
    assert.equal((await push({ number: 32, head: headSha(32) })).outcome, 'queued')
    let jobs = await sql<{ id: string; pr: number }[]>`select id, pr_number as pr from jobs order by pr_number`
    for (let first of jobs) {
      let times = first.pr === 30 ? 2 : 1
      for (let i = 0; i < times; i++) {
        // One review per job: the second review of 30 is the review of a command.
        let job = first
        if (i > 0) {
          let [command] = await sql<{ id: string }[]>`
            insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, github_comment_id)
            values (${reviewId}, 'heavy', 'done', ${first.pr}, ${headSha(first.pr)}, 'main', ${7000 + i}) returning id`
          job = { id: command!.id, pr: first.pr }
        }
        await sql`
          insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at, created_at)
          values (${job.id}, ${reviewId}, ${job.pr}, ${headSha(job.pr)}, ${3 + i}, 'm', 0.01,
            ${JSON.stringify({ verdict: i === 0 ? 'COMMENT' : 'APPROVE', findings: [] })}::text::jsonb,
            now() - ${`${10 - i} minutes`}::interval, now() - ${`${10 - i} minutes`}::interval)`
      }
    }
    let finding = async (pr: number, status: string, ago = '1 day', title = `f-${pr}-${status}-${ago}`) => {
      let [review] = await sql<{ id: string }[]>`select id from reviews where pr_number = ${pr} limit 1`
      await sql`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
          first_review_id, last_review_id, first_seen_sha, last_seen_sha, created_at)
        values (${reviewId}, ${pr}, ${title}, ${title}, 'a.ts', 1, ${title}, 'major', 'correctness', 90, ${status},
          ${review!.id}, ${review!.id}, ${headSha(pr)}, ${headSha(pr)}, now() - ${ago}::interval)`
    }
    await finding(30, 'open')
    await finding(30, 'open', '2 days')
    await finding(30, 'fixed')
    await finding(30, 'dismissed')
    await finding(32, 'wontfix')
    await finding(32, 'open', '40 days')
    await finding(31, 'open')
    await push({ action: 'closed', number: 32, head: headSha(32) })

    let screen = await users.screen(orgId, 'alex')
    let viaScreen = await listFindingScreen(sql, orgId, { author: 'alex', days: 30 })
    assert.deepEqual(screen!.received, viaScreen.counts)
    assert.equal(screen!.received.open, 2, 'the open finding of 40 days ago and the one of Camille are not his')
    assert.equal(screen!.received.fixed, 1)
    assert.equal(screen!.received.wontfix, 1)

    assert.equal(screen!.pulls.total, 2)
    let [first, second] = screen!.pulls.rows
    assert.equal(first!.prNumber, 30)
    assert.equal(first!.reviews, 2)
    assert.equal(first!.verdict, 'APPROVE')
    assert.equal(first!.score, 4)
    assert.equal(first!.state, 'open')
    assert.deepEqual(first!.findings, { open: 2, fixed: 1, dismissed: 1, wontfix: 0, stale: 0 })
    assert.equal(second!.prNumber, 32)
    assert.equal(second!.state, 'closed')
    assert.deepEqual(second!.findings, { open: 0, fixed: 0, dismissed: 0, wontfix: 1, stale: 1 })
  })
})
