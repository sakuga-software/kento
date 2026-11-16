import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { FEEDBACK_MARKER, quotesRequest, replyText, requestText } from './request.ts'

describe('the request for feedback (REV-107)', () => {
  it('mentions the author only, gives the three ways to answer, and carries the marker', () => {
    let body = requestText('camille', 3)
    assert.ok(body.startsWith('@camille Kentō reviewed this PR 3 times.'))
    assert.equal(body.match(/@[\w-]+(?:\[bot\])?/g)?.filter((m) => m !== '@kento-review').length, 1)
    assert.match(body, /`@kento-review feedback <your opinion>`, quote this message, or react with 👍 or 👎/)
    assert.ok(body.endsWith(FEEDBACK_MARKER))
  })

  it('finds a quote of the request in a reply, whole or in part', () => {
    let quoted = requestText('camille', 3)
      .split('\n')
      .filter((line) => line && !line.startsWith('<!--'))
      .map((line) => `> ${line}`)
      .join('\n')
    assert.ok(quotesRequest(`${quoted}\n\nUseful.`))
    assert.ok(quotesRequest('> Your opinion on these reviews helps us\n\nThe score was too low.'))
    assert.ok(!quotesRequest('Kentō reviewed this PR, thanks.'))
    assert.ok(!quotesRequest('> Another quote\n\nOk.'))
  })

  it('keeps the text out of the quotes', () => {
    assert.equal(replyText('> Kentō reviewed this PR 3 times.\n> more\n\nA false positive.\nTwo lines.'), 'A false positive.\nTwo lines.')
    assert.equal(replyText('> Kentō reviewed this PR 3 times.'), '')
  })
})
