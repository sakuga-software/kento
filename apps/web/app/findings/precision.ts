// REV-18. The precision of the reviews: of the findings closed in the last 30 days, the share that a
// push fixed, `fixed / (fixed + dismissed)`. A wontfix or stale finding counts in neither.
//
// A finding counts when its status is `fixed` or `dismissed` now and its last event set that status,
// in the window: a finding fixed then opened again leaves the count until it closes again.
import type postgres from 'postgres'

import { REASON_MAX } from './store.ts'

/** The days of the window. */
export const PRECISION_DAYS = 30
/** The closed findings under which a share would say nothing: the screen shows "n = 9 of 10". */
export const PRECISION_MIN = 10

export interface Precision {
  fixed: number
  dismissed: number
  /** `fixed + dismissed`. */
  closed: number
  /** `fixed / closed`, from 0 to 1; null under PRECISION_MIN closed findings. */
  rate: number | null
}

export interface RepoPrecision extends Precision {
  id: string
  fullName: string
}

export interface RulePrecision extends Precision {
  id: string
  title: string
  /** The repository of a rule of a repository; null for a rule of the org. */
  repo: string | null
}

export interface DismissReason {
  reason: string
  count: number
}

export interface PrecisionReport {
  org: Precision
  /** The repositories with a closed finding, the most closed first, at most `limit`. */
  repos: RepoPrecision[]
  /** The repositories with a closed finding, all of them. */
  repoCount: number
  /** The rules with a closed finding, the most closed first, at most `limit`. */
  rules: RulePrecision[]
  ruleCount: number
  /** The reasons of the findings dismissed in the window, the most frequent first, at most `limit`. */
  reasons: DismissReason[]
  reasonCount: number
  /** The findings dismissed in the window with no reason: no link, the list cannot filter on an empty reason. */
  unreasoned: number
}

export function precisionOf(fixed: number, dismissed: number): Precision {
  let closed = fixed + dismissed
  return { fixed, dismissed, closed, rate: closed >= PRECISION_MIN ? fixed / closed : null }
}

/**
 * A reason as the groups and the links of the list read it: its first REASON_MAX characters, with no
 * space around, or null when it is empty. The link of a group carries this text, and the list filter
 * compares with it (any case).
 */
export function reasonOf(sql: postgres.Sql, column: 'findings.status_reason') {
  return sql`nullif(btrim(left(btrim(${sql.unsafe(column)}), ${REASON_MAX})), '')`
}

/** The text of a reason in a link: the same rule as `reasonOf`, in JavaScript. */
export function reasonText(value: string): string {
  return value.trim().slice(0, REASON_MAX).trim()
}

/**
 * The findings of an org closed in the window, with their status, and the names of their repository
 * and rule read in the same statement: a repository or a rule removed meanwhile cannot leave a group
 * without a name.
 *
 * The event that set the status must be the last event of the finding (by `created_at`, then `id`):
 * the ledger writes its events with `clock_timestamp()`, so two events of one finding do not share a
 * time.
 */
function closedFindings(sql: postgres.Sql, orgId: string, repoIds?: string[]) {
  return sql`
    select findings.repo_id, repos.full_name, findings.rule_id, rules.title as rule_title, rule_repos.full_name as rule_repo,
      findings.status, ${reasonOf(sql, 'findings.status_reason')} as status_reason
    from findings
    join repos on repos.id = findings.repo_id
    left join rules on rules.id = findings.rule_id
    left join repos rule_repos on rule_repos.id = rules.repo_id
    where repos.org_id = ${orgId}
      ${repoIds ? sql`and findings.repo_id = any(${repoIds}::uuid[])` : sql``}
      and findings.status in ('fixed', 'dismissed')
      -- The event that set the status is in the window, and no event came after it.
      and exists (
        select 1 from finding_events closing
        where closing.finding_id = findings.id
          and closing.type::text = findings.status::text
          and closing.created_at >= now() - ${`${PRECISION_DAYS} days`}::interval
          and not exists (
            select 1 from finding_events later
            where later.finding_id = findings.id and (later.created_at, later.id) > (closing.created_at, closing.id)
          )
      )`
}

type GroupRow = {
  level: 'org' | 'repo' | 'rule' | 'reason'
  key: string | null
  name: string | null
  extra: string | null
  fixed: string | number
  dismissed: string | number
}

/** The precision of an org, by repository and by rule, and the reasons of its dismissed findings. */
export async function precisionReport(sql: postgres.Sql, orgId: string, limit = 8): Promise<PrecisionReport> {
  let groups = await sql<GroupRow[]>`
    with closed as materialized (${closedFindings(sql, orgId)})
    select 'org'::text as level, null::text as key, null::text as name, null::text as extra,
      count(*) filter (where status = 'fixed') as fixed, count(*) filter (where status = 'dismissed') as dismissed
    from closed
    union all
    select 'repo', repo_id::text, full_name, null, count(*) filter (where status = 'fixed'), count(*) filter (where status = 'dismissed')
    from closed group by repo_id, full_name
    union all
    -- A rule removed since has no row: REV-55 sets rule_id to null, and the join gives no title.
    select 'rule', rule_id::text, rule_title, rule_repo, count(*) filter (where status = 'fixed'), count(*) filter (where status = 'dismissed')
    from closed where rule_title is not null group by rule_id, rule_title, rule_repo
    union all
    -- A dismissal with no reason (an empty one, or one of an earlier release) has its own group: key null.
    -- "Off topic" and "off topic" are one reason: the group goes by the lower case, and shows
    -- the first of its spellings. The link of the list compares the same way (screen.ts).
    select 'reason', min(status_reason), null, null, 0::bigint, count(*) from closed where status = 'dismissed' group by lower(status_reason)`

  let byLevel = (level: GroupRow['level']) =>
    groups
      .filter((g) => g.level === level)
      .map((g) => ({ key: g.key, name: g.name ?? '', extra: g.extra, ...precisionOf(Number(g.fixed), Number(g.dismissed)) }))
      .sort((a, b) => b.closed - a.closed || a.name.localeCompare(b.name, 'en') || String(a.key).localeCompare(String(b.key)))
  let org = groups.find((g) => g.level === 'org')
  let repos = byLevel('repo')
  let rules = byLevel('rule')
  let reasonGroups = groups.filter((g) => g.level === 'reason')
  let reasons = reasonGroups
    .filter((g) => g.key !== null)
    .map((g) => ({ reason: g.key!, count: Number(g.dismissed) }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'en'))
  let pick = ({ fixed, dismissed, closed, rate }: Precision): Precision => ({ fixed, dismissed, closed, rate })
  return {
    org: org ? precisionOf(Number(org.fixed), Number(org.dismissed)) : precisionOf(0, 0),
    repos: repos.slice(0, limit).map((g) => ({ ...pick(g), id: g.key!, fullName: g.name })),
    repoCount: repos.length,
    rules: rules.slice(0, limit).map((g) => ({ ...pick(g), id: g.key!, title: g.name, repo: g.extra })),
    ruleCount: rules.length,
    reasons: reasons.slice(0, limit),
    reasonCount: reasons.length,
    unreasoned: Number(reasonGroups.find((g) => g.key === null)?.dismissed ?? 0),
  }
}

/** The precision of some repositories of an org: the rows of a page of the Repos screen. */
export async function repoPrecisions(sql: postgres.Sql, orgId: string, repoIds: string[]): Promise<Map<string, Precision>> {
  if (repoIds.length === 0) return new Map()
  let rows = await sql<{ repoId: string; fixed: string | number; dismissed: string | number }[]>`
    with closed as (${closedFindings(sql, orgId, repoIds)})
    select repo_id as "repoId", count(*) filter (where status = 'fixed') as fixed, count(*) filter (where status = 'dismissed') as dismissed
    from closed group by repo_id`
  return new Map(rows.map((r) => [r.repoId, precisionOf(Number(r.fixed), Number(r.dismissed))]))
}

/** "82%", or "n = 9 of 10" under PRECISION_MIN closed findings. */
export function precisionLabel(precision: Precision): string {
  if (precision.rate === null) return `n = ${precision.closed} of ${PRECISION_MIN}`
  return `${Math.round(precision.rate * 100)}%`
}
