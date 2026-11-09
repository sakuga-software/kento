// The path of a review from the runner to GitHub: the result route stores it, the publisher posts
// it with an installation token of the App. Postgres is real; GitHub is the fake of
// test/fake-github.ts, which also makes the installation tokens.
import { generateKeyPairSync } from 'node:crypto'

import type { Job, ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createInstallationTokenMinter, readPrivateKey } from '../../app/github/installation-token.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createPublisher, type Publisher } from '../../app/publish/publisher.ts'
import { createAppRouter } from '../../app/router.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { BOT, createFakeGitHub, type FakeGitHub } from '../fake-github.ts'
import { createTestDatabase } from './helpers.ts'

const REGISTRATION_TOKEN = 'registration-token-for-the-tests-0123456789'
const BASE = 'a'.repeat(40)
const HEAD1 = '1'.repeat(40)
const HEAD2 = '2'.repeat(40)
const PR = 28

let pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function review(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    level: 'lite',
    base: BASE,
    head: HEAD1,
    score: 2,
    verdict: 'REQUEST_CHANGES',
    model: 'anthropic/claude-haiku-5.5',
    provider: 'Anthropic',
    costUsd: 0.0123,
    promptTokens: 1000,
    completionTokens: 200,
    summary: 'La PR change sum.',
    risk: 'Un calcul faux.',
    diagram: null,
    deeperReview: null,
    findings: [
      {
        path: 'src/sum.ts',
        start_line: 2,
        line: 2,
        severity: 'major',
        category: 'bug',
        confidence: 90,
        title: 'La somme soustrait',
        scenario: 'sum(1, 2) rend -1.',
        fix: 'Remettre +.',
        suggestion: '  return a + b;',
        anchor: 2,
        blocking: true,
        suggestion_range: [2, 2],
      },
    ],
    notReviewed: [],
    skipped: [],
    ...overrides,
  }
}

describe('publication of a review', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let repoId: string
  let fake: FakeGitHub
  let publisher: Publisher
  let woken: number

  function newPublisher() {
    let mint = createInstallationTokenMinter({ appId: '12345', privateKey: readPrivateKey(pem), apiUrl: fake.apiUrl, fetch: fake.fetch })
    return createPublisher({ sql: database.sql, mintInstallationToken: mint, apiUrl: fake.apiUrl, botLogin: BOT, fetch: fake.fetch })
  }

  function router() {
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 2 }),
      version: 'test',
      commit: null,
      webhook: disabledWebhook,
      runner: {
        store: createRunnerStore(database.sql),
        registrationToken: REGISTRATION_TOKEN,
        mintInstallationToken: async () => ({ token: 'ghs_clone', expiresAt: '2030-01-01T00:00:00Z' }),
        providerApiKey: null,
        claimWaitMs: 0,
        onReviewStored: () => {
          woken++
          publisher.wake()
        },
      },
    })
  }

  async function call(path: string, token: string, body: unknown) {
    return router().fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    )
  }

  /** A runner registers, claims the job of `head`, and sends `result`. */
  async function runJob(head: string, result: ReviewPayload, config: unknown = null): Promise<string> {
    await database.sql`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref, config)
      values (${repoId}, 'lite', ${PR}, ${head}, 'main', ${config === null ? null : JSON.stringify(config)}::jsonb)`
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true })
    assert.equal(claimed.status, 200)
    let job: Job = await claimed.json()
    let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: result })
    assert.equal(stored.status, 204)
    return job.id
  }

  async function rows() {
    return database.sql<{ headSha: string; publishedAt: Date | null; githubReviewId: string | null }[]>`
      select head_sha as "headSha", published_at as "publishedAt", github_review_id as "githubReviewId"
      from reviews order by created_at`
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 12 })
    let [org] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login)
      values (77, 2001, 'sakuga-software') returning id`
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${org!.id}, 3001, 'sakuga-software/sakuga-review', true) returning id`
    repoId = repo!.id
  })

  beforeEach(async () => {
    await publisher?.stop()
    await database.sql`delete from jobs`
    await database.sql`update orgs set suspended_at = null`
    fake = createFakeGitHub({ head: HEAD1, pr: PR, commits: { [HEAD1]: 'fix: sum', [HEAD2]: 'fix: sum again' } })
    publisher = newPublisher()
    woken = 0
  })

  after(async () => {
    await publisher?.stop()
    await database?.close()
    await test?.drop()
  })

  it('publishes the review that a runner sends, as the App, once', async () => {
    await runJob(HEAD1, review())
    assert.equal(woken, 1, 'the result route wakes the publisher')
    // The wake runs in the background: stop() waits for it.
    await publisher.stop()

    assert.equal(fake.state.reviews.length, 1)
    let [posted] = fake.state.reviews
    assert.equal(posted!.user, BOT)
    assert.equal(posted!.state, 'CHANGES_REQUESTED')
    assert.match(posted!.body, /Score de confiance : 2\/5/)
    assert.equal(fake.botThreads().length, 1)
    assert.match(fake.state.pr.body, /<!-- sakuga-review:start -->[\s\S]*<!-- sakuga-review:count 1 -->\n<!-- sakuga-review:end -->$/)
    assert.deepEqual(fake.state.pr.labels, ['review: 2/5'])
    assert.equal(fake.state.checkRuns.length, 1)
    assert.equal(fake.state.checkRuns[0]!.name, 'Sakuga Review')

    // The tokens: the repository of the job only, the permissions to publish, and the check apart.
    assert.deepEqual(
      fake.state.tokens.map((t) => [t.installationId, t.repositoryIds, t.permissions]),
      [
        [77, [3001], { contents: 'read', pull_requests: 'write', issues: 'write' }],
        [77, [3001], { checks: 'write' }],
        // REV-16: the sweep of the 👎 reads the comment of the new finding, in read only.
        [77, [3001], { pull_requests: 'read' }],
      ],
    )
    let writes = fake.state.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/app/'))
    assert.ok(writes.every((c) => c.token.startsWith('ghs_fake_')), 'every write goes with an installation token')

    let [row] = await rows()
    assert.ok(row!.publishedAt)
    assert.equal(Number(row!.githubReviewId), posted!.id)

    // Nothing is left to publish.
    assert.deepEqual(await publisher.publishPending(), [])
    assert.equal(fake.state.reviews.length, 1)
  })

  it('publishes again the review of the earlier head when the runner sends unchanged: block, label, check, and a review on the head (REV-89, REV-101)', async () => {
    const KEY = 'e'.repeat(64)
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let claimNext = async () => {
      let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: ['reuse'] })
      assert.equal(claimed.status, 200)
      return (await claimed.json()) as Job
    }
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD1}, 'main')`
    let first = await claimNext()
    assert.equal(first.kind === 'review' && first.reuse, null, 'no review yet')
    let done = { outcome: 'done', attempt: 1, review: review({ reuseKey: KEY, diffHash: '0123456789abcdef', cachedTokens: 600 }) }
    assert.equal((await call(`/api/runner/jobs/${first.id}/result`, token, done)).status, 204)
    await publisher.stop()
    let [posted] = fake.state.reviews

    // A merge of main: a new head, the same reviewed files.
    fake.state.pr.head = HEAD2
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD2}, 'main')`
    publisher = newPublisher()
    let second = await claimNext()
    assert.deepEqual(second.kind === 'review' && second.reuse, { head: HEAD1, key: KEY })
    let unchanged = { level: 'lite', base: BASE, head: HEAD2, of: HEAD1, diffHash: '0123456789abcdef', reuseKey: KEY }
    assert.equal((await call(`/api/runner/jobs/${second.id}/result`, token, { outcome: 'unchanged', attempt: 1, unchanged })).status, 204)
    await publisher.stop()

    // REV-101. The new head gets a review of its own, with the same verdict and score, and no comment.
    assert.equal(fake.state.reviews.length, 2, 'a review on the new head')
    let copy = fake.state.reviews[1]!
    assert.equal(copy.commitId, HEAD2)
    assert.equal(copy.state, 'CHANGES_REQUESTED', 'the verdict of the review of HEAD1')
    assert.equal(copy.comments, 0)
    assert.match(copy.body, /\*\*Score de confiance : 2\/5\*\*/)
    assert.match(copy.body, /Même score que le commit `111111111` : aucun fichier relu n'a changé depuis\./)
    assert.equal(fake.botThreads().length, 1, 'no second thread')
    assert.match(fake.state.pr.body, /Aucun fichier relu n'a changé depuis le commit `111111111`/)
    assert.match(fake.state.pr.body, /<!-- sakuga-review:count 1 -->/)
    assert.deepEqual(fake.state.pr.labels, ['review: 2/5'])
    assert.deepEqual(fake.state.checkRuns.map((c) => c.head_sha), [HEAD1, HEAD2], 'the new head gets its check')
    let [, row] = await rows()
    assert.equal(row!.headSha, HEAD2)
    assert.ok(row!.publishedAt)
    assert.equal(Number(row!.githubReviewId), posted!.id, 'the review with the findings is the one of HEAD1')
    let [stored] = await database.sql<{ headReviewId: string }[]>`select result->>'headReviewId' as "headReviewId" from reviews where head_sha = ${HEAD2}`
    assert.equal(Number(stored!.headReviewId), copy.id)
  })

  it('gives each head of a chain of unchanged pushes a review, and posts it once (REV-101)', async () => {
    const KEY = 'e'.repeat(64)
    const HEAD3 = '3'.repeat(40)
    fake.state.commits[HEAD3] = 'merge main again'
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let claimNext = async () => {
      let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: ['reuse'] })
      assert.equal(claimed.status, 200)
      return (await claimed.json()) as Job
    }
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD1}, 'main')`
    let first = await claimNext()
    let done = { outcome: 'done', attempt: 1, review: review({ reuseKey: KEY, diffHash: '0123456789abcdef', score: 4, verdict: 'APPROVE', findings: [] }) }
    assert.equal((await call(`/api/runner/jobs/${first.id}/result`, token, done)).status, 204)
    await publisher.stop()
    let [posted] = fake.state.reviews
    assert.equal(posted!.state, 'APPROVED')

    for (let head of [HEAD2, HEAD3]) {
      fake.state.pr.head = head
      await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${head}, 'main')`
      publisher = newPublisher()
      let next = await claimNext()
      assert.deepEqual(next.kind === 'review' && next.reuse, { head: head === HEAD2 ? HEAD1 : HEAD2, key: KEY })
      let unchanged = { level: 'lite', base: BASE, head, of: head === HEAD2 ? HEAD1 : HEAD2, diffHash: '0123456789abcdef', reuseKey: KEY }
      assert.equal((await call(`/api/runner/jobs/${next.id}/result`, token, { outcome: 'unchanged', attempt: 1, unchanged })).status, 204)
      await publisher.stop()
    }

    // The copy on HEAD2 does not replace the review of HEAD1: HEAD3 is published, with its review.
    assert.deepEqual(
      fake.state.reviews.map((r) => [r.commitId, r.state]),
      [[HEAD1, 'APPROVED'], [HEAD2, 'APPROVED'], [HEAD3, 'APPROVED']],
    )
    for (let copy of fake.state.reviews.slice(1)) {
      assert.match(copy.body, /\*\*Score de confiance : 4\/5\*\*/)
      assert.match(copy.body, /Même score que le commit `111111111`/, 'a copy of a copy names the review that a model made')
    }
    assert.match(fake.state.pr.body, /Aucun fichier relu n'a changé depuis le commit `111111111`/)
    let all = await rows()
    assert.deepEqual(all.map((r) => Number(r.githubReviewId)), [posted!.id, posted!.id, posted!.id])

    // A second publication of the same row (a try after a failure) posts no second review.
    await database.sql`update reviews set published_at = null where head_sha = ${HEAD3}`
    publisher = newPublisher()
    await publisher.publishPending()
    await publisher.stop()
    assert.equal(fake.state.reviews.length, 3, 'found by its marker')
  })

  it('builds the block of a reused review from the threads and the findings as they are at publication (REV-89)', async () => {
    const KEY = 'e'.repeat(64)
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let claimNext = async () => {
      let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: ['reuse'] })
      assert.equal(claimed.status, 200)
      return (await claimed.json()) as Job
    }
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD1}, 'main')`
    let first = await claimNext()
    assert.equal(first.kind === 'review' && first.reuse, null, 'no review yet')
    let mul = { ...review().findings[0]!, path: 'src/mul.ts', title: 'Le produit divise', scenario: 'mul(1, 2) rend 0,5.' }
    let done = { outcome: 'done', attempt: 1, review: review({ reuseKey: KEY, diffHash: '0123456789abcdef', findings: [...review().findings, mul] }) }
    assert.equal((await call(`/api/runner/jobs/${first.id}/result`, token, done)).status, 204)
    await publisher.stop()
    let [posted] = fake.state.reviews

    // Before the merge of main, a person resolves the thread of the first finding and dismisses the second.
    let threads = fake.botThreads()
    assert.equal(threads.length, 2)
    let sumThread = threads.find((t) => t.path === 'src/sum.ts')!
    fake.state.resolved.add(sumThread.id)
    await database.sql`update findings set status = 'dismissed', status_reason = 'voulu' where title = 'Le produit divise'`
    fake.state.pr.head = HEAD2
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD2}, 'main')`
    publisher = newPublisher()
    let second = await claimNext()
    assert.deepEqual(second.kind === 'review' && second.reuse, { head: HEAD1, key: KEY })
    let unchanged = { level: 'lite', base: BASE, head: HEAD2, of: HEAD1, diffHash: '0123456789abcdef', reuseKey: KEY }
    assert.equal((await call(`/api/runner/jobs/${second.id}/result`, token, { outcome: 'unchanged', attempt: 1, unchanged })).status, 204)
    await publisher.stop()

    let body = fake.state.pr.body
    assert.match(body, /Aucun fichier relu n'a changé depuis le commit `111111111`/)
    assert.doesNotMatch(body, /Le produit divise/, 'a finding dismissed since is out of the block')
    assert.match(body, /La somme soustrait/)
    assert.doesNotMatch(body, new RegExp(`#discussion_r${sumThread.id}`), 'a resolved thread gives no link')
    assert.match(body, /sum\(1, 2\) rend -1\./, 'without a thread, the block shows the scenario')
    assert.equal(fake.state.reviews.length, 2, 'one review on the new head, without comments')
    assert.equal(fake.state.reviews[1]!.comments, 0)
    assert.match(fake.state.reviews[1]!.body, /Score de confiance : 2\/5/, 'the score of the block')
    assert.equal(fake.state.reviews[0]!.id, posted!.id)
  })

  it('posts the copy as a review of its own when the review of the earlier head was dismissed (REV-89)', async () => {
    const KEY = 'e'.repeat(64)
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let claimNext = async () => {
      let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: ['reuse'] })
      assert.equal(claimed.status, 200)
      return (await claimed.json()) as Job
    }
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD1}, 'main')`
    let first = await claimNext()
    assert.equal(first.kind === 'review' && first.reuse, null, 'no review yet')
    let done = { outcome: 'done', attempt: 1, review: review({ reuseKey: KEY, diffHash: '0123456789abcdef', cachedTokens: 600 }) }
    assert.equal((await call(`/api/runner/jobs/${first.id}/result`, token, done)).status, 204)
    await publisher.stop()
    let [posted] = fake.state.reviews

    // A person dismissed the review of HEAD1, then main was merged.
    fake.state.reviews[0]!.state = 'DISMISSED'
    fake.state.pr.head = HEAD2
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD2}, 'main')`
    publisher = newPublisher()
    let second = await claimNext()
    assert.deepEqual(second.kind === 'review' && second.reuse, { head: HEAD1, key: KEY })
    let unchanged = { level: 'lite', base: BASE, head: HEAD2, of: HEAD1, diffHash: '0123456789abcdef', reuseKey: KEY }
    assert.equal((await call(`/api/runner/jobs/${second.id}/result`, token, { outcome: 'unchanged', attempt: 1, unchanged })).status, 204)
    await publisher.stop()

    assert.equal(fake.state.reviews.length, 2, 'the copy is posted as a review of its own')
    assert.equal(fake.state.reviews[1]!.commitId, HEAD2)
    assert.doesNotMatch(fake.state.pr.body, /Aucun fichier relu n'a changé/)
    let [, row] = await rows()
    assert.equal(Number(row!.githubReviewId), fake.state.reviews[1]!.id)
    assert.notEqual(Number(row!.githubReviewId), posted!.id)
    let [stored] = await database.sql<{ reused: boolean }[]>`select result ? 'reusedFrom' as reused from reviews where head_sha = ${HEAD2}`
    assert.equal(stored!.reused, false, 'the row is a review of its own: the next copy takes it as its source')

    // REV-101. The next unchanged push copies that review: it stands (it carries no `same-as`
    // marker), and HEAD3 gets a copy without comments, not a third full review.
    const HEAD3 = '3'.repeat(40)
    fake.state.commits[HEAD3] = 'merge main again'
    fake.state.pr.head = HEAD3
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD3}, 'main')`
    publisher = newPublisher()
    let third = await claimNext()
    assert.deepEqual(third.kind === 'review' && third.reuse, { head: HEAD2, key: KEY })
    let again = { level: 'lite', base: BASE, head: HEAD3, of: HEAD2, diffHash: '0123456789abcdef', reuseKey: KEY }
    assert.equal((await call(`/api/runner/jobs/${third.id}/result`, token, { outcome: 'unchanged', attempt: 1, unchanged: again })).status, 204)
    await publisher.stop()
    assert.equal(fake.state.reviews.length, 3)
    let copy = fake.state.reviews[2]!
    assert.equal(copy.commitId, HEAD3)
    assert.equal(copy.comments, 0, 'a copy, not a review of its own')
    assert.match(copy.body, /Même score que le commit `222222222`/)
    assert.match(copy.body, new RegExp(`<!-- kento:same-as ${fake.state.reviews[1]!.id} -->`))
  })

  it('does not publish a copy when a later review of the bot came after its source (REV-89)', async () => {
    const KEY = 'e'.repeat(64)
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let claimNext = async () => {
      let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: ['reuse'] })
      assert.equal(claimed.status, 200)
      return (await claimed.json()) as Job
    }
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD1}, 'main')`
    let first = await claimNext()
    assert.equal(first.kind === 'review' && first.reuse, null, 'no review yet')
    let done = { outcome: 'done', attempt: 1, review: review({ reuseKey: KEY, diffHash: '0123456789abcdef', cachedTokens: 600 }) }
    assert.equal((await call(`/api/runner/jobs/${first.id}/result`, token, done)).status, 204)
    await publisher.stop()
    let [posted] = fake.state.reviews

    // A later review of the bot (a command) is posted on the pull request, then main is merged.
    let later = fake.addReview({ state: 'COMMENTED', commitId: HEAD1 })
    fake.state.pr.head = HEAD2
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD2}, 'main')`
    publisher = newPublisher()
    let second = await claimNext()
    assert.deepEqual(second.kind === 'review' && second.reuse, { head: HEAD1, key: KEY })
    let unchanged = { level: 'lite', base: BASE, head: HEAD2, of: HEAD1, diffHash: '0123456789abcdef', reuseKey: KEY }
    assert.equal((await call(`/api/runner/jobs/${second.id}/result`, token, { outcome: 'unchanged', attempt: 1, unchanged })).status, 204)
    await publisher.stop()

    assert.deepEqual(fake.state.reviews.map((r) => r.id), [posted!.id, later], 'no review posted for the copy')
    assert.doesNotMatch(fake.state.pr.body, /Aucun fichier relu n'a changé/, 'the block of the later review stays')
    // The later review was of HEAD1: HEAD2 still gets its check, once.
    assert.deepEqual(fake.state.checkRuns.map((c) => c.head_sha), [HEAD1, HEAD2], 'the new head is not left without a check')
    let [, row] = await rows()
    assert.ok(row!.publishedAt)
    assert.equal(row!.githubReviewId, null, 'not published, on purpose')
  })

  it('uses no try of a reused review when GitHub fails to list the reviews (REV-89)', async () => {
    const KEY = 'e'.repeat(64)
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let claimNext = async () => {
      let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: ['reuse'] })
      assert.equal(claimed.status, 200)
      return (await claimed.json()) as Job
    }
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD1}, 'main')`
    let first = await claimNext()
    assert.equal(first.kind === 'review' && first.reuse, null, 'no review yet')
    let done = { outcome: 'done', attempt: 1, review: review({ reuseKey: KEY, diffHash: '0123456789abcdef', cachedTokens: 600 }) }
    assert.equal((await call(`/api/runner/jobs/${first.id}/result`, token, done)).status, 204)
    await publisher.stop()
    let [posted] = fake.state.reviews

    // A merge of main, while GitHub fails to list the reviews more times than a review has tries.
    fake.state.pr.head = HEAD2
    fake.state.failReviewLists = 4
    await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEAD2}, 'main')`
    publisher = newPublisher()
    let second = await claimNext()
    assert.deepEqual(second.kind === 'review' && second.reuse, { head: HEAD1, key: KEY })
    let unchanged = { level: 'lite', base: BASE, head: HEAD2, of: HEAD1, diffHash: '0123456789abcdef', reuseKey: KEY }
    assert.equal((await call(`/api/runner/jobs/${second.id}/result`, token, { outcome: 'unchanged', attempt: 1, unchanged })).status, 204)
    await publisher.stop()
    for (let i = 0; i < 4; i++) await publisher.publishPending()

    assert.equal(fake.state.failReviewLists, 0)
    assert.deepEqual(fake.state.reviews.map((r) => r.commitId), [HEAD1, HEAD2], 'one review on the new head')
    assert.match(fake.state.pr.body, /Aucun fichier relu n'a changé depuis le commit `111111111`/)
    let [, row] = await rows()
    assert.ok(row!.publishedAt, 'published after the failures, its tries intact')
    assert.equal(Number(row!.githubReviewId), posted!.id)
  })

  it('says in the review which assignment rule set its level, and mentions the person of the rule (REV-21)', async () => {
    let assignment = { ruleId: 'r2', position: 2, level: 'heavy', mention: 'alex', reasons: { path: 'db/migrations/0002.sql' }, trigger: 'push' }
    await runJob(HEAD1, review(), { repoConfigVersion: 0, models: null, source: 'kento', assignment })
    await publisher.stop()
    let [posted] = fake.state.reviews
    assert.match(posted!.body, /<sub>Assignation : règle 2, la PR touche db\/migrations\/0002\.sql, donc heavy à chaque push\.<\/sub>\n\nRelecture demandée par la règle : @alex/)
    // The hidden marker of the review stays last.
    assert.match(posted!.body, /@alex\n\n<!-- kento:review [0-9a-f-]+ -->$/)
  })

  it('says in the review which rules with paths GitHub kept from being tested (REV-21)', async () => {
    await runJob(HEAD1, review(), { repoConfigVersion: 0, models: null, source: 'kento', assignmentUnread: [1, 3] })
    await publisher.stop()
    assert.match(fake.state.reviews[0]!.body, /<sub>Assignation : sans la liste des fichiers de la PR, les règles 1, 3 \(chemins\) n’ont pas pu être testées\.<\/sub>/)
  })

  it('says nothing of an assignment for the review of a job without one', async () => {
    await runJob(HEAD1, review())
    await publisher.stop()
    assert.doesNotMatch(fake.state.reviews[0]!.body, /Assignation|Relecture demandée/)
  })

  it('does not post twice a review whose row could not be marked, after a restart', async () => {
    await runJob(HEAD1, review())
    await publisher.stop()
    let [before] = await rows()
    // The write of published_at failed after the review was posted, then the process restarted.
    await database.sql`update reviews set published_at = null, github_review_id = null`

    let [result] = await newPublisher().publishPending()

    assert.equal(result!.kind, 'published')
    assert.equal(fake.state.reviews.length, 1, 'no second review')
    let [after] = await rows()
    assert.ok(after!.publishedAt)
    assert.equal(after!.githubReviewId, before!.githubReviewId)
  })

  it('marks a row on the next pass of the same process when its first mark failed', async () => {
    // The write of published_at fails once, as on a lost connection, after the review is posted.
    await database.sql.unsafe(`
      create table fail_mark (id int);
      insert into fail_mark values (1);
      create function fail_mark() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from fail_mark) and new.published_at is not null then
          raise exception 'connection lost';
        end if;
        return new;
      end $$;
      create trigger fail_mark before update on reviews for each row execute function fail_mark();`)
    try {
      await runJob(HEAD1, review())
      await publisher.stop()
      let [unmarked] = await rows()
      assert.equal(unmarked!.publishedAt, null)
      assert.equal(fake.state.reviews.length, 1)

      await database.sql`delete from fail_mark`
      let [result] = await publisher.publishPending()

      assert.equal(result!.kind, 'published')
      assert.equal(fake.state.reviews.length, 1, 'no second review')
      let [marked] = await rows()
      assert.ok(marked!.publishedAt)
      assert.equal(Number(marked!.githubReviewId), fake.state.reviews[0]!.id)
    } finally {
      await database.sql.unsafe('drop trigger fail_mark on reviews; drop function fail_mark(); drop table fail_mark')
    }
  })

  it('does not let the rows it gave up on hold the limit of a pass', async () => {
    // 21 reviews of a pull request that GitHub does not know: each try fails.
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref, state)
      values (${repoId}, 'lite', 99, ${HEAD1}, 'main', 'done') returning id`
    for (let i = 0; i < 21; i++) {
      let [other] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, base_ref, state)
        values (${repoId}, 'lite', 99, ${HEAD1}, 'main', 'done') returning id`
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, created_at)
        values (${other!.id}, ${repoId}, 99, ${HEAD1}, 2, 'm', ${JSON.stringify(review())}::jsonb, now() - interval '10 minutes')`
    }
    assert.ok(job)
    for (let pass = 0; pass < 3; pass++) await publisher.publishPending()

    await runJob(HEAD1, review())
    await publisher.stop()
    await publisher.publishPending()

    assert.equal(fake.state.reviews.length, 1, 'the recent review is published')
  })

  it('does not publish the review of a head that a newer push replaced, nor on a closed pull request', async () => {
    fake.state.pr.head = HEAD2
    await runJob(HEAD1, review())
    await publisher.stop()
    fake.state.pr.head = HEAD1
    fake.state.pr.state = 'closed'
    publisher = newPublisher()
    await runJob(HEAD1, review())
    await publisher.stop()

    assert.equal(fake.state.reviews.length, 0)
    assert.equal(fake.state.pr.body, 'Description de la PR.')
    for (let row of await rows()) {
      assert.ok(row.publishedAt, 'a skipped review is not tried again')
      assert.equal(row.githubReviewId, null)
    }
  })

  it('posts the review without the check when the App has no checks permission', async () => {
    fake.state.appPermissions.delete('checks')
    await runJob(HEAD1, review())
    await publisher.stop()

    assert.equal(fake.state.reviews.length, 1)
    assert.equal(fake.state.checkRuns.length, 0)
    assert.deepEqual(fake.state.pr.labels, ['review: 2/5'])
  })

  it('tries a review again after a failure before it is posted, three times at most', async () => {
    fake.state.appPermissions.delete('pull_requests')
    await runJob(HEAD1, review())
    await publisher.stop()
    let results = [...(await publisher.publishPending()), ...(await publisher.publishPending()), ...(await publisher.publishPending())]
    assert.deepEqual(
      results.map((r) => r.kind),
      ['failed', 'failed'],
      'the wake was the first try',
    )
    let [row] = await rows()
    assert.equal(row!.publishedAt, null)

    // A new process tries again, and GitHub now gives the token.
    fake.state.appPermissions.add('pull_requests')
    publisher = newPublisher()
    let [result] = await publisher.publishPending()
    assert.equal(result!.kind, 'published')
    assert.equal(fake.state.reviews.length, 1)
  })

  it('publishes a review once when two publishers run at the same time', async () => {
    fake.state.appPermissions.delete('pull_requests')
    await runJob(HEAD1, review())
    await publisher.stop()
    fake.state.appPermissions.add('pull_requests')

    let other = newPublisher()
    await Promise.all([newPublisher().publishPending(), other.publishPending(), newPublisher().publishPending()])

    assert.equal(fake.state.reviews.length, 1)
    assert.equal(fake.botThreads().length, 1)
  })

  it('leaves a review older than 30 minutes, and the reviews of a suspended installation', async () => {
    fake.state.appPermissions.delete('pull_requests')
    await runJob(HEAD1, review())
    await publisher.stop()
    fake.state.appPermissions.add('pull_requests')
    await database.sql`update reviews set created_at = now() - interval '31 minutes'`
    assert.deepEqual(await newPublisher().publishPending(), [])

    await database.sql`update reviews set created_at = now()`
    await database.sql`update orgs set suspended_at = now()`
    let [result] = await newPublisher().publishPending()
    assert.equal(result!.kind, 'skipped')
    assert.equal(fake.state.reviews.length, 0)
  })

  it('does not wake the publisher for a failed job', async () => {
    await database.sql`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref)
      values (${repoId}, 'lite', ${PR}, ${HEAD1}, 'main')`
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-2', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let job: Job = await (await call('/api/runner/jobs/claim', token, { hasProviderKey: true })).json()
    let response = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'failed', attempt: job.attempt, reason: 'clone failed' })
    assert.equal(response.status, 204)
    assert.equal(woken, 0)
  })
})
