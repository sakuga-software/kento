import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { LABEL_MAX, money, shortLabel, tickLabel } from './draw.ts'

describe('the charts of the Costs screen (KNT-188)', () => {
  it('cuts a long label of an axis with an ellipsis, and keeps a short one (Fable P3)', () => {
    assert.equal(shortLabel('demo-app'), 'demo-app')
    let long = 'a-very-long-repository-name-of-forty-chars'
    assert.equal(shortLabel(long).length, LABEL_MAX)
    assert.ok(shortLabel(long).endsWith('…'))
    assert.equal(shortLabel(long).slice(0, -1), long.slice(0, LABEL_MAX - 1))
  })

  it('writes a cost as the tables do', () => {
    assert.equal(money(0.004), '$0.004')
    assert.equal(money(12.5), '$12.50')
  })

  it('gives the axis of a bar chart the labels cut, by index (Fable re-check)', () => {
    let callback = tickLabel(['demo-app', 'sakuga-software/a-repository-with-a-long-name'])
    assert.equal(callback(0, 0), 'demo-app')
    assert.equal(callback(1, 1), 'sakuga-software/a-repos…')
    assert.equal(callback(1, 1).length, LABEL_MAX)
    assert.equal(callback(2, 2), '')
  })
})
