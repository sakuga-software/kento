import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { parseCommentCommand, USAGE } from './comment-command.ts'

describe('parseCommentCommand', () => {
  it('reads the verb and the level, under both names and in any case', () => {
    assert.deepEqual(parseCommentCommand('@kento-review review heavy'), { verb: 'review', level: 'heavy', force: false })
    assert.deepEqual(parseCommentCommand('@sakuga-review review balanced'), { verb: 'review', level: 'balanced', force: false })
    assert.deepEqual(parseCommentCommand('  @Kento-Review Review HEAVY'), { verb: 'review', level: 'heavy', force: false })
    assert.deepEqual(parseCommentCommand('@kento-review resolve'), { verb: 'resolve', level: 'lite', force: false })
    assert.deepEqual(parseCommentCommand('@sakuga-review resolve balanced'), { verb: 'resolve', level: 'balanced', force: false })
  })

  it('reads the name alone as a lite review', () => {
    assert.deepEqual(parseCommentCommand('@kento-review'), { verb: 'review', level: 'lite', force: false })
    assert.deepEqual(parseCommentCommand('@sakuga-review\n\nplease look again'), { verb: 'review', level: 'lite', force: false })
  })

  it('reads `force` after a level, or alone, for a review only', () => {
    assert.deepEqual(parseCommentCommand('@kento-review review heavy force'), { verb: 'review', level: 'heavy', force: true })
    assert.deepEqual(parseCommentCommand('@kento-review review force'), { verb: 'review', level: 'lite', force: true })
    assert.equal(parseCommentCommand('@kento-review resolve force')?.verb, 'unknown')
    assert.deepEqual(parseCommentCommand('@kento-review resolve heavy force'), { verb: 'resolve', level: 'heavy', force: false })
  })

  it('reads only the first line, and free text after the level', () => {
    assert.deepEqual(parseCommentCommand('@kento-review review balanced please\nheavy force'), { verb: 'review', level: 'balanced', force: false })
    assert.deepEqual(parseCommentCommand('@kento-review review\nheavy'), { verb: 'review', level: 'lite', force: false })
  })

  it('gives `unknown` for another verb or a wrong level, with the text of the first line', () => {
    assert.deepEqual(parseCommentCommand('@kento-review frobnicate'), { verb: 'unknown', text: '@kento-review frobnicate' })
    assert.equal(parseCommentCommand('@kento-review review hevy')?.verb, 'unknown')
    assert.equal(parseCommentCommand('@sakuga-review please review')?.verb, 'unknown')
  })

  it('takes the level without the verb review', () => {
    assert.deepEqual(parseCommentCommand('@kento-review heavy'), { verb: 'review', level: 'heavy', force: false })
    assert.deepEqual(parseCommentCommand('@kento-review heavy force'), { verb: 'review', level: 'heavy', force: true })
    assert.deepEqual(parseCommentCommand('@kento-review force'), { verb: 'review', level: 'lite', force: true })
    assert.deepEqual(parseCommentCommand('@kento-review Balanced, please'), { verb: 'unknown', text: '@kento-review Balanced, please' })
    assert.deepEqual(parseCommentCommand('@kento-review balanced please'), { verb: 'review', level: 'balanced', force: false })
    // A word after the level is free text, as after `review heavy`.
    assert.deepEqual(parseCommentCommand('@kento-review heavy resolve'), { verb: 'review', level: 'heavy', force: false })
    assert.deepEqual(parseCommentCommand('@kento-review frobnicate heavy'), { verb: 'unknown', text: '@kento-review frobnicate heavy' })
  })

  it('gives null when the comment does not start with a name of the bot', () => {
    assert.equal(parseCommentCommand('LGTM @kento-review review heavy'), null)
    assert.equal(parseCommentCommand('@kentobot review'), null)
    // `@kento` is a GitHub account of another person: a mention notifies it.
    assert.equal(parseCommentCommand('@kento review heavy'), null)
    assert.equal(parseCommentCommand('@sakuga-review-ci review'), null)
    assert.equal(parseCommentCommand('@sakuga-reviewer review'), null)
    assert.equal(parseCommentCommand(''), null)
  })
})

describe('USAGE', () => {
  it('lists the commands, and the cost of each level without the name of a model', () => {
    assert.equal(
      USAGE,
      [
        'Commandes de Kentō, dans un commentaire de la PR (`@sakuga-review` marche aussi) :',
        '',
        '- `@kento-review [lite|balanced|heavy]` : une review de la PR au niveau donné (`lite` par défaut).',
        '- `@kento-review heavy force` : une nouvelle review à un niveau que ce commit a déjà reçu (elle est payée deux fois).',
        '- `@kento-review resolve [lite|balanced|heavy]` : répondre aux fils ouverts, et résoudre ceux que le code règle.',
        '',
        "`lite` : le diff et les définitions qu'il utilise, environ 1 centime. " +
          '`balanced` : en plus, le code qui appelle le changement, de 10 à 20 centimes. ' +
          '`heavy` : le contexte de `balanced` avec plus de réflexion, de 30 à 50 centimes. ' +
          'Le modèle de chaque niveau se règle dans la config du repo.',
        '',
        'Seule une personne qui peut écrire dans le repo peut lancer une commande.',
      ].join('\n'),
    )
  })
})
