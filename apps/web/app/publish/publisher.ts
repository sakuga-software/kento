// The publisher: it takes the reviews that the runners sent and that GitHub does not have yet, and
// publishes them with an installation token of the App. The result route wakes it; a timer also
// runs it, so that a review stored before a restart is still published.
//
// `reviews.published_at` set and `github_review_id` set: the review is on GitHub.
// `reviews.published_at` set and `github_review_id` null: the review was not published, on purpose
// (the pull request is closed, or a newer push moved its head). The log line says why.
import type { ReviewPayload } from '@sakuga-review/protocol'
import type postgres from 'postgres'

import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
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
const MAX_AGE = '30 minutes'
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
    let skip = async (reason: 'closed' | 'superseded' | 'suspended'): Promise<PublishResult> => {
      await deps.sql`update reviews set published_at = now() where id = ${row.id} and published_at is null`
      log('info', 'review.publication_skipped', { reviewId: row.id, repo: row.fullName, pr: row.prNumber, head: row.headSha, reason })
      return { kind: 'skipped', reviewId: row.id, reason }
    }
    if (row.suspended) return skip('suspended')

    let target = { installationId: Number(row.installationId), githubRepoId: Number(row.githubRepoId) }
    let token = await deps.mintInstallationToken({ ...target, permissions: PUBLISH_PERMISSIONS })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })

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
    return { kind: 'published', reviewId: row.id, githubReviewId }
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
            orgs.github_installation_id as "installationId", orgs.suspended_at is not null as suspended
          from reviews
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
