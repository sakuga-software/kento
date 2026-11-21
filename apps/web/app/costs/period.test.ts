import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { dayKey, periodQuery, periodRange, readPeriod } from './period.ts'

const at = (iso: string) => new Date(iso)
const day = (date: Date) => dayKey(date)

describe('the periods of the Costs screen (KNT-188)', () => {
  it('reads a known period, and the default for none or an unknown value (KNT-195)', () => {
    assert.equal(readPeriod(null), 'month')
    assert.equal(readPeriod(''), 'month')
    assert.equal(readPeriod('year'), 'month')
    assert.equal(readPeriod('MONTH'), 'month')
    assert.equal(readPeriod('last-month'), 'last-month')
    assert.equal(readPeriod('30d'), '30d')
    assert.equal(readPeriod('90d'), '90d')
    assert.equal(periodQuery('month'), '')
    assert.equal(periodQuery('90d'), '?period=90d')
  })

  it('makes "this month" end today, against the same days of the month before', () => {
    let range = periodRange('month', at('2026-11-21T22:30:00Z'))
    assert.equal(day(range.start), '2026-11-01')
    assert.equal(day(range.end), '2026-11-22')
    assert.equal(range.days.length, 21)
    assert.equal(range.days[0], '2026-11-01')
    assert.equal(range.days.at(-1), '2026-11-21')
    assert.equal(day(range.previousStart), '2026-10-01')
    assert.equal(day(range.previousEnd), '2026-10-22')
    assert.equal(range.monthDays, 30)
  })

  it('stops the days before at the end of a shorter month', () => {
    // 31 March against February 2026, which has 28 days.
    let range = periodRange('month', at('2026-03-31T08:00:00Z'))
    assert.equal(day(range.previousStart), '2026-02-01')
    assert.equal(day(range.previousEnd), '2026-03-01')
    assert.equal(range.days.length, 31)
    // On the first day of the year, the month before is December of the year before.
    let first = periodRange('month', at('2026-01-01T00:00:00Z'))
    assert.equal(day(first.start), '2026-01-01')
    assert.deepEqual(first.days, ['2026-01-01'])
    assert.equal(day(first.previousStart), '2025-12-01')
    assert.equal(day(first.previousEnd), '2025-12-02')
  })

  it('makes "last month" the whole month before, against the month before it', () => {
    let range = periodRange('last-month', at('2026-03-15T12:00:00Z'))
    assert.equal(day(range.start), '2026-02-01')
    assert.equal(day(range.end), '2026-03-01')
    assert.equal(range.days.length, 28)
    assert.equal(day(range.previousStart), '2026-01-01')
    assert.equal(day(range.previousEnd), '2026-02-01')
  })

  it('makes 30 and 90 days end today, against as many days before', () => {
    let thirty = periodRange('30d', at('2026-11-21T05:00:00Z'))
    assert.equal(thirty.days.length, 30)
    assert.equal(thirty.days[0], '2026-10-23')
    assert.equal(thirty.days.at(-1), '2026-11-21')
    assert.equal(day(thirty.previousStart), '2026-09-23')
    assert.equal(day(thirty.previousEnd), '2026-10-23')
    let ninety = periodRange('90d', at('2026-11-21T05:00:00Z'))
    assert.equal(ninety.days.length, 90)
    assert.equal(ninety.previousEnd.getTime(), ninety.start.getTime())
    assert.equal((ninety.start.getTime() - ninety.previousStart.getTime()) / 86_400_000, 90)
  })
})
