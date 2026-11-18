import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { benchCases, caseComment, KENTO_REVIEWER, type CaseFinding } from './bench-cases.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

function finding(status: CaseFinding['status'], fields: Partial<CaseFinding> = {}): CaseFinding {
  return {
    repo: 'sakuga-software/pantry',
    pr: 12,
    sha: A,
    path: 'app/routes/sheet.ts',
    line: 42,
    title: 'The total ignores the discount',
    scenario: null,
    severity: 'major',
    category: 'bug',
    status,
    reason: status === 'dismissed' ? 'False positive' : null,
    ...fields,
  }
}

describe('caseComment', () => {
  it('names the file and the line, then the title and a short scenario', () => {
    assert.equal(caseComment(finding('fixed')), 'sheet.ts:42 The total ignores the discount')
    let long = caseComment(finding('fixed', { scenario: `A cart with a code. ${'x'.repeat(400)}` }))
    assert.ok(long.startsWith('sheet.ts:42 The total ignores the discount. A cart with a code. x'))
    assert.equal(long.length, 'sheet.ts:42 The total ignores the discount. '.length + 300)
  })
})

describe('benchCases', () => {
  it('makes golden comments of fixed and wontfix findings, and known false positives of dismissed ones', () => {
    let { cases, withoutBase } = benchCases(
      [
        finding('fixed', { severity: 'critical', category: 'contract' }),
        finding('wontfix', { severity: 'minor', category: 'test', line: 7 }),
        finding('dismissed', { line: 90, reason: 'Off topic' }),
        // No reason: not a case.
        finding('dismissed', { line: 91, reason: null }),
      ],
      () => 'f'.repeat(40),
    )
    assert.equal(withoutBase, 0)
    assert.deepEqual(cases, [
      {
        source: 'kento',
        repo: 'pantry',
        url: 'kento:pantry#12@aaaaaaa',
        owner: 'sakuga-software',
        name: 'pantry',
        base: 'f'.repeat(40),
        head: A,
        golden: [
          { comment: 'sheet.ts:42 The total ignores the discount', severity: 'High', category: 'api', reviewers: [KENTO_REVIEWER] },
          { comment: 'sheet.ts:7 The total ignores the discount', severity: 'Low', category: 'test_gap', reviewers: [KENTO_REVIEWER] },
        ],
        false_positives: [{ comment: 'sheet.ts:90 The total ignores the discount', reviewer: KENTO_REVIEWER, reason: 'Off topic' }],
      },
    ])
  })

  it('keeps one commit for each pull request, the one with the most findings, and leaves out a pull request without a base', () => {
    let { cases, withoutBase } = benchCases(
      [
        finding('fixed', { sha: B }),
        finding('fixed', { sha: A, line: 1 }),
        finding('fixed', { sha: A, line: 2 }),
        finding('fixed', { pr: 13 }),
        finding('fixed', { repo: 'sakuga-software/orchard', pr: 4 }),
        finding('fixed', { repo: 'sakuga-software/orchard', pr: 5 }),
      ],
      (_repo, pr) => (pr === 4 ? null : 'f'.repeat(40)),
      { maxPerRepo: 1 },
    )
    assert.equal(withoutBase, 1)
    assert.deepEqual(cases.map((c) => [c.url, c.golden.length]), [
      ['kento:pantry#12@aaaaaaa', 2],
      ['kento:orchard#5@aaaaaaa', 1],
    ])
  })

  it('asks for the base of a pull request once, whatever the number of its commits', () => {
    let calls: number[] = []
    let { cases, withoutBase } = benchCases(
      [finding('fixed', { sha: A }), finding('fixed', { sha: A, line: 2 }), finding('fixed', { sha: B }), finding('fixed', { pr: 13 })],
      (_repo, pr) => {
        calls.push(pr)
        return pr === 12 ? null : 'f'.repeat(40)
      },
    )
    assert.deepEqual(calls, [12, 13])
    assert.equal(withoutBase, 1)
    assert.deepEqual(cases.map((c) => c.url), ['kento:pantry#13@aaaaaaa'])
  })
})
