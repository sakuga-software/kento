import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { decileOf, DECILES, measure, rateText, renderMeasures, wilson, type ClosedFinding } from './measures.ts'

function closed(status: ClosedFinding['status'], fields: Partial<ClosedFinding> = {}): ClosedFinding {
  return { week: '2026-11-02', repo: 'sakuga-software/pantry', severity: 'major', category: 'bug', confidence: 80, status, ...fields }
}

function times<T>(n: number, make: () => T): T[] {
  return Array.from({ length: n }, make)
}

describe('wilson', () => {
  it('gives the interval of a hand computation', () => {
    let rate = wilson(8, 10)
    assert.equal(rate.rate, 0.8)
    assert.equal(rate.low!.toFixed(4), '0.4902')
    assert.equal(rate.high!.toFixed(4), '0.9433')
  })

  it('stays in [0, 1] at 0 of n and n of n, and gives null with no trial', () => {
    assert.equal(wilson(0, 5).low, 0)
    assert.ok(wilson(0, 5).high! > 0.4)
    assert.equal(wilson(5, 5).high, 1)
    assert.ok(wilson(5, 5).low! < 0.6)
    assert.deepEqual(wilson(0, 0), { k: 0, n: 0, rate: null, low: null, high: null })
  })
})

describe('decileOf', () => {
  it('puts 100 in the top decile', () => {
    assert.deepEqual([0, 9, 10, 69, 70, 99, 100].map(decileOf), ['0-9', '0-9', '10-19', '60-69', '70-79', '90-100', '90-100'])
    assert.equal(DECILES.length, 10)
    assert.equal(DECILES.at(-1), '90-100')
  })
})

describe('measure', () => {
  it('counts the handled and the reject rates for each week, repository, severity, category and decile', () => {
    let findings = [
      closed('fixed'),
      closed('fixed', { repo: 'sakuga-software/orchard', severity: 'minor' }),
      closed('dismissed', { category: 'security', confidence: 55 }),
      closed('wontfix'),
      closed('fixed', { week: '2026-10-26' }),
    ]
    let report = measure(findings, [
      { week: '2026-11-02', repo: 'sakuga-software/pantry', prs: 3, findings: 7 },
      { week: '2026-11-02', repo: 'sakuga-software/orchard', prs: 1, findings: 0 },
    ], '2026-10-26')
    assert.deepEqual(report.weeks.map((w) => w.week), ['2026-10-26', '2026-11-02'])
    let week = report.weeks[1]!
    assert.deepEqual([week.all.fixed, week.all.applied, week.all.dismissed, week.all.wontfix, week.all.closed], [2, 0, 1, 1, 4])
    assert.equal(week.all.handled.rate, 0.5)
    assert.equal(week.all.rejected.rate, 0.25)
    assert.deepEqual(Object.keys(week.repos), ['sakuga-software/orchard', 'sakuga-software/pantry'])
    assert.equal(week.severities.minor!.closed, 1)
    assert.equal(week.categories.security!.rejected.rate, 1)
    assert.deepEqual(Object.keys(week.deciles), ['50-59', '80-89'])
    // A pull request with no finding counts in the guardrail: it lowers the findings for each one.
    assert.deepEqual(week.volume, { prs: 4, findings: 7, perPr: 1.75 })
    assert.deepEqual(report.weeks[0]!.volume, { prs: 0, findings: 0, perPr: null })
  })

  it('finds the deciles where the reject rate goes up, and whether the threshold splits the rates', () => {
    let findings = [
      // 40-49: 8 of 10 dismissed. 50-59: 9 of 10 dismissed, an inversion. 60-69: 2 findings, too few.
      ...times(8, () => closed('dismissed', { confidence: 42 })),
      ...times(2, () => closed('fixed', { confidence: 42 })),
      ...times(9, () => closed('dismissed', { confidence: 51 })),
      closed('fixed', { confidence: 51 }),
      closed('dismissed', { confidence: 65 }),
      closed('dismissed', { confidence: 65 }),
      // 70 and above: 1 of 20 dismissed.
      closed('dismissed', { confidence: 70 }),
      ...times(19, () => closed('fixed', { confidence: 100 })),
    ]
    let { calibration } = measure(findings, [], '2026-11-02')
    assert.deepEqual(calibration.inversions, [{ from: '40-49', to: '50-59' }])
    assert.deepEqual([calibration.below.closed, calibration.below.dismissed], [22, 19])
    assert.deepEqual([calibration.above.closed, calibration.above.dismissed], [20, 1])
    assert.equal(calibration.separated, true)
    assert.equal(calibration.deciles.find((d) => d.decile === '90-100')!.cell.fixed, 19)

    let flat = measure([closed('dismissed', { confidence: 10 }), closed('dismissed', { confidence: 90 })], [], '2026-11-02')
    assert.equal(flat.calibration.separated, false)
  })
})

describe('renderMeasures', () => {
  it('writes the calibration, then each week, the newest first', () => {
    let report = measure([closed('fixed'), closed('dismissed', { week: '2026-10-26' })], [{ week: '2026-11-02', repo: 'sakuga-software/pantry', prs: 2, findings: 3 }], '2026-10-26')
    let text = renderMeasures(report)
    assert.ok(text.indexOf('## Calibration') < text.indexOf('## Week of 2026-11-02'))
    assert.ok(text.indexOf('## Week of 2026-11-02') < text.indexOf('## Week of 2026-10-26'))
    assert.ok(text.includes('Findings per pull request: 1.50 (3 findings, 2 pull requests).'))
    assert.ok(text.includes('| sakuga-software/pantry | 1 | 1 | 0 | 0 | 100% [21–100%] | 0% [0–79%] |'))
    assert.equal(rateText(wilson(0, 0)), '–')
  })
})
