import type postgres from 'postgres'

import { LEASE_SECONDS, type Level, type ReviewPayload } from '@sakuga-review/protocol'

/** A runner, as an authenticated call sees it. */
export interface RunnerRow {
  id: string
  name: string
  trusted: boolean
}

/** A job that a runner has just claimed, with what the service needs to build its message. */
export interface ClaimedJob {
  id: string
  level: Level
  prNumber: number
  headSha: string
  baseRef: string
  leaseExpiresAt: Date
  fullName: string
  githubRepoId: number
  githubInstallationId: number
  /** Whether the runner is trusted now, read in the statement that claims the job. */
  runnerTrusted: boolean
}

export type HeartbeatOutcome =
  | { kind: 'extended'; leaseExpiresAt: Date }
  | { kind: 'cancelled'; leaseExpiresAt: Date }
  | { kind: 'not_found' }
  | { kind: 'finished' }

export type ResultOutcome = 'stored' | 'not_found' | 'not_running' | 'wrong_head'

/** What the runner API reads and writes. Tests of the routes can pass a fake. */
export interface RunnerStore {
  createRunner(input: { name: string; labels: string[]; version: string; tokenHash: string }): Promise<string>
  /** The runner of this token hash, when it is not revoked. Marks it as seen. */
  findRunner(tokenHash: string): Promise<RunnerRow | null>
  /**
   * Takes the oldest queued job for this runner, or null. Two calls never get the same job, and a
   * runner revoked since the start of its request gets none.
   */
  claimJob(runnerId: string): Promise<ClaimedJob | null>
  /** Gives a claimed job back as failed, for example when no installation token could be made. */
  failJob(jobId: string, runnerId: string, reason: string): Promise<void>
  heartbeat(jobId: string, runnerId: string): Promise<HeartbeatOutcome>
  storeResult(
    jobId: string,
    runnerId: string,
    result: { outcome: 'done'; review: ReviewPayload } | { outcome: 'failed'; reason: string },
  ): Promise<ResultOutcome>
}

const lease = `${LEASE_SECONDS} seconds`

// drizzle replaces the parsers and serializers of the shared postgres client: a timestamp comes
// back as text, and a JSON value goes in as text with a cast.
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export function createRunnerStore(sql: postgres.Sql): RunnerStore {
  return {
    async createRunner({ name, labels, version, tokenHash }) {
      let [row] = await sql<{ id: string }[]>`
        insert into runners (name, labels, version, token_hash)
        values (${name}, ${labels}, ${version}, ${tokenHash})
        returning id`
      return row!.id
    },

    async findRunner(tokenHash) {
      let [row] = await sql<RunnerRow[]>`
        update runners set last_seen_at = now()
        where token_hash = ${tokenHash} and revoked_at is null
        returning id, name, trusted`
      return row ?? null
    },

    // One statement: the subquery locks the oldest queued job and skips a job that another claim
    // has locked, so two runners that claim at the same time get two different jobs, or one job
    // and nothing. The update runs in the same statement, so a claimed job is never seen as queued.
    async claimJob(runnerId) {
      let [row] = await sql<
        (Omit<ClaimedJob, 'githubRepoId' | 'githubInstallationId' | 'leaseExpiresAt'> & {
          leaseExpiresAt: Date | string
          githubRepoId: string
          githubInstallationId: string
        })[]
      >`
        with claimed as (
          update jobs set
            state = 'running',
            runner_id = ${runnerId},
            lease_expires_at = now() + ${lease}::interval,
            started_at = now(),
            attempts = attempts + 1,
            updated_at = now()
          where id = (
            select id from jobs
            where state = 'queued' and kind = 'review' and base_ref is not null
            order by created_at
            for update skip locked
            limit 1
          )
          -- A claim waits up to 30 s: the runner may have been revoked since its request began.
          and exists (select 1 from runners where id = ${runnerId} and revoked_at is null)
          returning id, repo_id, level, pr_number, head_sha, base_ref, lease_expires_at
        )
        select
          claimed.id, claimed.level, claimed.pr_number as "prNumber", claimed.head_sha as "headSha",
          claimed.base_ref as "baseRef", claimed.lease_expires_at as "leaseExpiresAt",
          repos.full_name as "fullName", repos.github_repo_id as "githubRepoId",
          orgs.github_installation_id as "githubInstallationId",
          runners.trusted as "runnerTrusted"
        from claimed
        join runners on runners.id = ${runnerId}
        join repos on repos.id = claimed.repo_id
        join orgs on orgs.id = repos.org_id`
      if (!row) return null
      return {
        ...row,
        leaseExpiresAt: toDate(row.leaseExpiresAt),
        githubRepoId: Number(row.githubRepoId),
        githubInstallationId: Number(row.githubInstallationId),
      }
    },

    async failJob(jobId, runnerId, reason) {
      await sql`
        update jobs set state = 'failed', failure_reason = ${reason}, finished_at = now(),
          lease_expires_at = null, updated_at = now()
        where id = ${jobId} and runner_id = ${runnerId} and state = 'running'`
    },

    async heartbeat(jobId, runnerId) {
      let [row] = await sql<{ state: string; leaseExpiresAt: Date | string | null }[]>`
        update jobs set
          lease_expires_at = case when state = 'running' then now() + ${lease}::interval else lease_expires_at end,
          updated_at = now()
        where id = ${jobId} and runner_id = ${runnerId}
        returning state, lease_expires_at as "leaseExpiresAt"`
      if (!row) return { kind: 'not_found' }
      if (row.state === 'running') return { kind: 'extended', leaseExpiresAt: toDate(row.leaseExpiresAt!) }
      if (row.state === 'cancelled') return { kind: 'cancelled', leaseExpiresAt: toDate(row.leaseExpiresAt ?? new Date()) }
      return { kind: 'finished' }
    },

    async storeResult(jobId, runnerId, result) {
      return sql.begin(async (tx) => {
        let [job] = await tx<{ state: string; repoId: string; prNumber: number; headSha: string }[]>`
          select state, repo_id as "repoId", pr_number as "prNumber", head_sha as "headSha"
          from jobs where id = ${jobId} and runner_id = ${runnerId}
          for update`
        if (!job) return 'not_found' as const
        if (job.state !== 'running') return 'not_running' as const

        if (result.outcome === 'failed') {
          await tx`
            update jobs set state = 'failed', failure_reason = ${result.reason}, finished_at = now(),
              lease_expires_at = null, updated_at = now()
            where id = ${jobId}`
          return 'stored' as const
        }

        let { review } = result
        if (review.head !== job.headSha) return 'wrong_head' as const
        await tx`
          insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
          values (${jobId}, ${job.repoId}, ${job.prNumber}, ${job.headSha}, ${review.score},
            ${review.model}, ${review.costUsd}, ${JSON.stringify(review)}::jsonb)`
        await tx`
          update jobs set state = 'done', finished_at = now(), lease_expires_at = null, updated_at = now()
          where id = ${jobId}`
        return 'stored' as const
      })
    },
  }
}
