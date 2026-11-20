// REV-17. What the screen of a pull request reads: its repository, its numbers, a page of its
// reviews (the columns of the sheet) and a page of its findings (the rows). Every read takes the org
// of the session: a pull request of another org is never found.
//
// The pages go by keyset on (created_at, id). The columns page from the newest review back; the rows
// page from the first finding on. The result of a review is read for the columns of the page only,
// and only the few fields of its findings that the sheet compares.
import { findingKey } from '@kento/engine/findings'
import { isOneOf, UUID, type Level } from '@kento/protocol'
import type postgres from 'postgres'

import { readJobAssignment, type JobAssignment } from '../assignment/model.ts'
import { toDate } from '../db/rows.ts'
import { cursorAt, decodeCursor, encodeCursor, FINDING_STATUSES, setFindingStatus, type FindingStatus, type Page, type PersonStatus, type StatusChange } from '../findings/store.ts'
import { readFindingDetail, readFindingHistory, type FindingDetail, type HistoryEvent } from './finding.ts'
import { readEstimates, rerunReview, type RerunOutcome } from './rerun.ts'
import { sheetCells, type Cell, type ResultFinding, type SheetEvent } from './sheet.ts'

/** The reviews of a page of the sheet. Six columns fit at 1440 px with the title of each row. */
export const COLUMNS_PAGE = 6
/** The findings of a page of the sheet. */
export const ROWS_PAGE = 50

/** The repository of a pull request of the org, with what a call to GitHub needs. */
export interface PullTarget {
  repoId: string
  fullName: string
  prNumber: number
  installationId: number
  githubRepoId: number
}

/** A review of the pull request: a column of the sheet. */
export interface PullReview {
  id: string
  number: number
  level: Level
  headSha: string
  model: string
  score: number
  costUsd: number | null
  /** The findings of the result, before the publication left out the dismissed ones. */
  findings: number
  createdAt: Date
  publishedAt: Date | null
  /** REV-91. The verdict of the result (APPROVE, COMMENT, REQUEST_CHANGES), and its summary. Null when absent. */
  verdict: string | null
  summary: string | null
  /** From the claim of the job to its result. Null when the job holds no start or no end. */
  durationMs: number | null
}

/**
 * REV-91. The time of a job from its claim to its result, in ms. Null without one, and null when the
 * clock of the database gives a negative or not finite time: the screen shows no time rather than a
 * wrong one.
 */
export function jobDuration(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  return Math.round(ms)
}

/** A review job of the pull request queued or running: the next column, "R5 in progress…". */
export interface PullActiveJob {
  id: string
  /** The number that its review will take. */
  number: number
  level: Level
  state: 'queued' | 'running'
  headSha: string
  createdAt: Date
}

/** A finding of the pull request: a row of the sheet. */
export interface PullFinding {
  id: string
  title: string
  path: string
  line: number
  severity: 'critical' | 'major' | 'minor'
  category: string
  confidence: number
  status: FindingStatus
  ruleId: string | null
  githubCommentId: number | null
}

export interface PullSummary {
  target: PullTarget
  /** The head of the last job of the pull request, and its base branch. */
  headSha: string
  baseRef: string | null
  reviews: number
  /** The scores of the two last reviews, newest first. */
  lastScores: number[]
  /** The cost of the reviews and of the resolutions of the pull request. Null when none has a cost. */
  costUsd: number | null
  byStatus: Record<FindingStatus, number>
  active: PullActiveJob | null
  /** REV-21. The assignment rule that chose the level of the last review job, or null: no rule did. */
  assignment: JobAssignment | null
  /** REV-21. What chose the level of the last review job, or null: a job queued before REV-21. */
  levelOrigin: { source: LevelSource; level: Level } | null
}

/** REV-21. What chose the level of a job: `jobs.level_source`. */
export const LEVEL_SOURCES = ['rule', 'preference', 'repo', 'command', 'retry'] as const
export type LevelSource = (typeof LEVEL_SOURCES)[number]

export interface PullSheet {
  /** Oldest first, left to right. */
  columns: PullReview[]
  rows: { finding: PullFinding; cells: Cell[] }[]
  /** The cursor of the older reviews, or null when the first column is R1. */
  olderCursor: string | null
  /** The cursor of the next findings, or null on the last page. */
  nextRowsCursor: string | null
}

export interface PullsStore {
  /** The pull request `prNumber` of a repository of the org, or null when Kentō never queued a job for it. */
  summary(orgId: string, repoId: string, prNumber: number): Promise<PullSummary | null>
  /**
   * A page of the sheet. `reviewsCursor`: the columns before it (older); null for the newest.
   * `rowsCursor`: the findings after it. `statuses`: the rows of these statuses only.
   */
  sheet(
    target: PullTarget,
    page: { reviewsCursor?: string | null; rowsCursor?: string | null; statuses?: readonly FindingStatus[] },
  ): Promise<PullSheet>
  /** One finding of the org, with the last review that found it. */
  finding(orgId: string, id: string): Promise<FindingDetail | null>
  /** A page of the history of a finding of the org, oldest first. */
  history(orgId: string, findingId: string, cursor: string | null): Promise<Page<HistoryEvent>>
  /** A person of the org sets the status of a finding: one event, with their login. */
  setStatus(input: { orgId: string; findingId: string; status: PersonStatus; reason: string | null; actor: string }): Promise<StatusChange>
  /** The mean cost of the last reviews of each level on the repository. */
  estimates(repoId: string): Promise<Record<Level, number | null>>
  /** "Run at <level>": a review job of the last head of the pull request. */
  rerun(input: { orgId: string; repoId: string; prNumber: number; level: Level; githubHead: string | null }): Promise<RerunOutcome>
}

const num = (value: string | number | null): number | null => (value === null ? null : Number(value))

export function createPullsStore(sql: postgres.Sql): PullsStore {
  return {
    finding: (orgId, id) => readFindingDetail(sql, orgId, id),
    history: (orgId, findingId, cursor) => readFindingHistory(sql, { orgId, findingId, cursor }),
    setStatus: (input) => setFindingStatus(sql, input),
    estimates: (repoId) => readEstimates(sql, repoId),
    rerun: (input) => rerunReview(sql, input),

    async summary(orgId, repoId, prNumber) {
      if (!UUID.test(repoId) || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null
      let [row] = await sql<
        {
          fullName: string
          installationId: string
          githubRepoId: string
          headSha: string | null
          baseRef: string | null
          reviews: number
          lastScores: number[] | null
          reviewsCost: string | null
          resolutionsCost: string | null
        }[]
      >`
        select repos.full_name as "fullName", installations.github_installation_id::text as "installationId",
          repos.github_repo_id::text as "githubRepoId", last_job.head_sha as "headSha", last_job.base_ref as "baseRef",
          (select count(*)::int from reviews where repo_id = repos.id and pr_number = ${prNumber}) as reviews,
          (select array_agg(score) from (
            select score from reviews where repo_id = repos.id and pr_number = ${prNumber}
            order by created_at desc, id desc limit 2) s) as "lastScores",
          (select sum(cost_usd)::text from reviews where repo_id = repos.id and pr_number = ${prNumber}) as "reviewsCost",
          (select sum(cost_usd)::text from resolutions where repo_id = repos.id and pr_number = ${prNumber}) as "resolutionsCost"
        from repos
        join installations on installations.id = repos.installation_id
        left join lateral (
          select head_sha, base_ref from jobs
          where jobs.repo_id = repos.id and jobs.pr_number = ${prNumber}
          order by created_at desc limit 1
        ) last_job on true
        where repos.id = ${repoId} and repos.org_id = ${orgId}`
      if (!row || row.headSha === null) return null
      let statuses = await sql<{ status: FindingStatus; n: number }[]>`
        select status, count(*)::int as n from findings
        where repo_id = ${repoId} and pr_number = ${prNumber}
        group by status`
      let byStatus = Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])) as Record<FindingStatus, number>
      for (let s of statuses) byStatus[s.status] = s.n
      let [active] = await sql<{ id: string; level: Level; state: 'queued' | 'running'; headSha: string; createdAt: Date }[]>`
        select id, level, state, head_sha as "headSha", created_at as "createdAt" from jobs
        where repo_id = ${repoId} and pr_number = ${prNumber} and kind = 'review' and state in ('queued', 'running')
        order by created_at desc limit 1`
      // REV-21. The last review job of the pull request, whatever created it, and what chose its
      // level: the job records it when it is queued (`level_source`). A rule names itself only on
      // the job whose level it chose. A cancelled job (a newer push, a close) reviewed nothing: the
      // job before it counts.
      let [last] = await sql<{ config: unknown; level: Level; levelSource: string | null }[]>`
        select config, level, level_source as "levelSource" from jobs
        where repo_id = ${repoId} and pr_number = ${prNumber} and kind = 'review' and state <> 'cancelled'
        order by created_at desc, id desc limit 1`
      let source = last && isOneOf(LEVEL_SOURCES, last.levelSource) ? last.levelSource : null
      let assignment = source === 'rule' ? readJobAssignment(last!.config) : null
      let costs = [num(row.reviewsCost), num(row.resolutionsCost)].filter((c): c is number => c !== null)
      return {
        target: {
          repoId,
          fullName: row.fullName,
          prNumber,
          installationId: Number(row.installationId),
          githubRepoId: Number(row.githubRepoId),
        },
        headSha: row.headSha,
        baseRef: row.baseRef,
        reviews: row.reviews,
        lastScores: row.lastScores ?? [],
        costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
        byStatus,
        active: active ? { ...active, createdAt: toDate(active.createdAt), number: row.reviews + 1 } : null,
        assignment,
        levelOrigin: source ? { source, level: last!.level } : null,
      }
    },

    async sheet(target, page) {
      let { repoId, prNumber } = target
      let reviewsCursor = decodeCursor(page.reviewsCursor)
      let rowsCursor = decodeCursor(page.rowsCursor)
      let statuses = (page.statuses ?? []).filter((s) => FINDING_STATUSES.includes(s))

      // One review more than the page: the review before the first column, for `moved` and the cursor.
      let reviews = await sql<(Omit<PullReview, 'costUsd'> & { costUsd: string | null; cursorAt: string })[]>`
        select r.id, r.head_sha as "headSha", r.model, r.score, r.cost_usd::text as "costUsd", j.level,
          coalesce(jsonb_array_length(r.result->'findings'), 0)::int as findings,
          r.result->>'verdict' as verdict, r.result->>'summary' as summary,
          (extract(epoch from (j.finished_at - j.started_at)) * 1000)::float8 as "durationMs",
          r.created_at as "createdAt", r.published_at as "publishedAt",
          ${sql.unsafe(cursorAt('r.created_at'))} as "cursorAt",
          (select count(*)::int from reviews e
            where e.repo_id = r.repo_id and e.pr_number = r.pr_number and (e.created_at, e.id) <= (r.created_at, r.id)) as number
        from reviews r
        join jobs j on j.id = r.job_id
        where r.repo_id = ${repoId} and r.pr_number = ${prNumber}
          ${reviewsCursor ? sql`and (r.created_at, r.id) < (${reviewsCursor.at}::timestamptz, ${reviewsCursor.id}::uuid)` : sql``}
        order by r.created_at desc, r.id desc
        limit ${COLUMNS_PAGE + 1}`
      let shown = reviews.slice(0, COLUMNS_PAGE)
      let beforeRow = reviews.length > COLUMNS_PAGE ? reviews[COLUMNS_PAGE]! : null
      let oldestShown = shown.at(-1)
      let olderCursor = beforeRow && oldestShown ? encodeCursor({ at: oldestShown.cursorAt, id: oldestShown.id }) : null
      let toReview = (r: (typeof reviews)[number]): PullReview => ({
        id: r.id,
        number: r.number,
        level: r.level,
        headSha: r.headSha,
        model: r.model,
        score: r.score,
        costUsd: num(r.costUsd),
        findings: r.findings,
        createdAt: toDate(r.createdAt),
        publishedAt: toDate(r.publishedAt),
        verdict: r.verdict ?? null,
        summary: r.summary ?? null,
        durationMs: jobDuration(r.durationMs),
      })
      let columns = shown.map(toReview).reverse()

      let found = await sql<(PullFinding & { githubCommentId: number | null; fingerprint: string; key: string; cursorAt: string })[]>`
        select id, title, path, line, severity, category, confidence, status, rule_id as "ruleId",
          github_comment_id::float8 as "githubCommentId", fingerprint, key,
          ${sql.unsafe(cursorAt('created_at'))} as "cursorAt"
        from findings
        where repo_id = ${repoId} and pr_number = ${prNumber}
          ${statuses.length ? sql`and status = any(${statuses}::finding_status[])` : sql``}
          ${rowsCursor ? sql`and (created_at, id) > (${rowsCursor.at}::timestamptz, ${rowsCursor.id}::uuid)` : sql``}
        order by created_at, id
        limit ${ROWS_PAGE + 1}`
      let rows = found.slice(0, ROWS_PAGE)
      let lastRow = rows.at(-1)
      let nextRowsCursor = found.length > ROWS_PAGE && lastRow ? encodeCursor({ at: lastRow.cursorAt, id: lastRow.id }) : null

      let at = (r: { createdAt: Date; publishedAt: Date | null }) => toDate(r.publishedAt ?? r.createdAt)
      let reviewIds = [...shown, ...(beforeRow ? [beforeRow] : [])].map((r) => r.id)
      let results: ResultFinding[] = []
      let events: SheetEvent[] = []
      if (rows.length && reviewIds.length) {
        let resultRows = await sql<{ reviewId: string; fingerprint: string | null; path: string; title: string; line: number | null }[]>`
          select r.id as "reviewId", f->>'fingerprint' as fingerprint, f->>'path' as path, f->>'title' as title,
            -- The result is what a runner sent: a line that is not a whole number reads as none.
            case when coalesce(f->>'anchor', f->>'line') ~ '^[0-9]{1,9}$' then coalesce(f->>'anchor', f->>'line')::int end as line
          from reviews r
          cross join lateral jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) f
          where r.id = any(${reviewIds}::uuid[])`
        results = resultRows.flatMap((r) =>
          typeof r.path === 'string' && typeof r.title === 'string'
            ? [{ reviewId: r.reviewId, fingerprint: r.fingerprint, key: findingKey({ path: r.path, title: r.title } as never), path: r.path, line: r.line ?? 0 }]
            : [],
        )
        let newest = Math.max(...shown.map((r) => at(r).getTime()))
        let read = await sql<SheetEvent[]>`
          select finding_id as "findingId", review_id as "reviewId", type, created_at as at
          from finding_events
          where finding_id = any(${rows.map((r) => r.id)}::uuid[])
            -- The events of the reviews of the page, whenever they were written (a review that was not
            -- marked as published has its events after its result), and the others up to the newest column.
            and (created_at <= ${new Date(newest).toISOString()} or review_id = any(${shown.map((r) => r.id)}::uuid[]))
          order by created_at, id`
        events = read.map((e) => ({ ...e, at: toDate(e.at) }))
      }
      let cells = sheetCells({
        rows,
        columns: columns.map((c) => ({ id: c.id, number: c.number, at: at(c) })),
        before: beforeRow ? { id: beforeRow.id, number: beforeRow.number, at: at(beforeRow) } : null,
        results,
        events,
      })
      return {
        columns,
        rows: rows.map((r) => ({
          finding: {
            id: r.id,
            title: r.title,
            path: r.path,
            line: r.line,
            severity: r.severity,
            category: r.category,
            confidence: r.confidence,
            status: r.status,
            ruleId: r.ruleId,
            githubCommentId: r.githubCommentId === null ? null : Number(r.githubCommentId),
          },
          cells: cells.get(r.id) ?? [],
        })),
        olderCursor,
        nextRowsCursor,
      }
    },
  }
}
