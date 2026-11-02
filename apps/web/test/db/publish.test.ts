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
