// KNT-188. What the Costs screen reads: the costs of the reviews and the resolutions of one org, as
// app/db/costs.ts sums them for the dashboard and the cap (a cost that the runner did not know
// counts 0), by day, repository, level and model, and the most expensive ones. Every query is for
// one org.
import type { JobKind, Level } from '@kento-review/protocol'

import type { Database } from '../db/client.ts'
import { toDate } from '../db/rows.ts'
import { readMoney, type OrgCaps } from '../org-settings/model.ts'
import { dayKey, periodRange, type CostPeriod } from './period.ts'

/** The repositories on the chart and in the table; the others add up in one "Other" row. */
export const REPO_LIMIT = 8
/** The most expensive reviews and resolutions of the period. */
export const TOP_LIMIT = 10

export interface CostDay {
  /** `2026-11-01`, UTC. */
  day: string
  usd: number
  /** The day at the same place in the period before. Null: that period has fewer days. */
  previousUsd: number | null
}

export interface CostShare {
  /** The repository id, the level or the model. Null for "Other" (repositories) or no model. */
  key: string | null
  label: string
  usd: number
  /** The reviews and resolutions. */
  count: number
}

export interface CostlyRun {
  id: string
  kind: JobKind
  repoId: string
  repo: string
  prNumber: number
  level: Level
  model: string | null
  usd: number
  createdAt: Date
}

export interface CostReport {
  period: CostPeriod
  /** The clock of the database. */
  now: Date
  start: Date
  /** Excluded. */
  end: Date
  days: CostDay[]
  totalUsd: number
  previousTotalUsd: number
  /** The reviews and resolutions of the period. */
  count: number
  /** Those whose cost the runner did not know: they count 0. */
  unknown: number
  byRepo: CostShare[]
  byLevel: CostShare[]
  byModel: CostShare[]
  top: CostlyRun[]
  caps: OrgCaps
  /** "This month": the month at the pace of its days so far. Null for the other periods. */
  projectionUsd: number | null
}

export interface CostsStore {
  report(orgId: string, period: CostPeriod): Promise<CostReport>
}

/** The sums of `numeric(10,6)`: 6 decimals, without the noise of the float additions. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

export function createCostsStore({ sql }: Pick<Database, 'sql'>): CostsStore {
  return {
    async report(orgId, period) {
      let [clock] = await sql<{ now: Date | string }[]>`select now() as now`
      let now = toDate(clock!.now)
      let range = periodRange(period, now)
      let { start, end, previousStart, previousEnd } = range
      // The reviews and the resolutions of the org from the start of the period before to the end.
      let costs = sql`
        select 'review'::text as source_table, r.id, r.job_id, r.repo_id, r.pr_number, r.model, r.cost_usd, r.created_at,
          r.result->>'costSource' as cost_source
        from reviews r join repos on repos.id = r.repo_id
        where repos.org_id = ${orgId} and r.created_at >= ${previousStart} and r.created_at < ${end}
        union all
        select 'resolution', s.id, s.job_id, s.repo_id, s.pr_number, s.model, s.cost_usd, s.created_at,
          s.result->>'costSource'
        from resolutions s join repos on repos.id = s.repo_id
        where repos.org_id = ${orgId} and s.created_at >= ${previousStart} and s.created_at < ${end}`
      let [days, repos, levels, models, top, totals, caps] = await Promise.all([
        sql<{ day: string; usd: string }[]>`
          with costs as (${costs})
          select to_char(created_at at time zone 'utc', 'YYYY-MM-DD') as day, coalesce(sum(cost_usd), 0)::text as usd
          from costs group by 1`,
        sql<{ key: string; label: string; usd: string; count: string }[]>`
          with costs as (${costs})
          select repos.id as key, repos.full_name as label, coalesce(sum(costs.cost_usd), 0)::text as usd, count(*)::text as count
          from costs join repos on repos.id = costs.repo_id
          where costs.created_at >= ${start}
          group by repos.id, repos.full_name
          order by sum(costs.cost_usd) desc nulls last, repos.full_name`,
        sql<{ key: Level; usd: string; count: string }[]>`
          with costs as (${costs})
          select jobs.level as key, coalesce(sum(costs.cost_usd), 0)::text as usd, count(*)::text as count
          from costs join jobs on jobs.id = costs.job_id
          where costs.created_at >= ${start}
          group by jobs.level`,
        sql<{ key: string | null; usd: string; count: string }[]>`
          with costs as (${costs})
          select model as key, coalesce(sum(cost_usd), 0)::text as usd, count(*)::text as count
          from costs where created_at >= ${start}
          group by model
          order by sum(cost_usd) desc nulls last, model`,
        sql<{ id: string; kind: JobKind; repoId: string; repo: string; prNumber: number; level: Level; model: string | null; usd: string; createdAt: Date | string }[]>`
          with costs as (${costs})
          select costs.id, jobs.kind, costs.repo_id as "repoId", repos.full_name as repo, costs.pr_number as "prNumber",
            jobs.level, costs.model, costs.cost_usd::text as usd, costs.created_at as "createdAt"
          from costs join jobs on jobs.id = costs.job_id join repos on repos.id = costs.repo_id
          where costs.created_at >= ${start} and costs.cost_usd is not null
          order by costs.cost_usd desc, costs.created_at desc, costs.id
          limit ${TOP_LIMIT}`,
        sql<{ count: string; unknown: string }[]>`
          with costs as (${costs})
          select count(*)::text as count,
            count(*) filter (where cost_usd is null or cost_source = 'unknown')::text as unknown
          from costs where created_at >= ${start}`,
        sql<{ daily: string | null; monthly: string | null; alert: number | null }[]>`
          select daily_cap_usd as daily, monthly_cap_usd as monthly, cap_alert_pct as alert from orgs where id = ${orgId}`,
      ])

      let byDay = new Map(days.map((row) => [row.day, Number(row.usd)]))
      let previousDays: string[] = []
      for (let day = previousStart; day < previousEnd; day = new Date(day.getTime() + 86_400_000)) previousDays.push(dayKey(day))
      let series: CostDay[] = range.days.map((day, i) => ({
        day,
        usd: round(byDay.get(day) ?? 0),
        previousUsd: i < previousDays.length ? round(byDay.get(previousDays[i]!) ?? 0) : null,
      }))
      let totalUsd = round(range.days.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0))
      let previousTotalUsd = round(previousDays.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0))

      let repoShares = repos.map((row) => ({ key: row.key, label: row.label, usd: round(Number(row.usd)), count: Number(row.count) }))
      let byRepo: CostShare[] = repoShares.slice(0, REPO_LIMIT)
      let rest = repoShares.slice(REPO_LIMIT)
      if (rest.length > 0) {
        byRepo.push({
          key: null,
          label: `Other ${rest.length} ${rest.length === 1 ? 'repo' : 'repos'}`,
          usd: round(rest.reduce((sum, row) => sum + row.usd, 0)),
          count: rest.reduce((sum, row) => sum + row.count, 0),
        })
      }
      let levelOrder: Level[] = ['lite', 'balanced', 'heavy']
      let byLevel = levelOrder
        .map((level) => levels.find((row) => row.key === level))
        .filter((row) => row !== undefined)
        .map((row) => ({ key: row.key, label: row.key, usd: round(Number(row.usd)), count: Number(row.count) }))
      let byModel = models.map((row) => ({ key: row.key, label: row.key ?? 'No model call', usd: round(Number(row.usd)), count: Number(row.count) }))

      let elapsed = range.days.length
      let projectionUsd = period === 'month' && elapsed > 0 ? round((totalUsd / elapsed) * range.monthDays) : null
      return {
        period,
        now,
        start,
        end,
        days: series,
        totalUsd,
        previousTotalUsd,
        count: Number(totals[0]?.count ?? 0),
        unknown: Number(totals[0]?.unknown ?? 0),
        byRepo,
        byLevel,
        byModel,
        top: top.map((row) => ({ ...row, prNumber: Number(row.prNumber), usd: Number(row.usd), createdAt: toDate(row.createdAt) })),
        caps: { dailyCapUsd: readMoney(caps[0]?.daily), monthlyCapUsd: readMoney(caps[0]?.monthly), alertPct: Number(caps[0]?.alert ?? 80) },
        projectionUsd,
      }
    },
  }
}
