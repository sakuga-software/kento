// KNT-176. The cursor of `?before=` on the page of the feedback: a value that is not a cursor gives
// the first page, never an error of Postgres.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { encodeCursor } from '../findings/store.ts'
import { readFeedbackCursor } from './store.ts'

const ID = '11111111-1111-4111-8111-111111111111'

describe('the cursor of the pages of the feedback (KNT-176)', () => {
  it('reads a cursor to the microsecond, with the id that breaks the ties', () => {
    let value = encodeCursor({ at: '2026-11-10T10:00:00.000007Z', id: ID })
    assert.deepEqual(readFeedbackCursor(value), { at: '2026-11-10T10:00:00.000007Z', id: ID })
  })

  it('gives null for no cursor and for a value that is not one', () => {
    for (let value of [null, undefined, '', 'abc', '!!!', encodeCursor({ at: '2026-11-10T10:00:00.000000Z', id: 'x' }), encodeCursor({ at: 'now', id: ID })]) {
      assert.equal(readFeedbackCursor(value), null, String(value))
    }
  })

  it('gives null for a date that has the pattern but does not exist', () => {
    for (let at of ['2026-02-30T10:00:00.000000Z', '2026-13-01T10:00:00.000000Z', '2026-11-10T24:00:00.000000Z', '2026-11-10T10:60:00.000000Z', '0000-01-01T00:00:00.000000Z']) {
      assert.equal(readFeedbackCursor(encodeCursor({ at, id: ID })), null, at)
    }
  })
})
