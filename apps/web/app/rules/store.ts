import type postgres from 'postgres'

import { MAX_JOB_RULES, UUID as LOWER_UUID } from '@sakuga-review/protocol'

import { toDate } from '../db/rows.ts'
import type { RuleValues, SeverityFloor } from './model.ts'

// Postgres reads a uuid in any case: an id in upper case finds the row too.
const UUID = new RegExp(LOWER_UUID.source, 'i')

/**
 * A repository or its org holds at most this many rules, disabled ones included: a job carries
 * MAX_JOB_RULES at most, and enabling a rule again must never pass the limit.
 */
export const MAX_RULES = MAX_JOB_RULES

/** A rule, as the screens show it. */
export interface RuleView {
  id: string
  /** Null: a rule of the whole org. */
  repoId: string | null
  title: string
  body: string
  paths: string[]
  severityFloor: SeverityFloor | null
  active: boolean
  /** The login of the person who disabled it, or null (active, or the account is gone). */
  disabledBy: string | null
  disabledAt: Date | null
  version: number
  /** The login of the person who wrote the last version. */
  updatedBy: string | null
  updatedAt: Date
}

export type RuleOutcome =
  | { kind: 'saved'; id: string; title: string; version: number; repoId: string | null }
  /** The form came from an older version of the rule: nothing is written. */
  | { kind: 'conflict'; id: string; version: number; updatedBy: string | null; updatedAt: Date }
  | { kind: 'not_found' }
  /** The repository or the org already holds MAX_RULES rules. */
  | { kind: 'full' }

export interface RulesStore {
  /** The rules of a repository of the org, or of the org itself (`repoId` null), oldest first. */
  list(orgId: string, repoId: string | null): Promise<RuleView[]>
  /** The number of active rules of the org itself: the Config screen of a repository recalls them. */
  activeOrgRules(orgId: string): Promise<number>
  /** A new rule of a repository of the org, or of the org. `not_found`: no such repository in the org. */
  create(orgId: string, repoId: string | null, userId: string, values: RuleValues): Promise<RuleOutcome>
  /** Writes the next version of a rule of the org, when `expectedVersion` is its current one. */
  update(orgId: string, ruleId: string, userId: string, expectedVersion: number, values: RuleValues): Promise<RuleOutcome>
  /** Disables a rule (with who and when) or enables it again. */
  setActive(orgId: string, ruleId: string, userId: string, expectedVersion: number, active: boolean): Promise<RuleOutcome>
  /** Removes a rule of the org. Null: no such rule. */
  remove(orgId: string, ruleId: string): Promise<{ title: string; repoId: string | null } | null>
}

type Row = Omit<RuleView, 'disabledAt' | 'updatedAt' | 'version'> & { disabledAt: Date | string | null; updatedAt: Date | string; version: number | string }

function view(row: Row): RuleView {
  return {
    ...row,
    paths: [...row.paths],
    version: Number(row.version),
    disabledAt: row.disabledAt === null ? null : toDate(row.disabledAt),
    updatedAt: toDate(row.updatedAt),
  }
}

export function createRulesStore(sql: postgres.Sql): RulesStore {
  // The version of a rule, read with a lock: a second form sent from the same version waits, then
  // gets a conflict.
  async function locked(tx: postgres.TransactionSql, orgId: string, ruleId: string) {
    let [row] = await tx<{ id: string; version: number; repoId: string | null; updatedBy: string | null; updatedAt: Date | string }[]>`
      select rules.id, rules.version, rules.repo_id as "repoId", users.login as "updatedBy", rules.updated_at as "updatedAt"
      from rules left join users on users.id = rules.updated_by
      where rules.id = ${ruleId} and rules.org_id = ${orgId}
      for update of rules`
    return row ?? null
  }

  return {
    async list(orgId, repoId) {
      if (repoId !== null && !UUID.test(repoId)) return []
      let rows = await sql<Row[]>`
        select rules.id, rules.repo_id as "repoId", rules.title, rules.body, rules.paths,
          rules.severity_floor as "severityFloor", rules.active, disabler.login as "disabledBy",
          rules.disabled_at as "disabledAt", rules.version, updater.login as "updatedBy", rules.updated_at as "updatedAt"
        from rules
        left join users disabler on disabler.id = rules.disabled_by
        left join users updater on updater.id = rules.updated_by
        where rules.org_id = ${orgId}
          and ${repoId === null ? sql`rules.repo_id is null` : sql`rules.repo_id = ${repoId}`}
        order by rules.created_at, rules.id`
      return rows.map(view)
    },

    async activeOrgRules(orgId) {
      let [row] = await sql<{ count: number }[]>`
        select count(*)::int as count from rules where org_id = ${orgId} and repo_id is null and active`
      return row?.count ?? 0
    },

    async create(orgId, repoId, userId, values) {
      if (repoId !== null && !UUID.test(repoId)) return { kind: 'not_found' }
      return sql.begin(async (tx): Promise<RuleOutcome> => {
        // The repository must be of the org: a form cannot add a rule to the repository of another org.
        // Its lock (or the lock of the org) orders two additions, so the limit holds.
        let [owner] = repoId
          ? await tx<{ id: string }[]>`select id from repos where id = ${repoId} and org_id = ${orgId} for update`
          : await tx<{ id: string }[]>`select id from orgs where id = ${orgId} for update`
        if (!owner) return { kind: 'not_found' }
        let [count] = await tx<{ count: number }[]>`
          select count(*)::int as count from rules
          where org_id = ${orgId} and ${repoId === null ? tx`repo_id is null` : tx`repo_id = ${repoId}`}`
        if ((count?.count ?? 0) >= MAX_RULES) return { kind: 'full' }
        let [row] = await tx<{ id: string; version: number }[]>`
          insert into rules (org_id, repo_id, title, body, paths, severity_floor, version, created_by, updated_by)
          values (${orgId}, ${repoId}, ${values.title}, ${values.body}, ${values.paths}, ${values.severityFloor}, 1, ${userId}, ${userId})
          returning id, version`
        return { kind: 'saved', id: row!.id, title: values.title, version: Number(row!.version), repoId }
      })
    },

    async update(orgId, ruleId, userId, expectedVersion, values) {
      if (!UUID.test(ruleId)) return { kind: 'not_found' }
      return sql.begin(async (tx): Promise<RuleOutcome> => {
        let row = await locked(tx, orgId, ruleId)
        if (!row) return { kind: 'not_found' }
        if (Number(row.version) !== expectedVersion) {
          return { kind: 'conflict', id: row.id, version: Number(row.version), updatedBy: row.updatedBy, updatedAt: toDate(row.updatedAt) }
        }
        let [saved] = await tx<{ version: number }[]>`
          update rules set title = ${values.title}, body = ${values.body}, paths = ${values.paths},
            severity_floor = ${values.severityFloor}, version = version + 1, updated_by = ${userId}, updated_at = now()
          where id = ${ruleId}
          returning version`
        return { kind: 'saved', id: ruleId, title: values.title, version: Number(saved!.version), repoId: row.repoId }
      })
    },

    async setActive(orgId, ruleId, userId, expectedVersion, active) {
      if (!UUID.test(ruleId)) return { kind: 'not_found' }
      return sql.begin(async (tx): Promise<RuleOutcome> => {
        let row = await locked(tx, orgId, ruleId)
        if (!row) return { kind: 'not_found' }
        if (Number(row.version) !== expectedVersion) {
          return { kind: 'conflict', id: row.id, version: Number(row.version), updatedBy: row.updatedBy, updatedAt: toDate(row.updatedAt) }
        }
        let [saved] = await tx<{ version: number; title: string }[]>`
          update rules set active = ${active},
            disabled_by = ${active ? null : userId}, disabled_at = ${active ? null : sql`now()`},
            version = version + 1, updated_by = ${userId}, updated_at = now()
          where id = ${ruleId}
          returning version, title`
        return { kind: 'saved', id: ruleId, title: saved!.title, version: Number(saved!.version), repoId: row.repoId }
      })
    },

    async remove(orgId, ruleId) {
      if (!UUID.test(ruleId)) return null
      let [row] = await sql<{ title: string; repoId: string | null }[]>`
        delete from rules where id = ${ruleId} and org_id = ${orgId}
        returning title, repo_id as "repoId"`
      return row ?? null
    },
  }
}
