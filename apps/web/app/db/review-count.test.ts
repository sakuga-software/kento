// KNT-175. The names of the reviews of a pull request. The SQL of the rule is in test/db/review-count.test.ts.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { countsSql, numberSql, rankLabel, rankOf } from './review-count.ts'

const row = { number: null, published: true, copy: false, copyHead: null, copyNumber: null }

describe('the rank of a review (KNT-175)', () => {
  it('gives an R number to a published review only, and names a copy by its source', () => {
    assert.deepEqual(rankOf({ ...row, number: 3 }), { kind: 'counted', number: 3 })
    assert.deepEqual(rankOf({ ...row, copy: true, copyHead: 'a'.repeat(40), copyNumber: 2 }), { kind: 'copy', of: 2, head: 'a'.repeat(40) })
    assert.deepEqual(rankOf({ ...row, published: false, number: null }), { kind: 'unpublished' })
    // A copy that the publisher did not post yet, or that a later review replaced, is not on GitHub.
    assert.deepEqual(rankOf({ ...row, published: false, copy: true, copyHead: 'a'.repeat(40), copyNumber: 2 }), { kind: 'unpublished' })
  })

  it('says "R3", "same as R2", "same as <commit>" once the source is gone, and "not published"', () => {
    assert.equal(rankLabel({ kind: 'counted', number: 3 }), 'R3')
    assert.equal(rankLabel({ kind: 'copy', of: 2, head: 'a'.repeat(40) }), 'same as R2')
    assert.equal(rankLabel({ kind: 'copy', of: null, head: '1a2b3c4d5e' }), 'same as 1a2b3c4')
    assert.equal(rankLabel({ kind: 'unpublished' }), 'not published')
  })

  it('refuses an alias that is not a plain name: the SQL goes into queries as text', () => {
    assert.throws(() => countsSql('r; drop table reviews'), /not a table alias/)
    assert.throws(() => numberSql('R'), /not a table alias/)
    assert.match(countsSql('r'), /r\.github_review_id is not null and r\.result -> 'reusedFrom' is null/)
  })
})
