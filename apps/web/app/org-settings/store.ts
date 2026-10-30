import type postgres from 'postgres'

import type { Database } from '../db/client.ts'
import { readOrgCosts, type OrgCosts } from '../db/costs.ts'
import { toDate } from '../db/rows.ts'
import type { DeliveryRecord } from '../github/webhook.ts'
import { readOverrides, type ConfigOverrides } from '../repo-config/model.ts'
import { DEFAULT_TRUSTED_BOTS, readMoney, readTrustedBots, type OrgCaps } from './model.ts'

/** A delivery of the webhook, as the section « App GitHub » shows it. */
export interface DeliveryView {
  deliveryId: string
  event: string
  action: string | null
  status: number
  outcome: string
  reason: string | null
  receivedAt: Date
}

/** What the settings screen reads about an org. */
export interface OrgSettingsView {
  login: string
  githubInstallationId: number
  suspendedAt: Date | null
  caps: OrgCaps
  trustedBots: string[]
  /** The defaults that the repositories inherit (`orgs.config`). */
  config: ConfigOverrides
  /** 0 before the first change. */
  version: number
  updatedBy: string | null
  updatedAt: Date | null
  repos: { total: number; enabled: number }
  costs: OrgCosts
  deliveries: {
    last: DeliveryView | null
    /** The last `pull_request` delivery: the ticket compares it with the last push. */
    lastPullRequest: DeliveryView | null
    /** Over the last 24 hours: the deliveries answered 4xx or 5xx, and all of them. */
    failures24h: number
    total24h: number
    /** The last failure of the 24 hours, with its reason. */
    lastFailure: DeliveryView | null
  }
}

export interface OrgSettingsValues {
  caps: OrgCaps
  trustedBots: string[]
  config: ConfigOverrides
}

export type OrgSettingsChange = (current: OrgSettingsValues) => OrgSettingsValues

export type OrgSaveOutcome =
  | { kind: 'saved'; version: number }
  /** The form was sent from an older version: someone saved in between. Nothing is written. */
  | { kind: 'conflict'; version: number; updatedBy: string | null; updatedAt: Date | null }
  | { kind: 'not_found' }

export interface OrgSettingsStore {
  read(orgId: string): Promise<OrgSettingsView | null>
  /**
   * Writes the next version when `expectedVersion` is the current one. The row lock orders the change
   * with the enqueue of a job, which locks the same row: a push after the commit sees the new limits.
   */
  save(orgId: string, userId: string, expectedVersion: number, change: OrgSettingsChange): Promise<OrgSaveOutcome>
  /** The trusted bots of the org of an installation; the default of a new org when Kentō does not know it. */
  trustedBotsFor(githubInstallationId: number | null): Promise<ReadonlySet<string>>
  /** Keeps a delivery, and deletes the ones older than 30 days. */
  recordDelivery(record: DeliveryRecord): Promise<void>
}

type DeliveryRow = Omit<DeliveryView, 'receivedAt'> & { receivedAt: Date | string }

function delivery(row: DeliveryRow | undefined): DeliveryView | null {
  return row ? { ...row, status: Number(row.status), receivedAt: toDate(row.receivedAt)! } : null
}

export function createOrgSettingsStore({ sql, db }: Pick<Database, 'sql' | 'db'>): OrgSettingsStore {
  async function lastDelivery(installationId: number, where: postgres.PendingQuery<postgres.Row[]> | null): Promise<DeliveryView | null> {
    let [row] = await sql<DeliveryRow[]>`
      select delivery_id as "deliveryId", event, action, status, outcome, reason, received_at as "receivedAt"
      from webhook_deliveries
      where github_installation_id = ${installationId} ${where ?? sql``}
      order by received_at desc, id desc
      limit 1`
    return delivery(row)
  }

  return {
    async read(orgId) {
      let [row] = await sql<
        {
          login: string
          installationId: string | number
          suspendedAt: Date | string | null
          dailyCapUsd: string | null
          monthlyCapUsd: string | null
          alertPct: number
          trustedBots: string[]
          config: unknown
          version: number
          updatedBy: string | null
          updatedAt: Date | string | null
          total: number
          enabled: number
        }[]
      >`
        select orgs.login, orgs.github_installation_id as "installationId", orgs.suspended_at as "suspendedAt",
          orgs.daily_cap_usd as "dailyCapUsd", orgs.monthly_cap_usd as "monthlyCapUsd", orgs.cap_alert_pct as "alertPct",
          orgs.trusted_bots as "trustedBots", orgs.config, orgs.settings_version as version,
          users.login as "updatedBy", orgs.settings_updated_at as "updatedAt",
          (select count(*)::int from repos where repos.org_id = orgs.id) as total,
          (select count(*)::int from repos where repos.org_id = orgs.id and repos.enabled) as enabled
        from orgs left join users on users.id = orgs.settings_updated_by
        where orgs.id = ${orgId}`
      if (!row) return null
      let installationId = Number(row.installationId)
      let [counts] = await sql<{ failures: number; total: number }[]>`
        select count(*) filter (where status >= 400)::int as failures, count(*)::int as total
        from webhook_deliveries
        where github_installation_id = ${installationId} and received_at > now() - interval '24 hours'`
      return {
        login: row.login,
        githubInstallationId: installationId,
        suspendedAt: toDate(row.suspendedAt),
        caps: { dailyCapUsd: readMoney(row.dailyCapUsd), monthlyCapUsd: readMoney(row.monthlyCapUsd), alertPct: Number(row.alertPct) },
        trustedBots: readTrustedBots(row.trustedBots),
        config: readOverrides(row.config),
        version: Number(row.version),
        updatedBy: row.updatedBy,
        updatedAt: toDate(row.updatedAt),
        repos: { total: Number(row.total), enabled: Number(row.enabled) },
        costs: await readOrgCosts(db, orgId),
        deliveries: {
          last: await lastDelivery(installationId, null),
          lastPullRequest: await lastDelivery(installationId, sql`and event = 'pull_request'`),
          failures24h: Number(counts?.failures ?? 0),
          total24h: Number(counts?.total ?? 0),
          lastFailure: await lastDelivery(installationId, sql`and status >= 400 and received_at > now() - interval '24 hours'`),
        },
      }
    },

    async save(orgId, userId, expectedVersion, change) {
      return sql.begin(async (tx): Promise<OrgSaveOutcome> => {
        let [row] = await tx<
          {
            dailyCapUsd: string | null
            monthlyCapUsd: string | null
            alertPct: number
            trustedBots: string[]
            config: unknown
            version: number
            updatedBy: string | null
            updatedAt: Date | string | null
          }[]
        >`
          select orgs.daily_cap_usd as "dailyCapUsd", orgs.monthly_cap_usd as "monthlyCapUsd", orgs.cap_alert_pct as "alertPct",
            orgs.trusted_bots as "trustedBots", orgs.config, orgs.settings_version as version,
            users.login as "updatedBy", orgs.settings_updated_at as "updatedAt"
          from orgs left join users on users.id = orgs.settings_updated_by
          where orgs.id = ${orgId}
          for update of orgs`
        if (!row) return { kind: 'not_found' }
        if (Number(row.version) !== expectedVersion) {
          return { kind: 'conflict', version: Number(row.version), updatedBy: row.updatedBy, updatedAt: toDate(row.updatedAt) }
        }
        let next = change({
          caps: { dailyCapUsd: readMoney(row.dailyCapUsd), monthlyCapUsd: readMoney(row.monthlyCapUsd), alertPct: Number(row.alertPct) },
          trustedBots: readTrustedBots(row.trustedBots),
          config: readOverrides(row.config),
        })
        let [saved] = await tx<{ version: number }[]>`
          update orgs set
            daily_cap_usd = ${next.caps.dailyCapUsd},
            monthly_cap_usd = ${next.caps.monthlyCapUsd},
            cap_alert_pct = ${next.caps.alertPct},
            trusted_bots = ${tx.array(next.trustedBots)}::text[],
            config = ${JSON.stringify(next.config)}::jsonb,
            settings_version = settings_version + 1,
            settings_updated_by = ${userId},
            settings_updated_at = now(),
            updated_at = now()
          where id = ${orgId}
          returning settings_version as version`
        return { kind: 'saved', version: Number(saved!.version) }
      })
    },

    async trustedBotsFor(githubInstallationId) {
      if (githubInstallationId === null) return new Set(DEFAULT_TRUSTED_BOTS)
      let [row] = await sql<{ trustedBots: string[] }[]>`
        select trusted_bots as "trustedBots" from orgs where github_installation_id = ${githubInstallationId}`
      return new Set(row ? readTrustedBots(row.trustedBots) : DEFAULT_TRUSTED_BOTS)
    },

    async recordDelivery(record) {
      await sql`
        insert into webhook_deliveries (delivery_id, github_installation_id, event, action, status, outcome, reason)
        values (${record.deliveryId}, ${record.githubInstallationId}, ${record.event}, ${record.action}, ${record.status},
          ${record.outcome.slice(0, 32)}, ${record.reason?.slice(0, 300) ?? null})`
      await sql`delete from webhook_deliveries where received_at < now() - interval '30 days'`
    },
  }
}
