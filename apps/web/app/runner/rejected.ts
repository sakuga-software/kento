// REV-95. The rejected findings of a review job, as the protocol accepts them. Pure: no database.
import { CATEGORIES, isOneOf, SEVERITIES, SHA, type RejectedFinding } from '@kento-review/protocol'

/** A row of the database: the columns are NOT NULL in the schema, but a row is checked as it comes. */
export type RejectedRow = { [K in keyof RejectedFinding]: RejectedFinding[K] | null }

/** Why the protocol would refuse a row, or null. */
export function leftOutReason(r: RejectedRow): string | null {
  if (r.commit === null || r.title === null || r.path === null || r.line === null || r.status === null) return 'a column is null'
  if (!SHA.test(r.commit)) return 'last_seen_sha is not a commit'
  if (r.path.length > 1000 || r.title.length === 0 || r.line < 0 || r.line > 10_000_000) return 'path, title or line beyond the limits of the protocol'
  if (!isOneOf(CATEGORIES, r.category)) return `unknown category ${String(r.category).slice(0, 40)}`
  if (r.severity !== null && r.severity !== undefined && !isOneOf(SEVERITIES, r.severity)) return `unknown severity ${String(r.severity).slice(0, 40)}`
  return null
}

/**
 * The rows that the protocol accepts, with the title and the cause cut to its limits (that keeps
 * their meaning). A row that it would refuse would fail the check of the runner: it stays out, and
 * `warn` says which one and why, as for a rule (`job.rule_left_out`). One bad row never costs the
 * others.
 */
export function sendableRejected(rows: readonly RejectedRow[], warn: (fields: Record<string, unknown>) => void): RejectedFinding[] {
  return rows.flatMap((r) => {
    let reason = leftOutReason(r)
    if (reason) {
      warn({ path: String(r.path ?? '').slice(0, 200), line: r.line, reason })
      return []
    }
    let ok = r as RejectedFinding
    return [{ ...ok, title: ok.title.slice(0, 1000), reason: ok.reason === null ? null : ok.reason.slice(0, 500) }]
  })
}
