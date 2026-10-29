import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { parseCommentCommand } from './comment-command.ts'

describe('parseCommentCommand', () => {
  it('reads the verb and the level, under both names and in any case', () => {
    assert.deepEqual(parseCommentCommand('@kento-ai review heavy'), { verb: 'review', level: 'heavy', force: false })
    assert.deepEqual(parseCommentCommand('@sakuga-review review balanced'), { verb: 'review', level: 'balanced', force: false })
    assert.deepEqual(parseCommentCommand('  @Kento-AI Review HEAVY'), { verb: 'review', level: 'heavy', force: false })
    assert.deepEqual(parseCommentCommand('@kento-ai resolve'), { verb: 'resolve', level: 'lite', force: false })
    assert.deepEqual(parseCommentCommand('@sakuga-review resolve balanced'), { verb: 'resolve', level: 'balanced', force: false })
  })

  it('reads the name alone as a lite review', () => {
    assert.deepEqual(parseCommentCommand('@kento-ai'), { verb: 'review', level: 'lite', force: false })
    assert.deepEqual(parseCommentCommand('@sakuga-review\n\nplease look again'), { verb: 'review', level: 'lite', force: false })
  })

  it('reads `force` after a level, or alone, for a review only', () => {
    assert.deepEqual(parseCommentCommand('@kento-ai review heavy force'), { verb: 'review', level: 'heavy', force: true })
    assert.deepEqual(parseCommentCommand('@kento-ai review force'), { verb: 'review', level: 'lite', force: true })
    assert.equal(parseCommentCommand('@kento-ai resolve force')?.verb, 'unknown')
    assert.deepEqual(parseCommentCommand('@kento-ai resolve heavy force'), { verb: 'resolve', level: 'heavy', force: false })
  })

  it('reads only the first line, and free text after the level', () => {
    assert.deepEqual(parseCommentCommand('@kento-ai review balanced please\nheavy force'), { verb: 'review', level: 'balanced', force: false })
    assert.deepEqual(parseCommentCommand('@kento-ai review\nheavy'), { verb: 'review', level: 'lite', force: false })
  })

  it('gives `unknown` for another verb or a wrong level, with the text of the first line', () => {
    assert.deepEqual(parseCommentCommand('@kento-ai frobnicate'), { verb: 'unknown', text: '@kento-ai frobnicate' })
    assert.equal(parseCommentCommand('@kento-ai review hevy')?.verb, 'unknown')
    assert.equal(parseCommentCommand('@sakuga-review please review')?.verb, 'unknown')
  })

  it('gives null when the comment does not start with a name of the bot', () => {
    assert.equal(parseCommentCommand('LGTM @kento-ai review heavy'), null)
    assert.equal(parseCommentCommand('@kentobot review'), null)
    // `@kento` is a GitHub account of another person: a mention notifies it.
    assert.equal(parseCommentCommand('@kento review heavy'), null)
    assert.equal(parseCommentCommand('@sakuga-review-ci review'), null)
    assert.equal(parseCommentCommand('@sakuga-reviewer review'), null)
    assert.equal(parseCommentCommand(''), null)
  })
})
