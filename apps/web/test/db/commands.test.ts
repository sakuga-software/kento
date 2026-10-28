// The commands of the comments (REV-7), from the signed `issue_comment` webhook to the job in
// Postgres and the reactions on the comment. Postgres is real; GitHub is the fake of
// test/fake-github.ts: it makes the installation tokens, gives the pull request and the permission
// of the commenter, and keeps the reactions and the comments of the bot.
import { generateKeyPairSync } from 'node:crypto'

import type { Job, ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createCommandHandler } from '../../app/commands/handler.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { createInstallationTokenMinter, readPrivateKey } from '../../app/github/installation-token.ts'
import { headSha, issueCommentPayload, pullRequestPayload, REPO, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { createPublisher } from '../../app/publish/publisher.ts'
import { createAppRouter } from '../../app/router.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { BOT, createFakeGitHub, type FakeGitHub } from '../fake-github.ts'
import { createTestDatabase } from './helpers.ts'

const KENTO_REPOS = new Set(['sakuga-software/sakuga-review'])
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
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 4 }),
      version: 'test',
      commit: null,
      webhook: {
        secret: TEST_SECRET,
        kentoRepos: KENTO_REPOS,
        trustedBots: new Set(['sakuga-agent[bot]']),
        botLogin: BOT,
        apply: createWebhookStore(database.db, {
          kentoRepos: KENTO_REPOS,
          handleCommentCommand: createCommandHandler({
            db: database.db,
            mintInstallationToken: mint(),
            apiUrl: fake.apiUrl,
            kentoRepos: KENTO_REPOS,
            fetch: fake.fetch,
          }),
        }),
      },
      runner: {
        store: createRunnerStore(database.sql),
        registrationToken: REGISTRATION_TOKEN,
        mintInstallationToken: async () => ({ token: 'ghs_clone', expiresAt: '2030-01-01T00:00:00Z' }),
        providerApiKey: null,
        claimWaitMs: 0,
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
    fake = createFakeGitHub({ head: HEAD, pr: PR, repoId: REPO.id })
    fake.state.permissions.set('alex', 'admin')
    fake.state.permissions.set('writer', 'write')
    fake.state.permissions.set('maintainer', 'maintain')
    fake.state.permissions.set('reader', 'read')
    fake.state.permissions.set('triager', 'triage')
  })

  it('1. `@kento review heavy` queues a heavy review of the current head, and answers 👀', async () => {
    let { status, body, payload } = await say('@kento review heavy')
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
    assert.deepEqual(token.permissions, { pull_requests: 'read', issues: 'write' })
    assert.deepEqual(token.repositoryIds, [REPO.id])
  })

  it('2. `@sakuga-review` is an alias, and the name alone asks for a lite review', async () => {
    assert.equal((await say('@sakuga-review review balanced')).body.outcome, 'queued')
    assert.equal((await say('@kento')).body.outcome, 'queued')
    assert.deepEqual((await jobs()).map((j) => j.level), ['balanced', 'lite'])
  })

  it('3. a redelivery, or a replay with a new delivery id, creates no second job', async () => {
    let first = await say('@kento review heavy')
    assert.equal((await replay(first.payload, first.deliveryId)).body.outcome, 'duplicate')
    assert.equal((await replay(first.payload, nextDelivery())).body.outcome, 'duplicate')
    assert.equal((await jobs()).length, 1)
    assert.deepEqual(reactionsOf(first.payload.comment.id), ['eyes'])
  })

  it('4. a heavy asked twice on the same head is paid once; `force` pays again', async () => {
    let first = await say('@kento review heavy')
    let second = await say('@kento review heavy')
    assert.equal(second.body.outcome, 'refused')
    assert.equal(second.body.reason, 'head already has a review at this level')
    assert.deepEqual(reactionsOf(second.payload.comment.id), ['confused'])
    assert.equal(fake.state.issueComments.length, 1)
    assert.match(fake.state.issueComments[0]!.body, /@alex .*déjà une review `heavy`.*@kento review heavy force/s)

    // The replay of the refused comment posts no second reply.
    await replay(second.payload, nextDelivery())
    assert.equal(fake.state.issueComments.length, 1)

    let forced = await say('@kento review heavy force')
    assert.equal(forced.body.outcome, 'queued')
    assert.deepEqual((await jobs()).map((j) => j.level), ['heavy', 'heavy'])
    assert.deepEqual(reactionsOf(first.payload.comment.id), ['eyes'])
  })

  it('5. another level, or a new head, is not a repeat; a failed review does not count', async () => {
    await say('@kento review heavy')
    assert.equal((await say('@kento review balanced')).body.outcome, 'queued')
    fake.state.pr.head = headSha(0xdef)
    assert.equal((await say('@kento review heavy')).body.outcome, 'queued')
    await database.sql`update jobs set state = 'failed', finished_at = now() where head_sha = ${headSha(0xdef)}`
    assert.equal((await say('@kento review heavy')).body.outcome, 'queued')
    assert.equal((await jobs()).length, 4)
  })

  it('6. the lite review of the push counts: `@kento review` on the same head is refused', async () => {
    let push = pullRequestPayload({ action: 'synchronize', number: PR, head: HEAD })
    let pushed = await router().fetch(signedRequest(push, { deliveryId: nextDelivery() }))
    assert.equal(pushed.status, 202)
    assert.equal((await say('@kento review')).body.outcome, 'refused')
    assert.equal((await jobs()).length, 1)
  })

  it('7. only a person who can write gives a command: no job, no reaction, no reply for the others', async () => {
    for (let login of ['reader', 'triager', 'stranger']) {
      let { body, payload } = await say('@kento review heavy', { user: { login, type: 'User' } })
      assert.deepEqual(body, { outcome: 'refused', reason: 'commenter cannot write to the repository' })
      assert.deepEqual(reactionsOf(payload.comment.id), [])
    }
    // An unknown command of a reader gets no list either.
    assert.equal((await say('@kento frobnicate', { user: { login: 'reader', type: 'User' } })).body.outcome, 'refused')
    assert.equal(fake.state.issueComments.length, 0)
    assert.equal((await jobs()).length, 0)

    for (let login of ['writer', 'maintainer']) {
      assert.equal((await say(`@kento review ${login === 'writer' ? 'lite' : 'balanced'}`, { user: { login, type: 'User' } })).body.outcome, 'queued')
    }
  })

  it('8. a bot of KENTO_TRUSTED_BOTS commands without a permission call; another bot never reaches GitHub', async () => {
    let agent = await say('@kento review balanced', { user: { login: 'sakuga-agent[bot]', type: 'Bot' } })
    assert.equal(agent.body.outcome, 'queued')
    assert.equal(permissionCalls().length, 0)

    let calls = fake.state.calls.length
    let other = await say('@kento review heavy', { user: { login: 'dependabot[bot]', type: 'Bot' } })
    assert.equal(other.status, 202)
    assert.equal(other.body.outcome, 'ignored')
    let own = await say('@kento review heavy', { user: { login: BOT, type: 'Bot' } })
    assert.equal(own.body.reason, 'comment of the App itself')
    assert.equal(fake.state.calls.length, calls)
    assert.equal((await jobs()).length, 1)
  })

  it('9. an unknown command gets 😕 and the list of the commands, once', async () => {
    let { body, payload, deliveryId } = await say('@kento frobnicate')
    assert.deepEqual(body, { outcome: 'refused', reason: 'unknown command' })
    assert.deepEqual(reactionsOf(payload.comment.id), ['confused'])
    assert.equal(fake.state.issueComments.length, 1)
    assert.match(fake.state.issueComments[0]!.body, /`@kento frobnicate` n'est pas une commande de Kentō/)
    assert.match(fake.state.issueComments[0]!.body, /@kento review \[lite\|balanced\|heavy\]/)
    await replay(payload, deliveryId)
    assert.equal(fake.state.issueComments.length, 1)
    assert.equal((await jobs()).length, 0)
  })

  it('10. a pull request from a fork, or from a deleted fork, gets no job', async () => {
    fake.state.pr.headRepoId = 9999
    let fork = await say('@kento review heavy')
    assert.deepEqual(fork.body, { outcome: 'refused', reason: 'pull request from a fork' })
    assert.deepEqual(reactionsOf(fork.payload.comment.id), ['confused'])
    assert.match(fake.state.issueComments[0]!.body, /fork/)
    fake.state.pr.headRepoId = null
    assert.equal((await say('@kento review heavy')).body.reason, 'pull request from a fork')
    assert.equal((await jobs()).length, 0)
  })

  it('11. a pull request closed since the comment, or a repository outside KENTO_REPOS, gets no job', async () => {
    fake.state.pr.state = 'closed'
    assert.deepEqual((await say('@kento review heavy')).body, { outcome: 'skipped', reason: 'pull request is closed' })

    let calls = fake.state.calls.length
    let other = { ...REPO, id: 4001, full_name: 'sakuga-software/fruitback' }
    let outside = await say('@sakuga-review review heavy', { repo: other })
    assert.equal(outside.body.outcome, 'ignored')
    assert.match(outside.body.reason, /workflow keeps the command/)
    assert.equal(fake.state.calls.length, calls)
    assert.equal((await jobs()).length, 0)
  })

  it('12. two identical commands at the same time: one job, one refusal', async () => {
    let [a, b] = await Promise.all([say('@kento review heavy'), say('@kento review heavy')])
    assert.deepEqual([a.body.outcome, b.body.outcome].sort(), ['queued', 'refused'])
    assert.equal((await jobs()).length, 1)
  })

  it('13. `resolve` waits for its job: nothing is queued and nothing answers', async () => {
    let { body, payload } = await say('@kento resolve')
    assert.equal(body.outcome, 'skipped')
    assert.deepEqual(reactionsOf(payload.comment.id), [])
    assert.equal((await jobs()).length, 0)
  })

  it('14. a GitHub error fails the delivery (500), so that GitHub can send it again', async () => {
    fake.state.permissions.clear()
    let failing = fake.fetch
    fake.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/collaborators/') ? new Response('{}', { status: 502 }) : failing(input, init)) as typeof fetch
    let { status } = await say('@kento review heavy')
    assert.equal(status, 500)
    assert.equal((await jobs()).length, 0)
  })

  describe('the end of the job', () => {
    async function call(path: string, token: string, body: unknown) {
      return router().fetch(
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

    function publisher() {
      return createPublisher({ sql: database.sql, mintInstallationToken: mint(), apiUrl: fake.apiUrl, botLogin: BOT, fetch: fake.fetch })
    }

    it('15. the review of a command is published, then the comment gets 🚀 (end to end)', async () => {
      let { payload } = await say('@kento review heavy')
      let { job, token } = await claim()
      assert.equal(job.level, 'heavy')
      assert.equal(job.pullRequest.headSha, HEAD)
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
      let { payload } = await say('@kento review heavy')
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
      let { payload } = await say('@kento review heavy')
      let { job, token } = await claim()
      await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: review() })
      fake.state.pr.head = headSha(0xfff)
      let results = await publisher().publishPending()
      assert.deepEqual(results[0], { kind: 'skipped', reviewId: results[0]!.reviewId, reason: 'superseded' })
      assert.deepEqual(reactionsOf(payload.comment.id), ['confused', 'eyes'])
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
