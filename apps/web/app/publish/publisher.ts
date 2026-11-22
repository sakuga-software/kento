// The publisher: it takes the reviews that the runners sent and that GitHub does not have yet, and
// publishes them with an installation token of the App. The result route wakes it; a timer also
// runs it, so that a review stored before a restart is still published.
//
// `reviews.published_at` set and `github_review_id` set: the review is on GitHub.
// `reviews.published_at` set and `github_review_id` null: the review was not published, on purpose
// (the pull request is closed, or a newer push moved its head). The log line says why.
//
// A job that failed for good gets one comment on its pull request: `jobs.failure_noticed_at`.
// A pull request whose job waits in the queue for too long gets one comment too (REV-52, queued.ts).
import type { Icons } from '@kento-review/engine/render'
import type { ResolvePayload, ReviewPayload } from '@kento-review/protocol'
import type postgres from 'postgres'

import { DOCS_PATH } from '../commands/hint.ts'
import { readJobAssignment, readUnreadPathRules } from '../assignment/model.ts'
import { react, type Reaction } from '../commands/handler.ts'
import { jsonOf } from '../db/rows.ts'
import { askForFeedback } from '../feedback/github.ts'
import { PUBLISH_MAX_AGE } from '../db/webhook-store.ts'
import { claimRejectHint, createFindingsLedger, markFixedByResolve, releaseRejectHint } from '../findings/ledger.ts'
import { sweepReactions } from '../findings/reactions.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
import { publishResolution, type ResolveHints } from '../resolve/publish.ts'
import { pageRoutes } from '../routes.ts'
import { ONLINE_SECONDS } from '../runner/admin.ts'
import { failedCheck, failureComment } from './failure.ts'
import { createGitHub, GitHubError, type GitHub } from './github.ts'
import { botReviewState, checkName, hasCheck, postReusedCheck, PR_ICONS_PATH, publishReview, publishUnchanged } from './publish.ts'
import type { StoredReview } from '../runner/store.ts'
import { QUEUE_NOTICE_MAX_AGE, QUEUE_STALL_MINUTES, queuedComment, queuedMarker } from './queued.ts'

/** What the review needs: read the code and the history, write the review, the description and the label. */
export const PUBLISH_PERMISSIONS: TokenPermissions = { contents: 'read', pull_requests: 'write', issues: 'write' }
/**
 * The check run asks for its own token. GitHub refuses a token for a permission that the App does
 * not have: the review must not depend on it.
 */
export const CHECK_PERMISSIONS: TokenPermissions = { checks: 'write' }

/** REV-16. The 👎 of the open findings are read this often, besides before each review. */
const REACTION_SWEEP_MS = 5 * 60_000

/** A review older than this is not published any more: its pull request has moved on. */
const MAX_AGE = PUBLISH_MAX_AGE
/** The tries of one review in one process. A failure after the review is on GitHub never retries. */
const MAX_TRIES = 3
/** One publisher at a time across the containers of the service (a deploy runs two for a while). */
const LOCK_KEY = 0x6b656e74 // "kent"

export interface PublisherDependencies {
  sql: postgres.Sql
  mintInstallationToken: MintInstallationToken
  /** The REST API of GitHub, `https://api.github.com`, or a fake in a test. */
  apiUrl: string
  /** The site of GitHub, for the links of the description. */
  webUrl?: string
  /** The login of the App on GitHub. */
  botLogin: string
  /** The origin of Kentō, for the link to the config in the comment of a failed job. Null: no link. */
  publicUrl?: URL | null
  fetch?: typeof globalThis.fetch
  /** How often the timer looks for a review to publish. */
  intervalMs?: number
  /** REV-16. How often the publisher reads the 👎 of the open findings. 0: at each run. */
  reactionSweepMs?: number
}

export type PublishResult =
  | { kind: 'published'; reviewId: string; githubReviewId: number }
  | { kind: 'skipped'; reviewId: string; reason: 'closed' | 'superseded' | 'suspended' }
  | { kind: 'failed'; reviewId: string; error: string }

type Pending = {
  id: string
  repoId: string
  prNumber: number
  headSha: string
  result: ReviewPayload | string
  fullName: string
  githubRepoId: string | number
  installationId: string | number
  suspended: boolean
  /** The comment of the command that asked for the review, or null for the review of a push. */
  commentId: string | number | null
  /** REV-21. `jobs.config`, with the assignment rule of a push. */
  jobConfig: unknown
}

/** A job of a command that ended without a review: it failed, or a newer push cancelled it. */
type EndedCommand = {
  id: string
  state: string
  commentId: string | number
  fullName: string
  githubRepoId: string | number
  installationId: string | number
}

/** A job that failed after its last attempt: the publisher tells its pull request why, once. */
type FailedJobRow = {
  id: string
  kind: 'review' | 'resolve'
  level: string
  prNumber: number
  headSha: string
  failureReason: string | null
  commentId: string | number | null
  repoId: string
  fullName: string
  githubRepoId: string | number
  installationId: string | number
}

/** REV-52. A pull request whose oldest waiting job waits for too long, and the runners that could take it. */
type StalledPull = {
  repoId: string
  prNumber: number
  kind: 'review' | 'resolve'
  level: string
  headSha: string
  waitingSince: Date | string
  count: string | number
  fullName: string
  githubRepoId: string | number
  installationId: string | number
  /** The runners that could run the job and called within ONLINE_SECONDS. */
  online: string | number
  /** The last call of one of these runners, online or not. */
  lastSeenAt: Date | string | null
}

/** REV-52. The comment of the queue of a pull request, as `queue_notices` keeps it. */
type QueueNotice = {
  repoId: string
  prNumber: number
  commentId: string | number | null
  body: string | null
  gone: boolean
  fullName: string
  githubRepoId: string | number
  installationId: string | number
  suspended: boolean
  /** The row was last written more than a day ago. */
  stale: boolean
}

/** The reaction to the comment of a command. On a pull request, GitHub needs `pull_requests: write`. */
const REACTION_PERMISSIONS: TokenPermissions = { pull_requests: 'write', issues: 'write' }

/**
 * Read the threads, reply in them, post the summary and react. `contents: read` because GitHub gives
 * the `originalCommit` of a comment only to a token that can read the contents.
 */
export const RESOLVE_PERMISSIONS: TokenPermissions = { contents: 'read', pull_requests: 'write', issues: 'write' }
/**
 * GitHub resolves a review thread only for a token that can write the contents. The service asks for
 * it only here, for this repository, at the moment it resolves; never for a runner.
 */
export const RESOLVE_THREAD_PERMISSIONS: TokenPermissions = { contents: 'write', pull_requests: 'write' }

/** A resolution that the publisher has just taken: its row is already marked published. */
type PendingResolution = {
  id: string
  jobId: string
  prNumber: number
  headSha: string
  result: ResolvePayload | string
  fullName: string
  githubRepoId: string | number
  installationId: string | number
  suspended: boolean
  commentId: string | number | null
}

export interface Publisher {
  /** Publishes every pending review, oldest first. Returns what happened to each. */
  publishPending(): Promise<PublishResult[]>
  /** Runs `publishPending` soon. Never throws. */
  wake(): void
  start(): void
  stop(): Promise<void>
}

/** REV-89. A publication that stopped before it wrote anything, on a failure of GitHub: it uses no try. */
class NoTryUsed extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause })
  }
}

export function createPublisher(deps: PublisherDependencies): Publisher {
  let webUrl = (deps.webUrl ?? 'https://github.com').replace(/\/+$/, '')
  // REV-96. The page of the commands, linked in the comment of each finding and in the hint of `reject`.
  let docsUrl = deps.publicUrl ? new URL(DOCS_PATH, deps.publicUrl).toString() : null
  // REV-106. The icons of the texts on GitHub, served from public/assets/pr. Without a public URL, the alt text.
  let icons: Icons = deps.publicUrl ? { base: new URL(PR_ICONS_PATH, deps.publicUrl).toString() } : 'text'
  let tries = new Map<string, number>()
  let exhausted = () => [...tries].filter(([, n]) => n >= MAX_TRIES).map(([id]) => id)
  let running: Promise<unknown> | null = null
  let again = false
  let timer: NodeJS.Timeout | null = null
  let lastReactionSweep = 0

  async function publishOne(row: Pending): Promise<PublishResult> {
    let review = jsonOf<StoredReview>(row.result)
    let [owner, name] = row.fullName.split('/') as [string, string]
    let github: GitHub | null = null
    let skip = async (reason: 'closed' | 'superseded' | 'suspended'): Promise<PublishResult> => {
      await deps.sql`update reviews set published_at = now() where id = ${row.id} and published_at is null`
      log('info', 'review.publication_skipped', { reviewId: row.id, repo: row.fullName, pr: row.prNumber, head: row.headSha, reason })
      // The command that asked for this review gets 😕: its review will not come.
      if (github) await answerCommand(github, row, 'confused')
      return { kind: 'skipped', reviewId: row.id, reason }
    }
    if (row.suspended) return skip('suspended')

    let target = { installationId: Number(row.installationId), githubRepoId: Number(row.githubRepoId) }
    let token = await deps.mintInstallationToken({ ...target, permissions: PUBLISH_PERMISSIONS })
    github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })

    // A newer push cancels the job of the previous head; a review that came back before the cancel
    // is not published either. The workflow did the same: a push cancelled the run in progress.
    let pr: { state: string; head: { sha: string }; user?: { login?: string } | null } = await github.rest('GET', `/repos/${owner}/${name}/pulls/${row.prNumber}`)
    if (pr.state !== 'open') return skip('closed')
    if (pr.head.sha !== row.headSha) return skip('superseded')

    let checks: GitHub | null = null
    try {
      let checkToken = await deps.mintInstallationToken({ ...target, permissions: CHECK_PERMISSIONS })
      checks = createGitHub({ apiUrl: deps.apiUrl, token: checkToken.token, fetch: deps.fetch })
    } catch (error) {
      log('warn', 'review.check_token_refused', { reviewId: row.id, error: errorMessage(error) })
    }

    // REV-89. The review of an earlier head with the same input: the block, the label and the check.
    // REV-101: and a review on the head, with the same score and verdict.
    let on = { owner, name, pr: row.prNumber, botLogin: deps.botLogin, webUrl, icons }
    let source: 'stands' | 'replaced' | 'gone' = 'stands'
    if (review.reusedFrom) {
      try {
        source = await botReviewState(github, on, review.reusedFrom.githubReviewId)
      } catch (error) {
        // Nothing is written yet: a failure of GitHub here costs no try of the review.
        throw new NoTryUsed(error)
      }
    }
    // A later review of the bot is on the pull request: the copy would write over its block. The head
    // still gets its check when that review was of another head, so that it is never left without one.
    if (source === 'replaced') {
      if (checks && review.reusedFrom) {
        let { head } = review.reusedFrom
        await postReusedCheck(checks, on, review, head).catch((error) =>
          log('warn', 'publish.step_failed', { reviewId: row.id, step: 'check', error: String(error) }),
        )
      }
      return skip('superseded')
    }
    if (review.reusedFrom && source === 'gone') {
      // The review of the earlier head is gone from GitHub, or a person dismissed it: the copy is
      // posted as a review of its own, with its comments.
      log('warn', 'review.reuse_source_gone', { reviewId: row.id, repo: row.fullName, pr: row.prNumber, githubReviewId: review.reusedFrom.githubReviewId })
      let { reusedFrom: _gone, ...own } = review
      review = own
      // The row is a review of its own from now on: the next copy takes it as its source.
      await deps.sql`update reviews set result = result - 'reusedFrom' where id = ${row.id}`
    }
    if (review.reusedFrom) {
      let from = review.reusedFrom
      let out = await publishUnchanged(github, on, review, from.head, {
        checks,
        findings: createFindingsLedger(deps.sql, { repoId: row.repoId, prNumber: row.prNumber, reviewId: row.id, head: row.headSha }),
        headReview: { sourceId: from.githubReviewId, marker: row.id },
        warn: (event, fields) => log('warn', event, { reviewId: row.id, ...fields }),
      })
      // The review with the findings is the one of the earlier head: the next copy reads it. The review
      // on the head (REV-101) is kept beside it, for a `reject` on the head and for the command limit.
      await deps.sql`
        update reviews set published_at = now(), github_review_id = ${from.githubReviewId},
          result = result || jsonb_build_object('headReviewId', ${out.headReviewId}::bigint)
        where id = ${row.id}`
      log('info', 'review.republished', {
        reviewId: row.id,
        repo: row.fullName,
        pr: row.prNumber,
        head: row.headSha,
        of: from.head,
        githubReviewId: from.githubReviewId,
        headReviewId: out.headReviewId,
        score: out.score,
        findings: out.shown,
        check: checks !== null,
      })
      await answerCommand(github, row, 'rocket')
      await askFeedback(github, row, pr.user?.login ?? null)
      return { kind: 'published', reviewId: row.id, githubReviewId: from.githubReviewId }
    }

    let githubReviewId = 0
    let outcome = await publishReview(
      github,
      { owner, name, pr: row.prNumber, botLogin: deps.botLogin, webUrl, docsUrl, icons },
      review,
      {
        checks,
        async threadWriter() {
          try {
            let writeToken = await deps.mintInstallationToken({ ...target, permissions: RESOLVE_THREAD_PERMISSIONS })
            return createGitHub({ apiUrl: deps.apiUrl, token: writeToken.token, fetch: deps.fetch })
          } catch (error) {
            // The App does not have `contents: write`: the reply in the thread says that a person can resolve it.
            log('warn', 'review.write_token_refused', { reviewId: row.id, error: errorMessage(error) })
            return null
          }
        },
        marker: row.id,
        assignment: readJobAssignment(row.jobConfig),
        assignmentUnread: readUnreadPathRules(row.jobConfig),
        async onPosted(id) {
          githubReviewId = id
          await deps.sql`
            update reviews set published_at = now(), github_review_id = ${id}
            where id = ${row.id}`
        },
        findings: createFindingsLedger(deps.sql, { repoId: row.repoId, prNumber: row.prNumber, reviewId: row.id, head: row.headSha }),
        warn: (event, fields) => log('warn', event, { reviewId: row.id, ...fields }),
      },
    )
    log('info', 'review.published', {
      reviewId: row.id,
      repo: row.fullName,
      pr: row.prNumber,
      head: row.headSha,
      githubReviewId,
      state: outcome.state,
      score: outcome.score,
      inline: outcome.inline,
      resolved: outcome.resolved,
      fixed: outcome.fixed,
      suppressed: outcome.suppressed,
      check: checks !== null,
    })
    await answerCommand(github, row, 'rocket')
    await askFeedback(github, row, pr.user?.login ?? null)
    return { kind: 'published', reviewId: row.id, githubReviewId }
  }

  /**
   * REV-107. The request for feedback, once per pull request, after its third published review. A
   * failure is logged and never throws: the review is already on GitHub.
   */
  async function askFeedback(github: GitHub, row: Pending, author: string | null) {
    try {
      let commentId = await askForFeedback(deps.sql, github, { repoId: row.repoId, fullName: row.fullName, prNumber: row.prNumber, author })
      if (commentId !== null) log('info', 'feedback.requested', { reviewId: row.id, repo: row.fullName, pr: row.prNumber, author, commentId })
    } catch (error) {
      log('warn', 'feedback.request_failed', { reviewId: row.id, repo: row.fullName, pr: row.prNumber, error: errorMessage(error).slice(0, 500) })
    }
  }

  /**
   * The last reaction on the comment of a command, once. A failure is logged and never throws: the
   * review is already on GitHub, and a second try would post it again.
   */
  async function answerCommand(github: GitHub, row: { id: string; fullName: string; commentId: string | number | null }, content: Reaction) {
    if (row.commentId === null) return
    try {
      await react(github, row.fullName, Number(row.commentId), content)
    } catch (error) {
      log('warn', 'command.reaction_failed', { reviewId: row.id, commentId: Number(row.commentId), content, error: errorMessage(error) })
    }
    await deps.sql`
      update jobs set command_answered_at = now()
      where id = (select job_id from reviews where id = ${row.id}) and command_answered_at is null`
  }

  /**
   * Publishes the resolutions, at most once each: the row is marked before anything is posted, so a
   * failure in the middle (a restart, an outage of GitHub) never posts the replies twice. The
   * comment of the command gets 🚀 after the summary, or 😕 when the publication stops.
   */
  async function publishResolutions(connection: postgres.ReservedSql) {
    let rows = await connection<PendingResolution[]>`
      with taken as (
        update resolutions set published_at = now()
        where id in (
          select id from resolutions
          where published_at is null and created_at > now() - ${MAX_AGE}::interval
          order by created_at
          limit 20
        )
        returning id, job_id, pr_number, head_sha, result
      )
      select taken.id, taken.job_id as "jobId", taken.pr_number as "prNumber", taken.head_sha as "headSha",
        taken.result, repos.full_name as "fullName", repos.github_repo_id as "githubRepoId",
        installations.github_installation_id as "installationId", installations.suspended_at is not null as suspended,
        jobs.github_comment_id as "commentId"
      from taken
      join jobs on jobs.id = taken.job_id
      join repos on repos.id = jobs.repo_id
      join installations on installations.id = repos.installation_id`
    for (let row of rows) {
      let fields = { resolutionId: row.id, jobId: row.jobId, repo: row.fullName, pr: row.prNumber, head: row.headSha }
      let payload = jsonOf<ResolvePayload>(row.result)
      let github: GitHub | null = null
      let answer = async (content: Reaction) => {
        if (github && row.commentId !== null) {
          await react(github, row.fullName, Number(row.commentId), content).catch((error) =>
            log('warn', 'command.reaction_failed', { ...fields, content, error: errorMessage(error) }),
          )
        }
        await connection`update jobs set command_answered_at = now() where id = ${row.jobId}`
      }
      try {
        if (row.suspended) {
          log('info', 'resolve.publication_skipped', { ...fields, reason: 'suspended' })
          await answer('confused')
          continue
        }
        let target = { installationId: Number(row.installationId), githubRepoId: Number(row.githubRepoId) }
        let token = await deps.mintInstallationToken({ ...target, permissions: RESOLVE_PERMISSIONS })
        github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
        let pr: { state: string; head: { sha: string } } = await github.rest('GET', `/repos/${row.fullName}/pulls/${row.prNumber}`)
        if (pr.state !== 'open' || pr.head.sha !== row.headSha) {
          let reason = pr.state !== 'open' ? 'closed' : 'superseded'
          log('info', 'resolve.publication_skipped', { ...fields, reason })
          await answer('confused')
          continue
        }
        let writer: GitHub | null = null
        if (payload.threads.some((t) => t.verdict !== 'open')) {
          try {
            let writeToken = await deps.mintInstallationToken({ ...target, permissions: RESOLVE_THREAD_PERMISSIONS })
            writer = createGitHub({ apiUrl: deps.apiUrl, token: writeToken.token, fetch: deps.fetch })
          } catch (error) {
            // The App does not have `contents: write` yet: the replies say that a person can resolve.
            log('warn', 'resolve.write_token_refused', { ...fields, error: errorMessage(error) })
          }
        }
        let outcome = await publishResolution(
          github,
          writer,
          { fullName: row.fullName, pr: row.prNumber, webUrl, icons },
          payload,
          (event, extra) => log('warn', event, { ...fields, ...extra }),
          resolveHints(connection, row, docsUrl),
        )
        log('info', 'resolve.published', { ...fields, ...outcome, costUsd: payload.costUsd })
        await answer('rocket')
      } catch (error) {
        log('error', 'resolve.publication_failed', { ...fields, error: errorMessage(error).slice(0, 500) })
        await answer('confused').catch((answerError) =>
          log('warn', 'resolve.answer_failed', { ...fields, error: errorMessage(answerError) }),
        )
      }
    }
  }

  /**
   * 😕 on the comment of each command whose job ended without a review: failed after its last
   * attempt, or cancelled by a newer push, a close or the installation. Once per job.
   */
  async function answerEndedCommands(connection: postgres.ReservedSql) {
    let rows = await connection<EndedCommand[]>`
      select jobs.id, jobs.state, jobs.github_comment_id as "commentId", repos.full_name as "fullName",
        repos.github_repo_id as "githubRepoId", installations.github_installation_id as "installationId"
      from jobs
      join repos on repos.id = jobs.repo_id
      join installations on installations.id = repos.installation_id
      where jobs.github_comment_id is not null and jobs.command_answered_at is null
        and jobs.state in ('failed', 'cancelled') and jobs.finished_at > now() - ${MAX_AGE}::interval
        and installations.suspended_at is null
      order by jobs.finished_at
      limit 20`
    for (let row of rows) {
      try {
        let token = await deps.mintInstallationToken({
          installationId: Number(row.installationId),
          githubRepoId: Number(row.githubRepoId),
          permissions: REACTION_PERMISSIONS,
        })
        let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
        await react(github, row.fullName, Number(row.commentId), 'confused')
        log('info', 'command.ended_without_review', { jobId: row.id, state: row.state, repo: row.fullName, commentId: Number(row.commentId) })
      } catch (error) {
        // One try: the comment may be gone. The job keeps its state either way.
        log('warn', 'command.reaction_failed', { jobId: row.id, commentId: Number(row.commentId), content: 'confused', error: errorMessage(error) })
      }
      await connection`update jobs set command_answered_at = now() where id = ${row.id}`
    }
  }

  /**
   * One comment on the pull request of each job that failed after its last attempt: why, and how to
   * run it again. The row is marked before the comment, so a failure in the middle never posts it
   * twice. No comment when the pull request is closed or a newer push moved its head.
   */
  async function noticeFailedJobs(connection: postgres.ReservedSql) {
    let rows = await connection<FailedJobRow[]>`
      with taken as (
        update jobs set failure_noticed_at = now()
        where id in (
          select jobs.id from jobs
          join repos on repos.id = jobs.repo_id
          join installations on installations.id = repos.installation_id
          where jobs.state = 'failed' and jobs.failure_noticed_at is null
            and jobs.finished_at > now() - ${MAX_AGE}::interval and installations.suspended_at is null
          order by jobs.finished_at
          limit 20
        )
        returning id, kind, level, pr_number, head_sha, failure_reason, github_comment_id, repo_id
      )
      select taken.id, taken.kind, taken.level, taken.pr_number as "prNumber", taken.head_sha as "headSha",
        taken.failure_reason as "failureReason", taken.github_comment_id as "commentId", taken.repo_id as "repoId",
        repos.full_name as "fullName", repos.github_repo_id as "githubRepoId", installations.github_installation_id as "installationId"
      from taken
      join repos on repos.id = taken.repo_id
      join installations on installations.id = repos.installation_id`
    for (let row of rows) {
      let fields = { jobId: row.id, kind: row.kind, repo: row.fullName, pr: row.prNumber, head: row.headSha }
      try {
        let token = await deps.mintInstallationToken({
          installationId: Number(row.installationId),
          githubRepoId: Number(row.githubRepoId),
          permissions: REACTION_PERMISSIONS,
        })
        let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
        let pr: { state: string; head: { sha: string } } = await github.rest('GET', `/repos/${row.fullName}/pulls/${row.prNumber}`)
        if (pr.state !== 'open' || pr.head.sha !== row.headSha) {
          log('info', 'job.failure_notice_skipped', { ...fields, reason: pr.state !== 'open' ? 'closed' : 'superseded' })
          continue
        }
        let commenter: string | null = null
        if (row.commentId !== null) {
          try {
            let comment: { user: { login: string } | null } = await github.rest('GET', `/repos/${row.fullName}/issues/comments/${row.commentId}`)
            commenter = comment.user?.login ?? null
          } catch (error) {
            log('warn', 'job.failure_commenter_unknown', { ...fields, commentId: Number(row.commentId), error: errorMessage(error) })
          }
        }
        let configUrl = deps.publicUrl ? new URL(pageRoutes.repoConfig.href({ id: row.repoId }), deps.publicUrl).toString() : null
        let body = failureComment({ ...row, commenter, configUrl })
        await github.rest('POST', `/repos/${row.fullName}/issues/${row.prNumber}/comments`, { body })
        let check = row.kind === 'review' ? await postFailedCheck(row, { ...row, commenter, configUrl }) : null
        log('info', 'job.failure_noticed', { ...fields, command: row.commentId !== null, check })
      } catch (error) {
        // One try: the row is already marked.
        log('warn', 'job.failure_notice_failed', { ...fields, error: errorMessage(error).slice(0, 500) })
      }
    }
  }

  /**
   * KNT-161. The check run of a failed review, when its head has no check of Kentō: without it, the
   * check stays missing or shows the review of an earlier head. A head that another review already
   * checked keeps that check. Returns the conclusion posted, or null. A failure is logged only.
   */
  async function postFailedCheck(row: FailedJobRow, job: Parameters<typeof failedCheck>[0]): Promise<string | null> {
    try {
      let token = await deps.mintInstallationToken({
        installationId: Number(row.installationId),
        githubRepoId: Number(row.githubRepoId),
        permissions: CHECK_PERMISSIONS,
      })
      let checks = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
      let repo = `/repos/${row.fullName}`
      if (await hasCheck(checks, repo, row.headSha, deps.botLogin)) return null
      let check = failedCheck(job)
      await checks.rest('POST', `${repo}/check-runs`, {
        name: checkName(),
        head_sha: row.headSha,
        status: 'completed',
        conclusion: check.conclusion,
        details_url: `${(deps.webUrl ?? 'https://github.com').replace(/\/+$/, '')}/${row.fullName}/pull/${row.prNumber}`,
        output: { title: check.title, summary: check.summary },
      })
      return check.conclusion
    } catch (error) {
      log('warn', 'job.failure_check_failed', { jobId: row.id, repo: row.fullName, pr: row.prNumber, error: errorMessage(error).slice(0, 500) })
      return null
    }
  }

  async function githubOf(row: { installationId: string | number; githubRepoId: string | number }): Promise<GitHub> {
    let token = await deps.mintInstallationToken({
      installationId: Number(row.installationId),
      githubRepoId: Number(row.githubRepoId),
      permissions: REACTION_PERMISSIONS,
    })
    return createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
  }

  /** The comment of the App that carries `marker` on the pull request, or null. Reads 1000 comments at most. */
  async function findComment(github: GitHub, fullName: string, prNumber: number, marker: string): Promise<number | null> {
    for (let page = 1; page <= 10; page++) {
      let comments: { id: number; body: string | null; user: { login: string } | null }[] =
        (await github.rest('GET', `/repos/${fullName}/issues/${prNumber}/comments?per_page=100&page=${page}`)) ?? []
      let found = comments.find((c) => c.user?.login === deps.botLogin && (c.body ?? '').includes(marker))
      if (found) return found.id
      if (comments.length < 100) return null
    }
    log('warn', 'job.queue_notice_search_capped', { repo: fullName, pr: prNumber, read: 1000 })
    return null
  }

  /**
   * REV-52. Brings the comments of the queue in line with the queue: one comment per pull request
   * whose oldest waiting job waits for more than QUEUE_STALL_MINUTES, and none on the others.
   *
   * The state is the row of `queue_notices` (one per pull request, its primary key), never the jobs:
   * a claim, an expired lease, a requeue or a cancel changes the jobs, and the next run reads them
   * again. Each step is safe to repeat. A comment posted with no answer is found again by its
   * marker before any new post, and a delete that GitHub answers 404 is done. A failure of GitHub
   * leaves the row as it was, and the next run (30 s) tries again.
   */
  async function syncQueueNotices(connection: postgres.ReservedSql) {
    // First the comments of the pull requests where no job waits for too long any more.
    let ended = await connection<QueueNotice[]>`
      select qn.repo_id as "repoId", qn.pr_number as "prNumber", qn.github_comment_id as "commentId", qn.body,
        qn.gone_at is not null as gone, repos.full_name as "fullName", repos.github_repo_id as "githubRepoId",
        installations.github_installation_id as "installationId", installations.suspended_at is not null as suspended,
        qn.updated_at < now() - interval '1 day' as stale
      from queue_notices qn
      join repos on repos.id = qn.repo_id
      join installations on installations.id = repos.installation_id
      where not exists (
        select 1 from jobs
        where jobs.repo_id = qn.repo_id and jobs.pr_number = qn.pr_number and jobs.state = 'queued' and jobs.base_ref is not null
          and coalesce(jobs.not_before, jobs.created_at) < now() - ${`${QUEUE_STALL_MINUTES} minutes`}::interval
          and coalesce(jobs.not_before, jobs.created_at) > now() - ${QUEUE_NOTICE_MAX_AGE}::interval
      ) or installations.suspended_at is not null
      order by qn.updated_at
      limit 20`
    for (let row of ended) {
      let fields = { repo: row.fullName, pr: row.prNumber }
      try {
        if (!row.gone && !row.suspended) {
          let github = await githubOf(row)
          let marker = queuedMarker(row.repoId, row.prNumber)
          let id = row.commentId === null ? await findComment(github, row.fullName, row.prNumber, marker) : Number(row.commentId)
          if (id !== null) {
            try {
              await github.rest('DELETE', `/repos/${row.fullName}/issues/comments/${id}`)
            } catch (error) {
              // Already deleted, by a person or by an earlier try with no answer: done.
              if (!(error instanceof GitHubError && error.status === 404)) throw error
            }
          }
          log('info', 'job.queue_notice_removed', { ...fields, commentId: id })
        }
      } catch (error) {
        log('warn', 'job.queue_notice_remove_failed', { ...fields, error: errorMessage(error).slice(0, 500) })
        // A comment that GitHub refuses to delete for a day is left there.
        if (!row.stale) continue
      }
      await connection`delete from queue_notices where repo_id = ${row.repoId} and pr_number = ${row.prNumber}`
    }

    // Then one comment on each pull request whose oldest waiting job waits for too long.
    let stalled = await connection<StalledPull[]>`
      with waiting as (
        select jobs.repo_id, jobs.pr_number, jobs.kind, jobs.level, jobs.head_sha,
          coalesce(jobs.not_before, jobs.created_at) as since,
          row_number() over (partition by jobs.repo_id, jobs.pr_number order by coalesce(jobs.not_before, jobs.created_at), jobs.id) as n,
          count(*) over (partition by jobs.repo_id, jobs.pr_number) as count
        from jobs
        join repos on repos.id = jobs.repo_id
        join installations on installations.id = repos.installation_id
        where jobs.state = 'queued' and jobs.base_ref is not null
          and coalesce(jobs.not_before, jobs.created_at) < now() - ${`${QUEUE_STALL_MINUTES} minutes`}::interval
          and coalesce(jobs.not_before, jobs.created_at) > now() - ${QUEUE_NOTICE_MAX_AGE}::interval
          and installations.suspended_at is null
      )
      select w.repo_id as "repoId", w.pr_number as "prNumber", w.kind, w.level, w.head_sha as "headSha",
        w.since as "waitingSince", w.count,
        repos.full_name as "fullName", repos.github_repo_id as "githubRepoId", installations.github_installation_id as "installationId",
        runner_state.online, runner_state.last_seen as "lastSeenAt"
      from waiting w
      join repos on repos.id = w.repo_id
      join installations on installations.id = repos.installation_id
      -- The runners that could take the job: of its org or of the service, in the pool of the repository.
      cross join lateral (
        select count(*) filter (where runners.last_seen_at >= now() - ${`${ONLINE_SECONDS} seconds`}::interval) as online,
          max(runners.last_seen_at) as last_seen
        from runners
        where (runners.org_id = repos.org_id or runners.org_id is null) and runners.revoked_at is null
          and (repos.default_runner_pool is null or repos.default_runner_pool = any(runners.labels))
      ) runner_state
      where w.n = 1
      order by w.since
      limit 20`
    for (let pull of stalled) {
      let fields = { repo: pull.fullName, pr: pull.prNumber, head: pull.headSha, level: pull.level }
      try {
        await connection`
          insert into queue_notices (repo_id, pr_number) values (${pull.repoId}, ${pull.prNumber})
          on conflict (repo_id, pr_number) do nothing`
        let [row] = await connection<{ commentId: string | number | null; body: string | null; gone: boolean }[]>`
          select github_comment_id as "commentId", body, gone_at is not null as gone
          from queue_notices where repo_id = ${pull.repoId} and pr_number = ${pull.prNumber}`
        if (!row || row.gone) continue
        let online = Number(pull.online)
        let lastSeenAt = pull.lastSeenAt === null ? null : new Date(pull.lastSeenAt)
        let cause = online === 0 ? ({ kind: 'no_runner', lastSeenAt } as const) : ({ kind: 'not_taken', online } as const)
        let runnersUrl = deps.publicUrl ? new URL(pageRoutes.runners.href(), deps.publicUrl).toString() : null
        let body = queuedComment({ ...pull, waitingSince: new Date(pull.waitingSince), count: Number(pull.count), cause, runnersUrl })
        if (row.commentId !== null && row.body === body) continue
        let github = await githubOf(pull)
        let id = row.commentId === null ? await findComment(github, pull.fullName, pull.prNumber, queuedMarker(pull.repoId, pull.prNumber)) : Number(row.commentId)
        if (id === null) {
          let pr: { state: string; head: { sha: string } } = await github.rest('GET', `/repos/${pull.fullName}/pulls/${pull.prNumber}`)
          if (pr.state !== 'open' || pr.head.sha !== pull.headSha) {
            // Nothing to show there: the row stays, marked, until no job of the pull request waits.
            log('info', 'job.queue_notice_skipped', { ...fields, reason: pr.state !== 'open' ? 'closed' : 'superseded' })
            await connection`update queue_notices set gone_at = now(), updated_at = now() where repo_id = ${pull.repoId} and pr_number = ${pull.prNumber}`
            continue
          }
          let posted: { id: number } = await github.rest('POST', `/repos/${pull.fullName}/issues/${pull.prNumber}/comments`, { body })
          id = posted.id
        } else {
          try {
            await github.rest('PATCH', `/repos/${pull.fullName}/issues/comments/${id}`, { body })
          } catch (error) {
            if (!(error instanceof GitHubError && error.status === 404)) throw error
            // A person deleted it: not posted again while a job of the pull request waits.
            log('info', 'job.queue_notice_gone', fields)
            await connection`update queue_notices set gone_at = now(), updated_at = now() where repo_id = ${pull.repoId} and pr_number = ${pull.prNumber}`
            continue
          }
        }
        await connection`
          update queue_notices set github_comment_id = ${id}, body = ${body}, updated_at = now()
          where repo_id = ${pull.repoId} and pr_number = ${pull.prNumber}`
        log('warn', 'job.queue_noticed', { ...fields, commentId: id, count: Number(pull.count), cause: cause.kind, online, lastSeenAt: lastSeenAt?.toISOString() ?? null })
      } catch (error) {
        // The row keeps what GitHub had before: the next run tries again.
        log('warn', 'job.queue_notice_failed', { ...fields, error: errorMessage(error).slice(0, 500) })
      }
    }
  }

  async function publishPending(): Promise<PublishResult[]> {
    let connection = await deps.sql.reserve()
    try {
      let [lock] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(${LOCK_KEY}) as locked`
      if (!lock?.locked) return []
      try {
        let rows = await connection<Pending[]>`
          select reviews.id, reviews.repo_id as "repoId", reviews.pr_number as "prNumber", reviews.head_sha as "headSha", reviews.result,
            repos.full_name as "fullName", repos.github_repo_id as "githubRepoId",
            installations.github_installation_id as "installationId", installations.suspended_at is not null as suspended,
            jobs.github_comment_id as "commentId", jobs.config as "jobConfig"
          from reviews
          join jobs on jobs.id = reviews.job_id
          join repos on repos.id = reviews.repo_id
          join installations on installations.id = repos.installation_id
          where reviews.published_at is null and reviews.created_at > now() - ${MAX_AGE}::interval
            -- The rows that this process gave up on do not hold the limit.
            and not (reviews.id = any(${exhausted()}::uuid[]))
          order by reviews.created_at
          limit 20`
        let results: PublishResult[] = []
        for (let row of rows) {
          // A review posted by an earlier try and not marked is found again by its marker: the try
          // marks it and posts nothing.
          if ((tries.get(row.id) ?? 0) >= MAX_TRIES) continue
          tries.set(row.id, (tries.get(row.id) ?? 0) + 1)
          try {
            results.push(await publishOne(row))
            tries.delete(row.id)
          } catch (error) {
            // REV-89. A failure before anything is written gives the try back; MAX_AGE still ends it.
            if (error instanceof NoTryUsed) tries.set(row.id, (tries.get(row.id) ?? 1) - 1)
            let message = errorMessage(error).slice(0, 500)
            log('error', 'review.publication_failed', {
              reviewId: row.id,
              repo: row.fullName,
              pr: row.prNumber,
              try: tries.get(row.id),
              error: message,
            })
            results.push({ kind: 'failed', reviewId: row.id, error: message })
          }
        }
        try {
          await publishResolutions(connection)
        } catch (error) {
          log('error', 'resolve.publisher_failed', { error: errorMessage(error) })
        }
        try {
          await answerEndedCommands(connection)
        } catch (error) {
          log('error', 'command.answers_failed', { error: errorMessage(error) })
        }
        if (Date.now() - lastReactionSweep >= (deps.reactionSweepMs ?? REACTION_SWEEP_MS)) {
          lastReactionSweep = Date.now()
          try {
            let swept = await sweepReactions(deps.sql, deps)
            if (swept.dismissed) log('info', 'findings.reaction_sweep', swept)
          } catch (error) {
            log('error', 'findings.reaction_sweep_failed', { error: errorMessage(error) })
          }
        }
        try {
          await noticeFailedJobs(connection)
        } catch (error) {
          log('error', 'job.failure_notices_failed', { error: errorMessage(error) })
        }
        try {
          await syncQueueNotices(connection)
        } catch (error) {
          log('error', 'job.queue_notices_failed', { error: errorMessage(error) })
        }
        return results
      } finally {
        await connection`select pg_advisory_unlock(${LOCK_KEY})`
      }
    } finally {
      connection.release()
    }
  }

  function wake() {
    if (running) {
      again = true
      return
    }
    running = publishPending()
      .catch((error) => log('error', 'review.publisher_failed', { error: errorMessage(error) }))
      .finally(() => {
        running = null
        if (again) {
          again = false
          wake()
        }
      })
  }

  return {
    publishPending,
    wake,
    start() {
      if (timer) return
      timer = setInterval(wake, deps.intervalMs ?? 30_000)
      timer.unref()
      wake()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      again = false
      await running
    },
  }
}

/** REV-116. The hints of a resolution: the findings of its pull request, and their claims. */
function resolveHints(sql: postgres.ISql, row: { githubRepoId: number | string; prNumber: number }, docsUrl: string | null): ResolveHints {
  return {
    docsUrl,
    async findingOf(commentId) {
      let [finding] = await sql<{ id: string }[]>`
        select findings.id from findings
        join repos on repos.id = findings.repo_id
        where repos.github_repo_id = ${Number(row.githubRepoId)} and findings.pr_number = ${row.prNumber}
          and findings.github_comment_id = ${commentId}
        limit 1`
      return finding?.id ?? null
    },
    claim: (findingId) => claimRejectHint(sql, findingId),
    release: (findingId) => releaseRejectHint(sql, findingId),
    markFixed: (findingId) => markFixedByResolve(sql, findingId),
  }
}
