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
    assert.ok(quotesRequest(`${quoted}\n\nUtile.`))
    assert.ok(quotesRequest('> Your opinion on these reviews helps us\n\nThe score was too low.'))
    assert.ok(!quotesRequest('Kentō reviewed this PR, thanks.'))
    assert.ok(!quotesRequest('> Une autre citation\n\nOk.'))
  })

  // REV-114. A pull request opened before the deploy holds the French request: a quote of it still counts.
  it('finds a quote of the French request of the pull requests before the deploy', () => {
    let french =
      "@camille Kentō a relu cette PR 3 fois. Ton avis sur ces reviews nous aide à l'améliorer : ce qui t'a servi, un faux positif, un fil inutile, " +
      'un défaut manqué. Pour répondre, écris `@kento-review feedback <ton avis>`, cite ce message, ou réagis avec 👍 ou 👎.'
    assert.ok(quotesRequest(`> ${french}\n\nUtile.`))
    assert.ok(quotesRequest('> Ton avis sur ces reviews nous aide\n\nLe score était trop bas.'))
    assert.ok(quotesRequest('> Kentō a relu cette PR 3 fois.\n\nUn faux positif.'))
    assert.ok(!quotesRequest('Kentō a relu cette PR, merci.'))
  })

  it('keeps the text out of the quotes', () => {
    assert.equal(replyText('> Kentō a relu cette PR 3 fois.\n> suite\n\nUn faux positif.\nDeux lignes.'), 'Un faux positif.\nDeux lignes.')
    assert.equal(replyText('> Kentō a relu cette PR 3 fois.'), '')
  })
})
