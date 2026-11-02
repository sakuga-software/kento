// REV-21. The assignment rules of a repository, as the Config screen reads and writes them. Every
// write locks the row of the repository: two forms sent together keep the order 1, 2, 3… without a
// hole or a duplicate. In the database, the unique index (repo_id, position) refuses a duplicate,
// and a check keeps the places between 0 and MAX_ASSIGNMENT_RULES. Place 0 holds the rule that moves
// during a swap; no statement ever puts two rules on one place, even for one row.
import type postgres from 'postgres'

import { UUID as LOWER_UUID, type Level } from '@sakuga-review/protocol'

import { MAX_ASSIGNMENT_RULES, type AssignmentAction, type AssignmentRule, type AssignmentValues } from './model.ts'

// Postgres reads a uuid in any case: an id in upper case finds the row too.
const UUID = new RegExp(LOWER_UUID.source, 'i')

/** A rule as the screen shows it. */
export interface AssignmentView extends AssignmentRule {
  /** The login of the person who added it, or null (the account is gone). */
  createdBy: string | null
}

export type AssignmentOutcome =
  | { kind: 'saved'; id: string; position: number }
  | { kind: 'removed'; position: number }
  | { kind: 'not_found' }
  /** The repository already holds MAX_ASSIGNMENT_RULES rules. */
  | { kind: 'full' }

export interface AssignmentStore {
  /** The rules of a repository of the org, in their order. */
  list(orgId: string, repoId: string): Promise<AssignmentView[]>
  /** A new rule at the end of the list. `not_found`: no such repository in the org. */
  create(orgId: string, repoId: string, userId: string, values: AssignmentValues): Promise<AssignmentOutcome>
  /** Moves a rule one place up or down. At the first or the last place, nothing moves. */
  move(orgId: string, repoId: string, ruleId: string, direction: 'up' | 'down'): Promise<AssignmentOutcome>
  /** Removes a rule; the rules after it move up one place. */
  remove(orgId: string, repoId: string, ruleId: string): Promise<AssignmentOutcome>
}

type Row = Omit<AssignmentView, 'position' | 'action' | 'level'> & { position: number | string; action: string; level: string | null }

function view(row: Row): AssignmentView {
  return {
    ...row,
    position: Number(row.position),
    authors: [...row.authors],
    paths: [...row.paths],
    labels: [...row.labels],
    action: row.action as AssignmentAction,
    level: row.level as Level | null,
  }
}

/** The place of a rule while another one takes its place, inside one transaction. */
const PARKED = 0

export function createAssignmentStore(sql: postgres.Sql): AssignmentStore {
  /** The repository of the org, locked until the end of the transaction; null when it is not of the org. */
  async function lockRepo(tx: postgres.TransactionSql, orgId: string, repoId: string): Promise<boolean> {
    let [row] = await tx<{ id: string }[]>`select id from repos where id = ${repoId} and org_id = ${orgId} for update`
    return row !== undefined
  }

  return {
    async list(orgId, repoId) {
      if (!UUID.test(repoId)) return []
      let rows = await sql<Row[]>`
        select a.id, a.position, a.authors, a.paths, a.labels, a.action, a.level::text as level, a.mention,
          users.login as "createdBy"
        from assignment_rules a
        left join users on users.id = a.created_by
        where a.org_id = ${orgId} and a.repo_id = ${repoId}
        order by a.position, a.id`
      return rows.map(view)
    },

    async create(orgId, repoId, userId, values) {
      if (!UUID.test(repoId)) return { kind: 'not_found' }
      return sql.begin(async (tx): Promise<AssignmentOutcome> => {
        if (!(await lockRepo(tx, orgId, repoId))) return { kind: 'not_found' }
        let [last] = await tx<{ count: number; max: number }[]>`
          select count(*)::int as count, coalesce(max(position), 0)::int as max from assignment_rules where repo_id = ${repoId}`
        let position = (last?.max ?? 0) + 1
        if ((last?.count ?? 0) >= MAX_ASSIGNMENT_RULES || position > MAX_ASSIGNMENT_RULES) return { kind: 'full' }
        let [row] = await tx<{ id: string }[]>`
          insert into assignment_rules (org_id, repo_id, position, authors, paths, labels, action, level, mention, created_by)
          values (${orgId}, ${repoId}, ${position}, ${values.authors}, ${values.paths}, ${values.labels}, ${values.action},
            ${values.level}, ${values.mention}, ${userId})
          returning id`
        return { kind: 'saved', id: row!.id, position }
      })
    },

    async move(orgId, repoId, ruleId, direction) {
      if (!UUID.test(repoId) || !UUID.test(ruleId)) return { kind: 'not_found' }
      return sql.begin(async (tx): Promise<AssignmentOutcome> => {
        if (!(await lockRepo(tx, orgId, repoId))) return { kind: 'not_found' }
        let [rule] = await tx<{ position: number }[]>`select position from assignment_rules where id = ${ruleId} and repo_id = ${repoId}`
        if (!rule) return { kind: 'not_found' }
        let from = Number(rule.position)
        let to = direction === 'up' ? from - 1 : from + 1
        let [other] = await tx<{ id: string }[]>`select id from assignment_rules where repo_id = ${repoId} and position = ${to}`
        if (!other) return { kind: 'saved', id: ruleId, position: from }
        await tx`update assignment_rules set position = ${PARKED}, updated_at = now() where id = ${ruleId}`
        await tx`update assignment_rules set position = ${from}, updated_at = now() where id = ${other.id}`
        await tx`update assignment_rules set position = ${to}, updated_at = now() where id = ${ruleId}`
        return { kind: 'saved', id: ruleId, position: to }
      })
    },

    async remove(orgId, repoId, ruleId) {
      if (!UUID.test(repoId) || !UUID.test(ruleId)) return { kind: 'not_found' }
      return sql.begin(async (tx): Promise<AssignmentOutcome> => {
        if (!(await lockRepo(tx, orgId, repoId))) return { kind: 'not_found' }
        let [removed] = await tx<{ position: number }[]>`
          delete from assignment_rules where id = ${ruleId} and repo_id = ${repoId} returning position`
        if (!removed) return { kind: 'not_found' }
        // The rules after it move up one place, one at a time from the first: each one takes the
        // place that the one before it has just left.
        let after = await tx<{ id: string; position: number }[]>`
          select id, position from assignment_rules where repo_id = ${repoId} and position > ${removed.position} order by position`
        for (let rule of after) {
          await tx`update assignment_rules set position = ${Number(rule.position) - 1}, updated_at = now() where id = ${rule.id}`
        }
        return { kind: 'removed', position: Number(removed.position) }
      })
    },
  }
}
