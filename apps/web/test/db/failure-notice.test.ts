// The comment that tells a pull request why its job failed after its last attempt (REV-35). Postgres
// is real; GitHub is the fake of test/fake-github.ts.
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
const NOT_FOUND =
  'no model gave a usable answer: ProviderError: Anthropic answered 404: ' +
  '{"type":"error","error":{"type":"not_found_error","message":"model: anthropic/claude-sonnet-5.5"},"request_id":"req_011CXk7rT2mVb9QpLzN4wYhD8eFs"}'

let pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

describe('comment of a failed job', () => {
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

  async function failedJob(input: { state?: string; kind?: string; level?: string; reason?: string; commentId?: number; finishedAgo?: string } = {}) {
    let [row] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, github_comment_id, attempts, failure_reason, finished_at)
      values (${repoId}, ${input.kind ?? 'review'}, ${input.level ?? 'lite'}, ${input.state ?? 'failed'}, ${PR}, ${HEAD}, 'main',
        ${input.commentId ?? null}, 3, ${input.reason ?? NOT_FOUND}, now() - ${input.finishedAgo ?? '0 seconds'}::interval)
      returning id`
    return row!.id
  }

  async function noticedAt(id: string): Promise<Date | null> {
    let [row] = await database.sql<{ at: Date | null }[]>`select failure_noticed_at as at from jobs where id = ${id}`
    return row!.at
  }

  const failureComments = () => fake.state.issueComments.filter((c) => c.body.includes('<!-- kento:failure '))

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

  it('1. a failed review of a push gets one comment: the level, the commit, the reason, the retry and the config', async () => {
    let id = await failedJob()
    await publisher().publishPending()

    assert.equal(failureComments().length, 1)
    let body = failureComments()[0]!.body
    assert.ok(body.startsWith(`**Kentō · review failed** at commit \`${HEAD.slice(0, 9)}\``), body)
    assert.ok(body.includes('The `lite` review of this commit failed'), body)
    assert.ok(body.includes('Anthropic answered 404'), body)
    assert.ok(body.includes('model: anthropic/claude-sonnet-5.5'), body)
    assert.ok(body.includes('`@kento-review lite`'), body)
    assert.ok(body.includes(`(https://review.test/repos/${repoId}/config)`), body)
    assert.ok(body.endsWith(`<!-- kento:failure ${id} -->`), body)
    assert.notEqual(await noticedAt(id), null)
    assert.deepEqual(fake.state.tokens.at(-1)!.permissions, { pull_requests: 'write', issues: 'write' })
  })

  it('2. a second pass of the publisher posts nothing more', async () => {
    await failedJob()
    await publisher().publishPending()
    let calls = fake.state.calls.length
    await publisher().publishPending()
    assert.equal(failureComments().length, 1)
    assert.equal(fake.state.calls.length, calls)
  })

  it('3. a head that a newer push moved gets no comment, and the job is marked', async () => {
    let id = await failedJob()
    fake.state.pr.head = headSha(0xfff)
    await publisher().publishPending()
    assert.equal(fake.state.issueComments.length, 0)
    assert.notEqual(await noticedAt(id), null)
  })

  it('4. a closed pull request gets no comment, and the job is marked', async () => {
    let id = await failedJob()
    fake.state.pr.state = 'closed'
    await publisher().publishPending()
    assert.equal(fake.state.issueComments.length, 0)
    assert.notEqual(await noticedAt(id), null)
  })

  it('5. a key in the reason is masked', async () => {
    let key = 'sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'
    await failedJob({ reason: `the provider "Anthropic" refused its key (401): invalid x-api-key ${key}` })
    await publisher().publishPending()
    let body = failureComments()[0]!.body
    assert.ok(!body.includes(key), body)
    assert.ok(body.includes('invalid x-api-key ***'), body)
  })

  it('6. a cancelled job gets no comment, and stays unmarked', async () => {
    let id = await failedJob({ state: 'cancelled', reason: 'superseded' })
    await publisher().publishPending()
    assert.equal(fake.state.issueComments.length, 0)
    assert.equal(await noticedAt(id), null)
  })

  it('7. a failed command names its author, and its comment keeps 😕', async () => {
    fake.state.commentAuthors.set(9001, 'octocat')
    let id = await failedJob({ level: 'heavy', commentId: 9001 })
    await publisher().publishPending()
    assert.deepEqual([...fake.state.reactions], ['9001:confused'])
    assert.equal(failureComments().length, 1)
    let body = failureComments()[0]!.body
    assert.ok(body.includes('@octocat The `heavy` review of this commit failed'), body)
    assert.ok(body.endsWith(`<!-- kento:failure ${id} -->`), body)
  })

  it('8. a failed resolve gets the comment of a resolution; an unknown author is no mention', async () => {
    await failedJob({ kind: 'resolve', level: 'balanced', commentId: 9002, reason: 'lease expired 2 times' })
    await publisher().publishPending()
    let body = failureComments()[0]!.body
    assert.ok(body.startsWith('**Kentō · thread resolution failed**'), body)
    assert.ok(body.includes('\n\nThe `balanced` thread resolution of this commit failed'), body)
    assert.ok(body.includes('Reason: `lease expired 2 times`'), body)
    assert.ok(body.includes('`@kento-review resolve balanced`'), body)
  })

  it('9. an old failure, or a failure in a suspended org, gets nothing', async () => {
    let old = await failedJob({ finishedAgo: '2 hours' })
    await publisher().publishPending()
    assert.equal(await noticedAt(old), null)

    await database.sql`update orgs set suspended_at = now() where id = ${orgId}`
    let suspended = await failedJob()
    await publisher().publishPending()
    assert.equal(fake.state.issueComments.length, 0)
    assert.equal(await noticedAt(suspended), null)
  })

  it('10. a failure of GitHub on the comment is one try: the job stays marked, and nothing posts later', async () => {
    let id = await failedJob()
    fake.state.failIssueComments = 1
    await publisher().publishPending()
    assert.notEqual(await noticedAt(id), null)
    await publisher().publishPending()
    assert.equal(fake.state.issueComments.length, 0)
  })
})
