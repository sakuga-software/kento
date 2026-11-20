import type { JobKind, Level } from '@kento-review/protocol'
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm'

import { matchAssignment, needsFiles, unreadPathRules, type AssignmentRule, type JobAssignment } from '../assignment/model.ts'
import type { Installation, PullAuthor, Repository, ReviewAction, WebhookCommand } from '../github/events.ts'
import { KENTO_ACTOR } from '../findings/store.ts'
import { instance } from '../instance.ts'
import { errorMessage, log } from '../log.ts'
import type { CapHit } from '../org-settings/model.ts'
import { jobConfig, pathsMatch, readOverrides, resolveConfig, type Trigger } from '../repo-config/model.ts'
import type { Db, Tx } from './client.ts'
import { orgCapHit, readRepoMonthCost } from './costs.ts'
import { assignmentRules, jobs, orgs, pullAuthors, repos, resolutions, reviews, userPrefs, users } from './schema.ts'

/** What a verified webhook changed. The route returns it as JSON, for the deliveries page of the App. */
export type WebhookResult =
  | { outcome: 'queued'; jobId: string; cancelled: number }
  | { outcome: 'duplicate'; reason: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'cancelled'; cancelled: number }
  /** The jobs of a pull request that took its new base. */
  | { outcome: 'retargeted'; jobs: number }
  | { outcome: 'updated'; repositories: number; cancelled: number }
  /** A command that the bot refused: no permission, an unknown command, a fork, a head already reviewed. */
  | { outcome: 'refused'; reason: string }
  /**
   * REV-94. A `reject` set the finding aside (`dismissed`), or found it already set aside
   * (`unchanged`). `dismissedReview`: the review of Kentō that it dismissed, or null.
   */
  | { outcome: 'dismissed' | 'unchanged'; findingId: string; dismissedReview: number | null }
  /** REV-107. An answer about the reviews: `created` is false when an earlier delivery recorded it. */
  | { outcome: 'recorded'; created: boolean; reactions: number }
  /** REV-13. The org reached its cost limit of the day or of the month: no job. */
  | { outcome: 'capped'; reason: string; period: CapHit['period']; spentUsd: number; capUsd: number; resetsAt: string }

/** The commands that write to the database. `ping`, `ignore` and `invalid` never reach the store. */
export type StoreCommand = Exclude<WebhookCommand, { type: 'ping' | 'ignore' | 'invalid' }>

export type ApplyWebhook = (command: StoreCommand, deliveryId: string) => Promise<WebhookResult>

/** A command in a comment. It asks GitHub before it writes: it runs out of the transaction of the store. */
export type CommentCommandMessage = Extract<StoreCommand, { type: 'comment_command' }>
export type HandleCommentCommand = (command: CommentCommandMessage, deliveryId: string) => Promise<WebhookResult>

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
  /** An admin disabled the repository on the Repos screen while the job waited in the queue. */
  disabled: 'repository disabled',
} as const

type CancelReason = (typeof CANCEL_REASON)[keyof typeof CANCEL_REASON]

/** The paths of the files that a pull request changes, as GitHub lists them. Null: GitHub did not answer. */
export type ListChangedFiles = (command: Extract<StoreCommand, { type: 'enqueue_review' }>) => Promise<string[] | null>

export interface StoreOptions {
  /** The commands of the comments (REV-7). Without it, a command is skipped. */
  handleCommentCommand?: HandleCommentCommand
  /** REV-107. An answer about the reviews. Without it, the answer is skipped. */
  handleFeedbackReply?: (reply: Extract<StoreCommand, { type: 'feedback_reply' }>, deliveryId: string) => Promise<WebhookResult>
  /**
   * REV-107. Runs after the close of a pull request is written: GitHub sends no event for a
   * reaction, so the reactions on the request for feedback are read then. Its failure is logged and
   * never fails the delivery.
   */
  onPullClosed?: (command: Extract<StoreCommand, { type: 'cancel_pull_request' }>) => Promise<void>
  /**
   * REV-12. Reads the changed files of a pull request, for a repository whose config has paths.
   * Without it, or when GitHub does not answer, the paths filter nothing: a review too many costs
   * less than a review missed.
   */
  listChangedFiles?: ListChangedFiles
  /**
   * REV-13. Tells the pull request of a push that the cost limit of its org stopped its review. It
   * runs after the commit; its failure is logged and never fails the delivery.
   */
  onCapReached?: (command: Extract<StoreCommand, { type: 'enqueue_review' }>, hit: CapHit) => Promise<void>
  /**
   * REV-118. The lowercase logins of the accounts that Kentō serves. An event of another
   * installation writes nothing: no org, no repository, no job. An event that only removes or
   * cancels still applies. Without it, every installation is served.
   */
  allowedOrgs?: ReadonlySet<string> | null
}

/** The events that only remove or cancel: they apply to an account that is not allowed too. */
const REMOVALS: ReadonlySet<StoreCommand['type']> = new Set(['delete_installation', 'remove_repositories', 'cancel_pull_request'])

export function isOrgAllowed(allowedOrgs: ReadonlySet<string> | null | undefined, login: string): boolean {
  return !allowedOrgs || allowedOrgs.has(login.toLowerCase())
}

/** The `pull_request` actions that create a job, for each trigger of the config. */
const TRIGGER_ACTIONS: Record<Trigger, readonly ReviewAction[]> = {
  push: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
  ready: ['opened', 'reopened', 'ready_for_review'],
  command: [],
}

export function triggerAllows(trigger: Trigger, action: ReviewAction): boolean {
  return TRIGGER_ACTIONS[trigger].includes(action)
}

/** Applies each command in one transaction. A command of a comment goes to its handler. */
export function createWebhookStore(db: Db, options: StoreOptions = {}): ApplyWebhook {
  return async (command, deliveryId) => {
    if (!REMOVALS.has(command.type) && !isOrgAllowed(options.allowedOrgs, command.installation.login)) {
      log('warn', 'webhook.org_not_allowed', { login: command.installation.login, type: command.type, deliveryId })
      return { outcome: 'skipped', reason: 'organization is not allowed' }
    }
    if (command.type === 'comment_command') {
      if (!options.handleCommentCommand) return { outcome: 'skipped', reason: 'commands are not configured' }
      return options.handleCommentCommand(command, deliveryId)
    }
    if (command.type === 'feedback_reply') {
      if (!options.handleFeedbackReply) return { outcome: 'skipped', reason: 'feedback is not configured' }
      return options.handleFeedbackReply(command, deliveryId)
    }
    if (command.type === 'cancel_pull_request' && options.onPullClosed) {
      let result = await apply(command)
      await options.onPullClosed(command).catch((error) =>
        log('warn', 'webhook.pull_closed_hook_failed', { deliveryId, repo: command.repository.fullName, pr: command.prNumber, error: errorMessage(error) }),
      )
      return result
    }
    if (command.type === 'enqueue_review') {
      let before = await beforeEnqueue(db, command, options.listChangedFiles, deliveryId)
      if ('outcome' in before) return before
      let result = await db.transaction((tx) => enqueueReview(tx, command, deliveryId, before.files))
      if (result.outcome === 'capped' && options.onCapReached) {
        let hit: CapHit = { period: result.period, spentUsd: result.spentUsd, capUsd: result.capUsd, resetsAt: new Date(result.resetsAt) }
        await options.onCapReached(command, hit).catch((error) =>
          log('warn', 'webhook.cap_notice_failed', { deliveryId, repo: command.repository.fullName, pr: command.prNumber, error: errorMessage(error) }),
        )
      }
      return result
    }
    return apply(command)
  }

  function apply(command: Exclude<StoreCommand, { type: 'comment_command' | 'feedback_reply' | 'enqueue_review' }>): Promise<WebhookResult> {
    return db.transaction(async (tx): Promise<WebhookResult> => {
      switch (command.type) {
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
          // REV-16. The open findings of a closed pull request become `stale`. A review after a reopen
          // opens again the ones that it finds.
          await tx.execute(sql`
            with staled as (
              update findings set status = 'stale', updated_at = now()
              where repo_id = ${repo.id} and pr_number = ${command.prNumber} and status = 'open'
              returning id
            )
            insert into finding_events (finding_id, type, actor)
            select id, 'stale', ${KENTO_ACTOR} from staled`)
          // REV-59. The dashboard shows no failure of a job created before the last close. The time is
          // read now, under the lock of the repository: after the start of every job that the close saw,
          // and not at the start of this transaction, which may have waited for that lock.
          await tx.execute(sql`
            insert into pull_closures (repo_id, pr_number, closed_at) values (${repo.id}, ${command.prNumber}, clock_timestamp())
            on conflict (repo_id, pr_number) do update set closed_at = excluded.closed_at`)
          return { outcome: 'cancelled', cancelled }
        }
        case 'retarget_pull_request': {
          // The same lock as a close: an enqueue that has not committed yet gets the new base too.
          let [repo] = await tx
            .select({ id: repos.id })
            .from(repos)
            .where(eq(repos.githubRepoId, command.repository.githubRepoId))
            .for('update')
          if (!repo) return { outcome: 'skipped', reason: 'unknown repository' }
          // A queued job clones the base when it runs, and a retry of a failed job copies its base.
          // The old branch can be gone: a stacked pull request moves to the base of its parent when
          // the branch of the parent is deleted.
          let moved = await tx
            .update(jobs)
            .set({ baseRef: command.baseRef })
            .where(
              and(
                eq(jobs.repoId, repo.id),
                eq(jobs.prNumber, command.prNumber),
                inArray(jobs.state, ['queued', 'failed']),
                ne(jobs.baseRef, command.baseRef),
              ),
            )
            .returning({ id: jobs.id })
          return { outcome: 'retargeted', jobs: moved.length }
        }
        case 'upsert_installation': {
          let org = await upsertOrg(tx, command.installation, command.suspended)
          let count = await upsertRepos(tx, org.id, command.repositories)
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
          let count = await upsertRepos(tx, org.id, command.repositories)
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
}

/** REV-21. The assignment rules of a repository, in their order. */
async function readAssignmentRules(db: Db | Tx, repoId: string): Promise<AssignmentRule[]> {
  let rows = await db
    .select({
      id: assignmentRules.id,
      position: assignmentRules.position,
      authors: assignmentRules.authors,
      paths: assignmentRules.paths,
      labels: assignmentRules.labels,
      action: assignmentRules.action,
      level: assignmentRules.level,
      mention: assignmentRules.mention,
    })
    .from(assignmentRules)
    .where(eq(assignmentRules.repoId, repoId))
    .orderBy(assignmentRules.position, assignmentRules.id)
  return rows.map((r) => ({ ...r, action: r.action === 'command_only' ? 'command_only' : 'review' }))
}

/**
 * What a push needs from GitHub: the changed files. GitHub is read before the transaction, which
 * holds the lock of the repository.
 *
 * - REV-12. A pull request that changes no file under the paths of the config gets no automatic
 *   job.
 * - REV-21. The assignment rules need the files when one of them has paths. The transaction reads
 *   the rules again and matches them: a rule removed or moved in between does not apply.
 *
 * The changed files are read once, only when the paths of the config or a rule need them. When
 * GitHub does not answer, the paths filter nothing (a review too many costs less than a review
 * missed), and a rule with paths does not match. A rule with paths added in between does not
 * match either, when this push did not read the files.
 */
async function beforeEnqueue(
  db: Db,
  command: Extract<StoreCommand, { type: 'enqueue_review' }>,
  listChangedFiles: ListChangedFiles | undefined,
  deliveryId: string,
): Promise<WebhookResult | { files: string[] | null }> {
  let [row] = await db
    .select({ id: repos.id, enabled: repos.enabled, config: repos.config, orgConfig: orgs.config })
    .from(repos)
    .innerJoin(orgs, eq(orgs.id, repos.orgId))
    .where(eq(repos.githubRepoId, command.repository.githubRepoId))
  if (!row?.enabled) return { files: null }
  let resolved = resolveConfig(readOverrides(row.orgConfig), readOverrides(row.config))
  if (!triggerAllows(resolved.trigger.value, command.action)) return { files: null }
  let rules = await readAssignmentRules(db, row.id)

  let patterns = resolved.paths.value
  let files: string[] | null = null
  if (listChangedFiles && (patterns.length > 0 || needsFiles(rules))) {
    // A rule with paths decides the level: one more try before it is left out.
    let tries = needsFiles(rules) ? 2 : 1
    for (let attempt = 1; attempt <= tries && files === null; attempt++) {
      try {
        files = await listChangedFiles(command)
      } catch (error) {
        log('warn', 'webhook.changed_files_failed', { deliveryId, repo: command.repository.fullName, pr: command.prNumber, attempt, error: errorMessage(error) })
      }
    }
  }
  if (patterns.length > 0 && files !== null && !pathsMatch(patterns, files)) {
    return { outcome: 'skipped', reason: 'no changed file under the paths of the config' }
  }
  return { files }
}

function capped(hit: CapHit): Extract<WebhookResult, { outcome: 'capped' }> {
  return {
    outcome: 'capped',
    reason: `${hit.period === 'day' ? 'daily' : 'monthly'} cost limit of the org is reached`,
    period: hit.period,
    spentUsd: hit.spentUsd,
    capUsd: hit.capUsd,
    resetsAt: hit.resetsAt.toISOString(),
  }
}

/**
 * Whether Kentō serves a repository: its row is enabled, and the installation is not suspended. A
 * repository that is not, or that Kentō does not know yet, keeps its commands in `review.yml`.
 */
export async function isRepoEnabled(db: Db, githubRepoId: number): Promise<boolean> {
  let [row] = await db
    .select({ enabled: repos.enabled })
    .from(repos)
    .innerJoin(orgs, eq(orgs.id, repos.orgId))
    .where(and(eq(repos.githubRepoId, githubRepoId), sql`${orgs.suspendedAt} is null`))
  return row?.enabled === true
}

/**
 * A review or a resolution older than this is not published any more: its pull request has moved on.
 * The publisher and the guard of `resolve` use the same age.
 */
export const PUBLISH_MAX_AGE = '30 minutes'

export interface CommandJobInput {
  installation: Installation
  repository: Repository
  prNumber: number
  /** The head and the base branch of the pull request, as GitHub gave them after the comment. */
  headSha: string
  baseRef: string
  kind: JobKind
  level: Level
  /** Pay again for a level that the head already has. Review only. */
  force: boolean
  commentId: number
  deliveryId: string
  /** REV-22. The author of the pull request (`issue.user`): kept for the screen of a user. */
  author?: PullAuthor | null
}

export type CommandJobResult =
  | { outcome: 'queued'; jobId: string }
  /** The comment, or the delivery, already created a job: a redelivery, or a replay. */
  | { outcome: 'duplicate'; reason: string; jobId: string | null }
  /**
   * Review: the head already has a review at this level, queued, running or done. Resolve: a resolve
   * of the pull request is queued, running, or done and not published yet.
   */
  | { outcome: 'already'; jobId: string }
  | { outcome: 'skipped'; reason: string }
  /** REV-13. The org reached its cost limit: a command does not pass it either. */
  | { outcome: 'capped'; hit: CapHit }

/**
 * Creates the job of a command: a review or a resolve. It cancels no other job: a heavy review asked during the lite
 * review of the push runs beside it. A newer push cancels it, as any job of an older head.
 *
 * The cost limit: a head that already has a review at this level (queued, running or done) gets no
 * second one, unless the command says `force`. A failed or cancelled review does not count, nor a
 * copy published without a review on the head (REV-101).
 *
 * The upsert of the repository locks its row until the end of the transaction: two commands of the
 * same repository run one after the other, and the second one sees the job of the first.
 */
export function enqueueCommandJob(db: Db, input: CommandJobInput): Promise<CommandJobResult> {
  return db.transaction(async (tx): Promise<CommandJobResult> => {
    let org = await upsertOrg(tx, input.installation, null)
    if (org.suspendedAt !== null) return { outcome: 'skipped', reason: 'installation is suspended' }
    let [repo] = await upsertRepoRows(tx, org.id, [input.repository])
    if (!repo) throw new Error('upsert of the repository returned no row')
    if (!repo.enabled) return { outcome: 'skipped', reason: 'repository is not enabled' }
    if (input.author) await recordPullAuthor(tx, repo.id, input.prNumber, input.author)

    let [earlier] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(or(eq(jobs.githubCommentId, input.commentId), eq(jobs.githubDeliveryId, input.deliveryId)))
      .limit(1)
    if (earlier) return { outcome: 'duplicate', reason: 'comment already created a job', jobId: earlier.id }

    if (input.kind === 'resolve') {
      // A resolve answers only the threads that no resolve answered at this head: a second one at
      // the same head costs nothing once the first is published, but two at the same time would
      // answer the same threads twice. A job is done before the publisher posts its replies and
      // their marker: until then it still counts, but only as long as the publisher would still
      // take it. An older row is never published, and must not hold the pull request for ever.
      let [active] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.repoId, repo.id),
            eq(jobs.prNumber, input.prNumber),
            eq(jobs.kind, 'resolve'),
            or(
              inArray(jobs.state, [...ACTIVE_STATES]),
              and(
                eq(jobs.state, 'done'),
                sql`exists (select 1 from ${resolutions} where ${resolutions.jobId} = ${jobs.id} and ${resolutions.publishedAt} is null
                  and ${resolutions.createdAt} > now() - ${PUBLISH_MAX_AGE}::interval)`,
              ),
            ),
          ),
        )
        .limit(1)
      if (active) return { outcome: 'already', jobId: active.id }
    } else if (!input.force) {
      let [same] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.repoId, repo.id),
            eq(jobs.prNumber, input.prNumber),
            eq(jobs.headSha, input.headSha),
            eq(jobs.kind, 'review'),
            eq(jobs.level, input.level),
            or(
              inArray(jobs.state, ['queued', 'running']),
              // REV-101. A copy of an earlier review (`unchanged`) that was published without a review
              // on the head does not count: a release before REV-101, or a copy that a later review
              // replaced. The head has no score on GitHub, and the command is its only way to get one.
              and(
                eq(jobs.state, 'done'),
                sql`not exists (select 1 from ${reviews} where ${reviews.jobId} = ${jobs.id} and ${reviews.publishedAt} is not null
                  and ${reviews.result} -> 'reusedFrom' is not null and ${reviews.result} -> 'headReviewId' is null)`,
              ),
            ),
          ),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(1)
      if (same) return { outcome: 'already', jobId: same.id }
    }

    // REV-13. The limit of the org protects its budget: a command does not pass it.
    let hit = await orgCapHit(tx, org)
    if (hit) return { outcome: 'capped', hit }

    // The models of the config apply to a command too; its trigger, its paths and the limit of the
    // repository do not: a person with the right to write asked for this job.
    let resolved = resolveConfig(readOverrides(org.config), readOverrides(repo.config), repo.defaultLevel)
    let [job] = await tx
      .insert(jobs)
      .values({
        repoId: repo.id,
        kind: input.kind,
        level: input.level,
        config: jobConfig(resolved, input.level, repo.configVersion),
        state: 'queued',
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseRef: input.baseRef,
        githubDeliveryId: input.deliveryId,
        githubCommentId: input.commentId,
        levelSource: 'command',
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id })
    if (!job) return { outcome: 'duplicate', reason: 'comment already created a job', jobId: null }
    return { outcome: 'queued', jobId: job.id }
  })
}

/**
 * Creates the review job of a push, and cancels the jobs of the earlier heads of the pull request.
 *
 * - A delivery that already created a job creates nothing: GitHub's "Redeliver".
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
  files: string[] | null = null,
): Promise<WebhookResult> {
  let org = await upsertOrg(tx, command.installation, null)
  if (org.suspendedAt !== null) return { outcome: 'skipped', reason: 'installation is suspended' }
  let [repo] = await upsertRepoRows(tx, org.id, [command.repository])
  if (!repo) throw new Error('upsert of the repository returned no row')
  // REV-59. A reopen ends the close, even when it queues no job: the failures of the pull request
  // show again on the dashboard.
  if (command.action === 'reopened') {
    await tx.execute(sql`delete from pull_closures where repo_id = ${repo.id} and pr_number = ${command.prNumber}`)
  }
  if (!repo.enabled) return { outcome: 'skipped', reason: 'repository is not enabled' }

  let [delivered] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.githubDeliveryId, deliveryId))
  if (delivered) return { outcome: 'duplicate', reason: 'delivery already created a job' }

  // REV-21. The rules as they are now, under the lock of the repository: the first one that matches.
  let rules = await readAssignmentRules(tx, repo.id)
  let assigned = matchAssignment(rules, { author: command.author?.login ?? null, labels: command.labels, files })
  // The rules with paths that GitHub kept from being tested: the job and its review say so.
  let unread = unreadPathRules(rules, files, assigned?.rule ?? null)
  if (unread.length > 0) {
    log('warn', 'webhook.assignment_paths_unread', { deliveryId, repo: command.repository.fullName, pr: command.prNumber, rules: unread })
  }

  // REV-22. The preferences of the author of the pull request: no automatic review, or a level of
  // their own. REV-21: a rule of assignment of the repository that matches wins over them.
  let prefs: AuthorPrefs | null = null
  if (command.author) {
    await recordPullAuthor(tx, repo.id, command.prNumber, command.author)
    if (!assigned) {
      prefs = await authorPrefs(tx, repo.id, command.author.githubId)
      if (prefs && !prefs.autoReview) return { outcome: 'skipped', reason: 'automatic review is off for the author of the pull request' }
    }
  }

  // REV-12. The trigger of the config: a push of a repository set to "Ready for review" or to
  // the commands only creates nothing. The older jobs of the pull request stay.
  let resolved = resolveConfig(readOverrides(org.config), readOverrides(repo.config), repo.defaultLevel)
  if (!triggerAllows(resolved.trigger.value, command.action)) {
    return { outcome: 'skipped', reason: `trigger of the config is ${resolved.trigger.value}` }
  }
  // REV-21. The first assignment rule that matches sets the level, or leaves the push to the commands.
  if (assigned?.rule.action === 'command_only') {
    return { outcome: 'skipped', reason: `assignment rule ${assigned.rule.position} leaves the pull request to the commands` }
  }
  let level: Level = assigned?.rule.level ?? prefs?.level ?? resolved.level.value
  let assignment: JobAssignment | null = assigned
    ? {
        ruleId: assigned.rule.id,
        position: assigned.rule.position,
        level,
        mention: assigned.rule.mention,
        reasons: assigned.reasons,
        trigger: resolved.trigger.value,
      }
    : null
  // REV-13. The limit of the org, before the one of the repository: it is the one that protects the
  // budget, and its check run tells the pull request.
  let hit = await orgCapHit(tx, org)
  if (hit) return capped(hit)
  let cap = resolved.monthlyCapUsd.value
  if (cap !== null && (await readRepoMonthCost(tx, repo.id)) >= cap) {
    return { outcome: 'skipped', reason: 'monthly cost limit of the repository is reached' }
  }

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
    level,
    config: {
      ...jobConfig(resolved, level, repo.configVersion),
      ...(assignment ? { assignment } : {}),
      ...(unread.length > 0 ? { assignmentUnread: unread } : {}),
    },
    // REV-21. What chose the level, for the screen of the pull request.
    levelSource: assigned ? 'rule' : prefs?.level ? 'preference' : 'repo',
    assignmentRuleId: assigned?.rule.id ?? null,
    prNumber: command.prNumber,
    headSha: command.headSha,
    // The runner diffs the head from its merge base with this branch.
    baseRef: command.baseRef,
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

/** REV-22. What the author of a pull request set: for this repository, else for every repository. */
export interface AuthorPrefs {
  autoReview: boolean
  /** Null: the level of the repository. */
  level: Level | null
  /** The row of the repository wins whole over the row of every repository: its two fields together. */
  scope: 'repo' | 'global'
}

/** REV-22. The preferences of the person with this GitHub id for a repository, or null: none set. */
export async function authorPrefs(tx: Tx | Db, repoId: string, githubId: number): Promise<AuthorPrefs | null> {
  let [row] = await tx
    .select({ autoReview: userPrefs.autoReview, level: userPrefs.level, repoId: userPrefs.repoId })
    .from(userPrefs)
    .innerJoin(users, eq(users.id, userPrefs.userId))
    .where(and(eq(users.githubId, githubId), or(eq(userPrefs.repoId, repoId), sql`${userPrefs.repoId} is null`)))
    .orderBy(sql`${userPrefs.repoId} nulls last`)
    .limit(1)
  return row ? { autoReview: row.autoReview, level: row.level, scope: row.repoId === null ? 'global' : 'repo' } : null
}

/** REV-22. Keeps the author of a pull request; a later event of the same pull request updates the login. */
async function recordPullAuthor(tx: Tx, repoId: string, prNumber: number, author: PullAuthor) {
  await tx
    .insert(pullAuthors)
    .values({ repoId, prNumber, githubId: author.githubId, login: author.login })
    .onConflictDoUpdate({
      target: [pullAuthors.repoId, pullAuthors.prNumber],
      set: { githubId: author.githubId, login: author.login, updatedAt: sql`now()` },
    })
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
 * it, null keeps it (an event that says nothing about the state of the installation). A new org
 * trusts the default bots of the instance (KENTO_DEFAULT_TRUSTED_BOTS); an update keeps the trusted
 * bots that an admin set.
 */
async function upsertOrg(tx: Tx, installation: Installation, suspended: boolean | null) {
  let suspendedAt = suspended === null ? undefined : suspended ? new Date() : null
  let [org] = await tx
    .insert(orgs)
    .values({ ...installation, suspendedAt: suspendedAt ?? null, trustedBots: [...instance().defaultTrustedBots] })
    .onConflictDoUpdate({
      target: orgs.githubInstallationId,
      set: {
        githubAccountId: installation.githubAccountId,
        login: installation.login,
        ...(suspendedAt === undefined ? {} : { suspendedAt }),
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: orgs.id, suspendedAt: orgs.suspendedAt, config: orgs.config, dailyCapUsd: orgs.dailyCapUsd, monthlyCapUsd: orgs.monthlyCapUsd })
  if (!org) throw new Error('upsert of the org returned no row')
  return org
}

async function upsertRepos(tx: Tx, orgId: string, repositories: Repository[]): Promise<number> {
  if (repositories.length === 0) return 0
  return (await upsertRepoRows(tx, orgId, repositories)).length
}

// A repository keeps its row when it is renamed, or moved to another installation: its GitHub id
// does not change. `enabled` and `default_level` are settings of the Repos screen that an event never
// changes: a new repository comes in disabled. One insert cannot update the same row twice: a
// repository listed twice keeps its last entry.
function upsertRepoRows(tx: Tx, orgId: string, repositories: Repository[]) {
  let unique = [...new Map(repositories.map((repo) => [repo.githubRepoId, repo])).values()]
  return tx
    .insert(repos)
    .values(
      unique.map((repo) => ({
        orgId,
        githubRepoId: repo.githubRepoId,
        fullName: repo.fullName,
      })),
    )
    .onConflictDoUpdate({
      target: repos.githubRepoId,
      set: { orgId, fullName: sql`excluded.full_name`, updatedAt: sql`now()` },
    })
    .returning({ id: repos.id, defaultLevel: repos.defaultLevel, enabled: repos.enabled, config: repos.config, configVersion: repos.configVersion })
}
