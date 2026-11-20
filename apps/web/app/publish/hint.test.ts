// REV-96, REV-116. The hint of `reject`: the model calls a thread refuted, at the next review (REV-71)
// or at a `resolve` command, and Kentō answers that thread once with the command and the page of the
// commands. The hint changes no status, and it keeps the thread live for the next review.
import type { ResolvePayload, ReviewFinding, ReviewPayload } from '@kento-review/protocol'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BOT, createFakeGitHub } from '../../test/fake-github.ts'
import { HINT_MARKER } from '../commands/hint.ts'
import type { FindingsLedger, LedgerEntry } from '../findings/ledger.ts'
import type { StoredFinding } from '../findings/lifecycle.ts'
import { publishResolution, type ResolveHints } from '../resolve/publish.ts'
import { createGitHub } from './github.ts'
import { publishReview } from './publish.ts'

const BASE = 'a'.repeat(40)
const HEAD1 = '1'.repeat(40)
const HEAD2 = '2'.repeat(40)
const HEAD3 = '3'.repeat(40)
const FILE = 'app/schema.ts'
const DOCS = 'https://review.sakuga.dev/docs/commands'
const FRENCH = "C'est un faux positif, la fonction vérifie déjà le null."
const ENGLISH = 'I would not keep this finding: the schema already validates the value.'

const bug: ReviewFinding = {
  path: FILE,
  start_line: 12,
  line: 12,
  severity: 'major',
  category: 'bug',
  confidence: 90,
  title: 'The value of the form is not validated',
  scenario: 'An empty value passes.',
  fix: 'Validate the value.',
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
    summary: 'Summary.',
    risk: 'Risk.',
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
  fake.state.permissions.set('octocat', 'write')
  fake.state.permissions.set('visitor', 'read')
  let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: (input, init) => fake.fetch(input, init) })
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
  let resolveHints: ResolveHints = {
    docsUrl: DOCS,
    findingOf: async (commentId) => rows.find((r) => r.githubCommentId === commentId)?.id ?? null,
    claim: (id) => ledger.claimHint!(id),
    release: (id) => ledger.releaseHint!(id),
  }
  /** A `resolve` command at `head`, with the verdict of the model on each thread. */
  let resolve = (head: string, verdicts: [number, ResolvePayload['threads'][number]['verdict']][], warn = (_event: string) => {}, writer: typeof github | null = null) => {
    fake.state.pr.head = head
    let resolution: ResolvePayload = {
      level: 'lite',
      head,
      model: 'claude-haiku-5-5',
      provider: 'Anthropic',
      costUsd: 0.001,
      promptTokens: 100,
      completionTokens: 20,
      open: verdicts.length,
      waiting: verdicts.length,
      held: verdicts.length,
      threads: verdicts.map(([id, verdict]) => ({ id: `PRRT_${id}`, verdict, reply: 'The model read the thread and the code.', changed: false })),
    }
    return publishResolution(github, writer, { fullName: `${target.owner}/${target.name}`, pr: target.pr, webUrl: target.webUrl }, resolution, warn, resolveHints)
  }
  return { fake, github, publish, resolve, reply, hints, rows, claimed }
}

const other: ReviewFinding = { ...bug, path: 'app/form.ts', title: 'The form sends twice', scenario: 'A double click sends twice.' }
const third: ReviewFinding = { ...bug, path: 'app/list.ts', title: 'The list skips its last item', scenario: 'The loop stops one item early.' }

describe('the hint of `reject` at the next review (REV-96, REV-116)', () => {
  it('answers a thread refuted in French and one refuted in English, and not a thread that the model upheld', async () => {
    let { fake, publish, reply, hints } = setup()
    await publish(payload({ findings: [bug, other, third] }))
    let [french, english, upheld] = fake.botThreads()
    reply(french!.id, 'octocat', FRENCH)
    reply(english!.id, 'octocat', ENGLISH)
    reply(upheld!.id, 'octocat', 'Not applied: the loop is right.')

    let outcome = await publish(payload({ head: HEAD2, findings: [bug, other, third], refutedThreads: [`PRRT_${french!.id}`, `PRRT_${english!.id}`] }))

    assert.equal(outcome.hinted, 2)
    assert.equal(hints(french!.id).length, 1)
    assert.equal(hints(english!.id).length, 1)
    assert.deepEqual(hints(upheld!.id), [], 'the words of a reply give no hint: only the verdict of the model')
  })

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
    reply(thread!.id, 'octocat', 'I would not keep this finding: the schema already validates the value.')

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
    reply(thread!.id, 'octocat', 'Same here.')
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

  it('guard: no hint when a reply names `reject` already, or when a `resolve` claimed the hint of the finding', async () => {
    let { fake, publish, reply, hints, rows, claimed } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    reply(thread!.id, 'octocat', 'Not applied. To set it aside:\n\n```\n@kento-review reject the schema validates it\n```')
    let named = await publish(payload({ head: HEAD2, refutedThreads: [`PRRT_${thread!.id}`] }))
    assert.equal(named.hinted, 0)

    let { fake: other, publish: publishOther, reply: replyOther, hints: hintsOther, rows: rowsOther, claimed: claimedOther } = setup()
    await publishOther(payload())
    let [second] = other.botThreads()
    replyOther(second!.id, 'octocat', 'I would not keep this finding.')
    claimedOther.add(rowsOther[0]!.id!)
    let taken = await publishOther(payload({ head: HEAD2, refutedThreads: [`PRRT_${second!.id}`] }))
    assert.equal(taken.hinted, 0, 'a `resolve` posted it, or is posting it')
    assert.deepEqual([...hints(thread!.id), ...hintsOther(second!.id)], [])
    assert.equal(rows[0]!.status, 'open')
    assert.equal(claimed.size, 0)
  })

  it('guard: a thread whose finding has no row (no claim possible) gets no hint', async () => {
    let { fake, publish, reply, hints, rows } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    reply(thread!.id, 'octocat', 'I would not keep this finding.')
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
    reply(thread!.id, 'octocat', 'Not applied: the schema validates it.')
    let outcome = await publish(payload({ head: HEAD2 }))
    assert.equal(outcome.hinted, 0)
    assert.deepEqual(hints(thread!.id), [])
  })
})

describe('the hint of `reject` at a `resolve` command (REV-116)', () => {
  it('answers a thread answered in French and one answered in English, and not a thread that stays open or is fixed', async () => {
    let { fake, publish, resolve, reply, hints, rows } = setup()
    await publish(payload({ findings: [bug, other, third] }))
    let [french, english, open] = fake.botThreads()
    reply(french!.id, 'octocat', FRENCH)
    reply(english!.id, 'octocat', ENGLISH)
    reply(open!.id, 'octocat', 'Not applied: the loop is right.')

    let outcome = await resolve(HEAD2, [[french!.id, 'answered'], [english!.id, 'answered'], [open!.id, 'open']])

    assert.equal(outcome.hinted, 2)
    let [hint] = hints(french!.id)
    assert.equal(
      hint!.body,
      'This reply seems to set the finding aside. To count it as rejected (it will not come back and will not lower the score again), comment ' +
        `\`@kento-review reject <cause>\`. [Kentō commands](${DOCS})\n\n${HINT_MARKER}`,
    )
    assert.equal(hints(english!.id).length, 1)
    assert.deepEqual(hints(open!.id), [])
    // The hint comes in its own comment, before the reply of the verdict and before the thread closes.
    assert.doesNotMatch(fake.repliesTo(french!.id).at(-1)!.body, /kento:reject-hint/)
    assert.ok(rows.every((r) => r.status === 'open'), 'the hint changes no status')

    let fixed = await resolve(HEAD3, [[open!.id, 'fixed']])
    assert.equal(fixed.hinted, 0)
    assert.deepEqual(hints(open!.id), [])
  })

  it('guard: no hint in the thread of a person, when nobody who can write replied, or when a reply names `reject`', async () => {
    let { fake, publish, resolve, reply, hints } = setup()
    await publish(payload({ findings: [bug, other] }))
    let [byReader, named] = fake.botThreads()
    reply(byReader!.id, 'visitor', FRENCH)
    reply(named!.id, 'octocat', 'Not applied. To set it aside:\n\n```\n@kento-review reject the schema validates it\n```')
    let personal = fake.addThread({ path: FILE, line: 3, body: 'Why this name?', commit: HEAD1, author: 'camille' })
    reply(personal, 'octocat', 'It follows the module.')

    let outcome = await resolve(HEAD2, [[byReader!.id, 'answered'], [named!.id, 'answered'], [personal, 'answered']])

    assert.equal(outcome.hinted, 0)
    assert.deepEqual([...hints(byReader!.id), ...hints(named!.id), ...hints(personal)], [])
  })

  it('posts one hint per finding: a review then a `resolve`, a `resolve` then a review, and two `resolve` commands', async () => {
    let { fake, publish, resolve, reply, hints } = setup()
    await publish(payload({ findings: [bug, other] }))
    let [first, second] = fake.botThreads()
    reply(first!.id, 'octocat', FRENCH)
    reply(second!.id, 'octocat', ENGLISH)

    let review = await publish(payload({ head: HEAD2, findings: [bug, other], refutedThreads: [`PRRT_${first!.id}`] }))
    assert.equal(review.hinted, 1)
    let resolution = await resolve(HEAD3, [[first!.id, 'answered'], [second!.id, 'answered']])
    assert.equal(resolution.hinted, 1, 'only the thread that the review did not answer')
    let again = await resolve('4'.repeat(40), [[first!.id, 'answered'], [second!.id, 'answered']])
    assert.equal(again.hinted, 0)
    let later = await publish(payload({ head: '5'.repeat(40), findings: [bug, other], refutedThreads: [`PRRT_${first!.id}`, `PRRT_${second!.id}`] }))
    assert.equal(later.hinted, 0)
    assert.equal(hints(first!.id).length, 1)
    assert.equal(hints(second!.id).length, 1)
  })

  it('a hint that GitHub refuses gives its claim back and keeps the thread open: the next `resolve` posts it, once', async () => {
    let { fake, publish, resolve, reply, hints, claimed, github } = setup()
    fake.state.canResolve = true
    await publish(payload())
    let [thread] = fake.botThreads()
    reply(thread!.id, 'octocat', FRENCH)

    let warnings: string[] = []
    let real = fake.fetch
    // GitHub refuses the hint only: the reply of the verdict goes.
    fake.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      typeof init?.body === 'string' && init.body.includes('kento:reject-hint')
        ? new Response(JSON.stringify({ message: 'Bad Gateway' }), { status: 502 })
        : real(input, init)) as typeof globalThis.fetch
    let refused = await resolve(HEAD2, [[thread!.id, 'answered']], (event) => warnings.push(event), github)
    fake.fetch = real
    assert.equal(refused.hinted, 0)
    assert.ok(warnings.includes('resolve.hint_failed'))
    assert.equal(claimed.size, 0)
    assert.equal(fake.state.resolved.has(thread!.id), false, 'the thread stays open for the next resolve')
    assert.match(fake.repliesTo(thread!.id).at(-1)!.body, /could not post the `reject` command in this thread\. The thread stays open/)

    let retried = await resolve(HEAD3, [[thread!.id, 'answered']], undefined, github)
    assert.equal(retried.hinted, 1)
    assert.equal(retried.resolved, 1)
    assert.equal(hints(thread!.id).length, 1)
  })
})
