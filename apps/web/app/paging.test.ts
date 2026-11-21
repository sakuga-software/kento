import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { PAGE_NUMBER_MAX, PER_PAGE_MAX, PER_PAGE_MIN, pageWindow, readPageNumber, readPageSize } from './paging.ts'

const read = (query: string) => readPageNumber(new URLSearchParams(query))

describe('the numbered pages of a list (KNT-146)', () => {
  it('reads ?page=n, and gives 1 for a value that is not a whole number of 1 or more', () => {
    assert.equal(read(''), 1)
    assert.equal(read('page=1'), 1)
    assert.equal(read('page=2'), 2)
    assert.equal(read('page=42&q=x'), 42)
    for (let value of ['0', '-3', '2.5', '1e3', ' 2', '02', 'abc', '', '0x10', '+2']) {
      assert.equal(read(`page=${encodeURIComponent(value)}`), 1, value)
    }
  })

  it('reads a page over the highest one as the highest one, whatever its length: the store then shows the last page', () => {
    assert.equal(read(`page=${PAGE_NUMBER_MAX}`), PAGE_NUMBER_MAX)
    assert.equal(read('page=999999'), PAGE_NUMBER_MAX)
    assert.equal(read('page=9999999'), PAGE_NUMBER_MAX)
    assert.equal(read(`page=${'9'.repeat(400)}`), PAGE_NUMBER_MAX)
  })

  it('gives the page on screen, the count of pages and the offset', () => {
    assert.deepEqual(pageWindow(undefined, 120, 25), { page: 1, pages: 5, offset: 0 })
    assert.deepEqual(pageWindow(2, 120, 25), { page: 2, pages: 5, offset: 25 })
    assert.deepEqual(pageWindow(5, 120, 25), { page: 5, pages: 5, offset: 100 })
    // A page past the last one gives the last one; an empty list has one page.
    assert.deepEqual(pageWindow(99, 120, 25), { page: 5, pages: 5, offset: 100 })
    assert.deepEqual(pageWindow(PAGE_NUMBER_MAX, 0, 25), { page: 1, pages: 1, offset: 0 })
    // A page that is not a whole number of 1 or more gives the first one.
    for (let asked of [0, -2, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      assert.deepEqual(pageWindow(asked, 120, 25), { page: 1, pages: 5, offset: 0 }, String(asked))
    }
    // The offset stays under the count of rows, whatever the limit.
    for (let limit of [1, 7, 25, 1e15]) {
      let { offset } = pageWindow(PAGE_NUMBER_MAX, 120, limit)
      assert.ok(offset < 120, `${limit}: ${offset}`)
    }
  })
})

describe('the size of a page (KNT-178)', () => {
  it('reads ?per=n between 10 and 100, and gives null for a value that is not a whole number of 1 or more', () => {
    let read = (per: string) => readPageSize(new URLSearchParams(per ? { per } : {}))
    assert.equal(read('25'), 25)
    assert.equal(read('10'), PER_PAGE_MIN)
    assert.equal(read('3'), PER_PAGE_MIN)
    assert.equal(read('100'), PER_PAGE_MAX)
    assert.equal(read('999999'), PER_PAGE_MAX)
    assert.equal(read('1000000'), PER_PAGE_MAX)
    assert.equal(read('9'.repeat(400)), PER_PAGE_MAX, 'a number too long for a double is Infinity, the highest bound')
    for (let value of ['', '0', '-5', '2.5', '1e2', 'abc', '025', ' 50', '0x20']) assert.equal(read(value), null, value)
  })
})
