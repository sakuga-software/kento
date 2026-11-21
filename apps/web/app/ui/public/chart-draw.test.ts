import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { formatValue, money, withValues } from './chart-draw.ts'

describe('the charts drawn from the numbers of a page (KNT-188, KNT-191)', () => {
  it('leaves out of a bar chart the rows with no value', () => {
    let data = { labels: ['demo-app', 'mobile-client', 'docs-site'], series: [{ name: 'Precision', values: [83, null, 74] }] }
    assert.deepEqual(withValues(data), { labels: ['demo-app', 'docs-site'], series: [{ name: 'Precision', values: [83, 74] }] })
  })

  it('writes a number in the unit of its chart', () => {
    assert.equal(money(0.004), '$0.004')
    assert.equal(money(12.5), '$12.50')
    assert.equal(money(0), '$0.00')
    assert.equal(formatValue(85.7, 'pct'), '86%')
    assert.equal(formatValue(0.15, 'usd'), '$0.15')
  })
})
