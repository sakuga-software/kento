import { descriptionBlock, reviewBody } from '@kento-review/engine/render'
import { verdict, type ChangedLines } from '@kento-review/engine/findings'
import type { ReviewFinding, ReviewPayload } from '@kento-review/protocol'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BOT, createFakeGitHub } from '../../test/fake-github.ts'
import { withInstance } from '../../test/instance.ts'
import { createGitHub } from './github.ts'
import { anchorOf, answerOf, checkName, FIXED_NEAR_LINES, LABEL_DESCRIPTION, ledgerEntries, publishReview, publishUnchanged, touchedLines, usageOf } from './publish.ts'

const BASE = 'a'.repeat(40)
const HEAD1 = '1'.repeat(40)
const HEAD2 = '2'.repeat(40)
const HEAD3 = '3'.repeat(40)

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: 'src/sum.ts',
    start_line: 2,
    line: 2,
    severity: 'major',
    category: 'bug',
    confidence: 90,
    title: 'The sum subtracts',
    scenario: 'sum(1, 2) returns -1.',
    fix: 'Put + back.',
    suggestion: '  return a + b;',
    anchor: 2,
    blocking: true,
    suggestion_range: [2, 2],
    ...overrides,
  }
}

function payload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
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
    summary: 'The PR changes sum.',
    risk: 'A wrong result.',
    diagram: null,
    deeperReview: null,
    findings: [finding()],
    notReviewed: [],
    skipped: [],
    ...overrides,
  }
}

function setup(head = HEAD1, publicUrl = true, docsUrl?: string) {
  let fake = createFakeGitHub({ head, commits: { [HEAD1]: 'fix: sum', [HEAD2]: 'docs: readme', [HEAD3]: 'fix: sum again' } })
  let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
  let checks = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_checks_2', fetch: fake.fetch })
  let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com', docsUrl, ...(publicUrl ? { icons: { base: 'https://review.test/assets/pr/' } } : {}) }
  let warnings: { event: string; fields: Record<string, unknown> }[] = []
  let publish = (review: ReviewPayload, withChecks = true) =>
    publishReview(github, target, review, { checks: withChecks ? checks : null, warn: (event, fields) => warnings.push({ event, fields }) })
  let republish = (review: ReviewPayload, from: string) =>
    publishUnchanged(github, target, review, from, { checks, warn: (event, fields) => warnings.push({ event, fields }) })
  return { fake, publish, republish, warnings }
}

describe('publishReview', () => {
  it('posts the review, its inline comment, the block of the description, the label and the check', async () => {
    let { fake, publish, warnings } = setup()

    let outcome = await publish(payload())

    assert.deepEqual(warnings, [])
    assert.equal(outcome.score, 2)
    assert.equal(outcome.inline, 1)
    let [review] = fake.state.reviews
    assert.equal(review!.state, 'CHANGES_REQUESTED')
    assert.equal(review!.commitId, HEAD1)
    // The fields that boo and the scripts read.
    assert.match(review!.body, /\*\*Confidence score: 2\/5\*\* · <picture>.*?<img alt="Blocking" src="https:\/\/review\.test\/assets\/pr\/blocking\.v2\.svg" [^>]+><\/picture> 1 blocking issue · A wrong result\./)
    assert.match(review!.body, /<sub>Kentō · Level `lite` · `anthropic\/claude-haiku-5\.5` · \$0\.012 · /)

    let [comment] = fake.botThreads()
    assert.equal(comment!.path, 'src/sum.ts')
    assert.equal(comment!.line, 2)
    assert.equal(comment!.startLine, undefined, 'a one-line suggestion has no start line')
    assert.match(comment!.body, /^<picture><source media="\(prefers-color-scheme: dark\)" srcset="https:\/\/review\.test\/assets\/pr\/p1-dark\.v2\.svg"><img alt="P1" src="https:\/\/review\.test\/assets\/pr\/p1\.v2\.svg" height="20" align="top"><\/picture> \*\*/)
    assert.match(comment!.body, /```suggestion\n {2}return a \+ b;\n```/)
    assert.match(comment!.body, /<!-- sakuga-review:finding [0-9a-f]{12} -->/)

    let body = fake.state.pr.body
    assert.ok(body.startsWith('The description of the PR.\n\n<!-- sakuga-review:start -->'), 'the description of the author stays first')
    assert.match(body, /<h2>Kentō · Confidence score: 2\/5 <picture>.*?<img alt="2\/5" src="https:\/\/review\.test\/assets\/pr\/gauge-2\.v2\.svg" [^>]+><\/picture><\/h2>/)
    assert.match(body, new RegExp(`<a href="https://github.com/sakuga-software/sakuga-review/pull/28#discussion_r${comment!.id}"><picture><source [^>]+thread-dark\\.v2\\.svg"><img alt="Thread" [^>]+></picture></a>`))
    assert.match(body, /Reviews \(1\) · Last reviewed commit: \[fix: sum\]\(https:\/\/github\.com\/sakuga-software\/sakuga-review\/commit\/1{40}\) · Kentō · Level `lite`/)
    assert.match(body, /<!-- sakuga-review:count 1 -->\n<!-- sakuga-review:end -->$/)

    assert.deepEqual(fake.state.pr.labels, ['review: 2/5'])
    assert.ok(fake.state.repoLabels.has('review: 2/5'))
    // REV-41: the label names the service that posts the review, as the review does.
    assert.equal(fake.state.labelDescriptions.get('review: 2/5'), 'Kentō confidence score (5: ready to merge)')

    assert.equal(fake.state.checkRuns.length, 1)
    let [check] = fake.state.checkRuns
    assert.equal(check!.name, checkName())
    assert.equal(check!.name, 'Sakuga Review')
    assert.equal(check!.head_sha, HEAD1)
    assert.equal(check!.conclusion, 'success')
    assert.equal(check!.output.title, 'Confidence score: 2/5')
    assert.equal(check!.token, 'ghs_fake_checks_2', 'the check goes with its own token')
  })

  it('gives its description to a label of an earlier release, and leaves a label that has it', async () => {
    let { fake, publish } = setup()
    fake.state.repoLabels.add('review: 2/5')
    fake.state.labelDescriptions.set('review: 2/5', 'The description of an earlier release')
    await publish(payload())
    assert.equal(fake.state.labelDescriptions.get('review: 2/5'), LABEL_DESCRIPTION)
    assert.deepEqual(fake.state.pr.labels, ['review: 2/5'])
    let patches = fake.state.calls.filter((c) => c.method === 'PATCH' && c.path.includes('/labels/'))
    assert.equal(patches.length, 1)

    await publish(payload({ head: HEAD2 }))
    assert.equal(fake.state.calls.filter((c) => c.method === 'PATCH' && c.path.includes('/labels/')).length, 1)
  })

  it('posts no emoji, and no image when the service does not know its public URL (REV-106)', async () => {
    let emoji = /\p{Extended_Pictographic}/u
    for (let publicUrl of [true, false]) {
      let { fake, publish } = setup(HEAD1, publicUrl)
      await publish(payload())
      let texts = [fake.state.reviews[0]!.body, fake.botThreads()[0]!.body, fake.state.pr.body, fake.state.checkRuns[0]!.output.summary]
      for (let text of texts) {
        assert.doesNotMatch(text, emoji)
        assert.doesNotMatch(text, /shields\.io/)
        if (!publicUrl) assert.doesNotMatch(text, /<img|<picture/)
        for (let image of text.match(/<img [^>]*>/g) ?? []) assert.match(image, /^<img alt="[^"]+" src="https:\/\/review\.test\/assets\/pr\/[a-z0-9-]+\.v2\.svg"/)
      }
      if (!publicUrl) assert.match(fake.state.reviews[0]!.body, /\*\*Confidence score: 2\/5\*\* · 1 blocking issue · /)
    }
  })

  it('does not post again a finding that an open thread carries, and dismisses the previous REQUEST_CHANGES', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()

    // A second push that does not touch the finding.
    fake.state.pr.head = HEAD2
    fake.state.compare.set(`${HEAD1}...${HEAD2}`, { status: 'ahead', files: ['README.md'] })
    let outcome = await publish(payload({ head: HEAD2 }))

    assert.equal(outcome.inline, 0)
    assert.equal(fake.botThreads().length, 1, 'no second thread for the same finding')
    assert.deepEqual(fake.repliesTo(thread!.id), [], 'the thread gets no reply: the finding is still there')
    assert.deepEqual(
      fake.state.reviews.map((r) => r.state),
      ['DISMISSED', 'CHANGES_REQUESTED'],
    )
    // The block links the finding to its open thread, and counts the reviews.
    assert.match(fake.state.pr.body, new RegExp(`#discussion_r${thread!.id}"><picture><source [^>]+thread-dark\\.v2\\.svg"><img alt="Thread" [^>]+></picture></a>`))
    assert.match(fake.state.pr.body, /<!-- sakuga-review:count 2 -->/)
    assert.equal((fake.state.pr.body.match(/sakuga-review:start/g) ?? []).length, 1, 'one block, replaced')
  })

  it('ends the block with one line of the commands and the link to their page, after each review (REV-105)', async () => {
    let docs = 'https://review.sakuga.dev/docs/commands'
    let { fake, publish, republish } = setup(HEAD1, true, docs)
    let line =
      '<sub>Kentō commands: `@kento-review [lite|balanced|heavy]` · `@kento-review resolve` · ' +
      `\`@kento-review reject <cause>\` (in a thread) or \`reject #<id> <cause>\` · \`@kento-review feedback <opinion>\` · [Kentō commands](${docs})</sub>`
    await publish(payload())
    assert.ok(fake.state.pr.body.includes(`${line}\n\n<!-- sakuga-review:count 1 -->`))

    fake.state.pr.head = HEAD2
    fake.state.compare.set(`${HEAD1}...${HEAD2}`, { status: 'ahead', files: ['README.md'] })
    await publish(payload({ head: HEAD2 }))
    fake.state.pr.head = HEAD3
    await republish(payload({ head: HEAD3, costUsd: 0 }), HEAD2)

    assert.equal(fake.state.pr.body.split('<sub>Kentō commands:').length - 1, 1)
    assert.ok(fake.state.pr.body.includes(`${line}\n\n<!-- sakuga-review:count 2 -->`))
  })

  it('lists no command in the block when the service does not know its public URL (REV-105)', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    assert.doesNotMatch(fake.state.pr.body, /Kentō commands/)
  })

  it('also finds the thread of a finding worded differently a few lines away', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    fake.state.pr.head = HEAD2
    fake.state.compare.set(`${HEAD1}...${HEAD2}`, { status: 'ahead', files: ['src/sum.ts'] })

    await publish(payload({ head: HEAD2, findings: [finding({ title: 'Inverted sign in sum', anchor: 3, line: 3, start_line: 3 })] }))

    let [thread] = fake.botThreads()
    assert.equal(fake.botThreads().length, 1)
    assert.deepEqual(fake.repliesTo(thread!.id), [])
  })

  it('answers on the thread of a fixed finding that the file changed, once', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()

    fake.state.pr.head = HEAD3
    fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'ahead', files: ['src/sum.ts'] })
    let outcome = await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))

    assert.equal(outcome.resolved, 1)
    let replies = fake.repliesTo(thread!.id)
    assert.equal(replies.length, 1)
    assert.match(replies[0]!.body, /^This finding does not show anymore at commit `333333333`, and the file changed since\. The thread can be resolved\./)
    assert.match(replies[0]!.body, /<!-- sakuga-review:gone -->/)
    assert.match(fake.state.pr.body, /1 finding of an earlier review does not show anymore\. Its thread can be resolved\./)
    assert.equal(fake.state.reviews.at(-1)!.state, 'APPROVED')
    assert.deepEqual(fake.state.pr.labels, ['review: 5/5'], 'the old score label goes')

    // The next review does not answer the same thread again.
    await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))
    assert.equal(fake.repliesTo(thread!.id).length, 1)
  })

  it('leaves open the thread of a finding not found again when the push changed only another part of its file (KNT-160)', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    fake.state.pr.head = HEAD3
    let far = 2 + FIXED_NEAR_LINES + 1
    let patch = `@@ -${far},2 +${far},2 @@\n-  let x = 1;\n+  let x = 2;\n   return x;`
    fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'ahead', files: [{ filename: 'src/sum.ts', patch }] })
    let outcome = await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))
    assert.equal(outcome.resolved, 0)
    assert.equal(fake.repliesTo(thread!.id).length, 0)
  })

  it('fixes a finding with no line (an outdated thread of an earlier release) on any change of its file (KNT-160)', async () => {
    let { fake, publish } = setup()
    await publish(payload({ findings: [] }))
    let old = fake.addThread({ path: 'src/a.ts', line: 0, body: 'x <!-- sakuga-review:finding 0000000000aa -->', commit: HEAD1 })
    fake.state.pr.head = HEAD3
    let patch = '@@ -40,1 +40,1 @@\n-  let x = 1;\n+  let x = 2;'
    fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'ahead', files: [{ filename: 'src/a.ts', patch }] })
    let outcome = await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))
    assert.equal(outcome.resolved, 1)
    assert.equal(fake.repliesTo(old).length, 1)
  })

  it('moves the line of a suppressed follower with its head, so that the line is always one of the file at that head (KNT-160)', () => {
    let stored = {
      id: '00000000-0000-4000-8000-0000000000aa', fingerprint: 'fp', key: 'aaaaaaaaaaaa', ruleId: null, path: 'src/sum.ts', line: 2,
      title: 'The sum subtracts', severity: 'major' as const, category: 'bug', confidence: 90, status: 'dismissed' as const,
      statusReason: 'not a bug', loadedStatus: 'dismissed' as const, lastSeenSha: HEAD1, githubCommentId: 7, githubThreadId: 'PRRT_7',
    }
    let match = (f: ReviewFinding) => ({ finding: f, stored, carrier: null, suppressed: true, reopened: false, followIn: null, followed: true })
    let [same] = ledgerEntries([match(finding({ line: 9, anchor: 9 }))], [], [], new Map(), HEAD3)
    assert.deepEqual({ line: same!.values.line, sha: same!.values.lastSeenSha, status: same!.values.status, title: same!.values.title }, { line: 9, sha: HEAD3, status: 'dismissed', title: 'The sum subtracts' })
    let [other] = ledgerEntries([match(finding({ path: 'src/other.ts', line: 30, anchor: 30 }))], [], [], new Map(), HEAD3)
    assert.deepEqual({ line: other!.values.line, sha: other!.values.lastSeenSha, path: other!.values.path }, { line: 2, sha: HEAD1, path: 'src/sum.ts' })
  })

  it('reads the lines that a patch removes, and the lines around the place where it adds (KNT-160)', () => {
    assert.deepEqual([...touchedLines('@@ -10,3 +10,3 @@ fn\n a\n-b\n+c\n d')!].sort((x, y) => x - y), [11, 12])
    assert.deepEqual([...touchedLines('@@ -5 +5,2 @@\n e\n+f')!].sort((x, y) => x - y), [5, 6])
    assert.deepEqual([...touchedLines('@@ -1,2 +1,1 @@\n-a\n b\n\\ No newline at end of file\n@@ -40,1 +39,1 @@\n-x\n+y')!].sort((x, y) => x - y), [1, 40, 41])
    assert.equal(touchedLines('Binary files differ'), null)
  })

  it('opens a new thread for a finding that comes back after its thread was answered as gone', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [old] = fake.botThreads()
    fake.state.pr.head = HEAD2
    fake.state.compare.set(`${HEAD1}...${HEAD2}`, { status: 'ahead', files: ['src/sum.ts'] })
    await publish(payload({ head: HEAD2, score: 5, verdict: 'APPROVE', findings: [] }))
    assert.equal(fake.repliesTo(old!.id).length, 1)

    fake.state.pr.head = HEAD3
    let outcome = await publish(payload({ head: HEAD3 }))

    assert.equal(outcome.inline, 1)
    let threads = fake.botThreads()
    assert.equal(threads.length, 2)
    let fresh = threads.find((t) => t.id !== old!.id)!
    assert.equal(fresh.commit, HEAD3)
    assert.match(fake.state.pr.body, new RegExp(`#discussion_r${fresh.id}"><picture><source [^>]+thread-dark\\.v2\\.svg"><img alt="Thread" [^>]+></picture></a>`))
    assert.doesNotMatch(fake.state.pr.body, new RegExp(`#discussion_r${old!.id}"`))
    assert.equal(fake.repliesTo(old!.id).length, 1, 'the old thread gets no second reply')
  })

  it('posts the review when GitHub fails on a thread, and leaves that thread open', async () => {
    let { fake, publish, warnings } = setup()
    await publish(payload())
    let first = fake.addThread({ path: 'src/a.ts', line: 1, body: 'x <!-- sakuga-review:finding 0000000000aa -->', commit: HEAD1 })
    let second = fake.addThread({ path: 'src/b.ts', line: 1, body: 'y <!-- sakuga-review:finding 0000000000bb -->', commit: HEAD2 })
    fake.state.pr.head = HEAD3
    // The compare API fails for the commit of the first thread; the second thread was deleted on
    // GitHub, so the reply to it answers 404.
    fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'error', files: [] })
    fake.state.compare.set(`${HEAD2}...${HEAD3}`, { status: 'ahead', files: ['src/b.ts'] })
    fake.state.deletedComments.add(second)
    warnings.length = 0

    let outcome = await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))

    assert.equal(fake.state.reviews.length, 2, 'the review is posted')
    assert.equal(outcome.resolved, 0)
    assert.deepEqual(fake.repliesTo(first), [])
    assert.deepEqual(fake.repliesTo(second), [])
    assert.deepEqual(
      warnings.map((w) => w.event).sort(),
      // The thread of the first review and the first thread share the failing comparison; the reply
      // to the deleted thread fails after the review.
      ['publish.step_failed', 'publish.thread_failed', 'publish.thread_failed', 'publish.thread_not_resolved'],
    )
  })

  it('closes no thread when the review cannot be posted', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    fake.state.canResolve = true
    fake.state.pr.head = HEAD3
    fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'ahead', files: ['src/sum.ts'] })
    fake.state.failReviews = true

    await assert.rejects(publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] })), /answered 502/)

    assert.equal(fake.state.resolved.has(thread!.id), false)
    assert.deepEqual(fake.repliesTo(thread!.id), [])
    // The next try, with GitHub back, closes it and says so in the block.
    fake.state.failReviews = false
    let outcome = await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))
    assert.equal(outcome.resolved, 1)
    assert.ok(fake.state.resolved.has(thread!.id))
    assert.match(fake.state.pr.body, /1 finding of an earlier review does not show anymore/)
  })

  it('resolves the thread when GitHub lets the App do it', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    fake.state.canResolve = true
    fake.state.pr.head = HEAD3
    fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'ahead', files: ['src/sum.ts'] })

    await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))

    assert.ok(fake.state.resolved.has(thread!.id))
    assert.deepEqual(fake.repliesTo(thread!.id), [])
  })

  it('keeps open the thread of a finding that the engine moved to « Not reviewed », though its file changed (KNT-151)', async () => {
    let { fake, publish } = setup()
    // Kept at 82: above the floor of premise.ts, the finding is posted with its thread.
    let hedged = finding({ confidence: 82, title: 'The role is not checked', scenario: 'The definition of requireOwner is not in the pack, so a member may pay.' })
    await publish(payload({ findings: [hedged] }))
    let [thread] = fake.botThreads()

    // A push on its file. The same finding comes back at 75, and the engine moves it to « Not reviewed ».
    fake.state.pr.head = HEAD3
    fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'ahead', files: ['src/sum.ts'] })
    let moved = { ...hedged, confidence: 75 }
    let outcome = await publish(payload({ head: HEAD3, score: 4, verdict: 'APPROVE', findings: [], notReviewed: ['src/sum.ts: The role is not checked. To check: …'], moved: [moved] }))

    assert.equal(outcome.resolved, 0)
    assert.deepEqual(fake.repliesTo(thread!.id), [], 'no « does not show anymore » answer')
    assert.doesNotMatch(fake.state.pr.body, /does not show anymore/)
    // Without `moved`, the same review shows it fixed: what the field prevents.
    let other = setup()
    await other.publish(payload({ findings: [hedged] }))
    other.fake.state.pr.head = HEAD3
    other.fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'ahead', files: ['src/sum.ts'] })
    assert.equal((await other.publish(payload({ head: HEAD3, score: 4, verdict: 'APPROVE', findings: [] }))).resolved, 1)
  })

  it('keeps open a thread whose file did not change: a finding that the model did not repeat is not fixed', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    fake.state.pr.head = HEAD2
    fake.state.compare.set(`${HEAD1}...${HEAD2}`, { status: 'ahead', files: ['README.md'] })

    let outcome = await publish(payload({ head: HEAD2, score: 4, verdict: 'APPROVE', findings: [] }))

    assert.equal(outcome.resolved, 0)
    assert.deepEqual(fake.repliesTo(thread!.id), [])
  })

  it('keeps open the thread of a commit that a force-push removed, and says so in the review', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    fake.state.pr.head = HEAD3

    // GitHub no longer has the commit of the thread: 404. A diverged history gives the same answer.
    await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))
    fake.state.compare.set(`${HEAD1}...${HEAD3}`, { status: 'diverged', files: ['src/sum.ts'] })
    await publish(payload({ head: HEAD3, score: 5, verdict: 'APPROVE', findings: [] }))

    assert.deepEqual(fake.repliesTo(thread!.id), [])
    for (let review of fake.state.reviews.slice(1)) {
      assert.match(review.body, /A force-push removed from the history the commit that an open thread reviewed\./)
      assert.match(review.body, /from the base `aaaaaaaaa`/)
    }
  })

  it('posts the review without its inline comments when GitHub refuses a line', async () => {
    let { fake, publish, warnings } = setup()
    fake.state.refuseInline = true

    let outcome = await publish(payload())

    assert.equal(outcome.inline, 0)
    assert.equal(fake.state.reviews.length, 1)
    assert.deepEqual(fake.botThreads(), [])
    assert.deepEqual(warnings.map((w) => w.event), ['publish.inline_refused'])
    // Without a thread, the block shows the scenario of the finding.
    assert.match(fake.state.pr.body, /sum\(1, 2\) returns -1\. \*\*Fix:\*\* Put \+ back\./)
  })

  it('keeps the inline comments to the sure P2 findings, five at most; a P1 outside the diff gets a comment on its file', async () => {
    let { fake, publish } = setup()
    let findings = [
      finding({ title: 'Not sure', confidence: 50, severity: 'minor', blocking: false, anchor: 10, line: 10, start_line: 10 }),
      finding({ title: 'Outside the diff', anchor: null, line: 200, start_line: 200, blocking: false }),
      ...Array.from({ length: 6 }, (_, i) =>
        finding({ title: `Finding ${i}`, severity: 'minor', blocking: false, anchor: 20 + 10 * i, line: 20 + 10 * i, start_line: 20 + 10 * i, suggestion: '', suggestion_range: null }),
      ),
    ]

    let outcome = await publish(payload({ score: 3, verdict: 'COMMENT', findings }))

    assert.equal(outcome.inline, 5)
    assert.equal(outcome.fileComments, 1)
    assert.deepEqual(
      fake.botThreads().map((c) => [c.body.match(/\*\*(.+?)\*\*/)![1], c.line]),
      [['Finding 0', 20], ['Finding 1', 30], ['Finding 2', 40], ['Finding 3', 50], ['Finding 4', 60], ['Outside the diff', null]],
    )
    assert.equal(fake.state.reviews[0]!.state, 'COMMENTED')
    // A finding outside the diff links the line of the file at the reviewed commit.
    assert.match(fake.state.pr.body, /\[`src\/sum\.ts:200`\]\(https:\/\/github\.com\/sakuga-software\/sakuga-review\/blob\/1{40}\/src\/sum\.ts#L200\)/)
  })

  it('puts a suggestion of several lines on its range', async () => {
    let { fake, publish } = setup()
    await publish(payload({ findings: [finding({ start_line: 2, line: 4, anchor: 4, suggestion_range: [2, 4], suggestion: 'a\nb\nc' })] }))
    let [comment] = fake.botThreads()
    assert.equal(comment!.startLine, 2)
    assert.equal(comment!.line, 4)
  })

  it('posts the review when the App cannot write checks, without the check', async () => {
    let { fake, publish } = setup()
    let outcome = await publish(payload(), false)
    assert.equal(fake.state.reviews.length, 1)
    assert.equal(fake.state.checkRuns.length, 0)
    assert.equal(outcome.score, 2)
  })

  it('logs a failed step after the review and goes on to the next one', async () => {
    let { fake, publish, warnings } = setup()
    // The commit is unknown: the description cannot name it.
    fake.state.commits = {}

    await publish(payload())

    assert.equal(fake.state.reviews.length, 1)
    assert.deepEqual(warnings.map((w) => [w.event, w.fields.step]), [['publish.step_failed', 'description']])
    assert.deepEqual(fake.state.pr.labels, ['review: 2/5'])
    assert.equal(fake.state.checkRuns.length, 1)
  })

  it('dismisses a REQUEST_CHANGES of the bot past the first page of reviews', async () => {
    let { fake, publish } = setup()
    for (let i = 0; i < 104; i++) fake.addReview({ user: i % 2 ? 'octocat' : BOT, state: 'COMMENTED' })
    let old = fake.addReview({ state: 'CHANGES_REQUESTED' })
    let person = fake.addReview({ user: 'octocat', state: 'CHANGES_REQUESTED' })

    await publish(payload({ score: 5, verdict: 'APPROVE', findings: [] }))

    let states = new Map(fake.state.reviews.map((r) => [r.id, r.state]))
    assert.equal(states.get(old), 'DISMISSED')
    assert.equal(states.get(person), 'CHANGES_REQUESTED', 'the review of a person stays')
  })

  it('runs the steps after the review when marking it as posted fails', async () => {
    let { fake } = setup()
    let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
    let checks = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_checks_2', fetch: fake.fetch })
    let warnings: { event: string; fields: Record<string, unknown> }[] = []
    let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com' }

    let outcome = await publishReview(github, target, payload(), {
      checks,
      onPosted: async () => {
        throw new Error('connection terminated')
      },
      warn: (event, fields) => warnings.push({ event, fields }),
    })

    assert.equal(outcome.reviewId, fake.state.reviews[0]!.id)
    assert.deepEqual(warnings.map((w) => [w.event, w.fields.step]), [['publish.step_failed', 'mark']])
    assert.match(fake.state.pr.body, /<!-- sakuga-review:count 1 -->/)
    assert.deepEqual(fake.state.pr.labels, ['review: 2/5'])
    assert.equal(fake.state.checkRuns.length, 1)
  })

  it('does not post again a review that an earlier try posted but could not mark', async () => {
    let { fake } = setup()
    let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
    let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com' }
    let marked: number[] = []
    let warnings: string[] = []
    let options = {
      marker: '0b7c4c1e-0000-4000-8000-000000000001',
      onPosted: async (id: number) => void marked.push(id),
      warn: (event: string) => void warnings.push(event),
    }

    let first = await publishReview(github, target, payload(), options)
    let second = await publishReview(github, target, payload(), options)

    assert.equal(fake.state.reviews.length, 1)
    assert.match(fake.state.reviews[0]!.body, /<!-- kento:review 0b7c4c1e-0000-4000-8000-000000000001 -->$/)
    assert.equal(fake.botThreads().length, 1)
    assert.equal(second.reviewId, first.reviewId)

    assert.deepEqual(marked, [first.reviewId, first.reviewId])
    assert.deepEqual(warnings, ['publish.already_posted'])
    assert.match(fake.state.pr.body, /<!-- sakuga-review:count 1 -->/, 'the block counts the review once')
    // A review of another stored row is posted.
    await publishReview(github, target, payload(), { ...options, marker: '0b7c4c1e-0000-4000-8000-000000000002' })
    assert.equal(fake.state.reviews.length, 2)
  })

  it('counts no inline comment for a review found again', async () => {
    let { fake } = setup()
    let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
    let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com' }
    // The first try lost its inline comment (422), so the second try still has one to place.
    fake.state.refuseInline = true
    await publishReview(github, target, payload(), { marker: 'row-1' })
    fake.state.refuseInline = false

    let second = await publishReview(github, target, payload(), { marker: 'row-1' })

    assert.equal(fake.state.reviews.length, 1)
    assert.deepEqual(fake.botThreads(), [])
    assert.equal(second.inline, 0)
  })

  it('renders the review and the block as the Action does, from the anchors of the runner', () => {
    // The Action renders from the changed lines of its checkout; the service from the anchors that the
    // runner computed from the same lines. Both must give the same text, but for the name and the
    // command of Kentō.
    let lines: ChangedLines = new Map([['src/sum.ts', new Set([2, 3, 4])]])
    let review = payload({
      findings: [
        finding(),
        finding({ title: 'Loin', line: 40, start_line: 40, anchor: null, blocking: false, suggestion_range: null }),
        finding({ title: 'Proche', line: 9, start_line: 9, anchor: 4, blocking: true, suggestion_range: null }),
      ],
      deeperReview: 'The diff touches security.',
      score: 2,
    })
    let answer = answerOf(review)
    let usage = usageOf(review)
    let action = reviewBody(answer, lines, 'lite', usage)
    let poster = { by: 'Kentō', handle: '@kento-review', icons: 'emoji' as const }
    let asAction = (text: string) => text.replace('Kentō · Confidence', 'Sakuga Review · Confidence').replace('Kentō · Level', 'Level').replaceAll('@kento-review ', '@sakuga-review review ')
    let kento = reviewBody(answer, anchorOf, 'lite', usage, poster)
    assert.match(kento, /Comment `@kento-review balanced` \(10 to 20 cents\) or `@kento-review heavy` \(30 to 50 cents\)\./)
    assert.equal(asAction(kento), action)
    assert.equal(verdict(answer, anchorOf, 'lite'), verdict(answer, lines, 'lite'))
    assert.equal(verdict(answer, anchorOf, 'lite'), review.verdict)
    let context = { count: 3, head: HEAD1, subject: 'fix: sum', commitUrl: `https://github.com/o/n/commit/${HEAD1}`, level: 'lite' as const }
    let links = answer.findings.map((f) => ({ finding: f, url: null }))
    assert.equal(
      asAction(descriptionBlock(answer, links, [], 0, usage, anchorOf, { ...context, poster })),
      descriptionBlock(answer, links, [], 0, usage, lines, context),
    )
  })
})

describe('publishUnchanged (REV-89)', () => {
  it('writes the block, the label and the check of the new head, and no review, comment or reply', async () => {
    let { fake, publish, republish, warnings } = setup()
    await publish(payload())
    let [thread] = fake.botThreads()
    let reviews = fake.state.reviews.length

    // A merge of main: the new head reads the same diff. The review of HEAD1 holds for HEAD2.
    fake.state.pr.head = HEAD2
    let outcome = await republish(payload({ head: HEAD2, costUsd: 0 }), HEAD1)

    assert.deepEqual(warnings, [])
    assert.equal(outcome.score, 2, 'the score of the review of HEAD1 stays')
    assert.equal(fake.state.reviews.length, reviews, 'no new review')
    assert.equal(fake.state.reviews[0]!.state, 'CHANGES_REQUESTED', 'the review of HEAD1 stays, not dismissed')
    assert.equal(fake.botThreads().length, 1, 'no new thread')
    assert.deepEqual(fake.repliesTo(thread!.id), [])
    let body = fake.state.pr.body
    assert.match(body, new RegExp(`#discussion_r${thread!.id}"><picture><source [^>]+thread-dark\\.v2\\.svg"><img alt="Thread" [^>]+></picture></a>`), 'the finding links to its open thread')
    assert.match(body, /No reviewed file changed since commit `111111111`/)
    assert.match(body, /Last reviewed commit: \[docs: readme\]\(https:\/\/github\.com\/sakuga-software\/sakuga-review\/commit\/2{40}\)/)
    assert.match(body, /<!-- sakuga-review:count 1 -->/, 'no new review: the count stays')
    assert.equal((body.match(/sakuga-review:start/g) ?? []).length, 1, 'one block, replaced')
    assert.deepEqual(fake.state.pr.labels, ['review: 2/5'])
    let check = fake.state.checkRuns.at(-1)!
    assert.equal(check.head_sha, HEAD2, 'the new head gets its check')
    assert.equal(check.output.title, 'Confidence score: 2/5')
  })

  it('gives the head of the source review when its P1 to consider has a thread (REV-106)', async () => {
    let { fake, publish, republish } = setup()
    let unsure = finding({ confidence: 60, blocking: false })
    let considered = finding({ seen: true, blocking: false, title: 'STUDIO_HOST is not documented', line: 3, start_line: 3, anchor: 3, suggestion_range: null })
    await publish(payload({ score: 2, verdict: 'COMMENT', findings: [unsure] }))
    // HEAD2: the P1 at 60 is carried, so the P1 to consider is the only new one, and gets a thread.
    fake.state.pr.head = HEAD2
    await publish(payload({ head: HEAD2, score: 2, verdict: 'COMMENT', findings: [unsure, considered] }))
    assert.equal(fake.botThreads().length, 2)
    assert.match(fake.state.reviews.at(-1)!.body, / 2 issues to check · /)

    fake.state.pr.head = HEAD3
    await republish(payload({ head: HEAD3, score: 2, verdict: 'COMMENT', findings: [unsure, considered], costUsd: 0 }), HEAD2)
    let check = fake.state.checkRuns.at(-1)!
    assert.equal(check.head_sha, HEAD3)
    assert.match(check.output.summary, / 2 issues to check · /, 'the same count as the review of HEAD2')
  })

  it('guard: a P1 to consider with a thread does not count when the source score is 4 (REV-106)', async () => {
    let { fake, publish, republish } = setup()
    let considered = finding({ seen: true, blocking: false, title: 'STUDIO_HOST is not documented' })
    await publish(payload({ score: 3, verdict: 'COMMENT', findings: [considered] }))
    assert.equal(fake.botThreads().length, 1)
    fake.state.pr.head = HEAD2
    await publish(payload({ head: HEAD2, score: 4, verdict: 'APPROVE', findings: [considered] }))
    assert.match(fake.state.reviews.at(-1)!.body, / Nothing blocking · /)

    fake.state.pr.head = HEAD3
    await republish(payload({ head: HEAD3, score: 4, verdict: 'APPROVE', findings: [considered], costUsd: 0 }), HEAD2)
    assert.match(fake.state.checkRuns.at(-1)!.output.summary, / Nothing blocking · /, 'the head of the review of HEAD2')
  })

  it('throws when the block cannot be written, so that the publisher tries again', async () => {
    let { fake, publish, republish } = setup()
    await publish(payload())
    fake.state.pr.head = HEAD2
    fake.state.failPullEdits = 1
    let checks = fake.state.checkRuns.length
    await assert.rejects(republish(payload({ head: HEAD2, costUsd: 0 }), HEAD1))
    assert.equal(fake.state.checkRuns.length, checks, 'no check before the block')
    await republish(payload({ head: HEAD2, costUsd: 0 }), HEAD1)
    assert.match(fake.state.pr.body, /No reviewed file changed since commit `111111111`/)
  })

  it('posts its check on the head even when the job "Sakuga Review" of the Action already has one', async () => {
    let { fake, publish, republish } = setup()
    await publish(payload())
    fake.state.pr.head = HEAD2
    // The workflow of the Action names its job "Sakuga Review" too.
    fake.state.checkRuns.push({ name: checkName(), head_sha: HEAD2, conclusion: 'success', output: { title: '', summary: '' }, token: 'actions', app: 'github-actions' })
    await republish(payload({ head: HEAD2, costUsd: 0 }), HEAD1)
    let ours = fake.state.checkRuns.filter((c) => c.head_sha === HEAD2 && c.app === undefined)
    assert.equal(ours.length, 1, 'the check of Kentō is posted')
    assert.equal(ours[0]!.output.title, 'Confidence score: 2/5')
  })

  it('names its check KENTO_CHECK_NAME, and finds it again by that name (REV-127)', () =>
    withInstance({ checkName: 'Acme Review' }, async () => {
      let { fake, publish, republish } = setup()
      await publish(payload())
      assert.deepEqual(
        fake.state.checkRuns.map((c) => c.name),
        ['Acme Review'],
      )
      fake.state.pr.head = HEAD2
      await republish(payload({ head: HEAD2, costUsd: 0 }), HEAD1)
      await republish(payload({ head: HEAD2, costUsd: 0 }), HEAD1)
      assert.deepEqual(
        fake.state.checkRuns.filter((c) => c.head_sha === HEAD2).map((c) => c.name),
        ['Acme Review'],
        'the second publication finds the check of the first one',
      )
      assert.ok(fake.state.calls.some((c) => c.path.endsWith(`/commits/${HEAD2}/check-runs?check_name=Acme%20Review`)))
    }))

  it('posts one check on the head, also when it publishes twice', async () => {
    let { fake, publish, republish } = setup()
    await publish(payload())
    fake.state.pr.head = HEAD2
    await republish(payload({ head: HEAD2, costUsd: 0 }), HEAD1)
    await republish(payload({ head: HEAD2, costUsd: 0 }), HEAD1)
    assert.equal(fake.state.checkRuns.filter((c) => c.head_sha === HEAD2).length, 1)
  })
})

describe('an incremental review (REV-88)', () => {
  it('says in the block which head it read the change since', async () => {
    let { fake, publish } = setup()
    await publish(payload())
    fake.state.pr.head = HEAD2
    await publish(payload({ head: HEAD2, delta: { since: HEAD1, files: 2 } }))
    assert.match(fake.state.pr.body, /Incremental review: it read the 2 files of the PR that changed since commit `111111111`/)
    assert.match(fake.state.pr.body, /<!-- sakuga-review:count 2 -->/)
    fake.state.pr.head = HEAD3
    await publish(payload({ head: HEAD3, delta: { since: HEAD2, files: 1 } }))
    assert.match(fake.state.pr.body, /Incremental review: it read the file of the PR that changed since commit `222222222`\./, 'the singular, for one file')
  })
})
