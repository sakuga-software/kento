// KNT-175. One rule counts and numbers the reviews of a pull request (app/db/review-count.ts): the
// request for feedback, the screen of the pull request, the detail and the history of a finding and
// the user screen. A pull request with three reviews on GitHub, a copy of one of
// them (REV-89), a review that a newer push left out and one the publisher has not posted yet.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { rankLabel } from '../../app/db/review-count.ts'
import { claimRequest } from '../../app/feedback/store.ts'
import { createPullsStore } from '../../app/pulls/store.ts'
import { scoreProgress } from '../../app/ui/pull.tsx'
import { createUsersStore } from '../../app/users/store.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

const PR = 51
const AUTHOR = { githubId: 4242, login: 'octocat' }
const sha = (c: string) => c.repeat(40)

/**
 * The reviews, oldest first. `gh`: the GitHub review id (null: not on GitHub); `copyOf`: the index of
 * the review that a copy reuses; `published`: `published_at` is set.
 */
const PLAN = [
  { name: 'R1', head: sha('1'), score: 2, gh: 501, copyOf: null, published: true },
  { name: 'copy of R1', head: sha('2'), score: 2, gh: 501, copyOf: 0, published: true },
  { name: 'R2', head: sha('3'), score: 3, gh: 502, copyOf: null, published: true },
  { name: 'left out by a push', head: sha('4'), score: 5, gh: null, copyOf: null, published: true },
  { name: 'R3', head: sha('5'), score: 4, gh: 503, copyOf: null, published: true },
  { name: 'waiting for the publisher', head: sha('6'), score: 1, gh: null, copyOf: null, published: false },
] as const

describe('the count and the numbers of the reviews of a pull request (KNT-175)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let repoId: string
  let reviews: string[] = []
  let findingId: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let sql = database.sql
    ;({ orgId, repoId } = await seedEnabledRepo(sql))
    for (let [i, p] of PLAN.entries()) {
      let [job] = await sql<{ id: string }[]>`
        insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, created_at, started_at, finished_at)
        values (${repoId}, 'review', 'lite', 'done', ${PR}, ${p.head}, 'main',
          now() - ${`${60 - i * 5} minutes`}::interval, now() - ${`${60 - i * 5} minutes`}::interval, now() - ${`${59 - i * 5} minutes`}::interval)
        returning id`
      let source = p.copyOf === null ? null : PLAN[p.copyOf]!
      let result = {
        verdict: 'COMMENT',
        findings: [],
        ...(source ? { reusedFrom: { reviewId: reviews[p.copyOf!]!, head: source.head, githubReviewId: source.gh } } : {}),
      }
      let [review] = await sql<{ id: string }[]>`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at, created_at)
        values (${job!.id}, ${repoId}, ${PR}, ${p.head}, ${p.score}, 'm', ${source ? 0 : 0.01}, ${JSON.stringify(result)}::text::jsonb, ${p.gh},
          ${p.published ? new Date(Date.now() - (58 - i * 5) * 60_000).toISOString() : null}, now() - ${`${59 - i * 5} minutes`}::interval)
        returning id`
      reviews.push(review!.id)
    }
    let [finding] = await sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence,
        first_review_id, last_review_id, first_seen_sha, last_seen_sha, created_at)
      values (${repoId}, ${PR}, 'f1', 'k1', 'src/a.ts', 3, 'A finding', 'major', 'bug', 90,
        ${reviews[0]!}, ${reviews[1]!}, ${PLAN[0].head}, ${PLAN[1].head}, now() - interval '56 minutes')
      returning id`
    findingId = finding!.id
    for (let [i, type] of [[0, 'opened'], [1, 'opened'], [3, 'fixed']] as const) {
      await sql`
        insert into finding_events (finding_id, review_id, type, actor, created_at)
        values (${findingId}, ${reviews[i]!}, ${type}, 'kento', now() - ${`${55 - i} minutes`}::interval)`
    }
    // The user screen: the pull request of octocat, a member of the org.
    let [user] = await sql<{ id: string }[]>`
      insert into users (github_id, login, email) values (${AUTHOR.githubId}, ${AUTHOR.login}, 'octocat@example.test') returning id`
    await sql`insert into memberships (user_id, org_id, role) values (${user!.id}, ${orgId}, 'member')`
    await sql`insert into pull_authors (repo_id, pr_number, github_id, login) values (${repoId}, ${PR}, ${AUTHOR.githubId}, ${AUTHOR.login})`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('counts three reviews on the screen of the pull request, as the request for feedback does', async () => {
    let store = createPullsStore(database.sql)
    let summary = (await store.summary(orgId, repoId, PR))!
    assert.equal(summary.reviews, 3)
    assert.equal(await claimRequest(database.sql, repoId, PR, 'octocat'), 3)
  })

  it('moves the score from R2 to R3, and offers R4 next', async () => {
    let summary = (await createPullsStore(database.sql).summary(orgId, repoId, PR))!
    assert.deepEqual(summary.lastScores, [4, 3])
    assert.deepEqual(scoreProgress(summary), { value: '4/5', change: '+1 since R2' })
    // "Run R{reviews + 1}" and the column of a job under way take the next number.
    await database.sql`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref)
      values (${repoId}, 'review', 'heavy', 'queued', ${PR}, ${sha('7')}, 'main')`
    let active = (await createPullsStore(database.sql).summary(orgId, repoId, PR))!.active
    await database.sql`delete from jobs where state = 'queued'`
    assert.equal(active?.number, 4)
  })

  it('numbers R1 to R3 on the sheet; a copy is "same as R1", the others are not published', async () => {
    let store = createPullsStore(database.sql)
    let summary = (await store.summary(orgId, repoId, PR))!
    let sheet = await store.sheet(summary.target, {})
    assert.deepEqual(
      sheet.columns.map((c) => rankLabel(c.rank)),
      ['R1', 'same as R1', 'R2', 'not published', 'R3', 'not published'],
    )
  })

  it('gives the same names in the detail and the history of a finding', async () => {
    let store = createPullsStore(database.sql)
    let detail = (await store.finding(orgId, findingId))!
    assert.equal(detail.review && rankLabel(detail.review.rank), 'same as R1')
    let history = await store.history(orgId, findingId, null)
    assert.deepEqual(
      history.items.map((e) => `${e.type} ${e.review ? rankLabel(e.review) : '-'}`),
      ['opened R1', 'opened same as R1', 'fixed not published'],
    )
  })

  it('counts three reviews on the user screen, and shows the score of the last one on GitHub', async () => {
    let screen = (await createUsersStore(database.sql).screen(orgId, AUTHOR.login))!
    assert.equal(screen.pulls.total, 1)
    let [pull] = screen.pulls.rows
    assert.equal(pull!.reviews, 3)
    assert.equal(pull!.score, 4)
  })

  it('dates a pull request by its last review on GitHub, a copy included, with the score of the review it copies', async () => {
    let sql = database.sql
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref)
      values (${repoId}, 'review', 'lite', 'done', ${PR}, ${sha('9')}, 'main') returning id`
    let copy = { verdict: 'COMMENT', findings: [], reusedFrom: { reviewId: reviews[4]!, head: PLAN[4].head, githubReviewId: 503 } }
    let [row] = await sql<{ publishedAt: Date }[]>`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
      values (${job!.id}, ${repoId}, ${PR}, ${sha('9')}, 4, 'm', 0, ${JSON.stringify(copy)}::text::jsonb, 503, now())
      returning published_at as "publishedAt"`
    let screen = (await createUsersStore(sql).screen(orgId, AUTHOR.login))!
    await sql`delete from jobs where id = ${job!.id}`
    let [pull] = screen.pulls.rows
    assert.equal(pull!.reviews, 3, 'the copy does not count')
    assert.equal(pull!.score, 4, 'the score of R3, which the copy carries')
    assert.equal(pull!.lastReviewAt.getTime(), new Date(row!.publishedAt).getTime())
  })

  it('lists no pull request whose only review never reached GitHub', async () => {
    let sql = database.sql
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref)
      values (${repoId}, 'review', 'lite', 'done', ${PR + 1}, ${sha('8')}, 'main') returning id`
    await sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, published_at)
      values (${job!.id}, ${repoId}, ${PR + 1}, ${sha('8')}, 3, 'm', '{"findings":[]}'::jsonb, now())`
    await sql`insert into pull_authors (repo_id, pr_number, github_id, login) values (${repoId}, ${PR + 1}, ${AUTHOR.githubId}, ${AUTHOR.login})`
    let screen = (await createUsersStore(sql).screen(orgId, AUTHOR.login))!
    await sql`delete from jobs where id = ${job!.id}`
    assert.deepEqual(screen.pulls.rows.map((r) => r.prNumber), [PR])
  })
})
