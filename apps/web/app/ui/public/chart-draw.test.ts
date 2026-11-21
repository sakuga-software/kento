import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { formatValue, LABEL_MAX, money, shortLabel, tickLabel, withValues } from './chart-draw.ts'

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

  it('cuts a long label of an axis with an ellipsis, and keeps a short one (Fable P3)', () => {
    assert.equal(shortLabel('demo-app'), 'demo-app')
    let long = 'a-very-long-repository-name-of-forty-chars'
    assert.equal(shortLabel(long).length, LABEL_MAX)
    assert.ok(shortLabel(long).endsWith('…'))
    assert.equal(shortLabel(long).slice(0, -1), long.slice(0, LABEL_MAX - 1))
  })

  it('gives the axis of a bar chart the labels cut, by index (Fable re-check)', () => {
    let callback = tickLabel(['demo-app', 'sakuga-software/a-repository-with-a-long-name'])
    assert.equal(callback(0, 0), 'demo-app')
    assert.equal(callback(1, 1), 'sakuga-software/a-repos…')
    assert.equal(callback(1, 1).length, LABEL_MAX)
    assert.equal(callback(2, 2), '')
  })
})
