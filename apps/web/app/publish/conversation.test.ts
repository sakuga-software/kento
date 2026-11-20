// REV-103. Every P0 and P1 gets a conversation on GitHub. Below the blocking confidence, its thread
// has the mark "to check" and does not block. Outside the diff, it gets a comment on its file,
// with a link to its line. A P1 to consider (REV-100) gets a thread with the mark "to consider"
// only when the published score is below 4 and no other new P0 or P1 is in the review.
import type { ReviewFinding, ReviewPayload } from '@kento/protocol'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BOT, createFakeGitHub } from '../../test/fake-github.ts'
import type { FindingsLedger, LedgerEntry } from '../findings/ledger.ts'
import type { StoredFinding } from '../findings/lifecycle.ts'
import { createGitHub } from './github.ts'
import { publishReview } from './publish.ts'

const HEAD1 = '1'.repeat(40)
const HEAD2 = '2'.repeat(40)
const SUM = 'src/sum.ts'
const CONFIG = 'src/config.ts'

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: SUM,
    start_line: 2,
    line: 2,
    severity: 'major',
    category: 'bug',
    confidence: 90,
    title: 'The sum subtracts',
    scenario: 'sum(1, 2) returns -1.',
    fix: 'Put + back.',
    suggestion: '',
    anchor: 2,
    blocking: true,
    suggestion_range: null,
    ...overrides,
  }
}

function payload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    level: 'lite',
    base: 'a'.repeat(40),
    head: HEAD1,
    score: 3,
    verdict: 'COMMENT',
    model: 'm',
    provider: null,
    costUsd: 0.01,
    promptTokens: 1,
    completionTokens: 1,
    summary: 'Summary.',
    risk: 'Risk.',
    diagram: null,
    deeperReview: null,
    findings: [finding()],
    notReviewed: [],
    skipped: [],
    ...overrides,
  }
}

function setup(head = HEAD1) {
  let fake = createFakeGitHub({ head, commits: { [HEAD1]: 'feat', [HEAD2]: 'fix' } })
  let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
  let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com', icons: { base: 'https://review.test/assets/pr/' } }
  let rows: StoredFinding[] = []
  let failSaves = 0
  let ledger: FindingsLedger = {
    async load() {
      return rows.map((r) => ({ ...r, loadedStatus: r.status }))
    },
    async save(entries: LedgerEntry[]) {
      if (failSaves > 0) {
        failSaves--
        throw new Error('the database is down')
      }
      for (let e of entries) {
        if (e.id === null) rows.push({ ...e.values, id: `row-${rows.length + 1}` })
        else Object.assign(rows.find((r) => r.id === e.id)!, e.values)
      }
    },
  }
  let warnings: string[] = []
  let publish = (review: ReviewPayload, marker?: string) =>
    publishReview(github, target, review, { findings: ledger, warn: (event) => warnings.push(event), ...(marker ? { marker } : {}) })
  return { fake, publish, rows, warnings, failNextSave: () => failSaves++ }
}

const titleOf = (body: string) => /\*\*(.+?)\*\*/.exec(body)![1]

describe('a P0 or P1 below the blocking confidence (REV-103)', () => {
  it('gets a thread "to check", and the review comments without asking for changes', async () => {
    let { fake, publish } = setup()
    let outcome = await publish(payload({ findings: [finding({ confidence: 60, blocking: false })] }))
    assert.equal(outcome.inline, 1)
    let [thread] = fake.botThreads()
    assert.equal(thread!.line, 2)
    assert.match(thread!.body, /<img alt="P1" [^>]+><\/picture> <picture><source [^>]+><img alt="to check" /)
    assert.equal(fake.state.reviews.at(-1)!.state, 'COMMENTED')
  })

  it('guard: a sure P1 has no mark and asks for changes', async () => {
    let { fake, publish } = setup()
    await publish(payload({ score: 2, verdict: 'REQUEST_CHANGES' }))
    assert.doesNotMatch(fake.botThreads()[0]!.body, /to check|to consider/)
    assert.equal(fake.state.reviews.at(-1)!.state, 'CHANGES_REQUESTED')
  })

  it('is not held back by MAX_INLINE: six P1 get six threads, and a P2 after them gets none', async () => {
    let { fake, publish } = setup()
    let findings = [
      ...Array.from({ length: 6 }, (_, i) => finding({ title: `P1 ${i}`, confidence: 55, blocking: false, anchor: 10 * (i + 1), line: 10 * (i + 1), start_line: 10 * (i + 1) })),
      finding({ title: 'P2', severity: 'minor', blocking: false, anchor: 100, line: 100, start_line: 100 }),
    ]
    let outcome = await publish(payload({ findings }))
    assert.equal(outcome.inline, 6)
    assert.deepEqual(fake.botThreads().map((c) => titleOf(c.body)), ['P1 0', 'P1 1', 'P1 2', 'P1 3', 'P1 4', 'P1 5'])
  })
})

describe('a P0 or P1 outside the diff (REV-103)', () => {
  let outside = finding({ path: CONFIG, start_line: 40, line: 42, anchor: null, blocking: false, title: 'The config key is read before the load' })

  it('gets a comment on its file that links its lines, and its row keeps the comment', async () => {
    let { fake, publish, rows } = setup()
    let outcome = await publish(payload({ findings: [outside] }))
    assert.equal(outcome.inline, 0)
    assert.equal(outcome.fileComments, 1)
    let [comment] = fake.botThreads()
    assert.equal(comment!.path, CONFIG)
    assert.equal(comment!.line, null)
    assert.equal(comment!.commit, HEAD1)
    assert.ok(
      comment!.body.startsWith(
        `Outside the diff of the PR: [\`${CONFIG}:40-42\`](https://github.com/sakuga-software/sakuga-review/blob/${HEAD1}/${CONFIG}#L40-L42)`,
      ),
    )
    assert.match(comment!.body, /<!-- sakuga-review:finding [0-9a-f]{12} -->/)
    assert.equal(titleOf(comment!.body), outside.title)
    assert.equal(rows[0]!.githubCommentId, comment!.id)
    // The block links the thread, and the review does not block on a finding outside the diff.
    assert.match(fake.state.pr.body, new RegExp(`#discussion_r${comment!.id}"><picture><source [^>]+thread-dark\\.v2\\.svg"><img alt="Thread" [^>]+></picture></a>`))
    assert.equal(fake.state.reviews.at(-1)!.state, 'COMMENTED')
  })

  it('is fixed at the next push that changes its file and no longer finds it: its thread is resolved', async () => {
    let { fake, publish, rows } = setup()
    await publish(payload({ findings: [outside] }))
    let [comment] = fake.botThreads()
    fake.state.canResolve = true
    fake.state.compare.set(`${HEAD1}...${HEAD2}`, { status: 'ahead', files: [CONFIG] })
    let outcome = await publish(payload({ head: HEAD2, score: 5, verdict: 'APPROVE', findings: [] }))
    assert.equal(outcome.fixed, 1)
    assert.equal(outcome.resolved, 1)
    assert.ok(fake.state.resolved.has(comment!.id))
    assert.equal(rows[0]!.status, 'fixed')
  })

  it('found again at the next push, keeps its thread: no second comment', async () => {
    let { fake, publish } = setup()
    await publish(payload({ findings: [outside] }))
    await publish(payload({ head: HEAD2, findings: [outside] }))
    assert.equal(fake.botThreads().length, 1)
  })

  it('is not posted twice when a retry follows a failed write of the findings', async () => {
    let { fake, publish, rows, failNextSave } = setup()
    failNextSave()
    await assert.rejects(publish(payload({ findings: [outside] }), 'review-1'))
    assert.equal(fake.botThreads().length, 1)
    await publish(payload({ findings: [outside] }), 'review-1')
    assert.equal(fake.state.reviews.length, 1)
    assert.equal(fake.botThreads().length, 1)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.githubCommentId, fake.botThreads()[0]!.id)
  })

  it('is not posted twice when a person resolves the comment of the failed try before the retry', async () => {
    let { fake, publish, rows, failNextSave } = setup()
    failNextSave()
    await assert.rejects(publish(payload({ findings: [outside] }), 'review-1'))
    let [comment] = fake.botThreads()
    fake.state.resolved.add(comment!.id)
    await publish(payload({ findings: [outside] }), 'review-1')
    assert.equal(fake.botThreads().length, 1)
    assert.equal(rows[0]!.githubCommentId, comment!.id)
  })

  it('on a file that the pull request does not change, stays in the list of the block', async () => {
    let { fake, publish, warnings } = setup()
    fake.state.prFiles = new Set([SUM])
    let outcome = await publish(payload({ findings: [outside] }))
    assert.equal(outcome.fileComments, 0)
    assert.equal(fake.botThreads().length, 0)
    assert.deepEqual(warnings, ['publish.file_comment_refused'])
    assert.match(fake.state.pr.body, /The config key is read before the load/)
  })

  it('guard: a P2 outside the diff gets no comment', async () => {
    let { fake, publish } = setup()
    await publish(payload({ findings: [{ ...outside, severity: 'minor' }] }))
    assert.equal(fake.botThreads().length, 0)
  })
})

describe('a P1 to consider (REV-100, REV-103)', () => {
  let considered = finding({ seen: true, blocking: false, title: 'STUDIO_HOST is not documented' })

  it('gets a thread "to consider" that does not block when the published score is below 4', async () => {
    let { fake, publish } = setup()
    let outcome = await publish(payload({ score: 3, findings: [considered] }))
    assert.equal(outcome.inline, 1)
    assert.match(fake.botThreads()[0]!.body, /<img alt="P1" [^>]+><\/picture> <picture><source [^>]+><img alt="to consider" /)
    assert.equal(fake.state.reviews.at(-1)!.state, 'COMMENTED')
    assert.match(fake.state.pr.body, /<h3>To consider \(code already reviewed\)<\/h3>/)
  })

  it('stays in the list only when the published score is 4', async () => {
    let { fake, publish } = setup()
    await publish(payload({ score: 4, verdict: 'APPROVE', findings: [considered] }))
    assert.equal(fake.botThreads().length, 0)
    assert.equal(fake.state.reviews.at(-1)!.state, 'APPROVED')
  })

  it('stays in the list only when another new P1 explains the score', async () => {
    let { fake, publish } = setup()
    let other = finding({ title: 'The sum subtracts', confidence: 60, blocking: false, anchor: 30, line: 30, start_line: 30 })
    await publish(payload({ score: 3, findings: [considered, other] }))
    assert.deepEqual(fake.botThreads().map((c) => titleOf(c.body)), ['The sum subtracts'])
  })

  it('guard: a P2 to consider stays in the list, whatever the score', async () => {
    let { fake, publish } = setup()
    await publish(payload({ score: 2, findings: [{ ...considered, severity: 'minor' }] }))
    assert.equal(fake.botThreads().length, 0)
  })
})
