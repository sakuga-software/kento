// REV-112. The weekly measures of the reviews, from the statuses of the findings of every org:
//
// - handled rate: `(fixed + applied) / closed`;
// - reject rate: `dismissed / closed`;
// - calibration: the reject rate by decile of confidence, over all the weeks;
// - guardrail: the findings for each pull request that a published review read.
//
// `closed` is `fixed + applied + dismissed + wontfix`. An open or stale finding is not closed. No
// status records an applied suggestion now: a commit of a suggestion makes the finding `fixed`, so
// `applied` is always 0 and stays in the formula for a later source.
//
// A finding counts in the week of the event that closed it, when its status is that of its last
// event (the rule of precision.ts). The weeks start on Monday, in UTC.
import { BLOCKING_CONFIDENCE } from '@kento-review/engine/findings'
import type postgres from 'postgres'

import { PRECISION_MIN } from './precision.ts'

export type ClosedStatus = 'fixed' | 'dismissed' | 'wontfix'

/** A finding closed in the window. `week` is the Monday of the week of its closing event, `YYYY-MM-DD`. */
export interface ClosedFinding {
  week: string
  repo: string
  severity: string
  category: string
  confidence: number
  status: ClosedStatus
}

/** The published reviews of a repository in a week, and the findings that they found first. */
export interface ReviewVolume {
  week: string
  repo: string
  prs: number
  findings: number
}

/** A share with its Wilson interval at 95 %. `rate`, `low` and `high` are null when `n` is 0. */
export interface Rate {
  k: number
  n: number
  rate: number | null
  low: number | null
  high: number | null
}

export interface Cell {
  fixed: number
  applied: number
  dismissed: number
  wontfix: number
  closed: number
  handled: Rate
  rejected: Rate
}

export interface Volume {
  prs: number
  findings: number
  /** `findings / prs`; null with no pull request. */
  perPr: number | null
}

export interface WeekMeasures {
  week: string
  all: Cell
  repos: Record<string, Cell>
  severities: Record<string, Cell>
  categories: Record<string, Cell>
  deciles: Record<string, Cell>
  volume: Volume
  volumeByRepo: Record<string, Volume>
}

export interface Calibration {
  /** The reject rate by decile over all the weeks, the lowest decile first. */
  deciles: { decile: string; cell: Cell }[]
  /**
   * The pairs of adjacent deciles, both with PRECISION_MIN closed findings or more, where the reject
   * rate goes up with the confidence.
   */
  inversions: { from: string; to: string }[]
  /** The findings under BLOCKING_CONFIDENCE and the findings at it or above. */
  below: Cell
  above: Cell
  /** The interval of `above` is under the interval of `below`: the threshold splits the reject rates. */
  separated: boolean
}

export interface MeasuresReport {
  since: string
  weeks: WeekMeasures[]
  calibration: Calibration
}

const Z95 = 1.96

/** The Wilson score interval of `k` successes in `n` trials. */
export function wilson(k: number, n: number, z = Z95): Rate {
  if (n === 0) return { k, n, rate: null, low: null, high: null }
  let p = k / n
  let z2 = z * z
  let denominator = 1 + z2 / n
  let centre = (p + z2 / (2 * n)) / denominator
  let half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

/** The decile of a confidence from 0 to 100: `0-9` to `90-100`. A confidence of 100 is in `90-100`. */
export function decileOf(confidence: number): string {
  let d = Math.min(9, Math.max(0, Math.floor(confidence / 10)))
  return d === 9 ? '90-100' : `${d * 10}-${d * 10 + 9}`
}

export const DECILES = Array.from({ length: 10 }, (_, d) => decileOf(d * 10))

export function cellOf(fixed: number, applied: number, dismissed: number, wontfix: number): Cell {
  let closed = fixed + applied + dismissed + wontfix
  return { fixed, applied, dismissed, wontfix, closed, handled: wilson(fixed + applied, closed), rejected: wilson(dismissed, closed) }
}

function cellFrom(findings: ClosedFinding[]): Cell {
  let count = (status: ClosedStatus) => findings.filter((f) => f.status === status).length
  return cellOf(count('fixed'), 0, count('dismissed'), count('wontfix'))
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  let groups = new Map<string, T[]>()
  for (let item of items) {
    let key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

function cells(findings: ClosedFinding[], keyOf: (f: ClosedFinding) => string): Record<string, Cell> {
  let groups = [...groupBy(findings, keyOf)].sort(([a], [b]) => a.localeCompare(b, 'en'))
  return Object.fromEntries(groups.map(([key, group]) => [key, cellFrom(group)]))
}

function volumeOf(rows: ReviewVolume[]): Volume {
  let prs = rows.reduce((sum, r) => sum + r.prs, 0)
  let findings = rows.reduce((sum, r) => sum + r.findings, 0)
  return { prs, findings, perPr: prs > 0 ? findings / prs : null }
}

function calibrationOf(findings: ClosedFinding[]): Calibration {
  let deciles = DECILES.map((decile) => ({ decile, cell: cellFrom(findings.filter((f) => decileOf(f.confidence) === decile)) }))
  let inversions: Calibration['inversions'] = []
  for (let i = 1; i < deciles.length; i++) {
    let [lower, upper] = [deciles[i - 1]!, deciles[i]!]
    if (lower.cell.closed < PRECISION_MIN || upper.cell.closed < PRECISION_MIN) continue
    if (upper.cell.rejected.rate! > lower.cell.rejected.rate!) inversions.push({ from: lower.decile, to: upper.decile })
  }
  let below = cellFrom(findings.filter((f) => f.confidence < BLOCKING_CONFIDENCE))
  let above = cellFrom(findings.filter((f) => f.confidence >= BLOCKING_CONFIDENCE))
  let separated = above.rejected.high !== null && below.rejected.low !== null && above.rejected.high < below.rejected.low
  return { deciles, inversions, below, above, separated }
}

/** The measures of each week, the oldest first, and the calibration over all the weeks. */
export function measure(closed: ClosedFinding[], volume: ReviewVolume[], since: string): MeasuresReport {
  let weeks = [...new Set([...closed.map((f) => f.week), ...volume.map((v) => v.week)])].sort()
  return {
    since,
    weeks: weeks.map((week) => {
      let findings = closed.filter((f) => f.week === week)
      let volumes = volume.filter((v) => v.week === week)
      return {
        week,
        all: cellFrom(findings),
        repos: cells(findings, (f) => f.repo),
        severities: cells(findings, (f) => f.severity),
        categories: cells(findings, (f) => f.category),
        deciles: cells(findings, (f) => decileOf(f.confidence)),
        volume: volumeOf(volumes),
        volumeByRepo: Object.fromEntries([...groupBy(volumes, (v) => v.repo)].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([repo, rows]) => [repo, volumeOf(rows)])),
      }
    }),
    calibration: calibrationOf(closed),
  }
}

const WEEK = (column: string) => `to_char(date_trunc('week', ${column} at time zone 'UTC'), 'YYYY-MM-DD')`

/** The findings of every org closed since `since`. */
export async function closedFindings(sql: postgres.Sql, since: Date): Promise<ClosedFinding[]> {
  let rows = await sql<(Omit<ClosedFinding, 'confidence'> & { confidence: number | string })[]>`
    select ${sql.unsafe(WEEK('last.created_at'))} as week, repos.full_name as repo, findings.severity, findings.category,
      findings.confidence, findings.status::text as status
    from findings
    join repos on repos.id = findings.repo_id
    cross join lateral (
      select type, created_at from finding_events
      where finding_events.finding_id = findings.id
      order by created_at desc, id desc
      limit 1
    ) last
    where findings.status in ('fixed', 'dismissed', 'wontfix')
      and last.type::text = findings.status::text
      and last.created_at >= ${since.toISOString()}::timestamptz`
  return rows.map((r) => ({ ...r, confidence: Number(r.confidence) }))
}

/**
 * The published reviews since `since`, by week of publication and repository: the pull requests
 * that they read, and the findings that they found first. A pull request with a review in two weeks
 * counts in each week.
 */
export async function reviewVolume(sql: postgres.Sql, since: Date): Promise<ReviewVolume[]> {
  let rows = await sql<{ week: string; repo: string; prs: string | number; findings: string | number }[]>`
    select week, repo, count(distinct pr_number) as prs, sum(found) as findings
    from (
      select ${sql.unsafe(WEEK('reviews.published_at'))} as week, repos.full_name as repo, reviews.pr_number,
        (select count(*) from findings where findings.first_review_id = reviews.id) as found
      from reviews
      join repos on repos.id = reviews.repo_id
      where reviews.published_at >= ${since.toISOString()}::timestamptz
    ) published
    group by week, repo`
  return rows.map((r) => ({ week: r.week, repo: r.repo, prs: Number(r.prs), findings: Number(r.findings) }))
}

export async function measuresReport(sql: postgres.Sql, since: Date): Promise<MeasuresReport> {
  let [closed, volume] = await Promise.all([closedFindings(sql, since), reviewVolume(sql, since)])
  return measure(closed, volume, since.toISOString().slice(0, 10))
}

function percent(value: number | null): string {
  return value === null ? '–' : `${Math.round(value * 100)}%`
}

/** "62% [48–74%]", or "–" with no closed finding. */
export function rateText(rate: Rate): string {
  if (rate.rate === null) return '–'
  return `${percent(rate.rate)} [${Math.round(rate.low! * 100)}–${percent(rate.high)}]`
}

function table(title: string, cells: Record<string, Cell> | [string, Cell][]): string[] {
  let rows = Array.isArray(cells) ? cells : Object.entries(cells)
  return [
    `| ${title} | closed | fixed | dismissed | wontfix | handled | rejected |`,
    '|---|---:|---:|---:|---:|---|---|',
    ...rows.map(([key, c]) => `| ${key} | ${c.closed} | ${c.fixed} | ${c.dismissed} | ${c.wontfix} | ${rateText(c.handled)} | ${rateText(c.rejected)} |`),
  ]
}

/** The report in Markdown: the calibration first, then each week, the newest first. */
export function renderMeasures(report: MeasuresReport): string {
  let { calibration } = report
  let lines = [
    `# The measures of Kentō since ${report.since}`,
    '',
    'Handled = (fixed + applied) / closed. Rejected = dismissed / closed. 95 % Wilson intervals. Applied is 0: no status records it.',
    '',
    '## Calibration, all the weeks',
    '',
    ...table('confidence', calibration.deciles.map(({ decile, cell }) => [decile, cell] as [string, Cell])),
    '',
    ...table('threshold', [
      [`< ${BLOCKING_CONFIDENCE}`, calibration.below],
      [`>= ${BLOCKING_CONFIDENCE}`, calibration.above],
    ]),
    '',
    calibration.separated
      ? `The reject rate at ${BLOCKING_CONFIDENCE} or above is lower, and the intervals do not overlap.`
      : `The intervals of the reject rate under and above ${BLOCKING_CONFIDENCE} overlap: the threshold does not split them.`,
    calibration.inversions.length === 0
      ? `No adjacent deciles with ${PRECISION_MIN} closed findings or more where the reject rate goes up.`
      : `The reject rate goes up from ${calibration.inversions.map((i) => `${i.from} to ${i.to}`).join(', ')}.`,
  ]
  for (let week of [...report.weeks].reverse()) {
    let perPr = week.volume.perPr === null ? '–' : week.volume.perPr.toFixed(2)
    lines.push(
      '',
      `## Week of ${week.week}`,
      '',
      `Handled ${rateText(week.all.handled)}, rejected ${rateText(week.all.rejected)}, of ${week.all.closed} closed. ` +
        `Findings per pull request: ${perPr} (${week.volume.findings} findings, ${week.volume.prs} pull requests).`,
      '',
      ...table('repository', week.repos),
      '',
      ...table('severity', week.severities),
      '',
      ...table('category', week.categories),
      '',
      ...table('confidence', week.deciles),
      '',
      '| repository | pull requests | findings | per pull request |',
      '|---|---:|---:|---:|',
      ...Object.entries(week.volumeByRepo).map(([repo, v]) => `| ${repo} | ${v.prs} | ${v.findings} | ${v.perPr === null ? '–' : v.perPr.toFixed(2)} |`),
    )
  }
  return `${lines.join('\n')}\n`
}
