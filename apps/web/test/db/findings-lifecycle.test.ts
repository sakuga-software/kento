// REV-16. The test of the ticket, from push to push: a runner sends each review through the runner
// API, the publisher posts it on the fake GitHub of test/fake-github.ts, and the findings of the pull
// request follow. Postgres is real.
//
// 1. A push that adds a defect → an `open` finding, one comment.
// 2. A push that adds lines above it → the same fingerprint, no new comment.
// 3. A push that fixes it → `fixed`, and its thread gets the answer.
// 4. (👎: the next PR of the stack.)
// 5. The pull request closes → the open findings left become `stale`.
import { generateKeyPairSync } from 'node:crypto'

import { fingerprint } from '@sakuga-review/engine/fingerprint'
import type { Job, ReviewFinding, ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore } from '../../app/db/webhook-store.ts'
import { setFindingStatus } from '../../app/findings/store.ts'
import { createInstallationTokenMinter, readPrivateKey } from '../../app/github/installation-token.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createPublisher } from '../../app/publish/publisher.ts'
import { createAppRouter } from '../../app/router.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { BOT, createFakeGitHub, type FakeGitHub } from '../fake-github.ts'
import { createTestDatabase } from './helpers.ts'

const REGISTRATION_TOKEN = 'registration-token-for-the-tests-0123456789'
const BASE = 'a'.repeat(40)
const HEADS = ['1', '2', '3', '4', '5'].map((c) => c.repeat(40))
const PR = 28
const GONE = '<!-- sakuga-review:gone -->'

let pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

// The files of the pull request at each head, as the runner reads them for the fingerprint.
const SUM_V1 = ['export function sum(a: number, b: number) {', '  return a - b;', '}']
const SUM_V2 = ['// Sums.', '// Two numbers.', '', ...SUM_V1]
const DIV = ['export function div(a: number, b: number) {', '  return a / b;', '}']

type Draft = { path: string; line: number; title: string; file: string[]; severity?: ReviewFinding['severity'] }

/** A finding as the runner sends it: anchored on its line, with the fingerprint of the file at the head. */
function finding(d: Draft): ReviewFinding {
  return {
    path: d.path,
    start_line: d.line,
    line: d.line,
    severity: d.severity ?? 'major',
    category: 'bug',
    confidence: 90,
    title: d.title,
    scenario: 'Un cas qui casse.',
    fix: 'Corriger.',
    suggestion: '',
    anchor: d.line,
    blocking: (d.severity ?? 'major') !== 'minor',
    suggestion_range: null,
    fingerprint: fingerprint(d, d.file),
  }
}

const SUBTRACTS = (line: number, file: string[]) => finding({ path: 'src/sum.ts', line, title: 'La somme soustrait', file })
const DIVIDES = finding({ path: 'src/div.ts', line: 2, title: 'Division par zéro', file: DIV, severity: 'minor' })

function review(head: string, findings: ReviewFinding[]): ReviewPayload {
  return {
    level: 'lite',
    base: BASE,
    head,
    score: findings.some((f) => f.blocking) ? 2 : 4,
    verdict: findings.some((f) => f.blocking) ? 'REQUEST_CHANGES' : 'COMMENT',
    model: 'anthropic/claude-haiku-5.5',
    provider: 'Anthropic',
    costUsd: 0.01,
    promptTokens: 1000,
    completionTokens: 200,
    summary: 'La PR change sum et div.',
    risk: 'Un calcul faux.',
    diagram: null,
    deeperReview: null,
    findings,
    notReviewed: [],
    skipped: [],
  }
}

type Row = { id: string; title: string; status: string; line: number; statusReason: string | null; githubCommentId: number | null }

describe('findings from push to push (REV-16)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let repoId: string
  let orgId: string
  let fake: FakeGitHub

  function newPublisher() {
    let mint = createInstallationTokenMinter({ appId: '12345', privateKey: readPrivateKey(pem), apiUrl: fake.apiUrl, fetch: fake.fetch })
    return createPublisher({ sql: database.sql, mintInstallationToken: mint, apiUrl: fake.apiUrl, botLogin: BOT, fetch: fake.fetch })
  }

  function router() {
    return createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 13 }),
      version: 'test',
      commit: null,
      webhook: disabledWebhook,
      runner: {
        store: createRunnerStore(database.sql),
        registrationToken: REGISTRATION_TOKEN,
        mintInstallationToken: async () => ({ token: 'ghs_clone', expiresAt: '2030-01-01T00:00:00Z' }),
        providerApiKey: null,
        claimWaitMs: 0,
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

  /** A push: GitHub moves the head, a runner reviews it, and the publisher posts the review. */
  async function push(head: string, findings: ReviewFinding[], changed: string[]) {
    let previous = fake.state.pr.head
    fake.state.pr.head = head
    fake.state.commits[head] = `push ${head.slice(0, 1)}`
    // Every earlier head is an ancestor of this one; `changed` lists the files of the last push.
    for (let earlier of HEADS.slice(0, HEADS.indexOf(head))) {
      fake.state.compare.set(`${earlier}...${head}`, { status: 'ahead', files: earlier === previous ? changed : ['src/sum.ts', 'src/div.ts'] })
    }
    await database.sql`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref)
      values (${repoId}, 'lite', ${PR}, ${head}, 'main')`
    let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    let { token } = await registered.json()
    let claimed = await call('/api/runner/jobs/claim', token, { hasProviderKey: true })
    assert.equal(claimed.status, 200)
    let job: Job = await claimed.json()
    let stored = await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: review(head, findings) })
    assert.equal(stored.status, 204)
    let results = await newPublisher().publishPending()
    assert.deepEqual(results.map((r) => r.kind), ['published'])
  }

  async function closePullRequest() {
    let apply = createWebhookStore(database.db)
    let result = await apply(
      {
        type: 'cancel_pull_request',
        installation: { githubInstallationId: 77, githubAccountId: 2001, login: 'sakuga-software' },
        repository: { githubRepoId: 3001, fullName: 'sakuga-software/sakuga-review' },
        prNumber: PR,
      },
      `delivery-close-${Math.random()}`,
    )
    assert.equal(result.outcome, 'cancelled')
  }

  async function findingRows(): Promise<Row[]> {
    let rows = await database.sql<Row[]>`
      select id, title, status, line, status_reason as "statusReason", github_comment_id::float8 as "githubCommentId"
      from findings where repo_id = ${repoId} and pr_number = ${PR} order by created_at, title`
    return rows
  }

  async function events(title: string) {
    return database.sql<{ type: string; actor: string; reason: string | null; reviewed: boolean }[]>`
      select finding_events.type, finding_events.actor, finding_events.reason, finding_events.review_id is not null as reviewed
      from finding_events join findings on findings.id = finding_events.finding_id
      where findings.title = ${title} and findings.repo_id = ${repoId}
      order by finding_events.created_at, finding_events.id`
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 12 })
    let [org] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login)
      values (77, 2001, 'sakuga-software') returning id`
    orgId = org!.id
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${orgId}, 3001, 'sakuga-software/sakuga-review', true) returning id`
    repoId = repo!.id
  })

  beforeEach(async () => {
    await database.sql`delete from jobs`
    await database.sql`delete from findings`
    fake = createFakeGitHub({ head: HEADS[0]!, pr: PR, commits: {} })
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('follows a finding from its push to its fix, then the close of the pull request', async () => {
    // 1. The defect comes in: two open findings, two comments.
    await push(HEADS[0]!, [SUBTRACTS(2, SUM_V1), DIVIDES], ['src/sum.ts', 'src/div.ts'])
    let rows = await findingRows()
    assert.deepEqual(rows.map((r) => [r.title, r.status, r.line]), [
      ['Division par zéro', 'open', 2],
      ['La somme soustrait', 'open', 2],
    ])
    assert.equal(fake.botThreads().length, 2)
    let sumComment = fake.botThreads().find((c) => c.path === 'src/sum.ts')!
    assert.equal(rows.find((r) => r.title === 'La somme soustrait')!.githubCommentId, sumComment.id)
    assert.deepEqual((await events('La somme soustrait')).map((e) => [e.type, e.actor, e.reviewed]), [['opened', 'kento', true]])

    // 2. Three lines above it: line 2 → 5, the same fingerprint, no new comment.
    assert.equal(SUBTRACTS(5, SUM_V2).fingerprint, SUBTRACTS(2, SUM_V1).fingerprint)
    // The thread of GitHub follows its line, as GitHub does on a push.
    sumComment.line = 5
    await push(HEADS[1]!, [SUBTRACTS(5, SUM_V2), DIVIDES], ['src/sum.ts'])
    assert.equal(fake.botThreads().length, 2, 'no new comment')
    assert.equal(fake.state.reviews.at(-1)!.comments, 0)
    rows = await findingRows()
    assert.deepEqual(rows.map((r) => [r.title, r.status, r.line]), [
      ['Division par zéro', 'open', 2],
      ['La somme soustrait', 'open', 5],
    ])
    assert.equal(rows.length, 2, 'no new finding')
    assert.match(fake.state.pr.body, new RegExp(`#discussion_r${sumComment.id}`), 'the description links the thread that carries it')

    // 3. The fix: the finding is not found again, and its file changed → fixed, and its thread
    // gets the answer (the App cannot resolve it here).
    await push(HEADS[2]!, [DIVIDES], ['src/sum.ts'])
    rows = await findingRows()
    assert.deepEqual(rows.map((r) => [r.title, r.status]), [
      ['Division par zéro', 'open'],
      ['La somme soustrait', 'fixed'],
    ])
    assert.equal(fake.repliesTo(sumComment.id).length, 1)
    assert.ok(fake.repliesTo(sumComment.id)[0]!.body.includes(GONE))
    assert.deepEqual((await events('La somme soustrait')).map((e) => e.type), ['opened', 'fixed'])
    // The other finding is not fixed: its file did not change.
    assert.equal(fake.repliesTo(fake.botThreads().find((c) => c.path === 'src/div.ts')!.id).length, 0)

    // 5. The pull request closes: the open finding left is stale; the fixed one stays fixed.
    await closePullRequest()
    rows = await findingRows()
    assert.deepEqual(rows.map((r) => [r.title, r.status]), [
      ['Division par zéro', 'stale'],
      ['La somme soustrait', 'fixed'],
    ])
    assert.deepEqual((await events('Division par zéro')).map((e) => [e.type, e.actor, e.reviewed]), [
      ['opened', 'kento', true],
      ['stale', 'kento', false],
    ])
  })

  it('never comments again on a finding that a person dismissed, and leaves it out of the review', async () => {
    await push(HEADS[0]!, [SUBTRACTS(2, SUM_V1)], ['src/sum.ts'])
    let [row] = await findingRows()
    let change = await setFindingStatus(database.sql, { orgId, findingId: row!.id, status: 'dismissed', reason: 'Voulu : sum soustrait ici.', actor: 'alex' })
    assert.equal(change.outcome, 'changed')
    // The person resolves the thread on GitHub; the next review finds the finding again.
    fake.state.resolved.add(fake.botThreads()[0]!.id)

    await push(HEADS[1]!, [SUBTRACTS(5, SUM_V2)], ['src/sum.ts'])

    assert.equal(fake.botThreads().length, 1, 'no new comment')
    let last = fake.state.reviews.at(-1)!
    assert.doesNotMatch(last.body, /La somme soustrait/)
    assert.notEqual(last.state, 'CHANGES_REQUESTED', 'a dismissed finding blocks nothing')
    let [after] = await findingRows()
    assert.deepEqual([after!.status, after!.statusReason, after!.line], ['dismissed', 'Voulu : sum soustrait ici.', 5])
    assert.deepEqual((await events('La somme soustrait')).map((e) => [e.type, e.actor, e.reason]), [
      ['opened', 'kento', null],
      ['dismissed', 'alex', 'Voulu : sum soustrait ici.'],
    ])

    // « Rouvrir »: the next review comments on it again.
    assert.equal((await setFindingStatus(database.sql, { orgId, findingId: row!.id, status: 'open', actor: 'alex' })).outcome, 'changed')
    await push(HEADS[2]!, [SUBTRACTS(5, SUM_V2)], [])
    assert.equal(fake.botThreads().length, 2, 'a new comment: its old thread is resolved')
  })

  it('asks a reason for a dismissal, and writes no event for a status that does not change', async () => {
    await push(HEADS[0]!, [SUBTRACTS(2, SUM_V1)], ['src/sum.ts'])
    let [row] = await findingRows()
    let set = (status: 'dismissed' | 'wontfix' | 'open', reason?: string, org = orgId) =>
      setFindingStatus(database.sql, { orgId: org, findingId: row!.id, status, reason, actor: 'camille' })

    assert.deepEqual(await set('dismissed', '   '), { outcome: 'invalid', reason: 'a dismissal needs a reason' })
    assert.equal((await set('dismissed', 'x'.repeat(501))).outcome, 'invalid')
    assert.equal((await set('open')).outcome, 'unchanged')
    assert.equal((await set('wontfix', '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000')).outcome, 'not_found')
    let kept = await set('wontfix')
    assert.equal(kept.outcome, 'changed')
    assert.equal(kept.outcome === 'changed' && kept.finding.status, 'wontfix')
    assert.equal((await set('wontfix')).outcome, 'unchanged')
    assert.deepEqual((await events('La somme soustrait')).map((e) => [e.type, e.actor]), [
      ['opened', 'kento'],
      ['wontfix', 'camille'],
    ])
  })

  it('opens a fixed finding again when a review finds it again, with a new comment', async () => {
    await push(HEADS[0]!, [SUBTRACTS(2, SUM_V1)], ['src/sum.ts'])
    await push(HEADS[1]!, [], ['src/sum.ts'])
    assert.equal((await findingRows())[0]!.status, 'fixed')

    await push(HEADS[2]!, [SUBTRACTS(5, SUM_V2)], ['src/sum.ts'])

    let [row] = await findingRows()
    assert.equal(row!.status, 'open')
    assert.equal(fake.botThreads().length, 2, 'the old thread was answered as gone: a new one')
    assert.equal(row!.githubCommentId, fake.botThreads()[1]!.id)
    assert.deepEqual((await events('La somme soustrait')).map((e) => e.type), ['opened', 'fixed', 'reopened'])
  })

  it('keeps open a finding not found again on a file that did not change', async () => {
    await push(HEADS[0]!, [SUBTRACTS(2, SUM_V1), DIVIDES], ['src/sum.ts', 'src/div.ts'])
    await push(HEADS[1]!, [DIVIDES], ['src/div.ts'])
    assert.deepEqual((await findingRows()).map((r) => [r.title, r.status]), [
      ['Division par zéro', 'open'],
      ['La somme soustrait', 'open'],
    ])
  })

  it('tells apart two findings of one title in one file by the code around them, after their lines move', async () => {
    const twice = ['function a(x: number) {', '  return 1 / x;', '}', 'function b(y: number) {', '  return 2 / y;', '}']
    const moved = ['// Two divisions.', '', ...twice]
    let at = (line: number, file: string[]) => finding({ path: 'src/div.ts', line, title: 'Division par zéro', file })
    await push(HEADS[0]!, [at(2, twice), at(5, twice)], ['src/div.ts'])
    let before = await database.sql<{ id: string; line: number }[]>`select id, line from findings order by line`

    // The lines move by two, and the model lists them in the other order: the key (path and title)
    // is the same for both, the fingerprint is not.
    await push(HEADS[1]!, [at(7, moved), at(4, moved)], ['src/div.ts'])

    let after = await database.sql<{ id: string; line: number }[]>`select id, line from findings order by line`
    assert.deepEqual(after.map((r) => [r.id, r.line]), [
      [before[0]!.id, 4],
      [before[1]!.id, 7],
    ])
    assert.equal(fake.botThreads().length, 2, 'no new comment')
  })

  it('writes the findings again on the next try when their write failed after the review was posted', async () => {
    // The insert of a finding fails once, as on a lost connection, after the review is on GitHub.
    await database.sql.unsafe(`
      create table fail_findings (id int);
      insert into fail_findings values (1);
      create function fail_findings() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from fail_findings) then raise exception 'connection lost'; end if;
        return new;
      end $$;
      create trigger fail_findings before insert on findings for each row execute function fail_findings();`)
    try {
      fake.state.pr.head = HEADS[0]!
      fake.state.commits[HEADS[0]!] = 'push 1'
      await database.sql`insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', ${PR}, ${HEADS[0]!}, 'main')`
      let registered = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
      let { token } = await registered.json()
      let job: Job = await (await call('/api/runner/jobs/claim', token, { hasProviderKey: true })).json()
      await call(`/api/runner/jobs/${job.id}/result`, token, { outcome: 'done', attempt: job.attempt, review: review(HEADS[0]!, [SUBTRACTS(2, SUM_V1)]) })

      let publisher = newPublisher()
      assert.deepEqual((await publisher.publishPending()).map((r) => r.kind), ['failed'])
      assert.equal(fake.state.reviews.length, 1, 'the review is on GitHub')
      assert.equal((await findingRows()).length, 0)
      let [unmarked] = await database.sql<{ publishedAt: Date | null }[]>`select published_at as "publishedAt" from reviews`
      assert.equal(unmarked!.publishedAt, null, 'not marked: the next try writes the findings')

      await database.sql`delete from fail_findings`
      assert.deepEqual((await publisher.publishPending()).map((r) => r.kind), ['published'])

      assert.equal(fake.state.reviews.length, 1, 'no second review')
      assert.equal(fake.botThreads().length, 1, 'no second comment')
      let rows = await findingRows()
      assert.deepEqual(rows.map((r) => [r.title, r.status, r.githubCommentId]), [['La somme soustrait', 'open', fake.botThreads()[0]!.id]])
      assert.deepEqual((await events('La somme soustrait')).map((e) => e.type), ['opened'])
    } finally {
      await database.sql.unsafe('drop trigger fail_findings on findings; drop function fail_findings(); drop table fail_findings;')
    }
  })

  it('comments on a finding at the next push when GitHub refused its line, with no second row', async () => {
    // GitHub refuses the inline comments: the review goes without them, and the finding has no thread.
    fake.state.refuseInline = true
    await push(HEADS[0]!, [SUBTRACTS(2, SUM_V1)], ['src/sum.ts'])
    let rows = await findingRows()
    assert.deepEqual(rows.map((r) => [r.status, r.githubCommentId]), [['open', null]])
    assert.equal(fake.botThreads().length, 0)

    fake.state.refuseInline = false
    await push(HEADS[1]!, [SUBTRACTS(5, SUM_V2)], ['src/sum.ts'])
    rows = await findingRows()
    assert.equal(rows.length, 1, 'the same finding, found again by its fingerprint')
    assert.equal(fake.botThreads().length, 1, 'one comment, the first one')
    assert.equal(rows[0]!.githubCommentId, fake.botThreads()[0]!.id)

    // The push after it posts nothing more: the thread carries the finding.
    await push(HEADS[2]!, [SUBTRACTS(5, SUM_V2)], [])
    assert.equal(fake.botThreads().length, 1)
  })

  it('keeps the thread of a stale finding when the pull request is reopened, and fixes it like an open one', async () => {
    await push(HEADS[0]!, [SUBTRACTS(2, SUM_V1), DIVIDES], ['src/sum.ts', 'src/div.ts'])
    await closePullRequest()
    assert.deepEqual((await findingRows()).map((r) => r.status), ['stale', 'stale'])

    // Reopened: the review finds the first one again, and the file of the second changed without it.
    await push(HEADS[1]!, [SUBTRACTS(2, SUM_V1)], ['src/div.ts'])

    assert.equal(fake.botThreads().length, 2, 'no second comment: the open thread still carries it')
    let rows = await findingRows()
    assert.deepEqual(rows.map((r) => [r.title, r.status]), [
      ['Division par zéro', 'fixed'],
      ['La somme soustrait', 'open'],
    ])
    assert.equal(fake.repliesTo(fake.botThreads().find((c) => c.path === 'src/div.ts')!.id).length, 1, 'its thread gets the answer')
    assert.deepEqual((await events('La somme soustrait')).map((e) => e.type), ['opened', 'stale', 'reopened'])
  })

  it('keeps a status that a person set while the review was being published', async () => {
    await push(HEADS[0]!, [SUBTRACTS(2, SUM_V1)], ['src/sum.ts'])
    let [row] = await findingRows()
    // The next review reads the finding open; a person dismisses it while GitHub takes the review.
    fake.state.onReview = async () => {
      fake.state.onReview = null
      await setFindingStatus(database.sql, { orgId, findingId: row!.id, status: 'dismissed', reason: 'Faux positif.', actor: 'alex' })
    }
    await push(HEADS[1]!, [SUBTRACTS(5, SUM_V2)], ['src/sum.ts'])

    let [after] = await findingRows()
    assert.deepEqual([after!.status, after!.statusReason, after!.line], ['dismissed', 'Faux positif.', 5])
    assert.deepEqual((await events('La somme soustrait')).map((e) => [e.type, e.actor]), [
      ['opened', 'kento'],
      ['dismissed', 'alex'],
    ])
  })

  it('takes the open threads of an earlier release as findings, and finds them again by their key', async () => {
    // A thread of a review before the table: no row.
    let body = `<img alt="P1" src="x"> **La somme soustrait**\n\nUn cas.\n\n<!-- sakuga-review:finding ${'0'.repeat(12)} -->`
    let legacy = fake.addThread({ path: 'src/sum.ts', line: 2, body, commit: HEADS[0]! })
    let other = fake.addThread({ path: 'src/div.ts', line: 2, body: body.replace('La somme soustrait', 'Ancien constat').replace('0'.repeat(12), 'f'.repeat(12)), commit: HEADS[0]! })

    // The review finds the first one again a line away; the second is not found, and its file changed.
    await push(HEADS[1]!, [SUBTRACTS(3, SUM_V1)], ['src/div.ts'])

    assert.equal(fake.botThreads().length, 2, 'no new comment for the finding that a thread carries')
    let rows = await findingRows()
    let byTitle = new Map(rows.map((r) => [r.title, r]))
    assert.equal(byTitle.get('La somme soustrait')!.status, 'open')
    assert.equal(byTitle.get('La somme soustrait')!.githubCommentId, legacy)
    assert.equal(byTitle.get('Ancien constat')!.status, 'fixed')
    assert.equal(fake.repliesTo(other).length, 1)
  })
})
