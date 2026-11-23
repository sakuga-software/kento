import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { sheetCells, type ResultFinding, type SheetColumn, type SheetEvent, type SheetRow } from './sheet.ts'

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 30, 10, minutes))
const columns: SheetColumn[] = [
  { id: 'r1', at: at(0) },
  { id: 'r2', at: at(10) },
  { id: 'r3', at: at(20) },
  { id: 'r4', at: at(30) },
]
const rows: SheetRow[] = [
  { id: 'A', fingerprint: 'fa', key: 'ka' },
  { id: 'B', fingerprint: 'fb', key: 'kb' },
  { id: 'C', fingerprint: 'fc', key: 'kc' },
  { id: 'D', fingerprint: 'fd', key: 'kd' },
]
const found = (reviewId: string, row: string, line: number, fingerprint: string | null = `f${row.toLowerCase()}`): ResultFinding => ({
  reviewId,
  fingerprint,
  key: `k${row.toLowerCase()}`,
  path: 'src/a.ts',
  line,
})
const results: ResultFinding[] = [
  found('r1', 'A', 42),
  found('r1', 'B', 88),
  found('r1', 'C', 12),
  found('r2', 'A', 47),
  found('r2', 'C', 12),
  found('r2', 'D', 30),
  found('r3', 'A', 47),
  found('r3', 'C', 12),
  found('r4', 'A', 47),
]
const events: SheetEvent[] = [
  { findingId: 'A', reviewId: 'r1', type: 'opened', at: at(0) },
  { findingId: 'B', reviewId: 'r1', type: 'opened', at: at(0) },
  { findingId: 'C', reviewId: 'r1', type: 'opened', at: at(0) },
  { findingId: 'B', reviewId: 'r2', type: 'fixed', at: at(10) },
  { findingId: 'D', reviewId: 'r2', type: 'opened', at: at(10) },
  { findingId: 'C', reviewId: null, type: 'dismissed', at: at(15) },
  { findingId: 'D', reviewId: null, type: 'wontfix', at: at(25) },
]

function states(cells: ReturnType<typeof sheetCells>, id: string) {
  return cells.get(id)!.map((c) => `${c.state}${c.carried ? '*' : ''}${c.line === null ? '' : `@${c.line}`}`)
}

describe('sheetCells', () => {
  let cells = sheetCells({ rows, columns, before: null, results, events })

  it('shows a finding moved to another line with no new comment, then found again', () => {
    assert.deepEqual(states(cells, 'A'), ['posted@42', 'moved@47', 'found@47', 'found@47'])
  })

  it('shows the review that fixed a finding, then the fix carried', () => {
    assert.deepEqual(states(cells, 'B'), ['posted@88', 'fixed', 'fixed*', 'fixed*'])
  })

  it('shows a dismissal of a person on the next review, even when its result holds the finding', () => {
    assert.deepEqual(states(cells, 'C'), ['posted@12', 'found@12', 'dismissed', 'dismissed*'])
  })

  it('shows nothing before a finding exists, and absent when a review does not find it', () => {
    assert.deepEqual(states(cells, 'D'), ['none', 'posted@30', 'absent', 'wontfix'])
  })

  it('reads the review before the page for a finding moved in the first column', () => {
    let page = sheetCells({ rows, columns: columns.slice(1), before: columns[0]!, results, events })
    assert.deepEqual(states(page, 'A'), ['moved@47', 'found@47', 'found@47'])
  })

  it('finds a finding again by its key when its fingerprint changed, and pairs each finding once', () => {
    let twice = sheetCells({
      rows: [rows[0]!, { id: 'A2', fingerprint: 'other', key: 'ka' }],
      columns: [columns[0]!],
      before: null,
      results: [found('r1', 'A', 42, 'changed')],
      events: [
        { findingId: 'A', reviewId: null, type: 'reopened', at: at(-5) },
        { findingId: 'A2', reviewId: null, type: 'reopened', at: at(-5) },
      ],
    })
    assert.deepEqual(states(twice, 'A'), ['found@42'])
    assert.deepEqual(states(twice, 'A2'), ['absent'])
  })
})
