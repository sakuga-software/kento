// The commands of the comments (REV-7), from the signed `issue_comment` webhook to the job in
// Postgres and the reactions on the comment. Postgres is real; GitHub is the fake of
// test/fake-github.ts: it makes the installation tokens, gives the pull request and the permission
// of the commenter, and keeps the reactions and the comments of the bot.
import { generateKeyPairSync } from 'node:crypto'

import { findingKey } from '@kento-review/engine/findings'
import type { Job, ReviewPayload } from '@kento-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createCommandHandler, findRejectTarget } from '../../app/commands/handler.ts'
import { HINT_MARKER } from '../../app/commands/hint.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { createInstallationTokenMinter, readPrivateKey } from '../../app/github/installation-token.ts'
import { headSha, issueCommentPayload, pullRequestPayload, REPO, reviewCommentPayload, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { createPublisher } from '../../app/publish/publisher.ts'
import { createAppRouter } from '../../app/router.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { BOT, createFakeGitHub, type FakeGitHub } from '../fake-github.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

const REGISTRATION_TOKEN = 'registration-token-for-the-tests-0123456789'
const HEAD = headSha(0xabc)
const PR = 28
const DOCS_URL = 'https://review.sakuga.dev/docs/commands'

let pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

interface JobRow {
  kind: string
  level: string
  state: string
  headSha: string
  baseRef: string
  commentId: string | null
  answeredAt: Date | null
}

describe('commands in the comments of a pull request', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let fake: FakeGitHub
  let delivery = 0
  let comment = 9000
  /** REV-94. The database of the command handler, when a test makes it fail. */
  let commandSql: Database['sql'] | null = null

  function mint() {
    return createInstallationTokenMinter({ appId: '12345', privateKey: readPrivateKey(pem), apiUrl: fake.apiUrl, fetch: fake.fetch })
  }

  function router() {
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 5 }),
      version: 'test',
      commit: null,
      webhook: {
        secret: TEST_SECRET,
        trustedBotsFor: async () => new Set(['sakuga-agent[bot]']),
        botLogin: BOT,
        apply: createWebhookStore(database.db, {
          handleCommentCommand: createCommandHandler({
            db: database.db,
            sql: commandSql ?? database.sql,
            botLogin: BOT,
            mintInstallationToken: mint(),
            apiUrl: fake.apiUrl,
            fetch: fake.fetch,
            docsUrl: DOCS_URL,
          }),
        }),
      },
      runner: {
        store: createRunnerStore(database.sql),
        registrationToken: REGISTRATION_TOKEN,
        mintInstallationToken: mint(),
        providerApiKey: null,
        claimWaitMs: 0,
        githubApiUrl: fake.apiUrl,
        fetch: fake.fetch,
      },
    })
  }

  function nextDelivery(): string {
    delivery++
    return `00000000-0000-0000-0000-${delivery.toString().padStart(12, '0')}`
  }

  /** Posts a comment as GitHub delivers it. Returns the status, the body and the delivery, to replay it. */
  async function say(body: string, options: Parameters<typeof issueCommentPayload>[0] & { deliveryId?: string } = {}) {
    let payload = issueCommentPayload({ body, commentId: options.commentId ?? ++comment, ...options })
    let deliveryId = options.deliveryId ?? nextDelivery()
    let response = await router().fetch(signedRequest(payload, { event: 'issue_comment', deliveryId }))
    return { status: response.status, body: await response.json().catch(() => null), payload, deliveryId }
  }

  async function replay(payload: unknown, deliveryId: string) {
    let response = await router().fetch(signedRequest(payload, { event: 'issue_comment', deliveryId }))
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  function jobs() {
    return database.sql<JobRow[]>`
      select kind, level, state, head_sha as "headSha", base_ref as "baseRef",
        github_comment_id as "commentId", command_answered_at as "answeredAt"
      from jobs order by created_at, id`
  }

  const reactionsOf = (id: number) => [...fake.state.reactions].filter((r) => r.startsWith(`${id}:`)).map((r) => r.split(':')[1]).sort()
  const permissionCalls = () => fake.state.calls.filter((c) => c.path.includes('/collaborators/'))

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 8 })
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  beforeEach(async () => {
    await database.sql`truncate orgs, repos, runners, jobs, reviews cascade`
    await seedEnabledRepo(database.sql)
    fake = createFakeGitHub({ head: HEAD, pr: PR, repoId: REPO.id })
    commandSql = null
    fake.state.permissions.set('octocat', 'admin')
    fake.state.permissions.set('writer', 'write')
    fake.state.permissions.set('maintainer', 'maintain')
    fake.state.permissions.set('reader', 'read')
    fake.state.permissions.set('triager', 'triage')
  })

  it('1. `@kento-review review heavy` queues a heavy review of the current head, and answers 👀', async () => {
    let { status, body, payload } = await say('@kento-review review heavy')
    assert.equal(status, 202)
    assert.equal(body.outcome, 'queued')
    let rows = await jobs()
    assert.equal(rows.length, 1)
    assert.deepEqual(
      { ...rows[0], commentId: Number(rows[0]!.commentId) },
      { kind: 'review', level: 'heavy', state: 'queued', headSha: HEAD, baseRef: 'main', commentId: payload.comment.id, answeredAt: null },
    )
    assert.deepEqual(reactionsOf(payload.comment.id), ['eyes'])
    assert.equal(fake.state.issueComments.length, 0)
    // The token of the handler can read the pull request and react; it cannot read the code.
    let token = fake.state.tokens.at(0)!
    assert.deepEqual(token.permissions, { pull_requests: 'write', issues: 'write' })
    assert.deepEqual(token.repositoryIds, [REPO.id])
  })

  it('2. `@sakuga-review` is an alias, and the name alone asks for a lite review', async () => {
    assert.equal((await say('@sakuga-review review balanced')).body.outcome, 'queued')
    assert.equal((await say('@kento-review')).body.outcome, 'queued')
    assert.deepEqual((await jobs()).map((j) => j.level), ['balanced', 'lite'])
  })

  it('3. a redelivery, or a replay with a new delivery id, creates no second job', async () => {
    let first = await say('@kento-review review heavy')
    assert.equal((await replay(first.payload, first.deliveryId)).body.outcome, 'duplicate')
    assert.equal((await replay(first.payload, nextDelivery())).body.outcome, 'duplicate')
    assert.equal((await jobs()).length, 1)
    assert.deepEqual(reactionsOf(first.payload.comment.id), ['eyes'])
  })

  it('4. a heavy asked twice on the same head is paid once; `force` pays again', async () => {
    let first = await say('@kento-review review heavy')
    let second = await say('@kento-review review heavy')
    assert.equal(second.body.outcome, 'refused')
    assert.equal(second.body.reason, 'head already has a review at this level')
    assert.deepEqual(reactionsOf(second.payload.comment.id), ['confused'])
    assert.equal(fake.state.issueComments.length, 1)
    assert.match(fake.state.issueComments[0]!.body, /@octocat .*already has a `heavy` review.*@kento-review heavy force/s)

    // The replay of the refused comment posts no second reply.
    await replay(second.payload, nextDelivery())
    assert.equal(fake.state.issueComments.length, 1)

    let forced = await say('@kento-review review heavy force')
    assert.equal(forced.body.outcome, 'queued')
    assert.deepEqual((await jobs()).map((j) => j.level), ['heavy', 'heavy'])
    assert.deepEqual(reactionsOf(first.payload.comment.id), ['eyes'])
  })

  it('5. another level, or a new head, is not a repeat; a failed review does not count', async () => {
    await say('@kento-review review heavy')
    assert.equal((await say('@kento-review review balanced')).body.outcome, 'queued')
    fake.state.pr.head = headSha(0xdef)
    assert.equal((await say('@kento-review review heavy')).body.outcome, 'queued')
    await database.sql`update jobs set state = 'failed', finished_at = now() where head_sha = ${headSha(0xdef)}`
    assert.equal((await say('@kento-review review heavy')).body.outcome, 'queued')
    assert.equal((await jobs()).length, 4)
  })

  it('6. the lite review of the push counts: `@kento-review review` on the same head is refused', async () => {
    let push = pullRequestPayload({ action: 'synchronize', number: PR, head: HEAD })
    let pushed = await router().fetch(signedRequest(push, { deliveryId: nextDelivery() }))
    assert.equal(pushed.status, 202)
    assert.equal((await say('@kento-review review')).body.outcome, 'refused')
    assert.equal((await jobs()).length, 1)
  })

  it('6b. a copy published without a review on the head does not count; a copy with one does (REV-101)', async () => {
    let push = pullRequestPayload({ action: 'synchronize', number: PR, head: HEAD })
    assert.equal((await router().fetch(signedRequest(push, { deliveryId: nextDelivery() }))).status, 202)
    let [job] = await database.sql<{ id: string; repoId: string }[]>`select id, repo_id as "repoId" from jobs`
    await database.sql`update jobs set state = 'done', finished_at = now() where id = ${job!.id}`
    // The copy of an earlier review, published by a release before REV-101: no review on the head.
    let copy = { reusedFrom: { reviewId: '00000000-0000-0000-0000-000000000000', head: headSha(0x111), githubReviewId: 41 } }
    await database.sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at, github_review_id)
      values (${job!.id}, ${job!.repoId}, ${PR}, ${HEAD}, 4, 'm', 0, ${JSON.stringify(copy)}::jsonb, now(), 41)`
    assert.equal((await say('@kento-review review')).body.outcome, 'queued', 'the head has no score: the command reviews it')

    // A copy that has its review on the head counts, as any review of this level.
    await database.sql`delete from jobs where id <> ${job!.id}`
    await database.sql`update reviews set result = result || '{"headReviewId": 42}'::jsonb`
    assert.equal((await say('@kento-review review')).body.outcome, 'refused')
  })

  it('7. only a person who can write gives a command: no job, no reaction, no reply for the others', async () => {
    for (let login of ['reader', 'triager', 'stranger']) {
      let { body, payload } = await say('@kento-review review heavy', { user: { login, type: 'User' } })
      assert.deepEqual(body, { outcome: 'refused', reason: 'commenter cannot write to the repository' })
      assert.deepEqual(reactionsOf(payload.comment.id), [])
    }
    // An unknown command of a reader gets no list either.
    assert.equal((await say('@kento-review frobnicate', { user: { login: 'reader', type: 'User' } })).body.outcome, 'refused')
    assert.equal(fake.state.issueComments.length, 0)
    assert.equal((await jobs()).length, 0)

    for (let login of ['writer', 'maintainer']) {
      assert.equal((await say(`@kento-review review ${login === 'writer' ? 'lite' : 'balanced'}`, { user: { login, type: 'User' } })).body.outcome, 'queued')
    }
  })

  it('8. a bot of KENTO_TRUSTED_BOTS commands without a permission call; another bot never reaches GitHub', async () => {
    let agent = await say('@kento-review review balanced', { user: { login: 'sakuga-agent[bot]', type: 'Bot' } })
    assert.equal(agent.body.outcome, 'queued')
    assert.equal(permissionCalls().length, 0)

    let calls = fake.state.calls.length
    let other = await say('@kento-review review heavy', { user: { login: 'dependabot[bot]', type: 'Bot' } })
    assert.equal(other.status, 202)
    assert.equal(other.body.outcome, 'ignored')
    let own = await say('@kento-review review heavy', { user: { login: BOT, type: 'Bot' } })
    assert.equal(own.body.reason, 'comment of the App itself')
    assert.equal(fake.state.calls.length, calls)
    assert.equal((await jobs()).length, 1)
  })

  it('9. an unknown command gets 😕 and the list of the commands, once', async () => {
    let { body, payload, deliveryId } = await say('@kento-review frobnicate')
    assert.deepEqual(body, { outcome: 'refused', reason: 'unknown command' })
    assert.deepEqual(reactionsOf(payload.comment.id), ['confused'])
    assert.equal(fake.state.issueComments.length, 1)
    assert.match(fake.state.issueComments[0]!.body, /`@kento-review frobnicate` is not a Kentō command/)
    assert.match(fake.state.issueComments[0]!.body, /@kento-review \[lite\|balanced\|heavy\]/)
    await replay(payload, deliveryId)
    assert.equal(fake.state.issueComments.length, 1)
    assert.equal((await jobs()).length, 0)
  })

  it('10. a pull request from a fork, or from a deleted fork, gets no job', async () => {
    fake.state.pr.headRepoId = 9999
    let fork = await say('@kento-review review heavy')
    assert.deepEqual(fork.body, { outcome: 'refused', reason: 'pull request from a fork' })
    assert.deepEqual(reactionsOf(fork.payload.comment.id), ['confused'])
    assert.match(fake.state.issueComments[0]!.body, /fork/)
    fake.state.pr.headRepoId = null
    assert.equal((await say('@kento-review review heavy')).body.reason, 'pull request from a fork')
    assert.equal((await jobs()).length, 0)
  })

  it('11. a pull request closed since the comment, or a repository that is not enabled, gets no job', async () => {
    fake.state.pr.state = 'closed'
    assert.deepEqual((await say('@kento-review review heavy')).body, { outcome: 'skipped', reason: 'pull request is closed' })

    let calls = fake.state.calls.length
    let other = { ...REPO, id: 4001, full_name: 'sakuga-software/fruitback' }
    // No row (Kentō does not know it), then a row that is not enabled: no token, no reaction, no reply.
    let outside = await say('@sakuga-review review heavy', { repo: other })
    assert.equal(outside.body.outcome, 'skipped')
    assert.match(outside.body.reason, /workflow keeps the command/)
    await database.sql`update repos set enabled = false`
    let disabled = await say('@kento-review review heavy')
    assert.deepEqual(disabled.body, { outcome: 'skipped', reason: 'repository is not enabled: the workflow keeps the command' })
    assert.equal(fake.state.calls.length, calls)
    assert.equal((await jobs()).length, 0)
  })

  it('12. two identical commands at the same time: one job, one refusal', async () => {
    let [a, b] = await Promise.all([say('@kento-review review heavy'), say('@kento-review review heavy')])
    assert.deepEqual([a.body.outcome, b.body.outcome].sort(), ['queued', 'refused'])
    assert.equal((await jobs()).length, 1)
  })

  it('13. `resolve` queues one resolve job; a second one waits until the first ends', async () => {
    let { body, payload } = await say('@sakuga-review resolve balanced')
    assert.equal(body.outcome, 'queued')
    assert.deepEqual(reactionsOf(payload.comment.id), ['eyes'])
    let again = await say('@kento-review resolve')
    assert.deepEqual(again.body, { outcome: 'refused', reason: 'a resolve of the pull request is already running' })
    assert.match(fake.state.issueComments.at(-1)!.body, /already queued or in progress/)
    await database.sql`update jobs set state = 'done', finished_at = now()`
    assert.equal((await say('@kento-review resolve')).body.outcome, 'queued')
    assert.deepEqual((await jobs()).map((j) => [j.kind, j.level]), [['resolve', 'balanced'], ['resolve', 'lite']])
  })

  it('14. a GitHub error fails the delivery (500), so that GitHub can send it again', async () => {
    fake.state.permissions.clear()
    let failing = fake.fetch
    fake.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/collaborators/') ? new Response('{}', { status: 502 }) : failing(input, init)) as typeof fetch
    let { status } = await say('@kento-review review heavy')
    assert.equal(status, 500)
    assert.equal((await jobs()).length, 0)
  })

  it('14b. a reply that fails takes its 😕 back, so that the redelivery replies', async () => {
    fake.state.failIssueComments = 1
    let first = await say('@kento-review frobnicate')
    assert.equal(first.status, 500)
    assert.deepEqual(reactionsOf(first.payload.comment.id), [])
    assert.equal(fake.state.issueComments.length, 0)

    let again = await replay(first.payload, first.deliveryId)
    assert.equal(again.body.outcome, 'refused')
    assert.deepEqual(reactionsOf(first.payload.comment.id), ['confused'])
    assert.equal(fake.state.issueComments.length, 1)
  })

  describe('the end of the job', () => {
    // One router for every request of a test, as in the server: it keeps its tokens (REV-92).
    // Null: a new router for each request.
    let app: ReturnType<typeof router> | null = null
    beforeEach(() => {
      app = null
    })

    async function call(path: string, token: string, body: unknown) {
      return (app ?? router()).fetch(
        new Request(new URL(path, 'http://localhost'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
      )
    }

    async function claim(): Promise<{ job: Job; token: string }> {
      let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
      let { token } = await registered.json()
      let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true })
      assert.equal(claimed.status, 200)
      return { job: await claimed.json(), token }
    }

    async function claimWith(body: unknown): Promise<{ status: number; job: Job | null; token: string }> {
      let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-2', labels: [], version: '0.2.0' })
      let { token } = await registered.json()
      let claimed = await call('/api/runner/jobs/claim', token, body)
      return { status: claimed.status, job: claimed.status === 200 ? await claimed.json() : null, token }
    }

    function publisher(publicUrl?: URL) {
      return createPublisher({ sql: database.sql, mintInstallationToken: mint(), apiUrl: fake.apiUrl, botLogin: BOT, fetch: fake.fetch, publicUrl })
    }

    it('15. the review of a command is published, then the comment gets 🚀 (end to end)', async () => {
      let { payload } = await say('@kento-review review heavy')
      let { job, token } = await claim()
      assert.equal(job.level, 'heavy')
      assert.equal(job.pullRequest.headSha, HEAD)
      // REV-71. A runner without the feature `threads` gets no key that it does not know.
      assert.equal('threads' in job, false)
      let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: review() })
      assert.equal(stored.status, 204)

      let results = await publisher().publishPending()
      assert.equal(results[0]?.kind, 'published')
      assert.equal(fake.state.reviews.length, 1)
      assert.deepEqual(reactionsOf(payload.comment.id), ['eyes', 'rocket'])
      assert.notEqual((await jobs())[0]!.answeredAt, null)

      // The next run reacts no more.
      let reactions = fake.state.calls.filter((c) => c.path.endsWith('/reactions')).length
      await publisher().publishPending()
      assert.equal(fake.state.calls.filter((c) => c.path.endsWith('/reactions')).length, reactions)
    })

    it('15b. REV-94: a review published with one blocking finding, then `reject` in its thread: the key of the ledger matches, the review is dismissed (end to end)', async () => {
      fake.state.canResolve = true
      await say('@kento-review review heavy')
      let { job, token } = await claim()
      let finding = {
        path: 'src/sum.ts', start_line: 4, line: 4, severity: 'major', category: 'bug', confidence: 90,
        title: 'The sum subtracts', scenario: 'sum(1, 2) gives -1.', fix: 'a + b', suggestion: '',
        anchor: 4, blocking: true, suggestion_range: null,
      }
      let payload = { ...review(), score: 2, verdict: 'REQUEST_CHANGES', findings: [finding] }
      let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: payload })
      assert.equal(stored.status, 204)
      assert.equal((await publisher().publishPending())[0]?.kind, 'published')
      let posted = fake.state.reviews.at(-1)!
      assert.equal(posted.state, 'CHANGES_REQUESTED')
      let [row] = await database.sql<{ key: string; commentId: number }[]>`select key, github_comment_id::float8 as "commentId" from findings`
      assert.ok(row && row.commentId)

      let command = reviewCommentPayload({ body: '@kento-review reject false positive: sum subtracts on purpose', inReplyTo: row.commentId, commentId: ++comment })
      let response = await router().fetch(signedRequest(command, { event: 'pull_request_review_comment', deliveryId: nextDelivery() }))
      let body = await response.json()
      assert.equal(body.outcome, 'dismissed')
      assert.equal(body.dismissedReview, posted.id)
      assert.equal(posted.state, 'DISMISSED')
    })

    it('16. a job of a command that fails gets 😕, once', async () => {
      let { payload } = await say('@kento-review review heavy')
      let { job, token } = await claim()
      let failed = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'failed', attempt: job.attempt, reason: 'clone failed' })
      assert.equal(failed.status, 204)
      // REV-6 queues a failed attempt again while attempts remain; the test ends the job.
      await database.sql`update jobs set state = 'failed', finished_at = now() where id = ${job.id}`

      await publisher().publishPending()
      assert.deepEqual(reactionsOf(payload.comment.id), ['confused', 'eyes'])
      assert.notEqual((await jobs())[0]!.answeredAt, null)
      let reactions = fake.state.calls.filter((c) => c.path.endsWith('/reactions')).length
      await publisher().publishPending()
      assert.equal(fake.state.calls.filter((c) => c.path.endsWith('/reactions')).length, reactions)
    })

    it('17. a review of a command that a newer push superseded is not published, and gets 😕', async () => {
      let { payload } = await say('@kento-review review heavy')
      let { job, token } = await claim()
      await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: review() })
      fake.state.pr.head = headSha(0xfff)
      let results = await publisher().publishPending()
      assert.deepEqual(results[0], { kind: 'skipped', reviewId: results[0]!.reviewId, reason: 'superseded' })
      assert.deepEqual(reactionsOf(payload.comment.id), ['confused', 'eyes'])
    })

    describe('resolve', () => {
      const OLD = headSha(0x111)
      let botFixed = 0
      let personAnswered = 0
      let botAnswered = 0

      beforeEach(() => {
        botFixed = fake.addThread({ path: 'src/sum.ts', line: 2, body: '**The sum subtracts** <!-- sakuga-review:finding abc -->', commit: OLD })
        personAnswered = fake.addThread({ path: 'src/a.ts', line: 5, body: 'Why this name?', commit: OLD, author: 'octocat' })
        botAnswered = fake.addThread({ path: 'src/b.ts', line: 9, body: '**A missed case** <details>long</details>', commit: HEAD })
        fake.state.canResolve = true
        fake.state.resolveNeedsWrite = true
      })

      function resolved(head = HEAD) {
        return {
          level: 'lite' as const,
          head,
          model: 'anthropic/claude-haiku-5.5',
          provider: 'Anthropic',
          costUsd: 0.004,
          promptTokens: 900,
          completionTokens: 100,
          open: 3,
          waiting: 3,
          held: 3,
          threads: [
            { id: `PRRT_${botFixed}`, verdict: 'fixed' as const, reply: 'Fixed: `+` is back.', changed: true },
            { id: `PRRT_${personAnswered}`, verdict: 'answered' as const, reply: 'The name follows the module.', changed: false },
            { id: `PRRT_${botAnswered}`, verdict: 'answered' as const, reply: 'The test covers the case.', changed: false },
          ],
        }
      }

      it('18. end to end: the service reads the threads, the runner answers, the service replies and resolves, then 🚀', async () => {
        let { payload } = await say('@sakuga-review resolve')
        // A runner of an earlier release does not say what it runs: it gets no resolve job.
        let old = await claimWith({ hasProviderKey: true })
        assert.equal(old.status, 204)

        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['review', 'resolve'] })
        assert.ok(job && job.kind === 'resolve')
        assert.equal(job.pullRequest.headSha, HEAD)
        assert.deepEqual({ open: job.resolve.open, waiting: job.resolve.waiting }, { open: 3, waiting: 3 })
        assert.deepEqual(job.resolve.threads.map((t) => [t.id, t.comments[0]!.isBot]), [
          [`PRRT_${botFixed}`, true],
          [`PRRT_${personAnswered}`, false],
          [`PRRT_${botAnswered}`, true],
        ])
        // The bodies come cleaned: no HTML comment, no <details>.
        assert.equal(job.resolve.threads[0]!.comments[0]!.body, '**The sum subtracts**')
        assert.equal(job.resolve.threads[2]!.comments[0]!.body, '**A missed case**')
        // The runner clones with `contents: read`; the service read the threads with its own token.
        let perms = fake.state.tokens.map((t) => JSON.stringify(t.permissions))
        assert.ok(perms.includes(JSON.stringify({ contents: 'read' })))
        assert.ok(perms.includes(JSON.stringify({ contents: 'read', pull_requests: 'read' })))
        assert.equal(job.installationToken.token.includes('pull_requests'), false)

        let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: resolved() })
        assert.equal(stored.status, 204)
        await publisher().publishPending()

        // The thread of the bot that the code fixed, and the one that a reply settled, are resolved.
        // The thread of a person stays open: an answer of the bot is not enough.
        assert.deepEqual([...fake.state.resolved].sort(), [botFixed, botAnswered].sort())
        assert.match(fake.repliesTo(botFixed)[0]!.body, /Fixed.*\n\nThread resolved\.\n\n<!-- sakuga-review:resolve [0-9a-f]{12} -->/s)
        assert.doesNotMatch(fake.repliesTo(personAnswered)[0]!.body, /Thread resolved/)
        let summary = fake.state.issueComments.at(-1)!.body
        assert.match(summary, /Kentō · thread resolution\*\* at commit/)
        assert.match(summary, /^- resolved · \[`src\/sum.ts:2`\]/m)
        assert.match(summary, /^- stays open · \[`src\/a.ts:5`\].* · octocat/m)
        assert.doesNotMatch(summary, /\p{Extended_Pictographic}/u)
        assert.match(summary, /Kentō · Level `lite` · `anthropic\/claude-haiku-5.5` · \$0\.004/)
        assert.deepEqual(reactionsOf(payload.comment.id), ['eyes', 'rocket'])
        // Only the publication asked for `contents: write`, for this repository.
        let writers = fake.state.tokens.filter((t) => t.permissions.contents === 'write')
        assert.equal(writers.length, 1)
        assert.deepEqual(writers[0]!.repositoryIds, [REPO.id])

        // Published once: a second pass posts nothing.
        let comments = fake.state.comments.length + fake.state.issueComments.length
        await publisher().publishPending()
        assert.equal(fake.state.comments.length + fake.state.issueComments.length, comments)

        // A new resolve at the same head finds the open thread already answered: no model call needed.
        await say('@kento-review resolve')
        let next = await claimWith({ hasProviderKey: true, kinds: ['review', 'resolve'] })
        assert.ok(next.job && next.job.kind === 'resolve')
        assert.deepEqual({ threads: next.job.resolve.threads.length, open: next.job.resolve.open, waiting: next.job.resolve.waiting }, { threads: 0, open: 1, waiting: 0 })
      })

      it('18h. REV-116: a thread of a finding that the model calls `answered` gets the hint of `reject` once, claimed in the database', async () => {
        let commentId = fake.addThread({ path: 'src/c.ts', line: 4, body: '**The value is not checked** `#5cf454`', commit: OLD })
        fake.state.comments.push({ id: 95_000, reviewId: null, path: 'src/c.ts', line: 4, body: "C'est un faux positif, la fonction vérifie déjà le null.", commit: OLD, author: 'writer', inReplyTo: commentId })
        let [finding] = await database.sql<{ id: string }[]>`
          insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
            first_seen_sha, last_seen_sha, github_comment_id, github_thread_id)
          select id, ${PR}, 'fp-5cf454', '5cf454aa0011', 'src/c.ts', 4, 'The value is not checked', 'major', 'bug', 90, 'open',
            ${OLD}, ${OLD}, ${commentId}, ${`PRRT_${commentId}`}
          from repos where github_repo_id = ${REPO.id}
          returning id`
        const hintsOf = (id: number) => fake.repliesTo(id).filter((c) => c.body.includes(HINT_MARKER))

        let hintBody = ''
        for (let round = 0; round < 2; round++) {
          let head = round === 0 ? HEAD : headSha(0xdef)
          if (round === 1) {
            // A person opens the thread again and deletes the hint: only the claim in the database is left.
            assert.ok(fake.state.resolved.has(commentId), 'the resolve closes the thread of the bot that a reply settled')
            fake.state.resolved.delete(commentId)
            let [hint, ...more] = hintsOf(commentId)
            assert.equal(more.length, 0)
            hintBody = hint!.body
            fake.state.comments.splice(fake.state.comments.indexOf(hint!), 1)
          }
          fake.state.pr.head = head
          await say('@kento-review resolve')
          let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
          assert.ok(job)
          let result = resolved(head)
          result.threads = [...result.threads, { id: `PRRT_${commentId}`, verdict: 'answered' as const, reply: 'The caller checks the null first.', changed: false }]
          await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: result })
          await publisher(new URL('https://review.sakuga.dev')).publishPending()
        }

        assert.deepEqual(hintsOf(commentId), [], 'the second resolve posts no second hint')
        assert.equal(
          hintBody,
          'This reply seems to set the finding aside. To count it as rejected (it will not come back and will not lower the score again), comment ' +
            `\`@kento-review reject <cause>\`. [Kentō commands](${DOCS_URL})\n\n${HINT_MARKER}`,
        )
        let [row] = await database.sql<{ claimed: boolean; status: string }[]>`select reject_hint_at is not null as claimed, status from findings where id = ${finding!.id}`
        assert.deepEqual({ ...row }, { claimed: true, status: 'open' })
        // A thread of the bot without a finding row, and a thread of a person, get no hint.
        assert.deepEqual([...hintsOf(botAnswered), ...hintsOf(personAnswered)], [])
      })

      it('18k. KNT-192: a fix that the resolve confirms makes its finding `fixed`, from open or stale; a dismissed one stays', async () => {
        let dismissedThread = fake.addThread({ path: 'src/d.ts', line: 3, body: '**Dismissed before**', commit: OLD })
        let openThread = fake.addThread({ path: 'src/e.ts', line: 7, body: '**Still open**', commit: OLD })
        let insert = async (key: string, path: string, line: number, title: string, status: string, reason: string | null, commentId: number) => {
          let [row] = await database.sql<{ id: string }[]>`
            insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
              status_reason, first_seen_sha, last_seen_sha, github_comment_id, github_thread_id)
            select id, ${PR}, ${`fp-${key}`}, ${key}, ${path}, ${line}, ${title}, 'major', 'bug', 90, ${status}::finding_status,
              ${reason}, ${OLD}, ${OLD}, ${commentId}, ${`PRRT_${commentId}`}
            from repos where github_repo_id = ${REPO.id}
            returning id`
          return row!.id
        }
        let stale = await insert('abc000000001', 'src/sum.ts', 2, 'The sum subtracts', 'stale', null, botFixed)
        let dismissed = await insert('def000000001', 'src/d.ts', 3, 'Dismissed before', 'dismissed', 'not a bug', dismissedThread)
        let open = await insert('fed000000001', 'src/e.ts', 7, 'Still open', 'open', null, openThread)

        await say('@kento-review resolve')
        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.ok(job)
        let result = resolved()
        result.threads = [
          ...result.threads,
          { id: `PRRT_${dismissedThread}`, verdict: 'fixed' as const, reply: 'Fixed.', changed: true },
          // The model says fixed, but the file did not change since the thread: not a fix.
          { id: `PRRT_${openThread}`, verdict: 'fixed' as const, reply: 'Fixed.', changed: false },
        ]
        await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: result })
        await publisher().publishPending()

        let rows = await database.sql<{ id: string; status: string; reason: string | null }[]>`
          select id, status::text as status, status_reason as reason from findings where id in ${database.sql([stale, dismissed, open])}`
        let byId = new Map(rows.map((r) => [r.id, [r.status, r.reason]]))
        assert.deepEqual(byId.get(stale), ['fixed', null])
        assert.deepEqual(byId.get(dismissed), ['dismissed', 'not a bug'])
        assert.deepEqual(byId.get(open), ['open', null])
        let events = await database.sql<{ findingId: string; type: string; actor: string; source: string | null; reviewed: boolean }[]>`
          select finding_id as "findingId", type::text as type, actor, source, review_id is not null as reviewed from finding_events
          where finding_id in ${database.sql([stale, dismissed, open])}`
        assert.deepEqual(events.map((e) => ({ ...e })), [{ findingId: stale, type: 'fixed', actor: 'kento', source: 'resolve', reviewed: false }])
      })

      it('18d. REV-71: a review job carries the threads of a finding of the bot that someone answered, cleaned', async () => {
        let refuted = fake.addThread({ path: 'src/sum.ts', line: 4, body: '**`sum` not imported** <!-- sakuga-review:finding 0123456789ab -->', commit: HEAD })
        fake.state.comments.push({
          id: 900_001,
          reviewId: null,
          path: 'src/sum.ts',
          line: 4,
          body: 'False positive: line 1 imports `sum`. <!-- gives 5/5 --><details>log</details>',
          commit: HEAD,
          author: 'octocat',
          inReplyTo: refuted,
        })
        // A finding of the bot that only the bot answered, and a thread of a person: neither goes.
        let alone = fake.addThread({ path: 'src/c.ts', line: 1, body: '**Alone** <!-- sakuga-review:finding ba9876543210 -->', commit: HEAD })
        fake.state.comments.push({ id: 900_002, reviewId: null, path: 'src/c.ts', line: 1, body: 'The finding holds.', commit: HEAD, author: BOT, inReplyTo: alone })
        fake.state.comments.push({ id: 900_003, reviewId: null, path: 'src/a.ts', line: 5, body: 'The name follows the module.', commit: HEAD, author: BOT, inReplyTo: personAnswered })

        await say('@kento-review review balanced')
        let { job } = await claimWith({ hasProviderKey: true, kinds: ['review', 'resolve'], features: ['threads'] })
        assert.ok(job && job.kind === 'review')
        assert.deepEqual(
          job.threads?.map((t) => [t.id, t.comments.map((c) => [c.author, c.isBot, c.body])]),
          [[`PRRT_${refuted}`, [['kento-review', true, '**`sum` not imported**'], ['octocat', false, 'False positive: line 1 imports `sum`.']]]],
        )
        // The service read the threads with a token that reads the contents and the pull requests only.
        assert.ok(fake.state.tokens.some((t) => JSON.stringify(t.permissions) === JSON.stringify({ contents: 'read', pull_requests: 'read' })))
      })

      it('18r1. REV-95: a review job carries the findings of the pull request that a person set aside, for a runner that reads them', async () => {
        let seed = async (key: string, status: string, reason: string | null, pr = PR) =>
          database.sql`
            insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, status_reason,
              first_seen_sha, last_seen_sha)
            select id, ${pr}, ${`fp-${key}`}, ${key}, 'src/a.ts', 7, ${`Title ${key}`}, 'major', 'bug', 90, ${status}, ${reason}, ${HEAD}, ${HEAD}
            from repos where github_repo_id = ${REPO.id}`
        await seed('aaaaaa000001', 'dismissed', 'false positive, the schema validates it')
        await seed('aaaaaa000002', 'wontfix', null)
        await seed('aaaaaa000003', 'open', null)
        await seed('aaaaaa000004', 'fixed', null)
        await seed('aaaaaa000005', 'dismissed', 'other PR', PR + 1)
        await database.sql`update findings set updated_at = now() + interval '1 minute' where key = 'aaaaaa000002'`

        await say('@kento-review review balanced')
        let { job } = await claimWith({ hasProviderKey: true, kinds: ['review'], features: ['rejected'] })
        assert.ok(job && job.kind === 'review')
        assert.deepEqual(job.rejected, [
          { path: 'src/a.ts', line: 7, title: 'Title aaaaaa000002', category: 'bug', status: 'wontfix', reason: null, commit: HEAD },
          { path: 'src/a.ts', line: 7, title: 'Title aaaaaa000001', category: 'bug', status: 'dismissed', reason: 'false positive, the schema validates it', commit: HEAD },
        ])
      })

      it('18r3. REV-95: a rejected finding that the protocol refuses stays out, and the log says why', async () => {
        await database.sql`
          insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, status_reason,
            first_seen_sha, last_seen_sha)
          select id, ${PR}, 'fp', 'cccccc000001', 'src/a.ts', 7, 'T', 'major', 'style', 90, 'dismissed', 'no', ${HEAD}, ${HEAD}
          from repos where github_repo_id = ${REPO.id}`
        await say('@kento-review review balanced')
        let lines: string[] = []
        // A warning goes to stderr (app/log.ts).
        let write = process.stderr.write.bind(process.stderr)
        process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
          lines.push(String(chunk))
          return write(chunk, ...rest)
        }) as typeof process.stderr.write
        let claimed
        try {
          claimed = await claimWith({ hasProviderKey: true, kinds: ['review'], features: ['rejected'] })
        } finally {
          process.stderr.write = write
        }
        assert.ok(claimed.job && claimed.job.kind === 'review')
        assert.deepEqual(claimed.job.rejected, [])
        let left = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'job.rejected_left_out')
        assert.deepEqual({ path: left?.path, line: left?.line, reason: left?.reason }, { path: 'src/a.ts', line: 7, reason: 'unknown category style' })
        // A line beyond the limit of the protocol stays out too.
        await database.sql`update findings set category = 'bug', line = 10000001 where key = 'cccccc000001'`
        await say('@kento-review review heavy')
        let second = await claimWith({ hasProviderKey: true, kinds: ['review'], features: ['rejected'] })
        assert.ok(second.job && second.job.kind === 'review')
        assert.deepEqual(second.job.rejected, [])
      })

      it('18r4. the severity of a rejected finding goes only to a runner that says `rejected-severity`', async () => {
        await database.sql`
          insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, status_reason,
            first_seen_sha, last_seen_sha)
          select id, ${PR}, 'fp', 'dddddd000001', 'src/a.ts', 7, 'T', 'critical', 'bug', 90, 'dismissed', 'no', ${HEAD}, ${HEAD}
          from repos where github_repo_id = ${REPO.id}`
        await say('@kento-review review balanced')
        let { job } = await claimWith({ hasProviderKey: true, kinds: ['review'], features: ['rejected', 'rejected-severity'] })
        assert.ok(job && job.kind === 'review')
        assert.equal(job.rejected?.[0]?.severity, 'critical')
        await say('@kento-review review heavy')
        let older = await claimWith({ hasProviderKey: true, kinds: ['review'], features: ['rejected'] })
        assert.ok(older.job && older.job.kind === 'review')
        assert.equal('severity' in older.job.rejected![0]!, false)
      })

      it('18r2. REV-95: a runner that does not say `rejected` gets no rejected findings', async () => {
        await database.sql`
          insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, status_reason,
            first_seen_sha, last_seen_sha)
          select id, ${PR}, 'fp', 'bbbbbb000001', 'src/a.ts', 7, 'T', 'major', 'bug', 90, 'dismissed', 'no', ${HEAD}, ${HEAD}
          from repos where github_repo_id = ${REPO.id}`
        await say('@kento-review review balanced')
        let { job } = await claimWith({ hasProviderKey: true, kinds: ['review'], features: ['threads'] })
        assert.ok(job && job.kind === 'review')
        assert.equal('rejected' in job, false)
      })

      describe('REV-92: the token that reads the threads', () => {
        const READS_THREADS = JSON.stringify({ contents: 'read', pull_requests: 'read' })
        const threadTokens = () => fake.state.tokens.filter((t) => JSON.stringify(t.permissions) === READS_THREADS)
        const cloneTokens = () => fake.state.tokens.filter((t) => JSON.stringify(t.permissions) === JSON.stringify({ contents: 'read' }))

        /** Queues a review, claims it as a runner that reads the threads, and sends its result. */
        async function reviewClaim(): Promise<Extract<Job, { kind: 'review' }>> {
          let queued = await say('@kento-review review balanced force')
          assert.equal(queued.body.outcome, 'queued')
          let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['review', 'resolve'], features: ['threads'] })
          assert.ok(job && job.kind === 'review')
          let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: review() })
          assert.equal(stored.status, 204)
          return job
        }

        beforeEach(() => {
          app = router()
        })

        it('18e. two review claims on the same repository mint one token that reads the threads', async () => {
          let first = await reviewClaim()
          let second = await reviewClaim()
          assert.equal(threadTokens().length, 1)
          assert.deepEqual(threadTokens()[0]!.repositoryIds, [REPO.id])
          // Each job still gets its own token for the runner, with `contents: read` only.
          assert.equal(cloneTokens().length, 2)
          for (let job of [first, second]) {
            assert.ok(cloneTokens().some((t) => t.token === job.installationToken.token))
            assert.doesNotMatch(job.installationToken.token, /pull_requests/)
          }
          // The resolve of the same repository reads with the same kept token.
          await say('@kento-review resolve')
          let { job } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
          assert.ok(job && job.kind === 'resolve')
          assert.equal(job.resolve.threads.length, 3)
          assert.equal(threadTokens().length, 1)
          let reads = fake.state.calls.filter((c) => c.path === '/graphql').map((c) => c.token)
          assert.deepEqual([...new Set(reads)], [threadTokens()[0]!.token])
        })

        it('18f. a token close to its expiry is minted again', async () => {
          // GitHub gives a token that expires in 2 minutes: inside the margin, so the next claim mints.
          fake.state.tokenExpiresAt = new Date(Date.now() + 2 * 60_000).toISOString()
          await reviewClaim()
          await reviewClaim()
          assert.equal(threadTokens().length, 2)
          fake.state.tokenExpiresAt = '2030-01-01T00:00:00Z'
          await reviewClaim()
          await reviewClaim()
          assert.equal(threadTokens().length, 3)
        })

        it('18g. a 401 on the kept token mints a new one once, and the review still gets its threads', async () => {
          let answered = fake.addThread({ path: 'src/sum.ts', line: 4, body: '**A finding** <!-- sakuga-review:finding 0123456789ab -->', commit: HEAD })
          fake.state.comments.push({ id: 900_010, reviewId: null, path: 'src/sum.ts', line: 4, body: 'False positive.', commit: HEAD, author: 'octocat', inReplyTo: answered })
          await reviewClaim()
          fake.state.revokedTokens.add(threadTokens()[0]!.token)
          let job = await reviewClaim()
          assert.equal(threadTokens().length, 2)
          assert.deepEqual(job.threads?.map((t) => t.id), [`PRRT_${answered}`])
          // The new token is kept: no third mint.
          await reviewClaim()
          assert.equal(threadTokens().length, 2)
        })
      })

      it('18b. a resolve done but not published yet still holds the pull request', async () => {
        await say('@kento-review resolve')
        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.ok(job)
        await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: resolved() })
        // The job is done; the publisher has not posted the replies and their marker yet.
        let early = await say('@kento-review resolve')
        assert.equal(early.body.reason, 'a resolve of the pull request is already running')
        await publisher().publishPending()
        assert.equal((await say('@kento-review resolve')).body.outcome, 'queued')
      })

      it('18c. an unpublished resolution older than the publisher takes stops holding the pull request', async () => {
        await say('@kento-review resolve')
        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.ok(job)
        await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: resolved() })
        // The publisher was down for longer than it keeps a row: the row is never published.
        await database.sql`update resolutions set created_at = now() - interval '31 minutes'`
        assert.equal((await say('@kento-review resolve')).body.outcome, 'queued')
      })

      it('18d. a thread that the model gave no verdict for is counted in the summary', async () => {
        await say('@kento-review resolve')
        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.ok(job)
        let result = resolved()
        result.threads = result.threads.slice(0, 1)
        await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: result })
        await publisher().publishPending()
        let summary = fake.state.issueComments.at(-1)!.body
        assert.match(summary, /2 threads got no answer from the model\. They stay open, and the next `@kento-review resolve` command reads them again\./)
        assert.equal(fake.repliesTo(personAnswered).length, 0)
      })

      it('18e. KNT-161: a resolution that the fallback provider answered says which provider answered in its summary (critique P2-2)', async () => {
        await say('@kento-review resolve')
        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.ok(job)
        let [second] = await database.sql<{ id: string }[]>`
          insert into providers (id, org_id, kind, label, runner_held)
          values (gen_random_uuid(), (select org_id from repos limit 1), 'openrouter', 'Second', true) returning id`
        let config = { repoConfigVersion: 3, source: 'repo', models: { provider: 'service', model: 'anthropic/claude-haiku-5.5', fallback: null, fallbackProvider: { provider: second!.id, model: 'm' } } }
        await database.sql`update jobs set config = ${JSON.stringify(config)}::jsonb where id = ${job.id}`
        let result = { ...resolved(), fellBack: { from: 'service', resetAt: '2026-12-01T00:00:00Z' } }
        let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: result })
        assert.equal(stored.status, 204)
        await publisher().publishPending()
        let summary = fake.state.issueComments.at(-1)!.body
        assert.ok(
          summary.includes('The provider "OpenRouter (key of the service)" refused the call on its usage limit until 2026-12-01 00:00 UTC: the fallback provider "Second" of this level answered.'),
          summary,
        )
      })

      it('19. without `contents: write`, the replies say that a person can resolve, and the threads stay open', async () => {
        fake.state.readOnly.add('contents')
        await say('@kento-review resolve')
        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.ok(job)
        await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: resolved() })
        await publisher(new URL('https://review.test')).publishPending()
        assert.equal(fake.state.resolved.size, 0)
        assert.match(fake.repliesTo(botFixed)[0]!.body, /The thread can be resolved\. The App does not have the permission/)
        // REV-106. A service that knows its public URL shows its icons.
        assert.match(
          fake.state.issueComments.at(-1)!.body,
          /^- <picture><source media="\(prefers-color-scheme: dark\)" srcset="https:\/\/review\.test\/assets\/pr\/to-resolve-dark\.v2\.svg"><img alt="To resolve" src="https:\/\/review\.test\/assets\/pr\/to-resolve\.v2\.svg" height="20" align="top"><\/picture> to resolve · \[`src\/sum.ts:2`\]/m,
        )
      })

      it('20. a review sent for a resolve job is refused; a resolution of an older head is not published', async () => {
        await say('@kento-review resolve')
        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.ok(job)
        let wrong = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: review() })
        assert.equal(wrong.status, 422)
        assert.equal((await wrong.json()).error, 'wrong_kind')

        let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: resolved() })
        assert.equal(stored.status, 204)
        fake.state.pr.head = headSha(0xfff)
        await publisher().publishPending()
        assert.equal(fake.state.comments.filter((c) => c.inReplyTo !== null).length, 0)
        assert.equal(fake.state.resolved.size, 0)
      })

      it('21. a GitHub error while the service reads the threads gives the job back for another attempt', async () => {
        await say('@kento-review resolve')
        let failing = fake.fetch
        fake.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
          String(input).endsWith('/graphql') ? new Response('{}', { status: 502 }) : failing(input, init)) as typeof fetch
        let { status } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.equal(status, 204)
        let [row] = await database.sql<{ state: string; attempts: number }[]>`select state, attempts from jobs`
        assert.deepEqual({ ...row }, { state: 'queued', attempts: 1 })
      })
    })
  })

  describe('reject (REV-93)', () => {
    /** A finding of the pull request PR (or of `pr`), with its thread on the fake when `thread` is set. */
    async function seedFinding(
      key: string,
      options: { thread?: boolean; threadIdKnown?: boolean; pr?: number; status?: string; severity?: string; confidence?: number; lastSeen?: string; title?: string } = {},
    ) {
      let title = options.title ?? 'Bug'
      let commentId = options.thread ? fake.addThread({ path: 'src/a.ts', line: 3, body: `**${title}** \`#${key.slice(0, 6)}\``, commit: HEAD }) : null
      let [row] = await database.sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
          first_seen_sha, last_seen_sha, github_comment_id, github_thread_id)
        select id, ${options.pr ?? PR}, ${`fp-${key}`}, ${key}, 'src/a.ts', 3, ${title}, ${options.severity ?? 'major'}, 'bug', ${options.confidence ?? 90},
          ${options.status ?? 'open'}, ${HEAD}, ${options.lastSeen ?? HEAD}, ${commentId}, ${commentId === null || options.threadIdKnown === false ? null : `PRRT_${commentId}`}
        from repos where github_repo_id = ${REPO.id}
        returning id`
      return { id: row!.id, commentId }
    }

    /** A reply in a review thread, as GitHub delivers it. */
    async function reply(body: string, rootCommentId: number, options: Parameters<typeof reviewCommentPayload>[0] & { deliveryId?: string } = {}) {
      let payload = reviewCommentPayload({ body, inReplyTo: rootCommentId, commentId: ++comment, ...options })
      let deliveryId = options.deliveryId ?? nextDelivery()
      let response = await router().fetch(signedRequest(payload, { event: 'pull_request_review_comment', deliveryId }))
      return { status: response.status, body: await response.json().catch(() => null), payload, deliveryId }
    }

    async function replayReply(payload: unknown, deliveryId: string) {
      let response = await router().fetch(signedRequest(payload, { event: 'pull_request_review_comment', deliveryId }))
      return { status: response.status, body: await response.json().catch(() => null) }
    }

    const threadReactionsOf = (id: number) =>
      [...fake.state.reviewCommentReactions].filter((r) => r.startsWith(`${id}:`)).map((r) => r.split(':')[1]).sort()

    async function statusOf(id: string) {
      let [row] = await database.sql<{ status: string; reason: string | null }[]>`select status, status_reason as reason from findings where id = ${id}`
      return { ...row }
    }

    async function eventsOf(id: string) {
      return (await database.sql<{ type: string; actor: string; reason: string | null; source: string | null }[]>`
        select type, actor, reason, source from finding_events where finding_id = ${id} order by created_at, id`).map((e) => ({ ...e }))
    }

    it('R1. a reject in the thread of a finding dismisses it, replies with the cause, resolves the thread, then 🚀 (REV-94)', async () => {
      fake.state.canResolve = true
      fake.state.resolveNeedsWrite = true
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let cause = 'false positive, the schema validates the value'
      let { status, body, payload } = await reply(`Not a bug.\n\n@kento-review reject ${cause}`, finding.commentId!)
      assert.equal(status, 202)
      assert.deepEqual(body, { outcome: 'dismissed', findingId: finding.id, dismissedReview: null })
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['eyes', 'rocket'])
      // The reactions go on the review comment, not on a comment of the conversation.
      assert.deepEqual(reactionsOf(payload.comment.id), [])
      assert.deepEqual(await statusOf(finding.id), { status: 'dismissed', reason: cause })
      assert.deepEqual(await eventsOf(finding.id), [{ type: 'dismissed', actor: 'octocat', reason: cause, source: 'command' }])
      let replies = fake.repliesTo(finding.commentId!)
      assert.equal(replies.length, 1)
      assert.equal(replies[0]!.body, `Finding dismissed by @octocat on Kentō. Reason: "${cause}". The next reviews will not comment on it again.\n\n<!-- kento:reject ${finding.id} -->`)
      assert.ok(fake.state.resolved.has(finding.commentId!))
      assert.equal(fake.state.issueComments.length, 0)
      assert.equal((await jobs()).length, 0)
    })

    it('R13. a fixed finding refuses the reject with 😕 and a reason; a stale one is dismissed (KNT-192)', async () => {
      let fixed = await seedFinding('dddddd000001', { thread: true, status: 'fixed' })
      let refused = await reply('@kento-review reject ok', fixed.commentId!)
      assert.deepEqual(refused.body, { outcome: 'refused', reason: 'reject: finding is fixed' })
      assert.deepEqual(threadReactionsOf(refused.payload.comment.id), ['confused'])
      assert.match(
        fake.repliesTo(fixed.commentId!)[0]!.body,
        /`#dddddd` is no longer open: it is fixed\. A later review did not find it again after a push changed its file, or `@kento-review resolve` read its thread against the code\./,
      )
      assert.doesNotMatch(fake.repliesTo(fixed.commentId!)[0]!.body, /fixed it/)
      // KNT-192. The reviews no longer see a stale finding, and it can still be a false positive.
      let stale = await seedFinding('eeeeee000001', { status: 'stale' })
      let dismissed = await say('@kento-review reject #eeeeee not a defect')
      assert.equal(dismissed.body.outcome, 'dismissed')
      assert.deepEqual(await statusOf(stale.id), { status: 'dismissed', reason: 'not a defect' })
      assert.deepEqual((await eventsOf(stale.id)).map((e) => [e.type, e.actor, e.source]), [['dismissed', 'octocat', 'command']])
      // A finding set aside before can be named again: the second reject changes nothing.
      await seedFinding('ffffff000001', { status: 'dismissed' })
      assert.equal((await say('@kento-review reject #ffffff ok')).body.outcome, 'unchanged')
    })

    it('R14. without an id in the conversation, the lookup finds nothing, even when called past the guard', async () => {
      await seedFinding('aaaaaa000001')
      let message = {
        type: 'comment_command' as const,
        installation: { githubInstallationId: 1001, githubAccountId: 2001, login: 'sakuga-software' },
        repository: { githubRepoId: REPO.id, fullName: REPO.full_name },
        prNumber: PR,
        commentId: 1,
        commenter: { login: 'octocat', isBot: false },
        command: { verb: 'reject' as const, id: null, reason: 'ok' },
        author: null,
        place: { kind: 'conversation' as const },
      }
      assert.deepEqual(await findRejectTarget(database.db, message, message.command), { kind: 'unknown_id' })
      assert.deepEqual(await findRejectTarget(database.db, message, { ...message.command, id: '' }), { kind: 'unknown_id' })
    })

    it('R2. `reject #<id>` in the conversation names the finding of that id, with or without `#`, in any case', async () => {
      let finding = await seedFinding('3cf454aa0011')
      await seedFinding('9d00aa110022')
      let first = await say('@kento-review reject #3CF454 the schema validates the value')
      assert.deepEqual(first.body, { outcome: 'dismissed', findingId: finding.id, dismissedReview: null })
      assert.deepEqual(reactionsOf(first.payload.comment.id), ['eyes', 'rocket'])
      // The reply goes under the pull request: this finding has no thread.
      assert.deepEqual(fake.state.issueComments.map((c) => c.body), [
        `@octocat The finding \`#3cf454\` "Bug" is dismissed. Reason: "the schema validates the value". The next reviews will not comment on it again.\n\n<!-- kento:reject ${finding.id} -->`,
      ])
      // A second reject of the same finding, even with another cause, changes nothing and posts nothing.
      let second = await say('@sakuga-review reject 3cf454aa the value is validated')
      assert.deepEqual(second.body, { outcome: 'unchanged', findingId: finding.id, dismissedReview: null })
      assert.equal(fake.state.issueComments.length, 1)
      assert.deepEqual(await statusOf(finding.id), { status: 'dismissed', reason: 'the schema validates the value' })
      assert.equal((await eventsOf(finding.id)).length, 1)
    })

    it('R2b. a reject in the conversation of a finding with a thread replies in both, and resolves the thread', async () => {
      fake.state.canResolve = true
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let { body } = await say('@kento-review reject #3cf454 dup of #12')
      assert.equal(body.outcome, 'dismissed')
      assert.equal(fake.repliesTo(finding.commentId!).length, 1)
      assert.equal(fake.state.issueComments.length, 1)
      assert.ok(fake.state.resolved.has(finding.commentId!))
    })

    /** The key of a finding of `src/a.ts` with this title, as the engine computes it. */
    const keyOf = (title: string) => findingKey({ path: 'src/a.ts', title } as never)

    /**
     * A review of Kentō on GitHub (the fake) and in the database, with the findings that the engine
     * gave it: `blocking` as the engine marked them.
     */
    async function storeReview(state: string, findings: { title: string; blocking: boolean }[], commitId = HEAD) {
      let githubReviewId = fake.addReview({ state, commitId })
      let [job] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id)
        select id, 'lite', ${PR}, ${commitId}, ${`delivery-review-${githubReviewId}`} from repos where github_repo_id = ${REPO.id}
        returning id`
      // Each finding as the runner stores it (ReviewFinding of the protocol), every field set.
      let result = {
        findings: findings.map((f) => ({
          path: 'src/a.ts',
          start_line: 3,
          line: 3,
          severity: 'major',
          category: 'bug',
          confidence: 90,
          title: f.title,
          scenario: 'A scenario.',
          fix: 'A fix.',
          suggestion: '',
          anchor: f.blocking ? 3 : null,
          blocking: f.blocking,
          suggestion_range: null,
          // A finding that cites a rule: its key is still the path and the title, as in the ledger.
          rule_id: '00000000-0000-4000-8000-000000000001',
        })),
      }
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        select ${job!.id}, id, ${PR}, ${commitId}, 2, 'm', 0, ${JSON.stringify(result)}::jsonb, ${githubReviewId}, now()
        from repos where github_repo_id = ${REPO.id}`
      return githubReviewId
    }

    it('R8. the last review of Kentō on the head asks for changes: a reject of its only blocking finding dismisses it', async () => {
      fake.state.canResolve = true
      let older = await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }], headSha(0x123))
      let review = await storeReview('CHANGES_REQUESTED', [
        { title: 'Bug', blocking: true },
        // Findings that the engine did not mark blocking hold nothing, even when they stay open.
        { title: 'Style', blocking: false },
      ])
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      await seedFinding(keyOf('Style'), { thread: true, title: 'Style' })
      let { body } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(body, { outcome: 'dismissed', findingId: finding.id, dismissedReview: review })
      let id = keyOf('Bug').slice(0, 6)
      assert.deepEqual(fake.state.dismissals, [
        { reviewId: review, message: `Dismissed by Kentō: @octocat dismissed the finding \`#${id}\` "Bug", and no blocking finding stays open.` },
      ])
      // The review of an older head is not the last one on the head: publish.ts dismisses it at the next review.
      assert.equal(fake.state.reviews.find((r) => r.id === older)!.state, 'CHANGES_REQUESTED')
    })

    it('R8b. the review on the head is a copy (REV-101): a reject dismisses it and its source of the earlier head', async () => {
      fake.state.canResolve = true
      const EARLIER = headSha(0x123)
      // The review that a model made, on the earlier head, then its copy on the head: the row of the
      // head names the source in github_review_id, and the copy in headReviewId.
      let source = await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }], EARLIER)
      let copy = fake.addReview({ state: 'CHANGES_REQUESTED', commitId: HEAD })
      let [job] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id)
        select id, 'lite', ${PR}, ${HEAD}, 'delivery-copy' from repos where github_repo_id = ${REPO.id}
        returning id`
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        select ${job!.id}, repo_id, pr_number, ${HEAD}, score, model, 0,
          result || ${JSON.stringify({ reusedFrom: { reviewId: '00000000-0000-0000-0000-000000000000', head: EARLIER, githubReviewId: source }, headReviewId: copy })}::jsonb,
          github_review_id, now()
        from reviews where github_review_id = ${source}`
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      let { body } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(body, { outcome: 'dismissed', findingId: finding.id, dismissedReview: copy })
      assert.deepEqual(fake.state.dismissals.map((d) => d.reviewId), [copy, source], 'the source would keep the pull request blocked')
    })

    it('R8c. the source of a copy that GitHub no longer lists: the copy is dismissed, and the log names the source (REV-101)', async () => {
      fake.state.canResolve = true
      const EARLIER = headSha(0x123)
      let source = await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }], EARLIER)
      let copy = fake.addReview({ state: 'CHANGES_REQUESTED', commitId: HEAD })
      let [job] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id)
        select id, 'lite', ${PR}, ${HEAD}, 'delivery-copy' from repos where github_repo_id = ${REPO.id}
        returning id`
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        select ${job!.id}, repo_id, pr_number, ${HEAD}, score, model, 0,
          result || ${JSON.stringify({ reusedFrom: { reviewId: '00000000-0000-0000-0000-000000000000', head: EARLIER, githubReviewId: source }, headReviewId: copy })}::jsonb,
          github_review_id, now()
        from reviews where github_review_id = ${source}`
      // The source is gone from GitHub.
      fake.state.reviews.splice(fake.state.reviews.findIndex((r) => r.id === source), 1)
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      let lines: string[] = []
      let write = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
        lines.push(String(chunk))
        return write(chunk, ...rest)
      }) as typeof process.stderr.write
      let body
      try {
        body = (await reply('@kento-review reject the schema validates it', finding.commentId!)).body
      } finally {
        process.stderr.write = write
      }
      assert.equal(body.dismissedReview, copy)
      assert.deepEqual(fake.state.dismissals.map((d) => d.reviewId), [copy])
      let warned = lines.flatMap((l) => l.split('\n')).filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'command.reject_source_not_found')
      assert.equal(warned?.source, source)
    })

    it('R9. another blocking finding of that review still open, or a last review that does not ask for changes: no dismissal', async () => {
      await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }, { title: 'Other', blocking: true }])
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      await seedFinding(keyOf('Other'), { thread: true, title: 'Other', lastSeen: headSha(0x123) })
      let lines: string[] = []
      let write = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
        lines.push(String(chunk))
        return write(chunk, ...rest)
      }) as typeof process.stderr.write
      let first
      try {
        first = await reply('@kento-review reject the schema validates it', finding.commentId!)
      } finally {
        process.stderr.write = write
      }
      assert.equal(first.body.dismissedReview, null, 'the other blocking finding of the review holds it, whatever its last head')
      let kept = lines.flatMap((l) => l.split('\n')).filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'command.reject_review_kept')
      assert.deepEqual(kept?.blocking, [`#${keyOf('Other').slice(0, 6)}`])
      assert.equal(fake.state.dismissals.length, 0)

      await database.sql`truncate findings, reviews, jobs cascade`
      fake.state.reviews.length = 0
      await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }])
      await storeReview('COMMENTED', [])
      let other = await seedFinding(keyOf('Bug'), { thread: true })
      let second = await reply('@kento-review reject ok', other.commentId!)
      assert.equal(second.body.dismissedReview, null)
      assert.equal(fake.state.dismissals.length, 0)
    })

    it('R24. a blocking finding of the review that is no longer open (fixed) holds nothing: the review is lifted', async () => {
      let review = await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }, { title: 'Other', blocking: true }])
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      await seedFinding(keyOf('Other'), { thread: true, title: 'Other', status: 'fixed' })
      let { body } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(body.dismissedReview, review)
    })

    it('R25. a blocking finding of the review with no row of the ledger holds nothing, and the log names it', async () => {
      let review = await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }, { title: 'Never written', blocking: true }])
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      let { body } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(body.dismissedReview, review)
    })

    it('R15. only the blocking findings of the review count: an open finding that it did not report holds nothing; a review that Kentō did not store is left', async () => {
      let review = await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }])
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      await seedFinding(keyOf('Old'), { thread: true, title: 'Old', lastSeen: headSha(0x123) })
      let { body } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(body.dismissedReview, review)

      await database.sql`truncate findings, reviews, jobs cascade`
      fake.state.reviews.length = 0
      fake.state.dismissals.length = 0
      fake.addReview({ state: 'CHANGES_REQUESTED' })
      let unknown = await seedFinding(keyOf('Bug'), { thread: true })
      let lines: string[] = []
      let write = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
        lines.push(String(chunk))
        return write(chunk, ...rest)
      }) as typeof process.stderr.write
      let second
      try {
        second = await reply('@kento-review reject ok', unknown.commentId!)
      } finally {
        process.stderr.write = write
      }
      assert.ok(lines.join('').includes('"event":"command.reject_review_not_stored"'))
      assert.equal(second.body.dismissedReview, null)
      assert.equal(fake.state.dismissals.length, 0)
    })

    it('R18. a review that someone dismissed between the list and the dismissal (422) is a success, not 😕', async () => {
      let review = await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }])
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      fake.state.dismissRefused = true
      let { body, payload } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(body, { outcome: 'dismissed', findingId: finding.id, dismissedReview: review })
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['eyes', 'rocket'])
    })

    it('R19. a dismissal of the review that GitHub refused: 😕, and the next reject of the finding does it, without a second reply', async () => {
      let review = await storeReview('CHANGES_REQUESTED', [{ title: 'Bug', blocking: true }])
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      fake.state.failDismissals = 1
      let first = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(first.body, { outcome: 'dismissed', findingId: finding.id, dismissedReview: null })
      assert.deepEqual(threadReactionsOf(first.payload.comment.id), ['confused', 'eyes'])
      assert.equal(fake.state.reviews.find((r) => r.id === review)!.state, 'CHANGES_REQUESTED')
      let again = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(again.body, { outcome: 'unchanged', findingId: finding.id, dismissedReview: review })
      assert.deepEqual(threadReactionsOf(again.payload.comment.id), ['eyes', 'rocket'])
      assert.equal(fake.state.reviews.find((r) => r.id === review)!.state, 'DISMISSED')
      assert.equal(fake.repliesTo(finding.commentId!).filter((c) => c.author === BOT).length, 1)
    })

    it('R20. a review whose stored findings have no path or title is left, logged, and the reject still ends with 🚀', async () => {
      let githubReviewId = fake.addReview({ state: 'CHANGES_REQUESTED' })
      let [job] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id)
        select id, 'lite', ${PR}, ${HEAD}, 'delivery-broken' from repos where github_repo_id = ${REPO.id} returning id`
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, github_review_id, published_at)
        select ${job!.id}, id, ${PR}, ${HEAD}, 2, 'm', 0, ${JSON.stringify({ findings: [{ blocking: true, line: 3 }] })}::jsonb, ${githubReviewId}, now()
        from repos where github_repo_id = ${REPO.id}`
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      let { body, payload } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(body, { outcome: 'dismissed', findingId: finding.id, dismissedReview: null })
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['eyes', 'rocket'])
      assert.equal(fake.state.dismissals.length, 0)
    })

    it('R21. a reply whose presence GitHub could not tell is not posted blind: 😕, and the next try posts it once', async () => {
      let finding = await seedFinding(keyOf('Bug'), { thread: true, status: 'dismissed' })
      fake.state.failCommentLists = 1
      let first = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(first.body.outcome, 'unchanged')
      assert.deepEqual(threadReactionsOf(first.payload.comment.id), ['confused', 'eyes'])
      assert.equal(fake.repliesTo(finding.commentId!).filter((c) => c.author === BOT).length, 0)
      let again = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(threadReactionsOf(again.payload.comment.id), ['eyes', 'rocket'])
      assert.equal(fake.repliesTo(finding.commentId!).filter((c) => c.author === BOT).length, 1)
      await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(fake.repliesTo(finding.commentId!).filter((c) => c.author === BOT).length, 1)
    })

    it('R22. a pull request closed since the comment: the reject does nothing', async () => {
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      fake.state.pr.state = 'closed'
      let { body, payload } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(body, { outcome: 'skipped', reason: 'pull request is closed' })
      assert.equal((await statusOf(finding.id)).status, 'open')
      assert.deepEqual(threadReactionsOf(payload.comment.id), [])
      assert.equal(fake.repliesTo(finding.commentId!).length, 0)
    })

    it('R26. a redelivery that fails after a try that succeeded takes its 🚀 back: 😕 alone', async () => {
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      let first = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.deepEqual(threadReactionsOf(first.payload.comment.id), ['eyes', 'rocket'])
      fake.state.failCommentLists = 1
      await replayReply(first.payload, first.deliveryId)
      assert.deepEqual(threadReactionsOf(first.payload.comment.id), ['confused', 'eyes'])
    })

    it('R16. a database that fails while the status is written: 😕 on the command, the delivery fails, and the same reject again does it', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      commandSql = new Proxy(database.sql, {
        get: (target, key, receiver) => (key === 'begin' ? () => Promise.reject(new Error('connection lost')) : Reflect.get(target, key, receiver)),
      })
      let failed = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(failed.status, 500)
      assert.deepEqual(threadReactionsOf(failed.payload.comment.id), ['confused', 'eyes'])
      assert.equal((await statusOf(finding.id)).status, 'open')
      assert.equal(fake.repliesTo(finding.commentId!).length, 0)
      // A redelivery of the same comment from the settings of the App: the 😕 goes, 🚀 stays alone.
      commandSql = null
      await replayReply(failed.payload, failed.deliveryId)
      assert.deepEqual(threadReactionsOf(failed.payload.comment.id), ['eyes', 'rocket'])
      // GitHub does not send the delivery again: the person can also write the reject again.
      let again = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(again.body.outcome, 'unchanged')
      assert.equal((await statusOf(finding.id)).status, 'dismissed')
    })

    it('R17b. a finding dismissed with a cause on the screen, then rejected again: the missing reply quotes the cause of the row', async () => {
      let finding = await seedFinding(keyOf('Bug'), { thread: true, status: 'dismissed' })
      await database.sql`update findings set status_reason = 'False positive' where id = ${finding.id}`
      await reply('@kento-review reject another cause', finding.commentId!)
      let replies = fake.repliesTo(finding.commentId!).filter((c) => c.author === BOT)
      assert.equal(replies.length, 1)
      assert.match(replies[0]!.body, /Reason: "False positive"/)
    })

    it('R23. a wontfix finding becomes dismissed with the cause of the reject, and its events keep both decisions', async () => {
      let finding = await seedFinding(keyOf('Bug'), { thread: true })
      await database.sql`update findings set status = 'wontfix' where id = ${finding.id}`
      await database.sql`insert into finding_events (finding_id, type, actor) values (${finding.id}, 'wontfix', 'camille')`
      let { body } = await reply('@kento-review reject false positive', finding.commentId!)
      assert.equal(body.outcome, 'dismissed')
      assert.deepEqual(await statusOf(finding.id), { status: 'dismissed', reason: 'false positive' })
      assert.deepEqual((await eventsOf(finding.id)).map((e) => [e.type, e.actor]), [['wontfix', 'camille'], ['dismissed', 'octocat']])
    })

    it('R10. a redelivery posts nothing more; a fixed finding is refused with 😕, a stale one is dismissed', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let first = await reply('@kento-review reject the schema validates it', finding.commentId!)
      await replayReply(first.payload, first.deliveryId)
      assert.equal(fake.repliesTo(finding.commentId!).length, 1)
      assert.equal((await eventsOf(finding.id)).length, 1)

      let fixed = await seedFinding('dddddd000001', { thread: true, status: 'fixed' })
      let refused = await reply('@kento-review reject ok', fixed.commentId!)
      assert.deepEqual(refused.body, { outcome: 'refused', reason: 'reject: finding is fixed' })
      assert.deepEqual(threadReactionsOf(refused.payload.comment.id), ['confused'])
      assert.match(fake.repliesTo(fixed.commentId!)[0]!.body, /is no longer open: it is fixed\. A later review did not find it again after a push changed its file/)
      // KNT-192. A stale finding: the reject dismisses it, and a redelivery changes nothing more.
      let stale = await seedFinding('eeeeee000001', { status: 'stale' })
      let staleRejected = await say('@kento-review reject #eeeeee ok')
      assert.equal(staleRejected.body.outcome, 'dismissed')
      assert.deepEqual(await statusOf(stale.id), { status: 'dismissed', reason: 'ok' })
      assert.equal((await say('@kento-review reject #eeeeee ok')).body.outcome, 'unchanged')
      assert.equal((await eventsOf(stale.id)).length, 1)
    })

    it('R11. without `contents: write`, the reply says that a person can resolve the thread, and the reject still succeeds', async () => {
      fake.state.canResolve = true
      fake.state.readOnly.add('contents')
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let { body, payload } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(body.outcome, 'dismissed')
      assert.equal(fake.state.resolved.size, 0)
      assert.match(fake.repliesTo(finding.commentId!)[0]!.body, /Kentō could not resolve this thread\. If it is still open, a person can resolve it\.\n\n<!-- kento:reject /)
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['eyes', 'rocket'])
    })

    it('R17. a reply that GitHub refused is posted at the next reject, with the first cause, and only once', async () => {
      let finding = await seedFinding('3cf454aa0011')
      fake.state.failIssueComments = 1
      let first = await say('@kento-review reject #3cf454 the value is validated')
      assert.equal(first.body.outcome, 'dismissed')
      assert.equal(fake.state.issueComments.length, 0)
      // A redelivery of the same comment posts the missing reply, with the cause of the dismissal.
      await replay(first.payload, first.deliveryId)
      let second = await say('@kento-review reject #3cf454 another cause')
      assert.equal(second.body.outcome, 'unchanged')
      assert.deepEqual(fake.state.issueComments.map((c) => c.body.split('\n')[0]), [
        '@octocat The finding `#3cf454` "Bug" is dismissed. Reason: "the value is validated". The next reviews will not comment on it again.',
      ])
      assert.deepEqual(reactionsOf(second.payload.comment.id), ['eyes', 'rocket'])
      assert.equal((await eventsOf(finding.id)).length, 1)
    })

    it('R12. a reply that GitHub refuses leaves the finding dismissed and answers 😕', async () => {
      let finding = await seedFinding('3cf454aa0011')
      fake.state.failIssueComments = 1
      let { body, payload } = await say('@kento-review reject #3cf454 ok')
      assert.equal(body.outcome, 'dismissed')
      assert.deepEqual(reactionsOf(payload.comment.id), ['confused', 'eyes'])
      assert.equal((await statusOf(finding.id)).status, 'dismissed')
    })

    it('R3. a reject without a reason gets 😕 and the usage in its thread, once', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let { body, payload, deliveryId } = await reply('@kento-review reject', finding.commentId!)
      assert.deepEqual(body, { outcome: 'refused', reason: 'reject: reason_missing' })
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['confused'])
      let replies = fake.repliesTo(finding.commentId!)
      assert.equal(replies.length, 1)
      assert.match(replies[0]!.body, /^@octocat The `reject` command needs a cause/)
      assert.match(replies[0]!.body, /@kento-review reject <cause>/)
      assert.equal(fake.state.issueComments.length, 0)
      await replayReply(payload, deliveryId)
      assert.equal(fake.repliesTo(finding.commentId!).length, 1)
    })

    it('R4. a reason too long gets 😕 and a short reply', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let long = await reply(`@kento-review reject ${'x'.repeat(501)}`, finding.commentId!)
      assert.deepEqual(long.body, { outcome: 'refused', reason: 'reject: reason_long' })
      let replies = fake.repliesTo(finding.commentId!).map((c) => c.body)
      assert.match(replies[0]!, /at most 500 characters/)
    })

    it('R4b. in a thread, the id of its own finding works, and the id of another finding is refused with the id of the thread (KNT-160)', async () => {
      fake.state.canResolve = true
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let other = await seedFinding('9ab123cc0022', { thread: true, title: 'Other' })
      let wrong = await reply('@kento-review reject #9ab123 false positive', finding.commentId!)
      assert.deepEqual(wrong.body, { outcome: 'refused', reason: 'reject: other_finding' })
      assert.deepEqual(threadReactionsOf(wrong.payload.comment.id), ['confused'])
      assert.match(fake.repliesTo(finding.commentId!)[0]!.body, /^@octocat This thread holds the finding `#3cf454`, not `#9ab123`\. /)
      assert.match(fake.repliesTo(finding.commentId!)[0]!.body, /`@kento-review reject #9ab123 <cause>` in the conversation/)
      assert.equal((await statusOf(other.id)).status, 'open', 'the other finding is not touched')
      // An id of no finding of the pull request: the reply says so, and names no thread.
      let unknown = await reply('@kento-review reject #ffffff false positive', finding.commentId!)
      assert.deepEqual(unknown.body, { outcome: 'refused', reason: 'reject: unknown_id' })
      assert.match(fake.repliesTo(finding.commentId!).at(-1)!.body, /No finding of this PR has the id `#ffffff`\./)
      assert.doesNotMatch(fake.repliesTo(finding.commentId!).at(-1)!.body, /reply in its thread/)
      assert.equal((await statusOf(finding.id)).status, 'open')

      let own = await reply('@kento-review reject #3cf454 false positive, the schema validates it', finding.commentId!)
      assert.deepEqual(own.body, { outcome: 'dismissed', findingId: finding.id, dismissedReview: null })
      assert.deepEqual(await statusOf(finding.id), { status: 'dismissed', reason: 'false positive, the schema validates it' })
      assert.deepEqual(threadReactionsOf(own.payload.comment.id), ['eyes', 'rocket'])
      // An id that names the finding of the thread and another finding is ambiguous, as in the conversation.
      let twin = await seedFinding('3cf454bb0044', { title: 'Twin' })
      let ambiguous = await reply('@kento-review reject #3cf454 not a bug', finding.commentId!)
      assert.deepEqual(ambiguous.body, { outcome: 'refused', reason: 'reject: ambiguous_id' })
      assert.match(fake.repliesTo(finding.commentId!).at(-1)!.body, /`#3cf454` matches several findings of this PR/)
      assert.equal((await statusOf(twin.id)).status, 'open')
      // A longer prefix of the key of the thread works too.
      let longer = await seedFinding('5d6e7f880033', { thread: true, title: 'Third' })
      assert.equal((await reply('@kento-review reject #5d6e7f88 not a bug', longer.commentId!)).body.outcome, 'dismissed')
    })

    it('R4c. a reject in the thread of a finding whose thread id the ledger does not know yet resolves the thread (KNT-160)', async () => {
      fake.state.canResolve = true
      fake.state.resolveNeedsWrite = true
      let finding = await seedFinding('3cf454aa0011', { thread: true, threadIdKnown: false })
      let { body } = await reply('@kento-review reject the schema validates it', finding.commentId!)
      assert.equal(body.outcome, 'dismissed')
      assert.ok(fake.state.resolved.has(finding.commentId!), 'the thread is resolved')
      assert.doesNotMatch(fake.repliesTo(finding.commentId!)[0]!.body, /could not resolve/)
      let [row] = await database.sql<{ thread: string | null }[]>`select github_thread_id as thread from findings where id = ${finding.id}`
      assert.equal(row!.thread, `PRRT_${finding.commentId}`, 'the ledger keeps the thread id')
    })

    it('R5. in the conversation: no id, an unknown id, an ambiguous id, a finding of another pull request', async () => {
      await seedFinding('aaa111bb0011')
      await seedFinding('aaa111cc0022')
      await seedFinding('bbb222dd0033', { pr: PR + 1 })
      let missing = await say('@kento-review reject false positive')
      assert.deepEqual(missing.body, { outcome: 'refused', reason: 'reject: id_missing' })
      let unknown = await say('@kento-review reject #ccc333 false positive')
      assert.deepEqual(unknown.body, { outcome: 'refused', reason: 'reject: unknown_id' })
      let ambiguous = await say('@kento-review reject #aaa111 false positive')
      assert.deepEqual(ambiguous.body, { outcome: 'refused', reason: 'reject: ambiguous_id' })
      let other = await say('@kento-review reject #bbb222 false positive')
      assert.deepEqual(other.body, { outcome: 'refused', reason: 'reject: unknown_id' })
      for (let r of [missing, unknown, ambiguous, other]) assert.deepEqual(reactionsOf(r.payload.comment.id), ['confused'])
      let texts = fake.state.issueComments.map((c) => c.body)
      assert.match(texts[0]!, /needs the id of the finding/)
      assert.match(texts[1]!, /No finding of this PR has the id `#ccc333`/)
      assert.match(texts[2]!, /`#aaa111` matches several findings of this PR: `#aaa111bb0011`, `#aaa111cc0022`/)
      assert.match(texts[3]!, /No finding of this PR has the id `#bbb222`/)
    })

    it('R6. a reject in a thread that is not the thread of a finding gets 😕', async () => {
      let thread = fake.addThread({ path: 'src/a.ts', line: 3, body: 'A question of a person.', commit: HEAD, author: 'camille' })
      let { body, payload } = await reply('@kento-review reject not relevant', thread)
      assert.deepEqual(body, { outcome: 'refused', reason: 'reject: not_a_finding_thread' })
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['confused'])
      assert.match(fake.repliesTo(thread)[0]!.body, /is not the thread of a Kentō finding/)
    })

    it('R7. a person who cannot write gets no answer; another command in a thread gets 😕', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let reader = await reply('@kento-review reject false positive', finding.commentId!, { user: { login: 'reader', type: 'User' } })
      assert.deepEqual(reader.body, { outcome: 'refused', reason: 'commenter cannot write to the repository' })
      assert.deepEqual(threadReactionsOf(reader.payload.comment.id), [])
      let heavy = await reply('@kento-review heavy', finding.commentId!)
      assert.deepEqual(heavy.body, { outcome: 'refused', reason: 'only reject is read in a review thread' })
      assert.match(fake.repliesTo(finding.commentId!)[0]!.body, /In a thread, Kentō reads `@kento-review reject <cause>` and `@kento-review feedback <opinion>`\. A review command goes in the conversation of the PR\./)
      // KNT-160. `resolve` in a thread gets an answer at once that says where it goes.
      let resolve = await reply('@kento-review resolve', finding.commentId!)
      assert.deepEqual(resolve.body, { outcome: 'refused', reason: 'only reject is read in a review thread' })
      assert.deepEqual(threadReactionsOf(resolve.payload.comment.id), ['confused'])
      assert.match(
        fake.repliesTo(finding.commentId!)[1]!.body,
        /^@octocat `@kento-review resolve` goes in the conversation of the PR, not in a thread\. From there, Kentō reads the open threads of the PR, this one among them, within the limits of the command\. In a thread, Kentō reads `@kento-review reject <cause>` and `@kento-review feedback <opinion>`\./,
      )
      assert.equal((await jobs()).length, 0)
    })

    describe('the hint of `reject` (REV-96, REV-116)', () => {
      it('H1. a reply that sets a finding aside, in English or in French, gets nothing from the webhook: no hint, no claim', async () => {
        let finding = await seedFinding('3cf454aa0011', { thread: true })
        for (let body of ['Not applied: the value is validated by the schema', "C'est un faux positif, la fonction vérifie déjà le null."]) {
          let answer = await reply(body, finding.commentId!)
          assert.equal(answer.status, 202)
          assert.deepEqual(answer.body, { outcome: 'ignored', reason: 'comment is not a command' })
          assert.deepEqual(threadReactionsOf(answer.payload.comment.id), [])
        }
        assert.deepEqual(fake.repliesTo(finding.commentId!), [])
        let [row] = await database.sql<{ claimed: boolean }[]>`select reject_hint_at is not null as claimed from findings where id = ${finding.id}`
        assert.equal(row!.claimed, false)
        assert.deepEqual(await statusOf(finding.id), { status: 'open', reason: null })
        assert.equal((await jobs()).length, 0)
      })

      it('H5. the list of the commands links the page of the commands', async () => {
        let finding = await seedFinding('3cf454aa0011', { thread: true })
        await reply('@kento-review reject', finding.commentId!)
        assert.match(fake.repliesTo(finding.commentId!)[0]!.body, /\[Kentō commands\]\(https:\/\/review\.sakuga\.dev\/docs\/commands\)/)
      })
    })
  })
})

function review(): ReviewPayload {
  return {
    level: 'heavy',
    base: 'a'.repeat(40),
    head: HEAD,
    score: 4,
    verdict: 'APPROVE',
    model: 'anthropic/claude-opus-5.5',
    provider: 'Anthropic',
    costUsd: 0.31,
    promptTokens: 1000,
    completionTokens: 200,
    summary: 'The PR is correct.',
    risk: 'Low.',
    diagram: null,
    deeperReview: null,
    findings: [],
    notReviewed: [],
    skipped: [],
  }
}
