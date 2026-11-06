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

  it('reads a command on its own line anywhere in the comment (REV-72)', () => {
    assert.deepEqual(parseCommentCommand('Fixed in abc1234, with a test.\n\n@kento-review balanced'), { verb: 'review', level: 'balanced', force: false })
    assert.deepEqual(parseCommentCommand('Rebased on main.\n@sakuga-review review heavy\nThanks!'), { verb: 'review', level: 'heavy', force: false })
    assert.deepEqual(parseCommentCommand('Done.\r\n\r\n@kento-review resolve balanced\r\n'), { verb: 'resolve', level: 'balanced', force: false })
    // The first command of the comment counts, as one comment gives one job.
    assert.deepEqual(parseCommentCommand('Two asks:\n@kento-review heavy\n@kento-review resolve'), { verb: 'review', level: 'heavy', force: false })
  })

  it('gives `unknown` for a command of the wrong form on its own line, so that the bot answers it (REV-72)', () => {
    assert.deepEqual(parseCommentCommand('Thanks for the review.\n\n@kento-review hevy'), { verb: 'unknown', text: '@kento-review hevy' })
    assert.deepEqual(parseCommentCommand('Fixed.\n@sakuga-review please review again'), { verb: 'unknown', text: '@sakuga-review please review again' })
  })

  it('reads no command in a code block or a quote (REV-72)', () => {
    assert.equal(parseCommentCommand('Run this:\n```\n@kento-review heavy\n```'), null)
    assert.equal(parseCommentCommand('Run this:\n~~~md\n@kento-review heavy\n~~~'), null)
    assert.equal(parseCommentCommand('  ```sh\n@kento-review heavy\n  ```\nok'), null)
    // A fence of four backticks ends only at four backticks or more.
    assert.equal(parseCommentCommand('````\n```\n@kento-review heavy\n```\n````'), null)
    // A fence that is never closed runs to the end of the comment.
    assert.equal(parseCommentCommand('```\n@kento-review heavy'), null)
    assert.equal(parseCommentCommand('Indented code:\n\n    @kento-review heavy'), null)
    assert.equal(parseCommentCommand('> @kento-review heavy\n\nI did not ask for this.'), null)
    assert.equal(parseCommentCommand('> quoted\n>\n>  @kento-review resolve\nAgreed.'), null)
    // Markdown keeps in the quote the lines that follow it up to a blank line.
    assert.equal(parseCommentCommand('> You said:\n@kento-review heavy'), null)
    assert.equal(parseCommentCommand('Use `@kento-review heavy` for a deeper look.'), null)
    // After the block, a command on its own line counts.
    assert.deepEqual(parseCommentCommand('```\n@kento-review heavy\n```\n@kento-review balanced'), { verb: 'review', level: 'balanced', force: false })
    assert.deepEqual(parseCommentCommand('> @kento-review heavy\n\n@kento-review resolve'), { verb: 'resolve', level: 'lite', force: false })
  })

  it('gives null when no line of the comment starts with a name of the bot', () => {
    assert.equal(parseCommentCommand('LGTM @kento-review review heavy'), null)
    assert.equal(parseCommentCommand('Fixed.\nAsk @kento-review heavy if needed.'), null)
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
