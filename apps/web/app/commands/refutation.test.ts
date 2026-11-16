import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CASES } from './refutation.cases.ts'
import { DOCS_PATH, HINT_MARKER, hintText, looksRefuted, replyHead } from './refutation.ts'

describe('looksRefuted (REV-96)', () => {
  it('reads the replies of the ticket: "Not applied" gets the hint, "Applied in abc123" does not', () => {
    assert.equal(looksRefuted('Not applied: the value is validated by the schema'), true)
    assert.equal(looksRefuted('Applied in abc123'), false)
  })

  it('reads the refutations', () => {
    for (let reply of [
      'No change, on purpose.',
      'Kept as is: the order is the one of main.',
      'Out of scope for this pull request.',
      'Agreed, no change: the doc block names it.',
      'Skipped, the premise does not hold.',
      'Same finding as the thread above, same answer.',
      'Known and wanted: the cache is per process.',
      'Risk accepted: it is the chosen trade-off.',
    ]) {
      assert.equal(looksRefuted(reply), true, reply)
    }
  })

  it('never hints a reply that says the fix went in, even in part, or that agrees', () => {
    for (let reply of [
      'Fixed in 04ed9b7, as suggested.',
      'Partially applied in 1a2b3c4: the rest is out of scope.',
      'Agreed, fixed in 1a2b3c4.',
      'Good catch, done.',
      'Thanks! Is the schema the right place?',
    ]) {
      assert.equal(looksRefuted(reply), false, reply)
    }
  })

  it('reads the start after the marker of an agent, a mention, emphasis or a quote of the finding', () => {
    assert.equal(looksRefuted('<!-- claude-reply -->\nNot applied: the guard runs first.'), true)
    assert.equal(looksRefuted('@kento-review[bot] **Not applied.** The guard runs first.'), true)
    assert.equal(looksRefuted('> **Bug** in the guard\n\nKept as is: the guard runs first.'), true)
    assert.equal(replyHead('> quoted\n\n**No change**, on purpose'), 'No change**, on purpose')
    // A refutation further in the reply is not its start.
    assert.equal(looksRefuted('Applied in abc123. Not applied: the second suggestion.'), false)
  })

  it('never hints a reply that already names `reject`, even in a block of code', () => {
    assert.equal(looksRefuted('Not applied: the schema validates it.\n\n```\n@kento-review reject the schema validates it\n```'), false)
    assert.equal(looksRefuted('Not applied. > @sakuga-review reject dup'), false)
  })

  it('keeps a precision of 95 % or more and a recall of 65 % or more on real replies labelled by hand', () => {
    let tp = 0
    let fp: string[] = []
    let fn = 0
    for (let [label, head] of CASES) {
      let hit = looksRefuted(head)
      if (hit && label === 'refutes') tp++
      else if (hit) fp.push(head)
      else if (label === 'refutes') fn++
    }
    let precision = tp / (tp + fp.length)
    let recall = tp / (tp + fn)
    assert.ok(CASES.length >= 150, `${CASES.length} cases`)
    assert.ok(precision >= 0.95, `precision ${precision.toFixed(3)}: ${fp.join(' | ')}`)
    assert.ok(recall >= 0.65, `recall ${recall.toFixed(3)}`)
  })
})

describe('hintText (REV-96)', () => {
  it('gives the command, the link to the page of the commands and the hidden marker', () => {
    let text = hintText('alex', `https://review.sakuga.dev${DOCS_PATH}`)
    assert.equal(
      text,
      '@alex This reply seems to set the finding aside. To count it as rejected (it will not come back and will not lower the score again), comment ' +
        '`@kento-review reject <cause>`. [Kentō commands](https://review.sakuga.dev/docs/commands)\n\n<!-- kento:reject-hint -->',
    )
    // At a review, nobody is mentioned; without a public URL, no link.
    assert.ok(!hintText(null, null).includes('@alex'))
    assert.ok(!hintText(null, null).includes('](') && hintText(null, null).endsWith(HINT_MARKER))
  })
})
