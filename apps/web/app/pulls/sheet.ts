// REV-17. The exposure sheet of a pull request: one column per review, one row per finding, and
// in each cell what that review did with that finding.
//
// The database holds no row per review and finding. A cell comes from three facts:
// - the events that the review wrote for the finding (`finding_events.review_id`): opened, reopened,
//   fixed;
// - the findings in the result of the review (`reviews.result`), found again by fingerprint, then by
//   key, as the publication does (app/findings/lifecycle.ts);
// - the last event before the review, for a finding that a person dismissed or kept, or that an
//   earlier review fixed.
//
// This module is pure: app/pulls/store.ts reads the database.
import type { FindingEventType, FindingStatus } from '../findings/store.ts'

/** A review of the pull request: a column of the sheet. */
export interface SheetColumn {
  id: string
  /** When the review changed its findings: its publication, or its result when it is not published. */
  at: Date
}

/** A finding of the pull request: a row of the sheet. */
export interface SheetRow {
  id: string
  /** Empty for a thread adopted from an earlier release. */
  fingerprint: string
  key: string
}

/** A finding in the result of a review, reduced to what the sheet compares. */
export interface ResultFinding {
  reviewId: string
  fingerprint: string | null
  key: string
  path: string
  line: number
}

/** An event of a finding, as the sheet reads it. */
export interface SheetEvent {
  findingId: string
  reviewId: string | null
  type: FindingEventType
  at: Date
}

/**
 * What a cell shows:
 * - `posted`: the review found it first and posted it;
 * - `found`: found again at the same line, with no new comment;
 * - `moved`: found again at another line, with no new comment;
 * - `reopened`: it was fixed, and this review found it again;
 * - `fixed`: this review saw its file change without it, or an earlier one did (`carried`);
 * - `dismissed`, `wontfix`: a person decided before this review, which left it out;
 * - `absent`: open, but this review did not find it, and its file did not change;
 * - `none`: the finding did not exist yet.
 */
export type CellState = 'posted' | 'found' | 'moved' | 'reopened' | 'fixed' | 'dismissed' | 'wontfix' | 'absent' | 'none'

export interface Cell {
  state: CellState
  /** The state comes from an earlier column: the screen shows it muted. */
  carried: boolean
  /** The line where the review found it, when it did. */
  line: number | null
}

/**
 * Pairs the findings of each review with the rows, at most one each: by fingerprint first, then by
 * key. A finding of a result may belong to a row of another page: it then pairs with nothing here.
 */
export function pairResults(rows: readonly SheetRow[], results: readonly ResultFinding[]): Map<string, Map<string, ResultFinding>> {
  let byReview = new Map<string, ResultFinding[]>()
  for (let r of results) byReview.set(r.reviewId, [...(byReview.get(r.reviewId) ?? []), r])
  let out = new Map<string, Map<string, ResultFinding>>()
  for (let [reviewId, found] of byReview) {
    let pairs = new Map<string, ResultFinding>()
    let taken = new Set<ResultFinding>()
    let pass = (test: (row: SheetRow, f: ResultFinding) => boolean) => {
      for (let row of rows) {
        if (pairs.has(row.id)) continue
        let hit = found.find((f) => !taken.has(f) && test(row, f))
        if (hit) {
          pairs.set(row.id, hit)
          taken.add(hit)
        }
      }
    }
    pass((row, f) => row.fingerprint !== '' && f.fingerprint === row.fingerprint)
    pass((row, f) => f.key === row.key)
    out.set(reviewId, pairs)
  }
  return out
}

const DECIDED: Partial<Record<FindingEventType, CellState>> = { dismissed: 'dismissed', wontfix: 'wontfix', fixed: 'fixed' }

/**
 * The cells of each row, in the order of `columns` (oldest first). `before` is the review just
 * before the first column, when there is one: a finding that it found at another line is `moved`
 * in the first column.
 */
export function sheetCells(input: {
  rows: readonly SheetRow[]
  columns: readonly SheetColumn[]
  before: SheetColumn | null
  results: readonly ResultFinding[]
  events: readonly SheetEvent[]
}): Map<string, Cell[]> {
  let { rows, columns, before, events } = input
  let paired = pairResults(rows, input.results)
  let eventsOf = new Map<string, SheetEvent[]>()
  for (let e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    eventsOf.set(e.findingId, [...(eventsOf.get(e.findingId) ?? []), e])
  }
  let out = new Map<string, Cell[]>()
  for (let row of rows) {
    let own = eventsOf.get(row.id) ?? []
    let lastLine = before ? (paired.get(before.id)?.get(row.id)?.line ?? null) : null
    let previousAt = before?.at ?? null
    let cells: Cell[] = []
    for (let column of columns) {
      let match = paired.get(column.id)?.get(row.id) ?? null
      let line = match?.line ?? null
      let mine = own.filter((e) => e.reviewId === column.id)
      // The last event before this review, written by a person, by the sweep or by an earlier review.
      let last = own.filter((e) => e.reviewId !== column.id && e.at.getTime() <= column.at.getTime()).at(-1) ?? null
      let decided = last ? DECIDED[last.type] : undefined
      let carried = last !== null && previousAt !== null && last.at.getTime() <= previousAt.getTime()
      let cell: Cell
      if (mine.some((e) => e.type === 'fixed')) cell = { state: 'fixed', carried: false, line: null }
      else if (mine.some((e) => e.type === 'opened')) cell = { state: 'posted', carried: false, line }
      else if (mine.some((e) => e.type === 'reopened')) cell = { state: 'reopened', carried: false, line }
      // A person decided: the review left the finding out, even when its result held it.
      else if (decided === 'dismissed' || decided === 'wontfix') cell = { state: decided, carried, line: null }
      else if (match) cell = { state: lastLine !== null && lastLine !== match.line ? 'moved' : 'found', carried: false, line }
      else if (decided === 'fixed') cell = { state: 'fixed', carried, line: null }
      else if (!last && !mine.length) cell = { state: 'none', carried: false, line: null }
      else cell = { state: 'absent', carried: false, line: null }
      if (match) lastLine = match.line
      previousAt = column.at
      cells.push(cell)
    }
    out.set(row.id, cells)
  }
  return out
}

/** The words of each state, on the screen. The colour of a cell never carries its meaning alone. */
export const CELL_LABELS: Record<CellState, string> = {
  posted: 'posted',
  found: 'found again',
  moved: 'moved',
  reopened: 'reopened',
  fixed: 'fixed',
  dismissed: 'dismissed',
  wontfix: 'wontfix',
  absent: 'absent',
  none: '',
}

/** The words of each status of a finding, on the screen. */
export const STATUS_LABELS: Record<FindingStatus, string> = {
  open: 'open',
  fixed: 'fixed',
  stale: 'stale',
  dismissed: 'dismissed',
  wontfix: 'wontfix',
}
