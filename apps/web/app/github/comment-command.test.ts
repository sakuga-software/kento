import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { parseCommentCommand, rejectProblem, usage, usageText } from './comment-command.ts'
import { REASON_MAX } from '../findings/store.ts'
import { inlineBody, shortId } from '@sakuga-review/engine/render'

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

describe('reject (REV-93)', () => {
  it('reads the reason as written, with its case and its punctuation', () => {
    assert.deepEqual(parseCommentCommand('@kento-review reject False positive, the value is validated by the schema'), {
      verb: 'reject',
      id: null,
      reason: 'False positive, the value is validated by the schema',
    })
    assert.deepEqual(parseCommentCommand('@sakuga-review REJECT  Zod checks it  '), { verb: 'reject', id: null, reason: 'Zod checks it' })
    assert.deepEqual(parseCommentCommand('Not a bug.\n\n@kento-review reject the caller checks `x`'), { verb: 'reject', id: null, reason: 'the caller checks `x`' })
  })

  it('reads a short id first: with `#`, or without `#` when it has a digit', () => {
    assert.deepEqual(parseCommentCommand('@kento-review reject #3CF454 the schema validates it'), { verb: 'reject', id: '3cf454', reason: 'the schema validates it' })
    assert.deepEqual(parseCommentCommand('@kento-review reject 3cf454a1b2c3 dup'), { verb: 'reject', id: '3cf454a1b2c3', reason: 'dup' })
    // A word of hexadecimal letters is the start of the reason.
    assert.deepEqual(parseCommentCommand('@kento-review reject facade is fine'), { verb: 'reject', id: null, reason: 'facade is fine' })
    assert.deepEqual(parseCommentCommand('@kento-review reject #abcdef ok'), { verb: 'reject', id: 'abcdef', reason: 'ok' })
    // Too short or too long for an id: the reason.
    assert.deepEqual(parseCommentCommand('@kento-review reject #3cf45 ok'), { verb: 'reject', id: null, reason: '#3cf45 ok' })
    assert.deepEqual(parseCommentCommand('@kento-review reject 3cf454a1b2c3d ok'), { verb: 'reject', id: null, reason: '3cf454a1b2c3d ok' })
  })

  it('reads the id exactly as a comment of Kentō shows it, `#` included', () => {
    let finding = { path: 'src/a.ts', line: 3, severity: 'major', category: 'bug', confidence: 90, title: 'The `exp` token passes', scenario: 's', fix: 'f', suggestion: '' }
    let shown = /`(#[0-9a-f]{6})`/.exec(inlineBody(finding as never, false).split('\n')[0]!)?.[1]
    assert.equal(shown, shortId(finding as never))
    assert.deepEqual(parseCommentCommand(`@kento-review reject ${shown} the schema validates it`), {
      verb: 'reject',
      id: shown!.slice(1),
      reason: 'the schema validates it',
    })
  })

  it('gives an empty reason when the line has none, and reads only the line of the command', () => {
    assert.deepEqual(parseCommentCommand('@kento-review reject'), { verb: 'reject', id: null, reason: '' })
    assert.deepEqual(parseCommentCommand('@kento-review reject #3cf454'), { verb: 'reject', id: '3cf454', reason: '' })
    assert.deepEqual(parseCommentCommand('@kento-review reject\nthe reason below'), { verb: 'reject', id: null, reason: '' })
    // `rejected` is another word.
    assert.equal(parseCommentCommand('@kento-review rejected')?.verb, 'unknown')
  })

  it('refuses a reject without a reason, with a reason too long, without an id in the conversation, with an id in a thread', () => {
    let reject = (id: string | null, reason: string) => ({ verb: 'reject' as const, id, reason })
    assert.equal(rejectProblem(reject(null, 'ok'), 'thread'), null)
    assert.equal(rejectProblem(reject('3cf454', 'ok'), 'conversation'), null)
    assert.equal(rejectProblem(reject(null, ''), 'thread'), 'reason_missing')
    assert.equal(rejectProblem(reject('3cf454', ''), 'conversation'), 'reason_missing')
    assert.equal(rejectProblem(reject(null, 'x'.repeat(REASON_MAX)), 'thread'), null)
    assert.equal(rejectProblem(reject(null, 'x'.repeat(REASON_MAX + 1)), 'thread'), 'reason_long')
    assert.equal(rejectProblem(reject(null, 'ok'), 'conversation'), 'id_missing')
    assert.equal(rejectProblem(reject('3cf454', 'ok'), 'thread'), 'id_in_thread')
  })
})

describe('usageText', () => {
  it('lists the commands, and the cost of each level without the name of a model', () => {
    assert.equal(
      usageText(),
      [
        'Kentō commands, in a comment of the PR (`@sakuga-review` works too):',
        '',
        '- `@kento-review [lite|balanced|heavy]`: a review of the PR at the given level (`lite` by default).',
        '- `@kento-review heavy force`: a new review at a level that this commit already got (you pay for it twice).',
        '- `@kento-review resolve [lite|balanced|heavy]`: answer the open threads, and resolve those that the code settles.',
        '- `@kento-review reject <cause>`, as a reply in the thread of a finding: dismiss that finding, with its cause.',
        '- `@kento-review reject #<id> <cause>`, in the conversation: dismiss the finding with this id (shown in the list of the description).',
        '- `@kento-review feedback <opinion>`: give your opinion on the reviews of Kentō (free).',
        '',
        '`lite`: the diff and the definitions that it uses, about 1 cent. ' +
          '`balanced`: also the code that calls the change, 10 to 20 cents. ' +
          '`heavy`: the context of `balanced` with more reasoning, 30 to 50 cents. ' +
          'The config of the repo sets the model of each level.',
        '',
        'The cause goes on the line of the command, in 500 characters at most. ' +
          'Only a person who can write to the repo can run a command, except `feedback`.',
      ].join('\n'),
    )
  })
})

describe('feedback (REV-107)', () => {
  it('reads `feedback` with its text, and never as a review or an unknown command', () => {
    assert.deepEqual(parseCommentCommand('@kento-review feedback it found the bug'), { verb: 'feedback', text: 'it found the bug' })
    assert.deepEqual(parseCommentCommand('@Kento-Review FEEDBACK  heavy force'), { verb: 'feedback', text: 'heavy force' })
    assert.deepEqual(parseCommentCommand('@sakuga-review feedback'), { verb: 'feedback', text: '' })
    assert.equal(parseCommentCommand('@kento-review feedbacks')?.verb, 'unknown')
  })

  it('keeps the lines under the command as the text', () => {
    assert.deepEqual(parseCommentCommand('Thanks.\n@kento-review feedback a false positive:\n\nthe thread on the cache.'), {
      verb: 'feedback',
      text: 'a false positive:\n\nthe thread on the cache.',
    })
  })
})

describe('the account of the App (REV-96)', () => {
  it('reads `@kento-review[bot]` as a mention of the App, not as a command', () => {
    assert.equal(parseCommentCommand('@kento-review[bot] thanks, not applied: the schema validates it'), null)
    assert.equal(parseCommentCommand('@Sakuga-Review[bot] ok'), null)
    assert.deepEqual(parseCommentCommand('@kento-review[bot] see below\n@kento-review heavy'), { verb: 'review', level: 'heavy', force: false })
  })
})

describe('usage (REV-96)', () => {
  it('links the page of the commands when the service knows its public URL', () => {
    assert.equal(usage(null), usageText())
    assert.match(usage('https://review.sakuga.dev/docs/commands'), /\[Kentō commands\]\(https:\/\/review\.sakuga\.dev\/docs\/commands\)\.$/)
    assert.ok(usage('https://review.sakuga.dev/docs/commands').startsWith(usageText()))
    assert.match(usageText(), /`@kento-review reject <cause>`/)
  })
})
