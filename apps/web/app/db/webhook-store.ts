import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm'

import type { Installation, Repository, WebhookCommand } from '../github/events.ts'
import type { Db } from './client.ts'
import { jobs, orgs, repos } from './schema.ts'

/** What a verified webhook changed. The route returns it as JSON, for the deliveries page of the App. */
export type WebhookResult =
  | { outcome: 'queued'; jobId: string; cancelled: number }
  | { outcome: 'duplicate'; reason: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'cancelled'; cancelled: number }
  | { outcome: 'updated'; repositories: number; cancelled: number }

/** The commands that write to the database. `ping`, `ignore` and `invalid` never reach the store. */
export type StoreCommand = Exclude<WebhookCommand, { type: 'ping' | 'ignore' | 'invalid' }>

export type ApplyWebhook = (command: StoreCommand, deliveryId: string) => Promise<WebhookResult>

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const ACTIVE_STATES = ['queued', 'running'] as const

/**
 * Why a job became `cancelled`, in `jobs.failure_reason`. Only `superseded` blocks the head for good:
 * a newer push replaced it. A job cancelled by a close or by the installation can come back, when the
 * pull request is reopened or the installation is unsuspended.
 */
export const CANCEL_REASON = {
  superseded: 'superseded by a newer push',
  closed: 'pull request closed',
  suspended: 'installation suspended',
  uninstalled: 'installation deleted',
} as const

type CancelReason = (typeof CANCEL_REASON)[keyof typeof CANCEL_REASON]

export interface StoreOptions {
  /**
   * Lowercase `owner/name` of `KENTO_REPOS`. In M2 the variable decides which repositories are
   * enabled: each upsert writes `repos.enabled` from it, and a job needs `enabled`. M3 replaces the
   * variable with the Repos screen, which then owns the column.
   */
  kentoRepos: ReadonlySet<string>
}

/** Applies each command in one transaction. */
export function createWebhookStore(db: Db, options: StoreOptions): ApplyWebhook {
  let { kentoRepos } = options
  return (command, deliveryId) =>
    db.transaction(async (tx) => {
      switch (command.type) {
        case 'enqueue_review':
          return enqueueReview(tx, command, deliveryId, kentoRepos)
        case 'cancel_pull_request': {
          // The lock waits for an enqueue of the same repository that has not committed yet, so the
          // update below also sees its job.
          let [repo] = await tx
            .select({ id: repos.id })
            .from(repos)
            .where(eq(repos.githubRepoId, command.repository.githubRepoId))
            .for('update')
          if (!repo) return { outcome: 'skipped', reason: 'unknown repository' }
          let where = and(eq(jobs.repoId, repo.id), eq(jobs.prNumber, command.prNumber))
          let cancelled = await cancelActive(tx, where, CANCEL_REASON.closed)
          return { outcome: 'cancelled', cancelled }
        }
        case 'upsert_installation': {
          let org = await upsertOrg(tx, command.installation, command.suspended)
          let count = await upsertRepos(tx, org.id, command.repositories, kentoRepos)
          let cancelled = command.suspended ? await cancelOrgJobs(tx, org.id, CANCEL_REASON.suspended) : 0
          return { outcome: 'updated', repositories: count, cancelled }
        }
        case 'delete_installation': {
          // The rows stay, so the history of the reviews stays. A new installation gets a new id,
          // and its events move the repositories to its org.
          let org = await upsertOrg(tx, command.installation, true)
          let cancelled = await cancelOrgJobs(tx, org.id, CANCEL_REASON.uninstalled)
          return { outcome: 'updated', repositories: 0, cancelled }
        }
        case 'add_repositories': {
          let org = await upsertOrg(tx, command.installation, null)
          let count = await upsertRepos(tx, org.id, command.repositories, kentoRepos)
          return { outcome: 'updated', repositories: count, cancelled: 0 }
        }
        case 'remove_repositories': {
          if (command.githubRepoIds.length === 0) return { outcome: 'updated', repositories: 0, cancelled: 0 }
          let org = await upsertOrg(tx, command.installation, null)
          // The App cannot read these repositories any more. Their jobs and reviews go with them.
          let removed = await tx
            .delete(repos)
            .where(and(eq(repos.orgId, org.id), inArray(repos.githubRepoId, command.githubRepoIds)))
            .returning({ id: repos.id })
          return { outcome: 'updated', repositories: removed.length, cancelled: 0 }
        }
      }
    })
}

/**
 * Creates the review job of a push, and cancels the jobs of the earlier heads of the pull request.
 *
 * - A delivery that already created a job creates nothing: GitHub's « Redeliver ».
 * - A head that already had a review job gets no second one, unless that job was cancelled by a close
 *   or by the installation (`CANCEL_REASON`): a reopen on the same head is reviewed again. The
 *   delivery id is not covered by the signature, so a captured request can come back with a new one.
 *   A head superseded by a newer push stays blocked: the replay of an older push cannot queue a paid
 *   review of a stale head, nor cancel the job of the current head. The cost: a force-push back to a
 *   head that was already reviewed gets no new job.
 *
 * The upsert of the repository locks its row until the end of the transaction, so two deliveries of
 * the same repository run one after the other.
 */
async function enqueueReview(
  tx: Tx,
  command: Extract<StoreCommand, { type: 'enqueue_review' }>,
  deliveryId: string,
  kentoRepos: ReadonlySet<string>,
): Promise<WebhookResult> {
  let org = await upsertOrg(tx, command.installation, null)
  if (org.suspendedAt !== null) return { outcome: 'skipped', reason: 'installation is suspended' }
  let [repo] = await upsertRepoRows(tx, org.id, [command.repository], kentoRepos)
  if (!repo) throw new Error('upsert of the repository returned no row')
  if (!repo.enabled) return { outcome: 'skipped', reason: 'repository is not enabled' }

  let [delivered] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.githubDeliveryId, deliveryId))
  if (delivered) return { outcome: 'duplicate', reason: 'delivery already created a job' }

  // GitHub sends no push event for a closed pull request, but a captured signed push can come back
  // with a new delivery id. While the last job of the pull request was cancelled by its close, only
  // a `reopened` event queues a job.
  if (command.action !== 'reopened') {
    let [last] = await tx
      .select({ state: jobs.state, failureReason: jobs.failureReason })
      .from(jobs)
      .where(and(eq(jobs.repoId, repo.id), eq(jobs.prNumber, command.prNumber)))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(1)
    if (last?.state === 'cancelled' && last.failureReason === CANCEL_REASON.closed) {
      return { outcome: 'skipped', reason: 'pull request is closed' }
    }
  }

  let [sameHead] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.repoId, repo.id),
        eq(jobs.prNumber, command.prNumber),
        eq(jobs.headSha, command.headSha),
        eq(jobs.kind, 'review'),
        or(ne(jobs.state, 'cancelled'), eq(jobs.failureReason, CANCEL_REASON.superseded)),
      ),
    )
    .limit(1)
  if (sameHead) return { outcome: 'duplicate', reason: 'head already had a review job' }

  let [job] = await insertReviewJob(tx, {
    repoId: repo.id,
    level: repo.defaultLevel,
    prNumber: command.prNumber,
    headSha: command.headSha,
    githubDeliveryId: deliveryId,
  })
  if (!job) return { outcome: 'duplicate', reason: 'delivery already created a job' }

  let cancelled = await cancelActive(
    tx,
    and(eq(jobs.repoId, repo.id), eq(jobs.prNumber, command.prNumber), ne(jobs.id, job.id)),
    CANCEL_REASON.superseded,
  )
  return { outcome: 'queued', jobId: job.id, cancelled }
}

/** Inserts one queued review job. A delivery id that is already in `jobs` inserts nothing. */
export function insertReviewJob(tx: Tx, values: typeof jobs.$inferInsert) {
  return tx
    .insert(jobs)
    .values({ ...values, kind: 'review', state: 'queued' })
    .onConflictDoNothing({ target: jobs.githubDeliveryId })
    .returning({ id: jobs.id })
}

async function cancelActive(tx: Tx, where: ReturnType<typeof and>, reason: CancelReason): Promise<number> {
  let rows = await tx
    .update(jobs)
    .set({ state: 'cancelled', finishedAt: new Date(), failureReason: reason })
    .where(and(where, inArray(jobs.state, [...ACTIVE_STATES])))
    .returning({ id: jobs.id })
  return rows.length
}

function cancelOrgJobs(tx: Tx, orgId: string, reason: CancelReason): Promise<number> {
  let orgRepos = tx.select({ id: repos.id }).from(repos).where(eq(repos.orgId, orgId))
  return cancelActive(tx, inArray(jobs.repoId, orgRepos), reason)
}

/**
 * Inserts or updates the org of an installation. `suspended`: true sets `suspended_at`, false clears
 * it, null keeps it (an event that says nothing about the state of the installation).
 */
async function upsertOrg(tx: Tx, installation: Installation, suspended: boolean | null) {
  let suspendedAt = suspended === null ? undefined : suspended ? new Date() : null
  let [org] = await tx
    .insert(orgs)
    .values({ ...installation, suspendedAt: suspendedAt ?? null })
    .onConflictDoUpdate({
      target: orgs.githubInstallationId,
      set: {
        githubAccountId: installation.githubAccountId,
        login: installation.login,
        ...(suspendedAt === undefined ? {} : { suspendedAt }),
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: orgs.id, suspendedAt: orgs.suspendedAt })
  if (!org) throw new Error('upsert of the org returned no row')
  return org
}

async function upsertRepos(
  tx: Tx,
  orgId: string,
  repositories: Repository[],
  kentoRepos: ReadonlySet<string>,
): Promise<number> {
  if (repositories.length === 0) return 0
  return (await upsertRepoRows(tx, orgId, repositories, kentoRepos)).length
}

// A repository keeps its row when it is renamed, or moved to another installation: its GitHub id
// does not change. `enabled` follows KENTO_REPOS (M2); `default_level` is a setting that an event
// never changes. One insert cannot update the same row twice: a repository listed twice keeps its
// last entry.
function upsertRepoRows(tx: Tx, orgId: string, repositories: Repository[], kentoRepos: ReadonlySet<string>) {
  let unique = [...new Map(repositories.map((repo) => [repo.githubRepoId, repo])).values()]
  return tx
    .insert(repos)
    .values(
      unique.map((repo) => ({
        orgId,
        githubRepoId: repo.githubRepoId,
        fullName: repo.fullName,
        enabled: kentoRepos.has(repo.fullName.toLowerCase()),
      })),
    )
    .onConflictDoUpdate({
      target: repos.githubRepoId,
      set: { orgId, fullName: sql`excluded.full_name`, enabled: sql`excluded.enabled`, updatedAt: sql`now()` },
    })
    .returning({ id: repos.id, defaultLevel: repos.defaultLevel, enabled: repos.enabled })
}
