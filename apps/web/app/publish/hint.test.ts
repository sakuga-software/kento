// REV-96. The second way to the hint of `reject`: the model of the next review calls a thread
// refuted (REV-71), and the publisher answers that thread once with the command and the page of the
// commands. The hint changes no status, and it keeps the thread live for the next review.
import type { ReviewFinding, ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BOT, createFakeGitHub } from '../../test/fake-github.ts'
import { HINT_MARKER } from '../commands/refutation.ts'
import type { FindingsLedger, LedgerEntry } from '../findings/ledger.ts'
import type { StoredFinding } from '../findings/lifecycle.ts'
import { createGitHub } from './github.ts'
import { publishReview } from './publish.ts'

const BASE = 'a'.repeat(40)
const HEAD1 = '1'.repeat(40)
const HEAD2 = '2'.repeat(40)
const HEAD3 = '3'.repeat(40)
const FILE = 'app/schema.ts'
const DOCS = 'https://review.sakuga.dev/docs/commands'

const bug: ReviewFinding = {
  path: FILE,
  start_line: 12,
  line: 12,
  severity: 'major',
  category: 'bug',
  confidence: 90,
  title: 'La valeur du formulaire n’est pas validée',
  scenario: 'Une valeur vide passe.',
  fix: 'Valider la valeur.',
  suggestion: '',
  anchor: 12,
  blocking: true,
  suggestion_range: null,
}

function payload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    level: 'lite',
    base: BASE,
    head: HEAD1,
    score: 2,
    verdict: 'REQUEST_CHANGES',
    model: 'claude-sonnet-5-5',
    provider: 'Anthropic',
    costUsd: 0.01,
    promptTokens: 1000,
    completionTokens: 200,
    summary: 'Résumé.',
    risk: 'Risque.',
    diagram: null,
    deeperReview: null,
    findings: [bug],
    notReviewed: [],
    skipped: [],
    ...overrides,
  }
}

function setup() {
  let fake = createFakeGitHub({ head: HEAD1, commits: { [HEAD1]: 'feat: form', [HEAD2]: 'docs: form', [HEAD3]: 'docs: form again' } })
  fake.state.permissions.set('alex', 'write')
  fake.state.permissions.set('visitor', 'read')
  let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
  let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com', docsUrl: DOCS }
  let rows: StoredFinding[] = []
  /** The findings whose hint is claimed, as `findings.reject_hint_at` holds them. */
  let claimed = new Set<string>()
  let ledger: FindingsLedger = {
    async claimHint(id) {
      if (claimed.has(id) || rows.find((r) => r.id === id)?.status !== 'open') return false
      claimed.add(id)
      return true
    },
    async releaseHint(id) {
      claimed.delete(id)
    },
    async load() {
      return rows.map((r) => ({ ...r, loadedStatus: r.status }))
    },
    async save(entries: LedgerEntry[]) {
      for (let e of entries) {
        let row = e.id === null ? undefined : rows.find((r) => r.id === e.id)
        if (!row) rows.push({ ...e.values, id: `row-${rows.length + 1}` })
        else Object.assign(row, e.values)
      }
    },
  }
  let publish = (review: ReviewPayload) => {
    fake.state.pr.head = review.head
    return publishReview(github, target, review, { findings: ledger })
  }
  /** A reply of `author` in the thread of the comment `root`. */
  let reply = (root: number, author: string, body: string) =>
    fake.state.comments.push({ id: 90_000 + fake.state.comments.length, reviewId: null, path: FILE, line: 12, body, commit: HEAD1, author, inReplyTo: root })
  let hints = (root: number) => fake.repliesTo(root).filter((c) => c.body.includes(HINT_MARKER))
  return { fake, publish, reply, hints, rows, claimed }
}

describe('the hint of `reject` at the next review (REV-96)', () => {
  it('links the page of the commands in the comment of each finding', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    assert.match(thread!.body, /\[Kentō commands\]\(https:\/\/review\.sakuga\.dev\/docs\/commands\)/)
    assert.match(thread!.body, /`@kento-review reject <cause>`/)
  })

  it('answers a thread that the model called refuted, once, and the finding stays open and carried', async () => {
    let { fake, publish, reply, hints, rows } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    // The reply says it in words that the pattern of the webhook does not read.
    reply(thread!.id, 'alex', 'Je ne retiendrais pas ce constat : le schéma valide déjà la valeur.')

    let outcome = await publish(payload({ head: HEAD2, refutedThreads: [`PRRT_${thread!.id}`] }))

    assert.equal(outcome.hinted, 1)
    let [hint] = hints(thread!.id)
    assert.equal(
      hint!.body,
      'This reply seems to set the finding aside. To count it as rejected (it will not come back and will not lower the score again), comment ' +
        `\`@kento-review reject <cause>\`. [Kentō commands](${DOCS})\n\n${HINT_MARKER}`,
    )
    assert.equal(rows[0]!.status, 'open', 'the hint changes no status')
    assert.equal(outcome.inline, 0, 'the open thread still carries the finding: no new thread')

    // The next review calls it refuted again: no second hint, and the thread still carries the finding.
    let next = await publish(payload({ head: HEAD3, refutedThreads: [`PRRT_${thread!.id}`] }))
    assert.equal(next.hinted, 0)
    assert.equal(hints(thread!.id).length, 1)
    assert.equal(next.inline, 0, 'the hint is no last word of the bot')
    assert.equal(fake.botThreads().length, 1)
  })

  it('guard: no hint in a resolved thread, for a finding set aside, or when nobody who can write replied', async () => {
    let { fake, publish, reply, hints, rows } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()

    // Only a reader replied: the command is not theirs to run.
    reply(thread!.id, 'visitor', 'Not a bug, the schema validates it.')
    let byReader = await publish(payload({ head: HEAD2, refutedThreads: [`PRRT_${thread!.id}`] }))
    assert.equal(byReader.hinted, 0)

    // A writer replied, but the thread is resolved.
    reply(thread!.id, 'alex', 'Same here.')
    fake.state.resolved.add(thread!.id)
    let resolved = await publish(payload({ head: HEAD3, refutedThreads: [`PRRT_${thread!.id}`] }))
    assert.equal(resolved.hinted, 0)

    // The finding is set aside: nothing to reject.
    fake.state.resolved.delete(thread!.id)
    rows[0]!.status = 'dismissed'
    let dismissed = await publish(payload({ head: '4'.repeat(40), findings: [], refutedThreads: [`PRRT_${thread!.id}`] }))
    assert.equal(dismissed.hinted, 0)
    assert.deepEqual(hints(thread!.id), [])
  })

  it('guard: no hint when a reply names `reject` already, or when the webhook claimed the hint of the finding', async () => {
    let { fake, publish, reply, hints, rows, claimed } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    reply(thread!.id, 'alex', 'Not applied. To set it aside:\n\n```\n@kento-review reject the schema validates it\n```')
    let named = await publish(payload({ head: HEAD2, refutedThreads: [`PRRT_${thread!.id}`] }))
    assert.equal(named.hinted, 0)

    let { fake: other, publish: publishOther, reply: replyOther, hints: hintsOther, rows: rowsOther, claimed: claimedOther } = setup()
    await publishOther(payload())
    let [second] = other.botThreads()
    replyOther(second!.id, 'alex', 'Je ne retiendrais pas ce constat.')
    claimedOther.add(rowsOther[0]!.id!)
    let taken = await publishOther(payload({ head: HEAD2, refutedThreads: [`PRRT_${second!.id}`] }))
    assert.equal(taken.hinted, 0, 'the webhook posted it, or is posting it')
    assert.deepEqual([...hints(thread!.id), ...hintsOther(second!.id)], [])
    assert.equal(rows[0]!.status, 'open')
    assert.equal(claimed.size, 0)
  })

  it('guard: a thread whose finding has no row (no claim possible) gets no hint', async () => {
    let { fake, publish, reply, hints, rows } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    reply(thread!.id, 'alex', 'Je ne retiendrais pas ce constat.')
    // The ledger forgets the row: the thread is one of an earlier release.
    rows.length = 0
    let outcome = await publish(payload({ head: HEAD2, findings: [], refutedThreads: [`PRRT_${thread!.id}`] }))
    assert.equal(outcome.hinted, 0)
    assert.deepEqual(hints(thread!.id), [])
  })

  it('guard: a review without `refutedThreads` (a runner of an earlier release) posts no hint', async () => {
    let { fake, publish, reply, hints } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    reply(thread!.id, 'alex', 'Not applied: the schema validates it.')
    let outcome = await publish(payload({ head: HEAD2 }))
    assert.equal(outcome.hinted, 0)
    assert.deepEqual(hints(thread!.id), [])
  })
})
