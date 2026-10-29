import type postgres from 'postgres'

import type { OrgSpent } from './model.ts'

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

/**
 * What the reviews and resolutions of all the repositories of an org cost since the start of the UTC
 * day and of the UTC month, in dollars, and the cost of the day per provider (from `jobs.provider_id`).
 * A cost that the runner did not know counts 0. The enqueue of a job reads the same totals
 * (`orgSpent` of app/db/webhook-store.ts).
 */
export async function readOrgCosts(sql: postgres.Sql, orgId: string): Promise<OrgCostsDetail> {
  let rows = await sql<{ providerId: string | null; label: string | null; day: string; month: string; unknown: string }[]>`
    with costs as (
      select reviews.job_id, reviews.cost_usd, reviews.created_at, reviews.result->>'costSource' as source from reviews join repos on repos.id = reviews.repo_id
      where repos.org_id = ${orgId} and reviews.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
      union all
      select resolutions.job_id, resolutions.cost_usd, resolutions.created_at, resolutions.result->>'costSource' as source from resolutions join repos on repos.id = resolutions.repo_id
      where repos.org_id = ${orgId} and resolutions.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
    )
    select jobs.provider_id as "providerId", providers.label,
      coalesce(sum(costs.cost_usd) filter (where costs.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'), 0)::text as day,
      coalesce(sum(costs.cost_usd), 0)::text as month,
      count(*) filter (where costs.cost_usd is null or costs.source = 'unknown')::text as unknown
    from costs
    join jobs on jobs.id = costs.job_id
    left join providers on providers.id = jobs.provider_id
    group by jobs.provider_id, providers.label`
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

/** The sums of `numeric(10,6)` as numbers: 6 decimals, without the noise of the float additions. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
