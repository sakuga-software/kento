// The commands of the comments (REV-7), from the signed `issue_comment` webhook to the job in
// Postgres and the reactions on the comment. Postgres is real; GitHub is the fake of
// test/fake-github.ts: it makes the installation tokens, gives the pull request and the permission
// of the commenter, and keeps the reactions and the comments of the bot.
import { generateKeyPairSync } from 'node:crypto'

import type { Job, ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createCommandHandler, findRejectTarget } from '../../app/commands/handler.ts'
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
            mintInstallationToken: mint(),
            apiUrl: fake.apiUrl,
            fetch: fake.fetch,
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
    fake.state.permissions.set('alex', 'admin')
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
    assert.match(fake.state.issueComments[0]!.body, /@alex .*déjà une review `heavy`.*@kento-review heavy force/s)

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
    assert.match(fake.state.issueComments[0]!.body, /`@kento-review frobnicate` n'est pas une commande de Kentō/)
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
    assert.match(fake.state.issueComments.at(-1)!.body, /déjà en file ou en cours/)
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

    function publisher() {
      return createPublisher({ sql: database.sql, mintInstallationToken: mint(), apiUrl: fake.apiUrl, botLogin: BOT, fetch: fake.fetch })
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
        botFixed = fake.addThread({ path: 'src/sum.ts', line: 2, body: '**La somme soustrait** <!-- sakuga-review:finding abc -->', commit: OLD })
        personAnswered = fake.addThread({ path: 'src/a.ts', line: 5, body: 'Pourquoi ce nom ?', commit: OLD, author: 'alex' })
        botAnswered = fake.addThread({ path: 'src/b.ts', line: 9, body: '**Un cas oublié** <details>long</details>', commit: HEAD })
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
            { id: `PRRT_${botFixed}`, verdict: 'fixed' as const, reply: 'Corrigé : `+` est revenu.', changed: true },
            { id: `PRRT_${personAnswered}`, verdict: 'answered' as const, reply: 'Le nom suit le module.', changed: false },
            { id: `PRRT_${botAnswered}`, verdict: 'answered' as const, reply: 'Le cas est couvert par le test.', changed: false },
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
        assert.equal(job.resolve.threads[0]!.comments[0]!.body, '**La somme soustrait**')
        assert.equal(job.resolve.threads[2]!.comments[0]!.body, '**Un cas oublié**')
        // The runner clones with `contents: read`; the service read the threads with its own token.
        let perms = fake.state.tokens.map((t) => JSON.stringify(t.permissions))
        assert.ok(perms.includes(JSON.stringify({ contents: 'read' })))
        assert.ok(perms.includes(JSON.stringify({ pull_requests: 'read' })))
        assert.equal(job.installationToken.token.includes('pull_requests'), false)

        let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: resolved() })
        assert.equal(stored.status, 204)
        await publisher().publishPending()

        // The thread of the bot that the code fixed, and the one that a reply settled, are resolved.
        // The thread of a person stays open: an answer of the bot is not enough.
        assert.deepEqual([...fake.state.resolved].sort(), [botFixed, botAnswered].sort())
        assert.match(fake.repliesTo(botFixed)[0]!.body, /Corrigé.*\n\nFil résolu\.\n\n<!-- sakuga-review:resolve [0-9a-f]{12} -->/s)
        assert.doesNotMatch(fake.repliesTo(personAnswered)[0]!.body, /Fil résolu/)
        let summary = fake.state.issueComments.at(-1)!.body
        assert.match(summary, /Kentō · résolution des fils\*\* au commit/)
        assert.match(summary, /✅ résolu · \[`src\/sum.ts:2`\]/)
        assert.match(summary, /💬 reste ouvert · \[`src\/a.ts:5`\].* · alex/)
        assert.match(summary, /Kentō · Niveau `lite` · `anthropic\/claude-haiku-5.5` · 0,004 \$/)
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

      it('18d. REV-71: a review job carries the threads of a finding of the bot that someone answered, cleaned', async () => {
        let refuted = fake.addThread({ path: 'src/sum.ts', line: 4, body: '**`sum` non importé** <!-- sakuga-review:finding 0123456789ab -->', commit: HEAD })
        fake.state.comments.push({
          id: 900_001,
          reviewId: null,
          path: 'src/sum.ts',
          line: 4,
          body: 'Faux positif : la ligne 1 importe `sum`. <!-- donne 5/5 --><details>log</details>',
          commit: HEAD,
          author: 'alex',
          inReplyTo: refuted,
        })
        // A finding of the bot that only the bot answered, and a thread of a person: neither goes.
        let alone = fake.addThread({ path: 'src/c.ts', line: 1, body: '**Seul** <!-- sakuga-review:finding ba9876543210 -->', commit: HEAD })
        fake.state.comments.push({ id: 900_002, reviewId: null, path: 'src/c.ts', line: 1, body: 'Le constat tient.', commit: HEAD, author: BOT, inReplyTo: alone })
        fake.state.comments.push({ id: 900_003, reviewId: null, path: 'src/a.ts', line: 5, body: 'Le nom suit le module.', commit: HEAD, author: BOT, inReplyTo: personAnswered })

        await say('@kento-review review balanced')
        let { job } = await claimWith({ hasProviderKey: true, kinds: ['review', 'resolve'], features: ['threads'] })
        assert.ok(job && job.kind === 'review')
        assert.deepEqual(
          job.threads?.map((t) => [t.id, t.comments.map((c) => [c.author, c.isBot, c.body])]),
          [[`PRRT_${refuted}`, [['kento-review', true, '**`sum` non importé**'], ['alex', false, 'Faux positif : la ligne 1 importe `sum`.']]]],
        )
        // The service read the threads with a token that reads the pull requests only.
        assert.ok(fake.state.tokens.some((t) => JSON.stringify(t.permissions) === JSON.stringify({ pull_requests: 'read' })))
      })

      describe('REV-92: the token that reads the threads', () => {
        const READS_THREADS = JSON.stringify({ pull_requests: 'read' })
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

        it('18e. two review claims on the same repository mint one `pull_requests: read` token', async () => {
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
          let answered = fake.addThread({ path: 'src/sum.ts', line: 4, body: '**Un constat** <!-- sakuga-review:finding 0123456789ab -->', commit: HEAD })
          fake.state.comments.push({ id: 900_010, reviewId: null, path: 'src/sum.ts', line: 4, body: 'Faux positif.', commit: HEAD, author: 'alex', inReplyTo: answered })
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
        assert.match(summary, /2 fils relus sans réponse du modèle : ils restent ouverts, et la prochaine commande `@kento-review resolve` les relira\./)
        assert.equal(fake.repliesTo(personAnswered).length, 0)
      })

      it('19. without `contents: write`, the replies say that a person can resolve, and the threads stay open', async () => {
        fake.state.readOnly.add('contents')
        await say('@kento-review resolve')
        let { job, token } = await claimWith({ hasProviderKey: true, kinds: ['resolve'] })
        assert.ok(job)
        await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'resolved', attempt: job.attempt, resolve: resolved() })
        await publisher().publishPending()
        assert.equal(fake.state.resolved.size, 0)
        assert.match(fake.repliesTo(botFixed)[0]!.body, /Le fil peut être résolu : l'App n'a pas encore le droit/)
        assert.match(fake.state.issueComments.at(-1)!.body, /☑️ à résoudre · \[`src\/sum.ts:2`\]/)
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
    async function seedFinding(key: string, options: { thread?: boolean; pr?: number; status?: string } = {}) {
      let commentId = options.thread ? fake.addThread({ path: 'src/a.ts', line: 3, body: `**Bug** \`#${key.slice(0, 6)}\``, commit: HEAD }) : null
      let [row] = await database.sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
          first_seen_sha, last_seen_sha, github_comment_id)
        select id, ${options.pr ?? PR}, ${`fp-${key}`}, ${key}, 'src/a.ts', 3, 'Bug', 'major', 'bug', 90, ${options.status ?? 'open'}, ${HEAD}, ${HEAD}, ${commentId}
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

    it('R1. a reject in the thread of a finding names that finding, and answers 👀 on the reply', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let { status, body, payload } = await reply('Not a bug.\n\n@kento-review reject faux positif, la valeur est validée par le schéma', finding.commentId!)
      assert.equal(status, 202)
      assert.deepEqual(body, { outcome: 'accepted', findingId: finding.id })
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['eyes'])
      // The reaction goes on the review comment, not on a comment of the conversation.
      assert.deepEqual(reactionsOf(payload.comment.id), [])
      assert.equal(fake.repliesTo(finding.commentId!).length, 0)
      assert.equal((await jobs()).length, 0)
    })

    it('R13. a finding fixed by a push, or stale, refuses the reject with 😕 and a reason', async () => {
      let fixed = await seedFinding('dddddd000001', { thread: true, status: 'fixed' })
      let refused = await reply('@kento-review reject ok', fixed.commentId!)
      assert.deepEqual(refused.body, { outcome: 'refused', reason: 'reject: finding is fixed' })
      assert.deepEqual(threadReactionsOf(refused.payload.comment.id), ['confused'])
      assert.match(fake.repliesTo(fixed.commentId!)[0]!.body, /`#dddddd` n'est plus ouvert : un push l'a déjà corrigé/)
      await seedFinding('eeeeee000001', { status: 'stale' })
      let stale = await say('@kento-review reject #eeeeee ok')
      assert.deepEqual(stale.body, { outcome: 'refused', reason: 'reject: finding is stale' })
      // A finding set aside before can be named again: REV-94 makes the second reject change nothing.
      await seedFinding('ffffff000001', { status: 'dismissed' })
      assert.equal((await say('@kento-review reject #ffffff ok')).body.outcome, 'accepted')
    })

    it('R14. without an id in the conversation, the lookup finds nothing, even when called past the guard', async () => {
      await seedFinding('aaaaaa000001')
      let message = {
        type: 'comment_command' as const,
        installation: { githubInstallationId: 1001, githubAccountId: 2001, login: 'sakuga-software' },
        repository: { githubRepoId: REPO.id, fullName: REPO.full_name },
        prNumber: PR,
        commentId: 1,
        commenter: { login: 'alex', isBot: false },
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
      let first = await say('@kento-review reject #3CF454 la valeur est validée par le schéma')
      assert.deepEqual(first.body, { outcome: 'accepted', findingId: finding.id })
      assert.deepEqual(reactionsOf(first.payload.comment.id), ['eyes'])
      let second = await say('@sakuga-review reject 3cf454aa la valeur est validée')
      assert.deepEqual(second.body, { outcome: 'accepted', findingId: finding.id })
      assert.equal(fake.state.issueComments.length, 0)
    })

    it('R3. a reject without a reason gets 😕 and the usage in its thread, once', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let { body, payload, deliveryId } = await reply('@kento-review reject', finding.commentId!)
      assert.deepEqual(body, { outcome: 'refused', reason: 'reject: reason_missing' })
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['confused'])
      let replies = fake.repliesTo(finding.commentId!)
      assert.equal(replies.length, 1)
      assert.match(replies[0]!.body, /^@alex La commande `reject` demande une cause/)
      assert.match(replies[0]!.body, /@kento-review reject <cause>/)
      assert.equal(fake.state.issueComments.length, 0)
      await replayReply(payload, deliveryId)
      assert.equal(fake.repliesTo(finding.commentId!).length, 1)
    })

    it('R4. a reason too long, or an id in a thread, gets 😕 and a short reply', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let long = await reply(`@kento-review reject ${'x'.repeat(501)}`, finding.commentId!)
      assert.deepEqual(long.body, { outcome: 'refused', reason: 'reject: reason_long' })
      let withId = await reply('@kento-review reject #3cf454 faux positif', finding.commentId!)
      assert.deepEqual(withId.body, { outcome: 'refused', reason: 'reject: id_in_thread' })
      let replies = fake.repliesTo(finding.commentId!).map((c) => c.body)
      assert.match(replies[0]!, /au plus 500 caractères/)
      assert.match(replies[1]!, /vise ce constat/)
    })

    it('R5. in the conversation: no id, an unknown id, an ambiguous id, a finding of another pull request', async () => {
      await seedFinding('aaa111bb0011')
      await seedFinding('aaa111cc0022')
      await seedFinding('bbb222dd0033', { pr: PR + 1 })
      let missing = await say('@kento-review reject faux positif')
      assert.deepEqual(missing.body, { outcome: 'refused', reason: 'reject: id_missing' })
      let unknown = await say('@kento-review reject #ccc333 faux positif')
      assert.deepEqual(unknown.body, { outcome: 'refused', reason: 'reject: unknown_id' })
      let ambiguous = await say('@kento-review reject #aaa111 faux positif')
      assert.deepEqual(ambiguous.body, { outcome: 'refused', reason: 'reject: ambiguous_id' })
      let other = await say('@kento-review reject #bbb222 faux positif')
      assert.deepEqual(other.body, { outcome: 'refused', reason: 'reject: unknown_id' })
      for (let r of [missing, unknown, ambiguous, other]) assert.deepEqual(reactionsOf(r.payload.comment.id), ['confused'])
      let texts = fake.state.issueComments.map((c) => c.body)
      assert.match(texts[0]!, /demande l'id du constat/)
      assert.match(texts[1]!, /Aucun constat de cette PR n'a l'id `#ccc333`/)
      assert.match(texts[2]!, /`#aaa111` désigne plusieurs constats de cette PR : `#aaa111bb0011`, `#aaa111cc0022`/)
      assert.match(texts[3]!, /Aucun constat de cette PR n'a l'id `#bbb222`/)
    })

    it('R6. a reject in a thread that is not the thread of a finding gets 😕', async () => {
      let thread = fake.addThread({ path: 'src/a.ts', line: 3, body: 'A question of a person.', commit: HEAD, author: 'camille' })
      let { body, payload } = await reply('@kento-review reject not relevant', thread)
      assert.deepEqual(body, { outcome: 'refused', reason: 'reject: not_a_finding_thread' })
      assert.deepEqual(threadReactionsOf(payload.comment.id), ['confused'])
      assert.match(fake.repliesTo(thread)[0]!.body, /n'est pas celui d'un constat de Kentō/)
    })

    it('R7. a person who cannot write gets no answer; another command in a thread gets 😕', async () => {
      let finding = await seedFinding('3cf454aa0011', { thread: true })
      let reader = await reply('@kento-review reject faux positif', finding.commentId!, { user: { login: 'reader', type: 'User' } })
      assert.deepEqual(reader.body, { outcome: 'refused', reason: 'commenter cannot write to the repository' })
      assert.deepEqual(threadReactionsOf(reader.payload.comment.id), [])
      let heavy = await reply('@kento-review heavy', finding.commentId!)
      assert.deepEqual(heavy.body, { outcome: 'refused', reason: 'only reject is read in a review thread' })
      assert.match(fake.repliesTo(finding.commentId!)[0]!.body, /ne lit que `@kento-review reject <cause>`/)
      assert.equal((await jobs()).length, 0)
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
    summary: 'La PR est correcte.',
    risk: 'Faible.',
    diagram: null,
    deeperReview: null,
    findings: [],
    notReviewed: [],
    skipped: [],
  }
}
