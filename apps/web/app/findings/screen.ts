// REV-18. The Findings screen: the findings of an org, filtered in SQL and paged by keyset.
//
// The order is the one of `listFindings` (store.ts): the newest first, by `created_at` then `id`. A
// page starts after the last row of the page before (or ends before the first row of the page
// after): its cost does not grow with the page number. The counts of the tabs and the position of
// the page come from one more query on the same filters.
import { SEVERITIES, UUID, type Severity } from '@sakuga-review/protocol'
import type postgres from 'postgres'

import { toDate } from '../db/rows.ts'
import { precisionReport, reasonOf, reasonText, repoPrecisions, type Precision, type PrecisionReport } from './precision.ts'
import { cursorAt, decodeCursor, encodeCursor, FINDING_STATUSES, PAGE_MAX, type FindingStatus } from './store.ts'

/** The tabs of the screen: one status, the closed ones (every status but `open`), or all. */
export const FINDING_VIEWS = ['open', 'fixed', 'dismissed', 'wontfix', 'stale', 'closed', 'all'] as const
export type FindingView = (typeof FINDING_VIEWS)[number]

/** The rows of one page of the screen. */
export const FINDINGS_PAGE_SIZE = 50

/** The longest search. */
export const SEARCH_MAX = 100
/** REV-22. A GitHub login, or the login of an App (`name[bot]`). */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
/** REV-22. The longest period of the filter « N derniers jours ». */
export const DAYS_MAX = 365

/** What the screen asks for. Every filter is optional; `view` is `open` by default. */
export interface FindingQuery {
  view?: FindingView
  repoId?: string | null
  severity?: Severity | null
  ruleId?: string | null
  /** The reason of a dismissed or wontfix finding, as written: a group of « Dismissal reasons ». */
  reason?: string | null
  /** A part of the title or of the path, any case. */
  search?: string
  /** REV-22. The findings of the pull requests of this GitHub login (`pull_authors`), any case. */
  author?: string | null
  /** REV-22. The findings of the last N days only (1 to 365). */
  days?: number | null
  /** REV-102. The findings to consider only: new on code already read, not blocking (REV-100). */
  considered?: boolean
  /** The rows after this cursor, in the order of the screen (the next page). */
  after?: string | null
  /** The rows before this cursor (the previous page). Ignored with `after`. */
  before?: string | null
  limit?: number
}

/** One row of the screen. */
export interface FindingRow {
  id: string
  repoId: string
  repo: string
  prNumber: number
  path: string
  line: number
  title: string
  severity: Severity
  category: string
  confidence: number
  status: FindingStatus
  statusReason: string | null
  ruleId: string | null
  /** The title of the rule; null without a rule, or when the rule is gone. */
  ruleTitle: string | null
  firstSeenSha: string
  lastSeenSha: string
  githubCommentId: number | null
  /**
   * REV-102. The last review that found it lists it under « To consider (code already reviewed) »: new on
   * code that an earlier review read, not critical, continuing no earlier finding. It does not block.
   */
  considered: boolean
  createdAt: Date
  updatedAt: Date
}

export interface FindingScreenPage {
  rows: FindingRow[]
  /** The findings of each tab, with the other filters and the search. */
  counts: Record<FindingView, number>
  /** The findings of the tab on screen: `counts[view]`. */
  matching: number
  /** The rows of the tab before this page: the first row is number `offset + 1`. */
  offset: number
  /** `after` of the next page, or null on the last one. */
  next: string | null
  /** `before` of the previous page, or null on the first one. */
  previous: string | null
}

/** The choices of the filters: the repositories that have findings, and the rules of the org. */
export interface FindingFacets {
  repos: { id: string; fullName: string }[]
  rules: { id: string; title: string; repo: string | null }[]
}

/**
 * REV-102. Whether the last review of a finding lists it as one to consider: an entry of its result
 * (`reviews.result.findings`) that is the finding carries `seen`, no `follows`, and is not critical.
 * The entries that are the finding: those of its fingerprint; when the result has none (a runner of
 * an earlier release), those of its path and title. The rule of `toConsider`
 * (packages/engine/src/findings.ts), in SQL, so that the screen filters on it; `consideredOf`
 * (pulls/finding.ts) is the same rule for the detail. `table` is the name of the findings in the query.
 */
export function consideredSql(sql: postgres.Sql, table = 'findings') {
  let t = sql.unsafe(table)
  let entries = sql`jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end)`
  return sql`exists (
    select 1 from reviews r
    cross join lateral ${entries} f
    where r.id = ${t}.last_review_id
      and f->'seen' = 'true'::jsonb
      and coalesce(f->>'follows', '') = ''
      and f->>'severity' is distinct from 'critical'
      and (
        (${t}.fingerprint <> '' and f->>'fingerprint' = ${t}.fingerprint)
        or (
          f->>'path' = ${t}.path and f->>'title' = ${t}.title
          and not exists (select 1 from ${entries} g where ${t}.fingerprint <> '' and g->>'fingerprint' = ${t}.fingerprint)
        )
      )
  )`
}

/** `%`, `_` and `\\` stand for themselves in a search. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

function statusesOf(view: FindingView): readonly FindingStatus[] {
  if (view === 'all') return FINDING_STATUSES
  if (view === 'closed') return FINDING_STATUSES.filter((s) => s !== 'open')
  return [view]
}

type Row = Omit<FindingRow, 'githubCommentId' | 'createdAt' | 'updatedAt'> & {
  githubCommentId: number | string | null
  createdAt: Date | string
  updatedAt: Date | string
  cursorAt: string
}

function toRow(row: Row): FindingRow {
  let out: Partial<Row> = { ...row }
  delete out.cursorAt
  return {
    ...(out as Omit<Row, 'cursorAt'>),
    githubCommentId: row.githubCommentId === null ? null : Number(row.githubCommentId),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  }
}

type CountRow = Record<FindingView, string | number> & { offset: string | number }

export async function listFindingScreen(sql: postgres.Sql, orgId: string, query: FindingQuery = {}): Promise<FindingScreenPage> {
  let view = query.view ?? 'open'
  // A limit of a caller outside the screen stays between 1 and PAGE_MAX rows, as in listFindings.
  let wanted = Math.trunc(query.limit ?? FINDINGS_PAGE_SIZE)
  let limit = Math.min(PAGE_MAX, Math.max(1, Number.isFinite(wanted) ? wanted : FINDINGS_PAGE_SIZE))
  let search = query.search?.trim().slice(0, SEARCH_MAX) ?? ''
  let repoId = query.repoId && UUID.test(query.repoId) ? query.repoId : null
  let ruleId = query.ruleId && UUID.test(query.ruleId) ? query.ruleId : null
  let reason = query.reason ? reasonText(query.reason) || null : null
  let severity = query.severity && SEVERITIES.includes(query.severity) ? query.severity : null
  let author = query.author && LOGIN.test(query.author) ? query.author : null
  let days = query.days && Number.isInteger(query.days) && query.days >= 1 && query.days <= DAYS_MAX ? query.days : null
  // A cursor that does not decode starts the list again at its first page.
  let cursorOf = (value: string | null | undefined) => {
    try {
      return decodeCursor(value)
    } catch {
      return null
    }
  }
  let after = cursorOf(query.after)
  let before = after ? null : cursorOf(query.before)

  // Every filter but the tab: the counts of the tabs read them too.
  let filters = sql`
    repos.org_id = ${orgId}
    ${repoId ? sql`and findings.repo_id = ${repoId}` : sql``}
    ${severity ? sql`and findings.severity = ${severity}` : sql``}
    ${ruleId ? sql`and findings.rule_id = ${ruleId}` : sql``}
    ${reason ? sql`and lower(${reasonOf(sql, 'findings.status_reason')}) = lower(${reason})` : sql``}
    ${search ? sql`and (findings.title ilike ${likePattern(search)} or findings.path ilike ${likePattern(search)})` : sql``}
    ${author ? sql`and exists (select 1 from pull_authors where pull_authors.repo_id = findings.repo_id and pull_authors.pr_number = findings.pr_number and lower(pull_authors.login) = lower(${author}))` : sql``}
    ${days ? sql`and findings.created_at > now() - make_interval(days => ${days}::int)` : sql``}
    ${query.considered ? sql`and ${consideredSql(sql)}` : sql``}`
  let inView = sql`findings.status = any(${sql.array([...statusesOf(view)])}::finding_status[])`
  let key = sql`(findings.created_at, findings.id)`

  let fetched = await sql<Row[]>`
    select findings.id, findings.repo_id as "repoId", repos.full_name as repo, findings.pr_number as "prNumber",
      findings.path, findings.line, findings.title, findings.severity, findings.category, findings.confidence,
      findings.status, findings.status_reason as "statusReason", findings.rule_id as "ruleId", rules.title as "ruleTitle",
      findings.first_seen_sha as "firstSeenSha", findings.last_seen_sha as "lastSeenSha",
      findings.github_comment_id::float8 as "githubCommentId", ${consideredSql(sql)} as considered,
      findings.created_at as "createdAt", findings.updated_at as "updatedAt",
      ${sql.unsafe(cursorAt('findings.created_at'))} as "cursorAt"
    from findings
    join repos on repos.id = findings.repo_id
    left join rules on rules.id = findings.rule_id
    where ${filters} and ${inView}
      ${after ? sql`and ${key} < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
      ${before ? sql`and ${key} > (${before.at}::timestamptz, ${before.id}::uuid)` : sql``}
    order by ${before ? sql`findings.created_at, findings.id` : sql`findings.created_at desc, findings.id desc`}
    limit ${limit + 1}`
  // Fewer than a page before the cursor (findings came or went since the link was made): the
  // previous page is the first one, whole, and not a short page.
  // In the same way, « Next » past the last row (its findings left the tab since) gives the first page.
  if ((before && fetched.length < limit) || (after && fetched.length === 0)) {
    return listFindingScreen(sql, orgId, { ...query, after: null, before: null })
  }
  let more = fetched.length > limit
  let kept = fetched.slice(0, limit)
  if (before) kept.reverse()

  // The position of the page: the rows of the tab that are newer than its first row.
  let first = kept[0]
  let [counts] = await sql<CountRow[]>`
    select
      count(*) filter (where findings.status = 'open') as "open",
      count(*) filter (where findings.status = 'fixed') as "fixed",
      count(*) filter (where findings.status = 'dismissed') as "dismissed",
      count(*) filter (where findings.status = 'wontfix') as "wontfix",
      count(*) filter (where findings.status = 'stale') as "stale",
      count(*) filter (where findings.status <> 'open') as "closed",
      count(*) as "all",
      ${
        first
          ? sql`count(*) filter (where ${inView} and ${key} > (${first.cursorAt}::timestamptz, ${first.id}::uuid))`
          : sql`0`
      } as "offset"
    from findings
    join repos on repos.id = findings.repo_id
    where ${filters}`

  let last = kept.at(-1)
  let offset = Number(counts!.offset)
  return {
    rows: kept.map(toRow),
    counts: Object.fromEntries(FINDING_VIEWS.map((v) => [v, Number(counts![v])])) as Record<FindingView, number>,
    matching: Number(counts![view]),
    offset,
    next: last && (before || more) ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    previous: first && offset > 0 ? encodeCursor({ at: first.cursorAt, id: first.id }) : null,
  }
}

/** The choices of the filters of an org. A repository without a finding is no choice. */
export async function findingFacets(sql: postgres.Sql, orgId: string): Promise<FindingFacets> {
  // One probe of the index (repo_id, created_at, id) per repository: no scan of the findings.
  let repos = await sql<{ id: string; fullName: string }[]>`
    select repos.id, repos.full_name as "fullName" from repos
    where repos.org_id = ${orgId} and exists (select 1 from findings where findings.repo_id = repos.id)
    order by lower(repos.full_name), repos.id`
  let rules = await sql<{ id: string; title: string; repo: string | null }[]>`
    select rules.id, rules.title, repos.full_name as repo from rules
    left join repos on repos.id = rules.repo_id
    where rules.org_id = ${orgId}
    order by rules.repo_id is not null, lower(repos.full_name), lower(rules.title), rules.id`
  return { repos, rules }
}

/** What the Findings screen reads. Tests of the routes can pass a fake. */
export interface FindingsScreenStore {
  list(orgId: string, query?: FindingQuery): Promise<FindingScreenPage>
  facets(orgId: string): Promise<FindingFacets>
  /** REV-18. The precision of the org over 30 days, by repository and by rule, and the reasons of the dismissed findings. */
  precision(orgId: string): Promise<PrecisionReport>
  /** The precision of some repositories of the org, by id. */
  repoPrecisions(orgId: string, repoIds: string[]): Promise<Map<string, Precision>>
}

export function createFindingsScreenStore(sql: postgres.Sql): FindingsScreenStore {
  return {
    list: (orgId, query) => listFindingScreen(sql, orgId, query),
    facets: (orgId) => findingFacets(sql, orgId),
    precision: (orgId) => precisionReport(sql, orgId),
    repoPrecisions: (orgId, repoIds) => repoPrecisions(sql, orgId, repoIds),
  }
}
