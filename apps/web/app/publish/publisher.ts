// The publisher: it takes the reviews that the runners sent and that GitHub does not have yet, and
// publishes them with an installation token of the App. The result route wakes it; a timer also
// runs it, so that a review stored before a restart is still published.
//
// `reviews.published_at` set and `github_review_id` set: the review is on GitHub.
// `reviews.published_at` set and `github_review_id` null: the review was not published, on purpose
// (the pull request is closed, or a newer push moved its head). The log line says why.
//
// A job that failed for good gets one comment on its pull request: `jobs.failure_noticed_at`.
import type { ResolvePayload, ReviewPayload } from '@sakuga-review/protocol'
import type postgres from 'postgres'

import { react, type Reaction } from '../commands/handler.ts'
import { PUBLISH_MAX_AGE } from '../db/webhook-store.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
import { publishResolution } from '../resolve/publish.ts'
import { pageRoutes } from '../routes.ts'
import { failureComment } from './failure.ts'
import { createGitHub, type GitHub } from './github.ts'
import { publishReview } from './publish.ts'

/** What the review needs: read the code and the history, write the review, the description and the label. */
export const PUBLISH_PERMISSIONS: TokenPermissions = { contents: 'read', pull_requests: 'write', issues: 'write' }
/**
 * The check run asks for its own token. GitHub refuses a token for a permission that the App does
 * not have: the review must not depend on it.
 */
export const CHECK_PERMISSIONS: TokenPermissions = { checks: 'write' }

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
}

export type PublishResult =
  | { kind: 'published'; reviewId: string; githubReviewId: number }
  | { kind: 'skipped'; reviewId: string; reason: 'closed' | 'superseded' | 'suspended' }
  | { kind: 'failed'; reviewId: string; error: string }

type Pending = {
  id: string
  prNumber: number
  headSha: string
  result: ReviewPayload | string
  fullName: string
  githubRepoId: string | number
  installationId: string | number
  suspended: boolean
  /** The comment of the command that asked for the review, or null for the review of a push. */
  commentId: string | number | null
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

/** The reaction to the comment of a command. On a pull request, GitHub needs `pull_requests: write`. */
const REACTION_PERMISSIONS: TokenPermissions = { pull_requests: 'write', issues: 'write' }

/** Read the threads, reply in them, post the summary and react: no `contents`. */
export const RESOLVE_PERMISSIONS: TokenPermissions = { pull_requests: 'write', issues: 'write' }
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

export function createPublisher(deps: PublisherDependencies): Publisher {
  let webUrl = (deps.webUrl ?? 'https://github.com').replace(/\/+$/, '')
  let tries = new Map<string, number>()
  let exhausted = () => [...tries].filter(([, n]) => n >= MAX_TRIES).map(([id]) => id)
  let running: Promise<unknown> | null = null
  let again = false
  let timer: NodeJS.Timeout | null = null

  async function publishOne(row: Pending): Promise<PublishResult> {
    let review: ReviewPayload = typeof row.result === 'string' ? JSON.parse(row.result) : row.result
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
    let pr: { state: string; head: { sha: string } } = await github.rest('GET', `/repos/${owner}/${name}/pulls/${row.prNumber}`)
    if (pr.state !== 'open') return skip('closed')
    if (pr.head.sha !== row.headSha) return skip('superseded')

    let checks: GitHub | null = null
    try {
      let checkToken = await deps.mintInstallationToken({ ...target, permissions: CHECK_PERMISSIONS })
      checks = createGitHub({ apiUrl: deps.apiUrl, token: checkToken.token, fetch: deps.fetch })
    } catch (error) {
      log('warn', 'review.check_token_refused', { reviewId: row.id, error: errorMessage(error) })
    }

    let githubReviewId = 0
    let outcome = await publishReview(
      github,
      { owner, name, pr: row.prNumber, botLogin: deps.botLogin, webUrl },
      review,
      {
        checks,
        marker: row.id,
        async onPosted(id) {
          githubReviewId = id
          await deps.sql`
            update reviews set published_at = now(), github_review_id = ${id}
            where id = ${row.id}`
        },
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
      check: checks !== null,
    })
    await answerCommand(github, row, 'rocket')
    return { kind: 'published', reviewId: row.id, githubReviewId }
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
  async function publishResolutions(connection: postgres.Sql) {
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
        orgs.github_installation_id as "installationId", orgs.suspended_at is not null as suspended,
        jobs.github_comment_id as "commentId"
      from taken
      join jobs on jobs.id = taken.job_id
      join repos on repos.id = jobs.repo_id
      join orgs on orgs.id = repos.org_id`
    for (let row of rows) {
      let fields = { resolutionId: row.id, jobId: row.jobId, repo: row.fullName, pr: row.prNumber, head: row.headSha }
      let payload: ResolvePayload = typeof row.result === 'string' ? JSON.parse(row.result) : row.result
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
          { fullName: row.fullName, pr: row.prNumber, webUrl },
          payload,
          (event, extra) => log('warn', event, { ...fields, ...extra }),
        )
        log('info', 'resolve.published', { ...fields, ...outcome, costUsd: payload.costUsd })
        await answer('rocket')
      } catch (error) {
        log('error', 'resolve.publication_failed', { ...fields, error: errorMessage(error).slice(0, 500) })
        await answer('confused').catch(() => {})
      }
    }
  }

  /**
   * 😕 on the comment of each command whose job ended without a review: failed after its last
   * attempt, or cancelled by a newer push, a close or the installation. Once per job.
   */
  async function answerEndedCommands(connection: postgres.Sql) {
    let rows = await connection<EndedCommand[]>`
      select jobs.id, jobs.state, jobs.github_comment_id as "commentId", repos.full_name as "fullName",
        repos.github_repo_id as "githubRepoId", orgs.github_installation_id as "installationId"
      from jobs
      join repos on repos.id = jobs.repo_id
      join orgs on orgs.id = repos.org_id
      where jobs.github_comment_id is not null and jobs.command_answered_at is null
        and jobs.state in ('failed', 'cancelled') and jobs.finished_at > now() - ${MAX_AGE}::interval
        and orgs.suspended_at is null
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
  async function noticeFailedJobs(connection: postgres.Sql) {
    let rows = await connection<FailedJobRow[]>`
      with taken as (
        update jobs set failure_noticed_at = now()
        where id in (
          select jobs.id from jobs
          join repos on repos.id = jobs.repo_id
          join orgs on orgs.id = repos.org_id
          where jobs.state = 'failed' and jobs.failure_noticed_at is null
            and jobs.finished_at > now() - ${MAX_AGE}::interval and orgs.suspended_at is null
          order by jobs.finished_at
          limit 20
        )
        returning id, kind, level, pr_number, head_sha, failure_reason, github_comment_id, repo_id
      )
      select taken.id, taken.kind, taken.level, taken.pr_number as "prNumber", taken.head_sha as "headSha",
        taken.failure_reason as "failureReason", taken.github_comment_id as "commentId", taken.repo_id as "repoId",
        repos.full_name as "fullName", repos.github_repo_id as "githubRepoId", orgs.github_installation_id as "installationId"
      from taken
      join repos on repos.id = taken.repo_id
      join orgs on orgs.id = repos.org_id`
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
        log('info', 'job.failure_noticed', { ...fields, command: row.commentId !== null })
      } catch (error) {
        // One try: the row is already marked.
        log('warn', 'job.failure_notice_failed', { ...fields, error: errorMessage(error).slice(0, 500) })
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
          select reviews.id, reviews.pr_number as "prNumber", reviews.head_sha as "headSha", reviews.result,
            repos.full_name as "fullName", repos.github_repo_id as "githubRepoId",
            orgs.github_installation_id as "installationId", orgs.suspended_at is not null as suspended,
            jobs.github_comment_id as "commentId"
          from reviews
          join jobs on jobs.id = reviews.job_id
          join repos on repos.id = reviews.repo_id
          join orgs on orgs.id = repos.org_id
          where reviews.published_at is null and reviews.created_at > now() - ${MAX_AGE}::interval
            -- The rows that this process gave up on do not hold the limit (2950: the type uuid).
            and not (reviews.id = any(${connection.array(exhausted(), 2950)}))
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
        try {
          await noticeFailedJobs(connection)
        } catch (error) {
          log('error', 'job.failure_notices_failed', { error: errorMessage(error) })
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
