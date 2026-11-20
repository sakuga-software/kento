// REV-16. The findings of the pull requests, and the events of their status, as the screens read
// them (REV-17: a pull request, REV-18: the findings of a repository or of an org). Every list is
// paged: at most PAGE_MAX rows, and a cursor for the next page.
//
// Each read takes the org of the session: a finding of another org is never found.
import { UUID } from '@kento-review/protocol'
import type postgres from 'postgres'

export const FINDING_STATUSES = ['open', 'fixed', 'stale', 'dismissed', 'wontfix'] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export const FINDING_EVENT_TYPES = ['opened', 'reopened', 'fixed', 'stale', 'dismissed', 'wontfix'] as const
export type FindingEventType = (typeof FINDING_EVENT_TYPES)[number]

/** The actor of the changes that Kentō makes by itself. A person is their GitHub login. */
export const KENTO_ACTOR = 'kento'

/** The rows of a page when the caller gives no limit. */
export const PAGE_SIZE = 50
/** The most rows of a page. */
export const PAGE_MAX = 100

export interface Finding {
  id: string
  repoId: string
  repo: string
  prNumber: number
  fingerprint: string
  key: string
  ruleId: string | null
  path: string
  line: number
  title: string
  severity: 'critical' | 'major' | 'minor'
  category: string
  confidence: number
  status: FindingStatus
  statusReason: string | null
  firstReviewId: string | null
  lastReviewId: string | null
  firstSeenSha: string
  lastSeenSha: string
  githubCommentId: number | null
  createdAt: Date
  updatedAt: Date
}

export interface FindingEvent {
  id: string
  findingId: string
  reviewId: string | null
  type: FindingEventType
  actor: string
  reason: string | null
  createdAt: Date
}

export interface Page<T> {
  items: T[]
  /** The cursor of the next page, or null on the last page. */
  nextCursor: string | null
}

export interface PageRequest {
  limit?: number
  cursor?: string | null
}

/** A cursor that the caller cannot read: the list starts again at its first page. */
export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor')
  }
}


// The cursor holds `created_at` as Postgres writes it (to the microsecond) and the id of the last
// row: a Date of JavaScript keeps milliseconds only, and two rows of one millisecond would be lost.
export type Cursor = { at: string; id: string }
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
export const cursorAt = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`).toString('base64url')
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null
  let [at, id] = Buffer.from(value, 'base64url').toString().split('|')
  if (!at || !id || !UUID.test(id) || !CURSOR_AT.test(at)) throw new InvalidCursorError()
  return { at, id }
}

function limitOf(request: PageRequest): number {
  let limit = Math.trunc(request.limit ?? PAGE_SIZE)
  return Math.min(PAGE_MAX, Math.max(1, Number.isFinite(limit) ? limit : PAGE_SIZE))
}

function withoutCursor<T extends { cursorAt: string }>(row: T): Omit<T, 'cursorAt'> {
  let out: Partial<T> = { ...row }
  delete out.cursorAt
  return out as Omit<T, 'cursorAt'>
}

/** One row more than the limit tells whether a next page exists. */
function page<T extends { id: string; cursorAt: string }>(rows: T[], limit: number): Page<Omit<T, 'cursorAt'>> {
  let more = rows.length > limit
  let kept = rows.slice(0, limit)
  let last = kept.at(-1)
  return {
    items: kept.map(withoutCursor),
    nextCursor: more && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
  }
}

function statusesOf(statuses: readonly FindingStatus[] | undefined): FindingStatus[] {
  let out = (statuses ?? FINDING_STATUSES).filter((s) => FINDING_STATUSES.includes(s))
  return out.length ? out : [...FINDING_STATUSES]
}

const findingColumns = (sql: postgres.Sql) => sql`
  findings.id, findings.repo_id as "repoId", repos.full_name as repo, findings.pr_number as "prNumber",
  findings.fingerprint, findings.key, findings.rule_id as "ruleId", findings.path, findings.line, findings.title,
  findings.severity, findings.category, findings.confidence, findings.status, findings.status_reason as "statusReason",
  findings.first_review_id as "firstReviewId", findings.last_review_id as "lastReviewId",
  findings.first_seen_sha as "firstSeenSha", findings.last_seen_sha as "lastSeenSha",
  findings.github_comment_id::float8 as "githubCommentId", findings.created_at as "createdAt", findings.updated_at as "updatedAt",
  ${sql.unsafe(cursorAt('findings.created_at'))} as "cursorAt"`

/**
 * The findings of an org, newest first: of one repository and one pull request when given, and of
 * the statuses given (all by default).
 */
export async function listFindings(
  sql: postgres.Sql,
  filter: { orgId: string; repoId?: string; prNumber?: number; statuses?: readonly FindingStatus[] } & PageRequest,
): Promise<Page<Finding>> {
  let limit = limitOf(filter)
  let cursor = decodeCursor(filter.cursor)
  let rows = await sql<(Finding & { cursorAt: string })[]>`
    select ${findingColumns(sql)}
    from findings
    join repos on repos.id = findings.repo_id
    where repos.org_id = ${filter.orgId}
      ${filter.repoId ? sql`and findings.repo_id = ${filter.repoId}` : sql``}
      ${filter.prNumber !== undefined ? sql`and findings.pr_number = ${filter.prNumber}` : sql``}
      and findings.status = any(${statusesOf(filter.statuses)}::finding_status[])
      ${cursor ? sql`and (findings.created_at, findings.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
    order by findings.created_at desc, findings.id desc
    limit ${limit + 1}`
  return page(rows, limit)
}

/** One finding of an org, or null. */
export async function getFinding(sql: postgres.Sql, input: { orgId: string; id: string }): Promise<Finding | null> {
  if (!UUID.test(input.id)) return null
  let [row] = await sql<(Finding & { cursorAt: string })[]>`
    select ${findingColumns(sql)}
    from findings
    join repos on repos.id = findings.repo_id
    where findings.id = ${input.id} and repos.org_id = ${input.orgId}`
  if (!row) return null
  return withoutCursor(row)
}

/** The events of a finding of an org, oldest first: the history of its status. */
export async function listFindingEvents(
  sql: postgres.Sql,
  input: { orgId: string; findingId: string } & PageRequest,
): Promise<Page<FindingEvent>> {
  if (!UUID.test(input.findingId)) return { items: [], nextCursor: null }
  let limit = limitOf(input)
  let cursor = decodeCursor(input.cursor)
  let rows = await sql<(FindingEvent & { cursorAt: string })[]>`
    select finding_events.id, finding_events.finding_id as "findingId", finding_events.review_id as "reviewId",
      finding_events.type, finding_events.actor, finding_events.reason, finding_events.created_at as "createdAt",
      ${sql.unsafe(cursorAt('finding_events.created_at'))} as "cursorAt"
    from finding_events
    join findings on findings.id = finding_events.finding_id
    join repos on repos.id = findings.repo_id
    where finding_events.finding_id = ${input.findingId} and repos.org_id = ${input.orgId}
      ${cursor ? sql`and (finding_events.created_at, finding_events.id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
    order by finding_events.created_at, finding_events.id
    limit ${limit + 1}`
  return page(rows, limit)
}

/** The statuses that a person sets. `open` is "Reopen". */
export const PERSON_STATUSES = ['dismissed', 'wontfix', 'open'] as const
export type PersonStatus = (typeof PERSON_STATUSES)[number]

/** The longest reason of a dismissal. */
export const REASON_MAX = 500

export type StatusChange =
  | { outcome: 'changed'; finding: Finding }
  /** The finding already has this status: no event. */
  | { outcome: 'unchanged'; finding: Finding }
  | { outcome: 'not_found' }
  /** `dismissed` needs a reason; a reason is at most REASON_MAX characters. */
  | { outcome: 'invalid'; reason: string }

/**
 * A person sets the status of a finding of their org: `dismissed` with a reason, `wontfix` with an
 * optional reason, or `open` again ("Reopen"). Each change writes one event with the person's
 * GitHub login. A dismissed finding never gets a comment again, even when a review finds it again.
 */
export async function setFindingStatus(
  sql: postgres.Sql,
  input: {
    orgId: string
    findingId: string
    status: PersonStatus
    reason?: string | null
    actor: string
    /** REV-94. Where the change came from, in the event: `command` for `@kento-review reject`. */
    source?: 'command'
    /**
     * REV-94. A finding already dismissed stays as it is, with its first reason, and a finding that a
     * push fixed or a close made stale stays too: `unchanged`. A `wontfix` finding does become
     * `dismissed`: `reject` says that it is a false positive, which is more than "accepted as is",
     * and its events keep both decisions. The status is read under the lock of
     * the row, so a push that fixed the finding after the caller read it is not undone.
     */
    keepDismissed?: boolean
  },
): Promise<StatusChange> {
  if (!PERSON_STATUSES.includes(input.status)) return { outcome: 'invalid', reason: 'unknown status' }
  let reason = input.status === 'open' ? null : input.reason?.trim() || null
  if (input.status === 'dismissed' && !reason) return { outcome: 'invalid', reason: 'a dismissal needs a reason' }
  if (reason && reason.length > REASON_MAX) return { outcome: 'invalid', reason: `the reason is longer than ${REASON_MAX} characters` }
  if (!UUID.test(input.findingId)) return { outcome: 'not_found' }

  let changed = await sql.begin(async (tx) => {
    let [current] = await tx<{ status: FindingStatus; statusReason: string | null }[]>`
      select findings.status, findings.status_reason as "statusReason"
      from findings join repos on repos.id = findings.repo_id
      where findings.id = ${input.findingId} and repos.org_id = ${input.orgId}
      for update of findings`
    if (!current) return null
    if (current.status === input.status && current.statusReason === reason) return false
    if (input.keepDismissed && (current.status === 'dismissed' || current.status === 'fixed' || current.status === 'stale')) return false
    await tx`
      update findings set status = ${input.status}, status_reason = ${reason}, updated_at = now()
      where id = ${input.findingId}`
    let type: FindingEventType = input.status === 'open' ? 'reopened' : input.status
    await tx`
      insert into finding_events (finding_id, type, actor, reason, source)
      values (${input.findingId}, ${type}, ${input.actor}, ${reason}, ${input.source ?? null})`
    return true
  })
  if (changed === null) return { outcome: 'not_found' }
  let finding = (await getFinding(sql, { orgId: input.orgId, id: input.findingId }))!
  return { outcome: changed ? 'changed' : 'unchanged', finding }
}
