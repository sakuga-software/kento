// The open threads of an earlier review that has no row: the review adopts them, with no second thread.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { findingKey } from '@sakuga-review/engine/findings'
import { inlineBody } from '@sakuga-review/engine/render'
import type { ReviewFinding } from '@sakuga-review/protocol'

import { adoptThreads, matchFindings, type BotThread } from './lifecycle.ts'

const PATH = 'src/auth.ts'

// The comment of a P0 security finding of an earlier release, under another title than the finding of today.
const EARLIER_COMMENT = [
  '<img alt="P0" src="https://review.sakuga.dev/assets/pr/p0.v2.svg"> <img alt="security" src="https://review.sakuga.dev/assets/pr/security.v2.svg"> **An expired token gets through** `#3cf454`',
  '',
  'An expired token passes the check.',
  '',
  '<!-- sakuga-review:finding 3cf4541234ab -->',
].join('\n')

function thread(body: string, over: Partial<BotThread> = {}): BotThread {
  return { id: 'T1', resolved: false, path: PATH, line: 12, key: '3cf4541234ab', commit: 'a'.repeat(40), commentId: 101, answered: false, body, ...over }
}

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: PATH,
    start_line: 13,
    line: 13,
    severity: 'critical',
    category: 'security',
    confidence: 90,
    title: 'Expired token is accepted',
    scenario: 'An expired token passes the check.',
    fix: 'Compare exp with Date.now().',
    suggestion: '',
    anchor: 13,
    blocking: true,
    suggestion_range: null,
    ...over,
  }
}

describe('the threads of an earlier review', () => {
  it('adopts a comment: its title, its priority and its security badge', () => {
    let [adopted] = adoptThreads([], [thread(EARLIER_COMMENT)])
    assert.equal(adopted?.title, 'An expired token gets through')
    assert.equal(adopted?.severity, 'critical')
    assert.equal(adopted?.category, 'security')
  })

  it('reads the security badge in text too', () => {
    let [adopted] = adoptThreads([], [thread(EARLIER_COMMENT.replace(/<img alt="security"[^>]*>/, '`security`'))])
    assert.equal(adopted?.category, 'security')
  })

  it('adopts a comment of today', () => {
    let body = inlineBody(finding() as never, false, 'https://review.sakuga.dev/docs/commands', 'text')
    let [adopted] = adoptThreads([], [thread(body)])
    assert.equal(adopted?.title, 'Expired token is accepted')
    assert.equal(adopted?.category, 'security')
  })

  // The key and the fingerprint hash the title: a new title does not match the earlier one. The
  // open thread a few lines away carries the finding, so the review opens no second thread.
  it('carries a finding on the open thread of the same defect under another title, with no new thread', () => {
    let threads = [thread(EARLIER_COMMENT)]
    let stored = adoptThreads([], threads)
    let renamed = finding()
    assert.notEqual(findingKey(renamed as never), stored[0]!.key)
    let { matches, unmatched } = matchFindings([renamed], stored, threads)
    assert.equal(matches[0]?.stored, stored[0])
    assert.equal(matches[0]?.carrier?.commentId, 101)
    assert.deepEqual(unmatched, [])
  })
})
