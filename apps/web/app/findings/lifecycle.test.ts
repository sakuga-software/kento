// REV-114. Kentō writes in English since REV-114. The threads of the pull requests before the deploy
// hold the French comments, and the review must still read them, with no second thread.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { findingKey } from '@sakuga-review/engine/findings'
import { inlineBody } from '@sakuga-review/engine/render'
import type { ReviewFinding } from '@sakuga-review/protocol'

import { adoptThreads, matchFindings, type BotThread } from './lifecycle.ts'

const PATH = 'src/auth.ts'

// The comment of a P0 security finding as Kentō posted it before REV-114.
const FRENCH_COMMENT = [
  '<img alt="P0" src="https://review.sakuga.dev/assets/pr/p0.v1.svg"> <img alt="sécurité" src="https://review.sakuga.dev/assets/pr/securite.v1.svg"> **Le jeton expiré est accepté** `#3cf454`',
  '',
  'Un jeton expiré passe la vérification.',
  '',
  '**Correction :** Comparer exp à Date.now().',
  '',
  '<sub>Constat faux : `@kento-review reject <cause>` en réponse dans ce fil. [Les commandes de Kentō](https://review.sakuga.dev/docs/commandes)</sub>',
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

describe('the threads of the pull requests before REV-114', () => {
  it('adopts a French comment: its title, its priority and its security badge', () => {
    let [adopted] = adoptThreads([], [thread(FRENCH_COMMENT)])
    assert.equal(adopted?.title, 'Le jeton expiré est accepté')
    assert.equal(adopted?.severity, 'critical')
    assert.equal(adopted?.category, 'security')
  })

  it('reads the French security badge in text too', () => {
    let [adopted] = adoptThreads([], [thread(FRENCH_COMMENT.replace(/<img alt="P0"[^>]*> <img alt="sécurité"[^>]*>/, '`P0` `sécurité`'))])
    assert.equal(adopted?.title, 'Le jeton expiré est accepté')
    assert.equal(adopted?.category, 'security')
  })

  it('adopts an English comment of today', () => {
    let body = inlineBody(finding() as never, false, 'https://review.sakuga.dev/docs/commands', 'text')
    let [adopted] = adoptThreads([], [thread(body)])
    assert.equal(adopted?.title, 'Expired token is accepted')
    assert.equal(adopted?.category, 'security')
  })

  // The key and the fingerprint hash the title: an English title does not match a French one. The
  // open thread a few lines away carries the finding, so the review opens no second thread.
  it('carries an English finding on the open thread of the same defect in French, with no new thread', () => {
    let threads = [thread(FRENCH_COMMENT)]
    let stored = adoptThreads([], threads)
    let english = finding()
    assert.notEqual(findingKey(english as never), stored[0]!.key)
    let { matches, unmatched } = matchFindings([english], stored, threads)
    assert.equal(matches[0]?.stored, stored[0])
    assert.equal(matches[0]?.carrier?.commentId, 101)
    assert.deepEqual(unmatched, [])
  })
})
