// KNT-183, KNT-187. The band and the text of a confidence score (app/ui/score.tsx).
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { scoreBand, scoreText } from './score.tsx'

describe('a confidence score', () => {
  it('is high from 3.5, in the middle from 2.5, and low under it', () => {
    assert.deepEqual([1, 2, 2.49, 2.5, 3, 3.49, 3.5, 4, 5].map(scoreBand), ['low', 'low', 'low', 'mid', 'mid', 'mid', 'high', 'high', 'high'])
  })

  it('says a score whole, and an average with one decimal', () => {
    assert.equal(scoreText(4, false), '4/5')
    assert.equal(scoreText(4.24, true), '4.2/5')
    assert.equal(scoreText(5, true), '5.0/5')
  })
})
