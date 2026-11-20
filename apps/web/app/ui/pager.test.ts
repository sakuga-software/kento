import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { pageNumbers, readPageNumber } from './pager.tsx'

const read = (query: string) => readPageNumber(new URLSearchParams(query))

describe('the numbered pager (KNT-146)', () => {
  it('reads ?page=n, and gives 1 for a value that is not a page', () => {
    assert.equal(read(''), 1)
    assert.equal(read('page=1'), 1)
    assert.equal(read('page=2'), 2)
    assert.equal(read('page=42&q=x'), 42)
    for (let value of ['0', '-3', '2.5', '1e3', ' 2', '02', 'abc', '', '9999999']) {
      assert.equal(read(`page=${encodeURIComponent(value)}`), 1, value)
    }
    assert.equal(read('page=999999'), 100_000)
  })

  it('shows every page up to 7, then the first, the last and the pages around the current one', () => {
    assert.deepEqual(pageNumbers(1, 1), [1])
    assert.deepEqual(pageNumbers(2, 7), [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(pageNumbers(1, 8), [1, 2, 3, 4, 5, null, 8])
    assert.deepEqual(pageNumbers(4, 8), [1, 2, 3, 4, 5, null, 8])
    assert.deepEqual(pageNumbers(5, 8), [1, null, 4, 5, 6, 7, 8])
    assert.deepEqual(pageNumbers(8, 8), [1, null, 4, 5, 6, 7, 8])
    assert.deepEqual(pageNumbers(10, 40), [1, null, 9, 10, 11, null, 40])
    // Seven places on every page: the pager keeps its width.
    for (let page = 1; page <= 40; page++) {
      let numbers = pageNumbers(page, 40)
      assert.equal(numbers.length, 7, String(page))
      assert.ok(numbers.includes(page), String(page))
    }
  })
})
