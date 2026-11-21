// REV-99. A finding that the runner linked to an earlier finding (`follows`) goes in the thread of
// that finding: Kentō answers in it, opens it again when it was resolved, and opens no new thread. A
// defect that no earlier finding names still gets its own thread. The titles translate those of
// example-repo#62 (2026-11-08).
import { findingKey } from '@kento-review/engine/findings'
import type { ReviewFinding, ReviewPayload } from '@kento-review/protocol'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BOT, createFakeGitHub } from '../../test/fake-github.ts'
import type { FindingsLedger, LedgerEntry } from '../findings/ledger.ts'
import type { StoredFinding } from '../findings/lifecycle.ts'
import { createGitHub } from './github.ts'
import { publishReview } from './publish.ts'

const BASE = 'a'.repeat(40)
const HEAD1 = '1'.repeat(40)
const HEAD2 = '2'.repeat(40)
const HEAD3 = '3'.repeat(40)
const BILLING = 'app/lib/billing.server.ts'

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: BILLING,
    start_line: 372,
    line: 372,
    severity: 'major',
    category: 'bug',
    confidence: 90,
    title: 'Row written before Stripe, then rolled back on a Stripe error',
    scenario: 'The row is written, then Stripe refuses.',
    fix: 'Write after Stripe.',
    suggestion: '',
    anchor: 372,
    blocking: true,
    suggestion_range: null,
    ...overrides,
  }
}

/** The first finding, then a finding that the runner linked to it. */
const rowBeforeStripe = finding()
const rowNotUndone = finding({
  line: 395,
  start_line: 395,
  anchor: 395,
  title: 'Stripe writes not undone if the commit fails or if the database fails on an existing schedule',
  follows: findingKey(rowBeforeStripe),
})

function payload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    level: 'balanced',
    base: BASE,
    head: HEAD1,
    score: 2,
    verdict: 'REQUEST_CHANGES',
    model: 'claude-sonnet-5-5',
    provider: 'Anthropic',
    costUsd: 0.12,
    promptTokens: 1000,
    completionTokens: 200,
    summary: 'Summary.',
    risk: 'Risk.',
    diagram: null,
    deeperReview: null,
    findings: [rowBeforeStripe],
    notReviewed: [],
    skipped: [],
    ...overrides,
  }
}

/** The findings of the pull request in memory, written as the database would write them. */
function memoryLedger() {
  let rows: StoredFinding[] = []
  let events: { id: string; type: string }[] = []
  let ledger: FindingsLedger = {
    async load() {
      return rows.map((r) => ({ ...r, loadedStatus: r.status }))
    },
    async save(entries: LedgerEntry[]) {
      for (let e of entries) {
        let row = e.id === null ? undefined : rows.find((r) => r.id === e.id)
        if (!row) {
          row = { ...e.values, id: `row-${rows.length + 1}` }
          rows.push(row)
        } else Object.assign(row, e.values)
        for (let ev of e.events) events.push({ id: row.id!, type: ev.type })
      }
      return new Set(entries.flatMap((e) => (e.id ? [e.id] : [])))
    },
  }
  return { ledger, rows, events }
}

function setup() {
  let fake = createFakeGitHub({ head: HEAD1, commits: { [HEAD1]: 'feat: billing', [HEAD2]: 'fix: billing', [HEAD3]: 'fix: billing again' } })
  fake.state.canResolve = true
  let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
  let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com' }
  let memory = memoryLedger()
  let warnings: string[] = []
  let publish = (review: ReviewPayload) => {
    fake.state.pr.head = review.head
    return publishReview(github, target, review, { findings: memory.ledger, warn: (event) => warnings.push(event) })
  }
  return { fake, publish, memory, warnings }
}

describe('a finding that follows an earlier finding (REV-99)', () => {
  it('goes in the thread of an open finding: one reply, no new thread, one row', async () => {
    let { fake, publish, memory, warnings } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()

    let outcome = await publish(payload({ head: HEAD2, findings: [rowNotUndone] }))

    assert.deepEqual(warnings, [])
    assert.equal(outcome.inline, 0)
    assert.equal(outcome.followed, 1)
    assert.equal(fake.botThreads().length, 1, 'no new thread')
    let replies = fake.repliesTo(thread!.id)
    assert.equal(replies.length, 1)
    assert.match(replies[0]!.body, /^The review of commit `222222222` still finds this finding\./)
    assert.match(replies[0]!.body, /\*\*Stripe writes not undone if the commit fails/)
    assert.match(replies[0]!.body, new RegExp(`<!-- kento:variant ${HEAD2} ${findingKey(rowNotUndone)} -->`))
    assert.equal(memory.rows.length, 1, 'one defect, one finding')
    assert.equal(memory.rows[0]!.githubCommentId, thread!.id)
    assert.match(fake.state.pr.body, new RegExp(`#discussion_r${thread!.id}">\`Thread\`</a>`), 'the block links to the thread of the earlier finding')

    // A second publication of the same head does not answer twice.
    await publish(payload({ head: HEAD2, findings: [rowNotUndone] }))
    assert.equal(fake.repliesTo(thread!.id).length, 1)

    // The next review finds the new wording again: the thread still carries it, no new thread, no reply.
    let next = await publish(payload({ head: HEAD3, findings: [{ ...rowNotUndone, follows: undefined }] }))
    assert.equal(next.inline, 0)
    assert.equal(fake.botThreads().length, 1)
    assert.equal(fake.repliesTo(thread!.id).length, 1)
  })

  it('opens again the resolved thread of a fixed finding, answers in it, and opens the finding again', async () => {
    let { fake, publish, memory } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    // HEAD2 changes the file and the review no longer finds it: fixed, thread resolved.
    fake.state.compare.set(`${HEAD1}...${HEAD2}`, { status: 'ahead', files: [BILLING] })
    await publish(payload({ head: HEAD2, score: 4, verdict: 'APPROVE', findings: [] }))
    assert.equal(memory.rows[0]!.status, 'fixed')
    assert.ok(fake.state.resolved.has(thread!.id))

    let outcome = await publish(payload({ head: HEAD3, findings: [rowNotUndone] }))

    assert.equal(outcome.inline, 0)
    assert.equal(outcome.followed, 1)
    assert.ok(!fake.state.resolved.has(thread!.id), 'the thread is open again')
    let replies = fake.repliesTo(thread!.id)
    assert.match(replies.at(-1)!.body, /^This finding comes back at commit `333333333`\. The fix did not remove all of it\./)
    assert.equal(fake.botThreads().length, 1)
    assert.equal(memory.rows.length, 1)
    assert.equal(memory.rows[0]!.status, 'open')
    assert.deepEqual(memory.events.map((e) => e.type), ['opened', 'fixed', 'reopened'])
  })

  it('guard: a defect that follows nothing gets its own thread, in the same review', async () => {
    let { fake, publish, memory } = setup()
    await publish(payload())
    let unrelated = finding({ line: 120, start_line: 120, anchor: 120, title: 'The Stripe refusal counts as a success in the log' })

    let outcome = await publish(payload({ head: HEAD2, findings: [rowNotUndone, unrelated] }))

    assert.equal(outcome.inline, 1)
    assert.equal(outcome.followed, 1)
    assert.equal(fake.botThreads().length, 2)
    assert.equal(memory.rows.length, 2)
    assert.equal(fake.state.reviews.at(-1)!.state, 'CHANGES_REQUESTED', 'the new P1 blocks')
  })

  it('keeps the decision of a person: a follower of a dismissed finding comes back only when GitHub shows its file changed', async () => {
    let { fake, publish, memory } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    Object.assign(memory.rows[0]!, { status: 'dismissed', statusReason: 'False: the row is a copy of the schedule.' })
    fake.state.resolved.add(thread!.id)

    // The file did not change since the last review of the finding: the follower is left out.
    fake.state.compare.set(`${HEAD1}...${HEAD2}`, { status: 'ahead', files: [] })
    let kept = await publish(payload({ head: HEAD2, score: 4, verdict: 'APPROVE', findings: [rowNotUndone] }))
    assert.equal(kept.suppressed, 1)
    assert.equal(kept.followed, 0)
    assert.deepEqual(fake.repliesTo(thread!.id), [])
    assert.ok(fake.state.resolved.has(thread!.id))
    assert.equal(memory.rows[0]!.status, 'dismissed')

    // The file changed since the last review that found it (HEAD2): the defect comes back, in its thread.
    fake.state.compare.set(`${HEAD2}...${HEAD3}`, { status: 'ahead', files: [BILLING] })
    let back = await publish(payload({ head: HEAD3, findings: [rowNotUndone] }))
    assert.equal(back.followed, 1)
    assert.match(fake.repliesTo(thread!.id)[0]!.body, /^The file changed after this finding was dismissed/)
    assert.equal(memory.rows[0]!.status, 'open')
  })

  it('a reply that the finding is gone, after a reply to a follower, ends the thread again', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    await publish(payload({ head: HEAD2, findings: [rowNotUndone] }))
    // GitHub refuses to resolve: the bot answers that the finding is gone.
    fake.state.canResolve = false
    fake.state.compare.set(`${HEAD2}...${HEAD3}`, { status: 'ahead', files: [BILLING] })
    await publish(payload({ head: HEAD3, score: 4, verdict: 'APPROVE', findings: [] }))
    assert.match(fake.repliesTo(thread!.id).at(-1)!.body, /sakuga-review:gone/)

    // The same defect later: the thread no longer carries it, a new thread opens.
    let again = await publish(payload({ head: '4'.repeat(40), findings: [{ ...rowNotUndone, follows: undefined }] }))
    assert.equal(again.inline, 1)
    assert.equal(fake.botThreads().length, 2)
  })
})
