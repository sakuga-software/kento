// REV-47. The one place that sums the costs of the reviews and resolutions, and that checks the cost
// limit of an org. The enqueue of a push or a command, the retry of the dashboard, the Settings
// screen, the dashboard and the config screen of a repository all read these functions.
import { sql } from 'drizzle-orm'

import { capReached, readMoney, type CapHit, type OrgSpent } from '../org-settings/model.ts'
import type { Executor } from './client.ts'

/** The cost of the day of one provider. `providerId` null: the key of the service, or a provider removed since. */
export interface ProviderCost {
  providerId: string | null
  label: string
  usd: number
}

export interface OrgCosts extends OrgSpent {
  dayByProvider: ProviderCost[]
}

/** The costs with the detail of the month that the dashboard shows (REV-14). */
export interface OrgCostsDetail extends OrgCosts {
  /** The cost of the month per provider. */
  monthByProvider: ProviderCost[]
  /** The reviews and resolutions of the month whose cost the runner did not know: they count 0. */
  monthUnknown: number
}

/** The label of the spend without a provider row: the key of the service, or a provider removed since. */
export const SERVICE_KEY_LABEL = 'Clé du service'

/** The costs of all the repositories of an org, or of one repository. */
export type CostScope = { orgId: string } | { repoId: string }

const MONTH = sql`date_trunc('month', now() at time zone 'utc') at time zone 'utc'`
const DAY = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`

/**
 * What the reviews and resolutions of `scope` cost since the start of the UTC day and of the UTC
 * month, in dollars, per provider (from `jobs.provider_id`). A cost that the runner did not know
 * (`cost_usd` null) counts 0; `monthUnknown` counts these rows and the rows of `costSource` `unknown`.
 */
export async function readCosts(db: Executor, scope: CostScope): Promise<OrgCostsDetail> {
  let where = 'orgId' in scope ? sql`repos.org_id = ${scope.orgId}` : sql`repos.id = ${scope.repoId}`
  let rows = await db.execute<{ providerId: string | null; label: string | null; day: string; month: string; unknown: string }>(sql`
    with costs as (
      select reviews.job_id, reviews.cost_usd, reviews.created_at, reviews.result->>'costSource' as source from reviews join repos on repos.id = reviews.repo_id
      where ${where} and reviews.created_at >= ${MONTH}
      union all
      select resolutions.job_id, resolutions.cost_usd, resolutions.created_at, resolutions.result->>'costSource' as source from resolutions join repos on repos.id = resolutions.repo_id
      where ${where} and resolutions.created_at >= ${MONTH}
    )
    select jobs.provider_id as "providerId", providers.label,
      coalesce(sum(costs.cost_usd) filter (where costs.created_at >= ${DAY}), 0)::text as day,
      coalesce(sum(costs.cost_usd), 0)::text as month,
      count(*) filter (where costs.cost_usd is null or costs.source = 'unknown')::text as unknown
    from costs
    join jobs on jobs.id = costs.job_id
    left join providers on providers.id = jobs.provider_id
    group by jobs.provider_id, providers.label`)
  let dayUsd = 0
  let monthUsd = 0
  let dayByProvider: ProviderCost[] = []
  let monthByProvider: ProviderCost[] = []
  let monthUnknown = 0
  for (let row of rows) {
    let day = Number(row.day)
    let label = row.label ?? SERVICE_KEY_LABEL
    dayUsd += day
    monthUsd += Number(row.month)
    monthUnknown += Number(row.unknown)
    if (day > 0) dayByProvider.push({ providerId: row.providerId, label, usd: day })
    monthByProvider.push({ providerId: row.providerId, label, usd: Number(row.month) })
  }
  dayByProvider.sort((a, b) => b.usd - a.usd)
  monthByProvider.sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label))
  return { dayUsd: round(dayUsd), monthUsd: round(monthUsd), dayByProvider, monthByProvider, monthUnknown }
}

/** The costs of all the repositories of an org: the Settings screen, the dashboard and the limit of the org. */
export function readOrgCosts(db: Executor, orgId: string): Promise<OrgCostsDetail> {
  return readCosts(db, { orgId })
}

/** What one repository cost since the start of the UTC month: its config screen and its own limit. */
export async function readRepoMonthCost(db: Executor, repoId: string): Promise<number> {
  return (await readCosts(db, { repoId })).monthUsd
}

/**
 * REV-13. The cost limit that the org reached, or null. The caps are the `numeric` columns of the
 * org row. The caller holds the lock of the org row: it orders the checks of two enqueues of the org.
 * The costs come from the results of the runners, so the jobs already queued are not counted until
 * they end.
 */
export async function orgCapHit(
  db: Executor,
  org: { id: string; dailyCapUsd: string | null; monthlyCapUsd: string | null },
  now: Date = new Date(),
): Promise<CapHit | null> {
  let caps = { dailyCapUsd: readMoney(org.dailyCapUsd), monthlyCapUsd: readMoney(org.monthlyCapUsd) }
  if (caps.dailyCapUsd === null && caps.monthlyCapUsd === null) return null
  return capReached(caps, await readOrgCosts(db, org.id), now)
}

/** The sums of `numeric(10,6)` as numbers: 6 decimals, without the noise of the float additions. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

