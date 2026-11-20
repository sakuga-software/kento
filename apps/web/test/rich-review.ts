// A review with every kind of text that the bot posts, published on the fake GitHub.
import type { ReviewFinding, ReviewPayload } from '@kento/protocol'
import * as assert from 'remix/assert'

import { createGitHub } from '../app/publish/github.ts'
import { publishReview } from '../app/publish/publish.ts'
import { BOT, createFakeGitHub } from './fake-github.ts'

/**
 * Publishes on a fake GitHub a review with every kind of text: a blocking finding with a thread, a
 * minor one in the block only, an unsure one, one outside the diff (a comment on its file), the
 * advice of a deeper review, the block, the label and the check. Returns every text that it sent.
 */
export async function publishRichReview(): Promise<string[]> {
  let fake = createFakeGitHub({ head: '1'.repeat(40), commits: { ['1'.repeat(40)]: 'fix: sum' } })
  let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
  let checks = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_checks_2', fetch: fake.fetch })
  let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com', docsUrl: 'https://review.test/docs/commands', icons: { base: 'https://review.test/assets/pr/' } }
  let finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
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
  })
  let review: ReviewPayload = {
    level: 'balanced',
    base: 'a'.repeat(40),
    head: '1'.repeat(40),
    score: 2,
    verdict: 'REQUEST_CHANGES',
    model: 'anthropic/claude-haiku-5.5',
    provider: 'Anthropic',
    costUsd: 0.0123,
    promptTokens: 1000,
    completionTokens: 200,
    summary: 'The PR changes sum.',
    risk: 'A wrong result.',
    diagram: 'flowchart LR\n  a --> b',
    deeperReview: 'heavy',
    findings: [
      finding({}),
      finding({ severity: 'minor', confidence: 50, blocking: false, title: 'A name', suggestion: undefined, suggestion_range: undefined }),
      finding({ severity: 'critical', confidence: 60, blocking: false, title: 'Unsure', line: 1, start_line: 1, anchor: 1 }),
      finding({ title: 'Outside the diff', anchor: null, line: 200, start_line: 200, blocking: false, suggestion: undefined, suggestion_range: undefined }),
    ],
    notReviewed: ['dist/app.js'],
    skipped: [],
  }
  let outcome = await publishReview(github, target, review, { checks, warn: () => {} })
  assert.equal(outcome.fileComments, 1, 'a comment on the file of the finding outside the diff')
  assert.ok(fake.state.sent.length >= 4, `only ${fake.state.sent.length} writes`)
  return [...fake.state.sent, fake.state.pr.body, ...fake.state.checkRuns.map((c) => JSON.stringify(c))]
}
