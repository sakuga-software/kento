import type postgres from 'postgres'

import type { Level } from '@sakuga-review/protocol'

import { readTrustedBots } from '../org-settings/model.ts'
import { readOverrides, type ConfigOverrides } from './model.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the Config screen of a repository reads. */
export interface RepoConfigView {
  id: string
  fullName: string
  enabled: boolean
  defaultLevel: Level
  /** What the repository sets itself. */
  config: ConfigOverrides
  /** What the org sets: the repository inherits it. */
  orgConfig: ConfigOverrides
  /** 0 before the first change. */
  version: number
  /** The login of the person who wrote the last version, or null (none yet, or the account is gone). */
  updatedBy: string | null
  updatedAt: Date | null
  /** What the reviews and resolutions of the repository cost since the first day of the month (UTC), in dollars. */
  spentThisMonthUsd: number
  /** REV-13. The trusted bots of the org: they can give a command, as a person who can write. */
  trustedBots: string[]
}

/** A change of the config: it gets the current values and returns the new ones. */
export type ConfigChange = (current: { config: ConfigOverrides; defaultLevel: Level }) => { config: ConfigOverrides; defaultLevel: Level }

export type SaveOutcome =
  | { kind: 'saved'; version: number; fullName: string }
  /** The form was sent from an older version: someone saved in between. Nothing is written. */
  | { kind: 'conflict'; version: number; updatedBy: string | null; updatedAt: Date | null }
  | { kind: 'not_found' }

export interface RepoConfigStore {
  /** Null: no such repository in the org. */
  read(orgId: string, repoId: string): Promise<RepoConfigView | null>
  /**
   * Writes the next version of the config when `expectedVersion` is the current one. The lock of the
   * row orders the change with the enqueue of a push, which locks the same row: a push after the
   * commit applies the new config.
   */
  save(orgId: string, repoId: string, userId: string, expectedVersion: number, change: ConfigChange): Promise<SaveOutcome>
}

type Row = {
  id: string
  fullName: string
  enabled: boolean
  defaultLevel: Level
  config: unknown
  orgConfig: unknown
  version: number
  updatedBy: string | null
  updatedAt: Date | string | null
  spent: string | null
  trustedBots: string[]
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value)
}

export function createRepoConfigStore(sql: postgres.Sql): RepoConfigStore {
  return {
    async read(orgId, repoId) {
      if (!UUID.test(repoId)) return null
      let [row] = await sql<Row[]>`
        select
          repos.id, repos.full_name as "fullName", repos.enabled, repos.default_level as "defaultLevel",
          repos.config, orgs.config as "orgConfig", repos.config_version as version,
          users.login as "updatedBy", repos.config_updated_at as "updatedAt", orgs.trusted_bots as "trustedBots",
          (
            select coalesce(sum(cost), 0)::text from (
              select cost_usd as cost from reviews
              where reviews.repo_id = repos.id and reviews.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
              union all
              select cost_usd from resolutions
              where resolutions.repo_id = repos.id and resolutions.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
            ) costs
          ) as spent
        from repos
        join orgs on orgs.id = repos.org_id
        left join users on users.id = repos.config_updated_by
        where repos.id = ${repoId} and repos.org_id = ${orgId}`
      if (!row) return null
      return {
        id: row.id,
        fullName: row.fullName,
        enabled: row.enabled,
        defaultLevel: row.defaultLevel,
        config: readOverrides(row.config),
        orgConfig: readOverrides(row.orgConfig),
        version: Number(row.version),
        updatedBy: row.updatedBy,
        updatedAt: toDate(row.updatedAt),
        spentThisMonthUsd: Number(row.spent ?? 0),
        trustedBots: readTrustedBots(row.trustedBots),
      }
    },

    async save(orgId, repoId, userId, expectedVersion, change) {
      if (!UUID.test(repoId)) return { kind: 'not_found' }
      return sql.begin(async (tx): Promise<SaveOutcome> => {
        let [row] = await tx<{ fullName: string; config: unknown; defaultLevel: Level; version: number; updatedBy: string | null; updatedAt: Date | string | null }[]>`
          select repos.full_name as "fullName", repos.config, repos.default_level as "defaultLevel", repos.config_version as version,
            users.login as "updatedBy", repos.config_updated_at as "updatedAt"
          from repos left join users on users.id = repos.config_updated_by
          where repos.id = ${repoId} and repos.org_id = ${orgId}
          for update of repos`
        if (!row) return { kind: 'not_found' }
        if (Number(row.version) !== expectedVersion) {
          return { kind: 'conflict', version: Number(row.version), updatedBy: row.updatedBy, updatedAt: toDate(row.updatedAt) }
        }
        let next = change({ config: readOverrides(row.config), defaultLevel: row.defaultLevel })
        let [saved] = await tx<{ version: number }[]>`
          update repos set
            config = ${JSON.stringify(next.config)}::jsonb,
            default_level = ${next.defaultLevel},
            config_version = config_version + 1,
            config_updated_by = ${userId},
            config_updated_at = now(),
            updated_at = now()
          where id = ${repoId}
          returning config_version as version`
        return { kind: 'saved', version: Number(saved!.version), fullName: row.fullName }
      })
    },
  }
}
