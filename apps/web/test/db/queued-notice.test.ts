// REV-52. The comment that tells a pull request that its job waits in the queue for too long: one
// per pull request (`queue_notices`), removed once no job of the pull request waits for too long.
// Postgres is real; GitHub is the fake of test/fake-github.ts.
import { generateKeyPairSync } from 'node:crypto'

import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createInstallationTokenMinter, readPrivateKey } from '../../app/github/installation-token.ts'
import { headSha } from '../../app/github/test-helpers.ts'
import { createPublisher } from '../../app/publish/publisher.ts'
import { BOT, createFakeGitHub, type FakeGitHub } from '../fake-github.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

const HEAD = headSha(0xabc)
const PR = 28

let pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

describe('comment of a pull request whose job waits in the queue', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let fake: FakeGitHub
  let repoId: string
  let orgId: string

  function publisher() {
    let mint = createInstallationTokenMinter({ appId: '12345', privateKey: readPrivateKey(pem), apiUrl: fake.apiUrl, fetch: fake.fetch })
    return createPublisher({
      sql: database.sql,
      mintInstallationToken: mint,
      apiUrl: fake.apiUrl,
      botLogin: BOT,
      fetch: fake.fetch,
      publicUrl: new URL('https://review.test'),
    })
  }

  async function queuedJob(input: { createdAgo?: string; kind?: string; level?: string; baseRef?: string | null } = {}) {
    let [row] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, created_at)
      values (${repoId}, ${input.kind ?? 'review'}, ${input.level ?? 'balanced'}, 'queued', ${PR}, ${HEAD},
        ${input.baseRef === undefined ? 'main' : input.baseRef}, now() - ${input.createdAgo ?? '12 minutes'}::interval)
      returning id`
    return row!.id
  }

  async function runner(input: { seenAgo: string | null; orgId?: string | null }) {
    let [row] = await database.sql<{ id: string }[]>`
      insert into runners (org_id, name, token_hash, last_seen_at)
      values (${input.orgId === undefined ? orgId : input.orgId}, 'runners-host', ${`hash-${Math.random()}`},
        case when ${input.seenAgo}::text is null then null else now() - ${input.seenAgo ?? '0 s'}::interval end)
      returning id`
    return row!.id
  }

  const queueComments = () => fake.state.issueComments.filter((c) => c.body.includes('<!-- kento:queued '))
  const marker = () => `<!-- kento:queued ${repoId}#${PR} -->`

  async function notices() {
    let rows = await database.sql<{ commentId: string | null; gone: boolean }[]>`
      select github_comment_id as "commentId", gone_at is not null as gone from queue_notices`
    return rows.map((row) => ({ commentId: row.commentId, gone: row.gone }))
  }

  /** Exactly `comments` comments of the queue on GitHub, and as many rows (no row left behind). */
  async function expectState(comments: number, step: string) {
    assert.equal(queueComments().length, comments, `${step}: comments on GitHub`)
    let rows = await notices()
    assert.equal(rows.length, comments, `${step}: rows of queue_notices`)
    if (comments === 1) assert.equal(Number(rows[0]!.commentId), queueComments()[0]!.id, `${step}: the row holds the comment`)
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  beforeEach(async () => {
    await database.sql`truncate orgs, repos, runners, jobs, reviews cascade`
    ;({ repoId, orgId } = await seedEnabledRepo(database.sql))
    fake = createFakeGitHub({ head: HEAD, pr: PR, repoId: 3001 })
  })

  it('1. a job queued for 12 min with no runner ever seen gets one comment: since when, why, and what to do', async () => {
    await queuedJob()
    await publisher().publishPending()

    await expectState(1, 'first run')
    let body = queueComments()[0]!.body
    assert.ok(body.startsWith(`**Kentō · review waiting** at commit \`${HEAD.slice(0, 9)}\``), body)
    assert.match(body, /The `balanced` review of this commit waits for a runner\. It entered the queue on \d{1,2} [A-Z][a-z]{2} \d\d:\d\d UTC\. No Kentō runner is online, and no runner ever called Kentō\./)
    assert.ok(body.includes('There is nothing to run again. This comment then goes away.'), body)
    assert.ok(body.includes('start a runner on the [Runners](https://review.test/runners) screen.'), body)
    assert.ok(body.endsWith(marker()), body)

    // The body does not change from one run to the next: no call to GitHub.
    let calls = fake.state.calls.length
    await publisher().publishPending()
    assert.equal(fake.state.calls.length, calls)
  })

  it('2. says when the last runner was seen, or that the online ones do not take the job', async () => {
    await runner({ seenAgo: '2 hours' })
    await queuedJob()
    await publisher().publishPending()
    assert.match(queueComments()[0]!.body, /No Kentō runner is online \(last signal on \d{1,2} [A-Z][a-z]{2} \d\d:\d\d UTC\)\./)

    // A runner of the service comes online and does not take it: the same comment changes.
    await runner({ seenAgo: '5 seconds', orgId: null })
    await publisher().publishPending()
    await expectState(1, 'cause changed')
    let body = queueComments()[0]!.body
    assert.ok(body.includes('1 runner is online, but it does not take the job'), body)
    assert.ok(body.includes('check the runners'), body)
  })

  it('3. a job queued for 5 min, or one with no base, gets nothing', async () => {
    await queuedJob({ createdAgo: '5 minutes' })
    await queuedJob({ createdAgo: '1 hour', baseRef: null })
    await publisher().publishPending()
    await expectState(0, 'nothing waits for too long')
  })

  it('4. two jobs that wait on one pull request give one comment, about the oldest', async () => {
    await queuedJob({ createdAgo: '30 minutes', level: 'heavy' })
    await queuedJob({ createdAgo: '12 minutes', kind: 'resolve', level: 'lite' })
    await publisher().publishPending()
    await expectState(1, 'two jobs')
    let body = queueComments()[0]!.body
    assert.ok(body.includes('The `heavy` review of this commit (and 1 other job of this PR) waits for a runner'), body)
  })

  it('5. the life of a job, step by step: exactly one comment while it waits, none after, never a row left behind', async () => {
    let one = publisher()
    let id = await queuedJob()
    await one.publishPending()
    await expectState(1, 'first queue')

    // A crash between the POST and the write of the row: the next run finds the comment by its marker.
    await database.sql`update queue_notices set github_comment_id = null, body = null`
    await one.publishPending()
    await expectState(1, 'crash after the POST')

    // A runner takes the job: the comment goes, and its row.
    let runnerId = await runner({ seenAgo: '1 second' })
    await database.sql`update jobs set state = 'running', runner_id = ${runnerId}, started_at = now(), attempts = 1 where id = ${id}`
    await one.publishPending()
    await expectState(0, 'claimed')

    // Its lease expires, and it waits again past its backoff: one new comment.
    await database.sql`update runners set last_seen_at = now() - interval '20 minutes'`
    await database.sql`update jobs set state = 'queued', runner_id = null, not_before = now() - interval '11 minutes' where id = ${id}`
    await one.publishPending()
    await expectState(1, 'requeued after the lease')

    // Two publishers at the same time (two containers during a deploy): still one comment.
    await database.sql`update queue_notices set github_comment_id = null, body = null`
    await Promise.all([one.publishPending(), publisher().publishPending()])
    await expectState(1, 'two publishers')

    // A runner comes back and does not take it (« again », the cause changes): the same comment.
    await database.sql`update runners set last_seen_at = now()`
    await one.publishPending()
    await expectState(1, 'cause changed while waiting')
    assert.ok(queueComments()[0]!.body.includes('1 runner is online'), queueComments()[0]!.body)

    // A crash between the DELETE and the delete of the row: the next DELETE answers 404, and that is done.
    let commentId = queueComments()[0]!.id
    await database.sql`update jobs set state = 'running', started_at = now(), attempts = 2 where id = ${id}`
    fake.state.issueComments = fake.state.issueComments.filter((c) => c.id !== commentId)
    await one.publishPending()
    await expectState(0, 'crash after the DELETE')

    // Second expiry; GitHub refuses the first POST: the row stays without a comment, the next run posts once.
    await database.sql`update jobs set state = 'queued', not_before = now() - interval '11 minutes' where id = ${id}`
    fake.state.failIssueComments = 1
    await one.publishPending()
    assert.equal(queueComments().length, 0)
    await one.publishPending()
    await expectState(1, 'POST refused once')

    // GitHub refuses the DELETE once: the row stays, and the next run deletes the comment.
    await database.sql`update jobs set state = 'done', started_at = now(), finished_at = now() where id = ${id}`
    fake.state.failIssueCommentDeletes = 1
    await one.publishPending()
    assert.equal(queueComments().length, 1)
    await one.publishPending()
    await expectState(0, 'done')
  })

  it('6. a failed job loses its comment of the queue and gets the comment of REV-35, once', async () => {
    let id = await queuedJob()
    await publisher().publishPending()
    await database.sql`
      update jobs set state = 'failed', started_at = now(), finished_at = now(), attempts = 2, failure_reason = 'lease expired 2 times'
      where id = ${id}`
    await publisher().publishPending()
    await publisher().publishPending()
    await expectState(0, 'failed')
    assert.equal(fake.state.issueComments.filter((c) => c.body.includes(`<!-- kento:failure ${id} -->`)).length, 1)
  })

  it('7. a closed pull request gets no comment; its row goes once its job is cancelled', async () => {
    let id = await queuedJob()
    fake.state.pr.state = 'closed'
    await publisher().publishPending()
    assert.equal(fake.state.issueComments.length, 0)
    assert.deepEqual(await notices(), [{ commentId: null, gone: true }])
    let calls = fake.state.calls.length
    await publisher().publishPending()
    assert.equal(fake.state.calls.length, calls, 'no call while it is marked')
    await database.sql`update jobs set state = 'cancelled', finished_at = now() where id = ${id}`
    await publisher().publishPending()
    await expectState(0, 'cancelled')
  })

  it('8. a comment that a person deleted is not posted again while the job waits', async () => {
    await queuedJob()
    await publisher().publishPending()
    fake.state.issueComments = []
    await runner({ seenAgo: '1 second', orgId: null })
    await publisher().publishPending()
    assert.equal(fake.state.issueComments.length, 0)
    assert.deepEqual((await notices()).map((n) => n.gone), [true])
    await publisher().publishPending()
    assert.equal(fake.state.issueComments.length, 0)
  })

  it('9. a suspended org, or a job that began to wait more than a day ago, gets nothing; a suspension removes the row', async () => {
    await queuedJob({ createdAgo: '2 days' })
    await publisher().publishPending()
    await expectState(0, 'too old')

    await queuedJob()
    await publisher().publishPending()
    await expectState(1, 'waits')
    await database.sql`update orgs set suspended_at = now() where id = ${orgId}`
    let calls = fake.state.calls.length
    await publisher().publishPending()
    assert.equal((await notices()).length, 0)
    assert.equal(fake.state.calls.length, calls, 'the token of a suspended installation is not asked for')
  })
})
