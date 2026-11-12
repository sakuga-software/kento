import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { FEEDBACK_MARKER, quotesRequest, replyText, requestText } from './request.ts'

describe('the request for feedback (REV-107)', () => {
  it('mentions the author only, gives the three ways to answer, and carries the marker', () => {
    let body = requestText('camille', 3)
    assert.ok(body.startsWith('@camille Kentō a relu cette PR 3 fois.'))
    assert.equal(body.match(/@[\w-]+(?:\[bot\])?/g)?.filter((m) => m !== '@kento-review').length, 1)
    assert.match(body, /`@kento-review feedback <ton avis>`, cite ce message, ou réagis avec 👍 ou 👎/)
    assert.ok(body.endsWith(FEEDBACK_MARKER))
  })

  it('finds a quote of the request in a reply, whole or in part', () => {
    let quoted = requestText('camille', 3)
      .split('\n')
      .filter((line) => line && !line.startsWith('<!--'))
      .map((line) => `> ${line}`)
      .join('\n')
    assert.ok(quotesRequest(`${quoted}\n\nUtile.`))
    assert.ok(quotesRequest('> Ton avis sur ces reviews nous aide\n\nLe score était trop bas.'))
    assert.ok(!quotesRequest('Kentō a relu cette PR, merci.'))
    assert.ok(!quotesRequest('> Une autre citation\n\nOk.'))
  })

  it('keeps the text out of the quotes', () => {
    assert.equal(replyText('> Kentō a relu cette PR 3 fois.\n> suite\n\nUn faux positif.\nDeux lignes.'), 'Un faux positif.\nDeux lignes.')
    assert.equal(replyText('> Kentō a relu cette PR 3 fois.'), '')
  })
})
