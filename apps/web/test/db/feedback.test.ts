// REV-107. The request for feedback after the third published review, and the answers: the command
// `feedback`, a quote of the request, the reactions at the close. Postgres is real; GitHub is the fake
// of test/fake-github.ts.
import { generateKeyPairSync } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ReviewPayload } from '@kento-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { migrationsFolder, runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { createFeedbackHandler } from '../../app/feedback/handler.ts'
import { requestText } from '../../app/feedback/request.ts'
import { claimRequest, listFeedback } from '../../app/feedback/store.ts'
import { createInstallationTokenMinter, readPrivateKey } from '../../app/github/installation-token.ts'
import { issueCommentPayload, pullRequestPayload, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { createPublisher } from '../../app/publish/publisher.ts'
import { createAppRouter } from '../../app/router.ts'
import { BOT, createFakeGitHub, type FakeGitHub } from '../fake-github.ts'
import { createTestDatabase, seedEnabledRepo, seedEnabledRepoBefore0029 } from './helpers.ts'

const PR = 28
const BASE = 'a'.repeat(40)
const head = (n: number) => n.toString(16).repeat(40).slice(0, 40)

let pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function review(sha: string): ReviewPayload {
  return {
    level: 'lite',
    base: BASE,
    head: sha,
    score: 4,
    verdict: 'COMMENT',
    model: 'anthropic/claude-haiku-5.5',
    provider: 'Anthropic',
    costUsd: 0.01,
    promptTokens: 1000,
    completionTokens: 200,
    summary: 'The PR changes sum.',
    risk: 'Low.',
    diagram: null,
    deeperReview: null,
    findings: [],
    notReviewed: [],
    skipped: [],
  }
}

describe('feedback on the reviews (REV-107)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let repoId: string
  let fake: FakeGitHub
  let delivery = 0

  function mint() {
    return createInstallationTokenMinter({ appId: '12345', privateKey: readPrivateKey(pem), apiUrl: fake.apiUrl, fetch: fake.fetch })
  }

  function publisher() {
    return createPublisher({ sql: database.sql, mintInstallationToken: mint(), apiUrl: fake.apiUrl, botLogin: BOT, fetch: fake.fetch })
  }

  function router() {
    let feedback = createFeedbackHandler({
      db: database.db,
      sql: database.sql,
      botLogin: BOT,
      mintInstallationToken: mint(),
      apiUrl: fake.apiUrl,
      webUrl: 'https://github.com',
      fetch: fake.fetch,
    })
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 26 }),
      version: 'test',
      commit: null,
      webhook: {
        secret: TEST_SECRET,
        trustedBotsFor: async () => new Set(['sakuga-agent[bot]']),
        botLogin: BOT,
        apply: createWebhookStore(database.db, { handleFeedbackReply: feedback.handleReply, onPullClosed: feedback.onPullClosed }),
      },
    })
  }

  async function deliver(event: string, payload: unknown, deliveryId = `00000000-0000-0000-0000-${(++delivery).toString().padStart(12, '0')}`) {
    let response = await router().fetch(signedRequest(payload, { event, deliveryId }))
    return { status: response.status, body: await response.json().catch(() => null), deliveryId }
  }

  /** A review of the pull request at `sha`, stored by a runner and not published yet. */
  async function storeReview(sha: string) {
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref, state)
      values (${repoId}, 'lite', ${PR}, ${sha}, 'main', 'done') returning id`
    await database.sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result)
      values (${job!.id}, ${repoId}, ${PR}, ${sha}, 4, 'm', ${JSON.stringify(review(sha))}::jsonb)`
  }

  async function publish(sha: string) {
    fake.state.pr.head = sha
    await storeReview(sha)
    let results = await publisher().publishPending()
    assert.equal(results[0]?.kind, 'published')
  }

  const requests = () => fake.state.issueComments.filter((c) => c.author === BOT && c.body.includes('Kentō reviewed this PR'))

  async function feedbackRows() {
    let rows = await database.sql<{ source: string; text: string; authorLogin: string; authorIsBot: boolean; url: string | null }[]>`
      select source, text, author_login as "authorLogin", author_is_bot as "authorIsBot", url from feedback order by created_at, id`
    return rows.map((row) => ({ ...row }))
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 12 })
    ;({ orgId, repoId } = await seedEnabledRepo(database.sql))
  })

  beforeEach(async () => {
    await database.sql`delete from jobs`
    await database.sql`delete from feedback_requests`
    await database.sql`delete from feedback`
    fake = createFakeGitHub({ head: head(1), pr: PR })
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('asks the author once, after the third published review, and never again', async () => {
    await publish(head(1))
    await publish(head(2))
    assert.equal(requests().length, 0, 'no request after the second review')

    await publish(head(3))
    assert.equal(requests().length, 1)
    let [request] = requests()
    assert.ok(request!.body.startsWith('@camille Kentō reviewed this PR 3 times.'))
    let [row] = await database.sql<{ commentId: string | null; author: string }[]>`
      select github_comment_id as "commentId", author_login as author from feedback_requests`
    assert.equal(Number(row!.commentId), request!.id)
    assert.equal(row!.author, 'camille')

    await publish(head(4))
    assert.equal(requests().length, 1, 'no second request after the fourth review')
  })

  it('asks a bot that opened the pull request too, and nobody on a closed pull request', async () => {
    fake.state.pr.author = { login: 'sakuga-agent[bot]', type: 'Bot' }
    for (let n = 1; n <= 3; n++) await publish(head(n))
    assert.ok(requests()[0]!.body.startsWith('@sakuga-agent[bot] Kentō reviewed'))

    await database.sql`delete from feedback_requests`
    fake.state.issueComments = []
    fake.state.pr.state = 'closed'
    await storeReview(head(5))
    let results = await publisher().publishPending()
    assert.equal(results[0]?.kind, 'skipped')
    assert.equal(requests().length, 0)
  })

  it('gives the request to one publication only, when two claim it at once', async () => {
    for (let n = 1; n <= 3; n++) {
      await storeReview(head(n))
      await database.sql`update reviews set published_at = now(), github_review_id = ${n} where head_sha = ${head(n)}`
    }
    let claims = await Promise.all(Array.from({ length: 8 }, () => claimRequest(database.sql, repoId, PR, 'camille')))
    assert.deepEqual(claims.filter((c) => c !== null), [3])
  })

  it('does not count the copies of a review on an unchanged head (KNT-157)', async () => {
    /** A published review at `sha`; a copy carries the GitHub review of its source, as the publisher writes it. */
    async function published(sha: string, githubReviewId: number, copyOf: string | null) {
      await storeReview(sha)
      let reusedFrom = copyOf ? { reviewId: '00000000-0000-0000-0000-000000000001', head: copyOf, githubReviewId } : null
      await database.sql`
        update reviews set published_at = now(), github_review_id = ${githubReviewId},
          result = case when ${reusedFrom === null}::boolean then result else result || jsonb_build_object('reusedFrom', ${JSON.stringify(reusedFrom)}::jsonb) end
        where head_sha = ${sha}`
    }
    await published(head(1), 1, null)
    for (let n = 2; n <= 4; n++) await published(head(n), 1, head(1))
    assert.equal(await claimRequest(database.sql, repoId, PR, 'camille'), null, 'one review and three copies: no request')

    await database.sql`delete from jobs`
    for (let n = 1; n <= 3; n++) await published(head(n), n, null)
    await published(head(4), 3, head(3))
    let reviews = await claimRequest(database.sql, repoId, PR, 'camille')
    assert.equal(reviews, 3, 'three reviews and one copy: one request, for three reviews')
    assert.ok(requestText('camille', reviews!).startsWith('@camille Kentō reviewed this PR 3 times.'))
  })

  it('gives the claim back when GitHub refuses the comment, so that the next review asks', async () => {
    for (let n = 1; n <= 2; n++) await publish(head(n))
    fake.state.failIssueComments = 1
    await publish(head(3))
    assert.equal(requests().length, 0)
    assert.equal((await database.sql`select 1 from feedback_requests`).length, 0)
    await publish(head(4))
    assert.equal(requests().length, 1)
    assert.match(requests()[0]!.body, /reviewed this PR 4 times/)
  })

  it('records `@kento-review feedback`, with ❤️ and no job, once for a redelivery', async () => {
    let payload = issueCommentPayload({ body: '@kento-review feedback it found the bug', commentId: 9501 })
    Object.assign(payload.comment, { html_url: 'https://github.com/sakuga-software/sakuga-review/pull/28#issuecomment-9501' })
    let first = await deliver('issue_comment', payload)
    assert.equal(first.status, 202)
    assert.deepEqual(first.body, { outcome: 'recorded', created: true, reactions: 0 })
    assert.ok(fake.state.reactions.has('9501:heart'))
    assert.equal((await database.sql`select 1 from jobs`).length, 0, 'no job')

    let again = await deliver('issue_comment', payload, first.deliveryId)
    assert.equal(again.body.created, false)
    assert.deepEqual(await feedbackRows(), [
      {
        source: 'command',
        text: 'it found the bug',
        authorLogin: 'octocat',
        authorIsBot: false,
        url: 'https://github.com/sakuga-software/sakuga-review/pull/28#issuecomment-9501',
      },
    ])
  })

  it('answers a `feedback` without a text with 😕 and the form, and records nothing', async () => {
    let out = await deliver('issue_comment', issueCommentPayload({ body: '@kento-review feedback', commentId: 9502 }))
    assert.equal(out.body.outcome, 'refused')
    assert.ok(fake.state.reactions.has('9502:confused'))
    assert.match(fake.state.issueComments.at(-1)!.body, /^@octocat The `feedback` command needs your opinion/)
    assert.deepEqual(await feedbackRows(), [])
  })

  it('takes its 😕 back when GitHub refuses the reply to an empty `feedback`, so that a redelivery replies', async () => {
    fake.state.failIssueComments = 1
    let payload = issueCommentPayload({ body: '@kento-review feedback', commentId: 9505 })
    let first = await deliver('issue_comment', payload)
    assert.equal(first.status, 500)
    assert.ok(!fake.state.reactions.has('9505:confused'))
    let again = await deliver('issue_comment', payload, first.deliveryId)
    assert.equal(again.body.outcome, 'refused')
    assert.equal(fake.state.issueComments.filter((c) => c.body.includes('needs your opinion')).length, 1)
  })

  it('finds the request by its marker when the post got no answer, and reads its reactions', async () => {
    await database.sql`insert into feedback_requests (repo_id, pr_number, author_login) values (${repoId}, ${PR}, 'camille')`
    fake.state.issueComments.push({ id: 8900, body: requestText('camille', 3), author: BOT })
    fake.state.issueReactions.set(8900, [{ id: 91, content: '-1', login: 'camille', type: 'User', created_at: '2026-11-12T10:00:00Z' }])
    await deliver('pull_request', pullRequestPayload({ action: 'closed', number: PR }))
    assert.deepEqual((await feedbackRows()).map((r) => [r.source, r.text]), [['reaction', '👎']])
    let [row] = await database.sql<{ commentId: string }[]>`select github_comment_id as "commentId" from feedback_requests`
    assert.equal(Number(row!.commentId), 8900)
  })

  it('records a quote of the request only where Kentō asked, and reads the reactions with it', async () => {
    const quote = '> @camille Kentō reviewed this PR 3 times. Your opinion on these reviews helps us make it better:\n\nA useless thread on the cache.'
    let none = await deliver('issue_comment', issueCommentPayload({ body: quote, commentId: 9503 }))
    assert.deepEqual(none.body, { outcome: 'skipped', reason: 'no request for feedback on the pull request' })

    await database.sql`insert into feedback_requests (repo_id, pr_number, author_login, github_comment_id) values (${repoId}, ${PR}, 'camille', 8800)`
    fake.state.issueReactions.set(8800, [{ id: 71, content: '+1', login: 'camille', type: 'User', created_at: '2026-11-12T10:00:00Z' }])
    let out = await deliver('issue_comment', issueCommentPayload({ body: quote, commentId: 9504 }))
    assert.deepEqual(out.body, { outcome: 'recorded', created: true, reactions: 1 })
    let rows = await feedbackRows()
    assert.deepEqual(rows.map((r) => [r.source, r.text]).sort(), [
      ['quote', 'A useless thread on the cache.'],
      ['reaction', '👍'],
    ])
  })

  it('reads the 👍 and 👎 on the request at the close of the pull request, once each, without those of the App', async () => {
    await database.sql`insert into feedback_requests (repo_id, pr_number, author_login, github_comment_id) values (${repoId}, ${PR}, 'camille', 8800)`
    fake.state.issueReactions.set(8800, [
      { id: 81, content: '+1', login: 'camille', type: 'User', created_at: '2026-11-12T10:00:00Z' },
      { id: 82, content: '-1', login: 'sakuga-agent[bot]', type: 'Bot', created_at: '2026-11-12T10:01:00Z' },
      { id: 83, content: 'laugh', login: 'camille', type: 'User', created_at: '2026-11-12T10:02:00Z' },
      { id: 84, content: '+1', login: BOT, type: 'Bot', created_at: '2026-11-12T10:03:00Z' },
    ])
    let closed = pullRequestPayload({ action: 'closed', number: PR })
    let first = await deliver('pull_request', closed)
    assert.equal(first.body.outcome, 'cancelled')
    await deliver('pull_request', closed)
    let rows = await feedbackRows()
    assert.deepEqual(rows.map((r) => [r.source, r.text, r.authorLogin, r.authorIsBot]), [
      ['reaction', '👍', 'camille', false],
      ['reaction', '👎', 'sakuga-agent[bot]', true],
    ])
    assert.equal(rows[0]!.url, 'https://github.com/sakuga-software/sakuga-review/pull/28#issuecomment-8800')
  })

  it('lists the answers of the org, the newest first, with the score of the last review and the filters', async () => {
    await publish(head(1))
    let insert = (source: string, login: string, bot: boolean, at: string, id: number) => database.sql`
      insert into feedback (repo_id, pr_number, author_login, author_is_bot, source, text, github_comment_id, created_at)
      values (${repoId}, ${PR}, ${login}, ${bot}, ${source}, 'avis', ${id}, ${at})`
    await insert('command', 'camille', false, '2026-11-10T10:00:00Z', 1)
    await insert('quote', 'sakuga-agent[bot]', true, '2026-11-11T10:00:00Z', 2)
    let all = await listFeedback(database.sql, orgId)
    assert.equal(all.total, 2)
    assert.deepEqual(all.rows.map((r) => [r.authorLogin, r.score, r.repo]), [
      ['sakuga-agent[bot]', 4, 'sakuga-software/sakuga-review'],
      ['camille', 4, 'sakuga-software/sakuga-review'],
    ])
    assert.deepEqual(all.repos.map((r) => r.id), [repoId])
    assert.deepEqual((await listFeedback(database.sql, orgId, { kind: 'person' })).rows.map((r) => r.authorLogin), ['camille'])
    assert.deepEqual((await listFeedback(database.sql, orgId, { source: 'quote' })).rows.map((r) => r.authorLogin), ['sakuga-agent[bot]'])
    let [other] = await database.sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('other', lower('other')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 9999, 9998, 'other' from org returning org_id as id`
    assert.equal((await listFeedback(database.sql, other!.id)).total, 0, 'another org sees nothing')
  })
})

describe('feedback on a pull request reviewed before the deploy (REV-107)', () => {
  it('never asks a pull request with three published reviews before the migration 0026, and asks one whose third comes after', async () => {
    let test = await createTestDatabase()
    let earlier = await mkdtemp(path.join(tmpdir(), 'kento-feedback-'))
    let database = createDatabase(test.url, { max: 4 })
    try {
      // The first release of REV-107: every migration up to 0025.
      await cp(migrationsFolder, earlier, { recursive: true })
      let journalPath = path.join(earlier, 'meta', '_journal.json')
      let journal = JSON.parse(await readFile(journalPath, 'utf8'))
      journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag < '0026')
      await writeFile(journalPath, JSON.stringify(journal))
      await runMigrations(test.url, earlier)
      let { repoId } = await seedEnabledRepoBefore0029(database.sql)

      let n = 0
      async function storeReview(pr: number, published: boolean) {
        let sha = (++n).toString(16).padStart(40, '0')
        let [job] = await database.sql<{ id: string }[]>`
          insert into jobs (repo_id, level, pr_number, head_sha, base_ref, state)
          values (${repoId}, 'lite', ${pr}, ${sha}, 'main', 'done') returning id`
        await database.sql`
          insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, published_at, github_review_id)
          values (${job!.id}, ${repoId}, ${pr}, ${sha}, 4, 'm', ${JSON.stringify(review(sha))}::jsonb,
            ${published ? new Date().toISOString() : null}, ${published ? 500 + n : null})`
        return sha
      }
      // Before the deploy: PR 41 has its three reviews, PR 42 two.
      for (let i = 0; i < 3; i++) await storeReview(41, true)
      for (let i = 0; i < 2; i++) await storeReview(42, true)

      await runMigrations(test.url)

      for (let pr of [41, 42]) {
        let fake = createFakeGitHub({ head: 'f'.repeat(40), pr })
        fake.state.pr.head = await storeReview(pr, false)
        let mint = createInstallationTokenMinter({ appId: '12345', privateKey: readPrivateKey(pem), apiUrl: fake.apiUrl, fetch: fake.fetch })
        let results = await createPublisher({ sql: database.sql, mintInstallationToken: mint, apiUrl: fake.apiUrl, botLogin: BOT, fetch: fake.fetch }).publishPending()
        assert.equal(results[0]?.kind, 'published')
        let requests = fake.state.issueComments.filter((c) => c.body.includes('Kentō reviewed this PR'))
        if (pr === 41) assert.equal(requests.length, 0, 'PR 41: its fourth review asks nothing')
        else assert.ok(requests[0]?.body.startsWith('@camille Kentō reviewed this PR 3 times.'), 'PR 42: its third review asks')
      }
    } finally {
      await database.close()
      await rm(earlier, { recursive: true, force: true })
      await test.drop()
    }
  })
})
