// REV-16. The findings of one pull request in the database, for the publication of one review: it
// reads them before the review, and writes what the review changed once it is on GitHub.
import type postgres from 'postgres'

import type { FindingEventDraft, StoredFinding } from './lifecycle.ts'

/** A finding to write: a new one (`id` null) or a change of a stored one, with its events. */
export type LedgerEntry = {
  id: string | null
  values: Omit<StoredFinding, 'id'>
  events: FindingEventDraft[]
}

export interface FindingsLedger {
  load(): Promise<StoredFinding[]>
  /** Writes every entry and its events in one transaction. */
  save(entries: LedgerEntry[]): Promise<void>
  /** REV-96. Claims the one hint of `reject` of an open finding: false when it is taken or the finding is not open. */
  claimHint?(findingId: string): Promise<boolean>
  /** REV-96. Gives the claim back, after a hint that GitHub refused. */
  releaseHint?(findingId: string): Promise<void>
}

/**
 * REV-96. Claims the one hint of `reject` of a finding, in one statement: of two deliveries or reviews
 * that race for it, one only gets it. Only an open finding can be claimed.
 */
export async function claimRejectHint(sql: postgres.Sql, findingId: string): Promise<boolean> {
  let rows = await sql`
    update findings set reject_hint_at = now()
    where id = ${findingId} and reject_hint_at is null and status = 'open'
    returning id`
  return rows.length === 1
}

/** REV-96. Gives a claim back: the hint did not reach GitHub, and the next refutation tries again. */
export async function releaseRejectHint(sql: postgres.Sql, findingId: string): Promise<void> {
  await sql`update findings set reject_hint_at = null where id = ${findingId}`
}

/**
 * The ledger of the pull request `prNumber` of `repoId`, for the review `reviewId`: a new finding
 * has it as its first review, a finding found again as its last, and each event names it.
 */
export function createFindingsLedger(sql: postgres.Sql, input: { repoId: string; prNumber: number; reviewId: string; head: string }): FindingsLedger {
  return {
    claimHint: (findingId) => claimRejectHint(sql, findingId),
    releaseHint: (findingId) => releaseRejectHint(sql, findingId),
    async load() {
      let rows = await sql<(StoredFinding & { githubCommentId: number | null })[]>`
        select id, fingerprint, key, rule_id as "ruleId", path, line, title, severity, category, confidence, status,
          status as "loadedStatus",
          status_reason as "statusReason", last_seen_sha as "lastSeenSha", github_comment_id::float8 as "githubCommentId",
          github_thread_id as "githubThreadId"
        from findings
        where repo_id = ${input.repoId} and pr_number = ${input.prNumber}
        order by created_at, id`
      return rows.map((r) => ({ ...r, githubCommentId: r.githubCommentId === null ? null : Number(r.githubCommentId) }))
    },

    async save(entries) {
      if (!entries.length) return
      await sql.begin(async (tx) => {
        for (let entry of entries) {
          let v = entry.values
          let id = entry.id
          let seen = v.lastSeenSha === input.head
          if (id === null) {
            let [row] = await tx<{ id: string }[]>`
              insert into findings (repo_id, pr_number, fingerprint, key, rule_id, path, line, title, severity, category,
                confidence, status, status_reason, first_review_id, last_review_id, first_seen_sha, last_seen_sha,
                github_comment_id, github_thread_id)
              values (${input.repoId}, ${input.prNumber}, ${v.fingerprint}, ${v.key}, ${ruleRef(tx, v.ruleId)}, ${v.path}, ${v.line},
                ${v.title}, ${v.severity}, ${v.category}, ${Math.round(v.confidence)}, ${v.status}, ${v.statusReason},
                ${seen ? input.reviewId : null}, ${seen ? input.reviewId : null}, ${v.lastSeenSha}, ${v.lastSeenSha},
                ${v.githubCommentId}, ${v.githubThreadId})
              returning id`
            id = row!.id
          } else {
            // The status read before the review may have changed since (a person dismissed the
            // finding, the pull request closed). The row is locked and read again: a status that
            // changed is kept, and the events of this review for it are not written.
            let [current] = await tx<{ status: string }[]>`select status from findings where id = ${id} for update`
            let statusHolds = current?.status === v.loadedStatus
            await tx`
              update findings set fingerprint = ${v.fingerprint}, key = ${v.key}, rule_id = ${ruleRef(tx, v.ruleId)}, path = ${v.path},
                line = ${v.line}, title = ${v.title}, severity = ${v.severity}, category = ${v.category},
                confidence = ${Math.round(v.confidence)},
                status = ${statusHolds ? tx`${v.status}::finding_status` : tx`status`},
                status_reason = ${statusHolds ? tx`${v.statusReason}` : tx`status_reason`},
                last_review_id = ${seen ? tx`${input.reviewId}::uuid` : tx`last_review_id`},
                last_seen_sha = ${v.lastSeenSha}, github_comment_id = ${v.githubCommentId},
                github_thread_id = ${v.githubThreadId}, updated_at = now()
              where id = ${id}`
            if (!statusHolds) continue
          }
          // `now()` is the start of the transaction: two events of one finding (an adopted thread
          // `opened` then `dismissed` or `fixed`) would share it, and their order would rest on
          // their random ids. `clock_timestamp()` keeps the order in which they are written.
          for (let event of entry.events) {
            await tx`
              insert into finding_events (finding_id, review_id, type, actor, reason, created_at)
              values (${id}, ${input.reviewId}, ${event.type}, ${event.actor}, ${event.reason ?? null}, clock_timestamp())`
          }
        }
      })
    },
  }
}

/**
 * REV-55. The rule of a finding, or null when it is gone: a review cites a rule as its job got it, and
 * an admin can remove the rule while the job runs. The finding keeps its row and loses the rule, as
 * the removal of a rule does to the findings already stored (`ON DELETE SET NULL`).
 */
function ruleRef(tx: postgres.TransactionSql, ruleId: string | null) {
  return ruleId === null ? tx`null::uuid` : tx`(select id from rules where id = ${ruleId}::uuid)`
}
