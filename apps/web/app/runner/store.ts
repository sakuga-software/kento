import type postgres from 'postgres'

import { LEASE_SECONDS, MAX_ATTEMPTS, type JobKind, type Level, type ResolvePayload, type ReviewPayload } from '@sakuga-review/protocol'

/** A runner, as an authenticated call sees it. */
export interface RunnerRow {
  id: string
  name: string
  trusted: boolean
}

/** A job that a runner has just claimed, with what the service needs to build its message. */
export interface ClaimedJob {
  id: string
  /** The number of this claim of the job, from 1. */
  attempt: number
  kind: JobKind
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
  /** REV-12. The config resolved when the job was queued (`JobConfig`), or null for a job queued before it. */
  config: unknown
}

/**
 * - `lease_lost`: the job exists, but this runner does not hold this attempt any more: its lease
 *   ended and the job went back to the queue, to another runner, or failed.
 * - `not_found`: no such job.
 */
export type HeartbeatOutcome =
  | { kind: 'extended'; leaseExpiresAt: Date }
  | { kind: 'cancelled'; leaseExpiresAt: Date }
  | { kind: 'not_found' }
  | { kind: 'lease_lost' }
  | { kind: 'finished' }

/** `wrong_kind`: a review for a resolve job, or the reverse. */
export type ResultOutcome = 'stored' | 'not_found' | 'lease_lost' | 'not_running' | 'wrong_head' | 'wrong_kind'

export type StoredResult =
  | { outcome: 'done'; review: ReviewPayload }
  | { outcome: 'resolved'; resolve: ResolvePayload }
  | { outcome: 'failed'; reason: string }

/** What one sweep of the expired leases did. */
export interface ExpiredLeases {
  /** Queued again, for a new attempt after the backoff. */
  requeued: { id: string; attempts: number; runnerId: string | null }[]
  /** Failed: their last attempt ended with no result. */
  failed: { id: string; attempts: number; runnerId: string | null }[]
}

/**
 * How long a job queued again waits before a runner can claim it: 30 s after the first attempt, and
 * twice as long after each next one. A job that stops every runner (a pull request too large for
 * the memory of the runner) then does not take every runner in turn at once.
 */
export const RETRY_BACKOFF_SECONDS = 30

/** What the runner API reads and writes. Tests of the routes can pass a fake. */
export interface RunnerStore {
  /** A runner of the service, registered with KENTO_RUNNER_REGISTRATION_TOKEN: no org. */
  createRunner(input: { name: string; labels: string[]; version: string; tokenHash: string }): Promise<string>
  /**
   * Uses a registration token of the Runners screen: creates the runner with the org, the name, the
   * labels and the trust of the token, and marks the token used. Null when the token is unknown,
   * used or expired. Two registrations with the same token at the same time make one runner.
   */
  registerWithToken(input: { registrationHash: string; version: string; tokenHash: string }): Promise<
    { runnerId: string; name: string; labels: string[]; orgId: string } | null
  >
  /** The runner of this token hash, when it is not revoked. Marks it as seen. */
  findRunner(tokenHash: string): Promise<RunnerRow | null>
  /**
   * Takes the oldest queued job for this runner, or null. Two calls never get the same job, and a
   * runner revoked since the start of its request gets none. With `trustedOnly`, only a runner that
   * is trusted at that moment gets a job: a runner without a model key of its own can run a job
   * only with the key of the service.
   */
  claimJob(runnerId: string, options?: { trustedOnly?: boolean; kinds?: readonly JobKind[] }): Promise<ClaimedJob | null>
  /**
   * Gives a claimed job back, for example when no installation token could be made: queued again
   * after the backoff while attempts remain, failed with `reason` after the last one.
   */
  releaseJob(jobId: string, runnerId: string, attempt: number, reason: string): Promise<'queued' | 'failed' | 'lease_lost'>
  heartbeat(jobId: string, runnerId: string, attempt: number): Promise<HeartbeatOutcome>
  storeResult(
    jobId: string,
    runnerId: string,
    attempt: number,
    result: StoredResult,
  ): Promise<ResultOutcome>
  /**
   * Queues again each running job whose lease has ended, or fails it after its last attempt. The
   * service runs it on a timer. Two sweeps at the same time (two replicas) never take the same job.
   */
  expireLeases(): Promise<ExpiredLeases>
}

const lease = `${LEASE_SECONDS} seconds`
const backoff = `${RETRY_BACKOFF_SECONDS} seconds`

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

    async registerWithToken({ registrationHash, version, tokenHash }) {
      return sql.begin(async (tx) => {
        // The update locks the row: a second registration with the same token waits, then sees
        // `used_at` set and gets nothing.
        let [registration] = await tx<{ id: string; orgId: string; name: string; labels: string[]; trusted: boolean }[]>`
          update runner_registrations set used_at = now()
          where token_hash = ${registrationHash} and used_at is null and expires_at > now()
          returning id, org_id as "orgId", name, labels, trusted`
        if (!registration) return null
        let [runner] = await tx<{ id: string }[]>`
          insert into runners (org_id, name, labels, version, token_hash, trusted)
          values (${registration.orgId}, ${registration.name}, ${registration.labels}, ${version}, ${tokenHash},
            ${registration.trusted})
          returning id`
        await tx`update runner_registrations set runner_id = ${runner!.id} where id = ${registration.id}`
        return { runnerId: runner!.id, name: registration.name, labels: registration.labels, orgId: registration.orgId }
      })
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
    async claimJob(runnerId, options = {}) {
      let trustedOnly = options.trustedOnly ?? false
      // A runner of an earlier release does not say what it runs: review jobs only.
      let kinds = [...(options.kinds ?? ['review'])]
      let [row] = await sql<
        (Omit<ClaimedJob, 'githubRepoId' | 'githubInstallationId' | 'leaseExpiresAt'> & {
          leaseExpiresAt: Date | string
          githubRepoId: string
          githubInstallationId: string
        })[]
      >`
        with me as (
          -- A claim waits up to 30 s: the runner may have been revoked since its request began, so
          -- it is read again here, with its trust. FOR SHARE orders the claim with a revocation:
          -- the revocation waits for this claim and then gives its job back to the queue, or this
          -- claim waits for the revocation and then sees it.
          select id, org_id, labels, trusted from runners
          where id = ${runnerId} and revoked_at is null and (${trustedOnly}::boolean = false or trusted)
          for share
        ),
        claimed as (
          update jobs set
            state = 'running',
            runner_id = ${runnerId},
            lease_expires_at = now() + ${lease}::interval,
            started_at = now(),
            attempts = attempts + 1,
            updated_at = now()
          where id = (
            select jobs.id from jobs
            join repos on repos.id = jobs.repo_id
            cross join me
            where jobs.state = 'queued' and jobs.kind = any(${kinds}::job_kind[]) and jobs.base_ref is not null
              and jobs.attempts < ${MAX_ATTEMPTS}
              and (jobs.not_before is null or jobs.not_before <= now())
              -- A runner of an org runs the jobs of that org only; a runner of the service, every job.
              and (me.org_id is null or repos.org_id = me.org_id)
              -- The pool of the repository: a runner without its label never gets the job.
              and (repos.default_runner_pool is null or repos.default_runner_pool = any(me.labels))
            order by jobs.created_at
            for update of jobs skip locked
            limit 1
          )
          returning id, attempts, kind, repo_id, level, pr_number, head_sha, base_ref, lease_expires_at, config
        )
        select
          claimed.id, claimed.attempts as "attempt", claimed.kind, claimed.level, claimed.pr_number as "prNumber", claimed.head_sha as "headSha",
          claimed.base_ref as "baseRef", claimed.lease_expires_at as "leaseExpiresAt",
          repos.full_name as "fullName", repos.github_repo_id as "githubRepoId",
          orgs.github_installation_id as "githubInstallationId",
          me.trusted as "runnerTrusted", claimed.config
        from claimed
        cross join me
        join repos on repos.id = claimed.repo_id
        join orgs on orgs.id = repos.org_id`
      if (!row) return null
      return {
        ...row,
        attempt: Number(row.attempt),
        leaseExpiresAt: toDate(row.leaseExpiresAt),
        githubRepoId: Number(row.githubRepoId),
        githubInstallationId: Number(row.githubInstallationId),
      }
    },

    async releaseJob(jobId, runnerId, attempt, reason) {
      let [row] = await sql<{ state: 'queued' | 'failed' }[]>`
        update jobs set
          state = case when attempts < ${MAX_ATTEMPTS} then 'queued'::job_state else 'failed'::job_state end,
          failure_reason = case when attempts < ${MAX_ATTEMPTS} then null else ${reason} end,
          finished_at = case when attempts < ${MAX_ATTEMPTS} then null else now() end,
          not_before = case when attempts < ${MAX_ATTEMPTS}
            then now() + ${backoff}::interval * power(2, attempts - 1) else null end,
          lease_expires_at = null,
          updated_at = now()
        where id = ${jobId} and runner_id = ${runnerId} and attempts = ${attempt} and state = 'running'
        returning state`
      return row?.state ?? 'lease_lost'
    },

    // The holder of a job is its runner and its attempt. A runner whose lease ended may still run
    // the job; when the job went back to the queue or to another runner, it gets lease_lost and
    // can write nothing.
    async heartbeat(jobId, runnerId, attempt) {
      let [extended] = await sql<{ leaseExpiresAt: Date | string }[]>`
        update jobs set lease_expires_at = now() + ${lease}::interval, updated_at = now()
        where id = ${jobId} and runner_id = ${runnerId} and attempts = ${attempt} and state = 'running'
        returning lease_expires_at as "leaseExpiresAt"`
      if (extended) return { kind: 'extended', leaseExpiresAt: toDate(extended.leaseExpiresAt) }

      let [row] = await sql<
        { state: string; holds: boolean; leaseExpiresAt: Date | string | null }[]
      >`
        select state, (runner_id is not distinct from ${runnerId} and attempts = ${attempt}) as holds,
          lease_expires_at as "leaseExpiresAt"
        from jobs where id = ${jobId}`
      if (!row) return { kind: 'not_found' }
      // A job cancelled during this attempt keeps its runner: the runner learns that it must stop.
      if (!row.holds || row.state === 'queued' || row.state === 'running') return { kind: 'lease_lost' }
      if (row.state === 'cancelled') return { kind: 'cancelled', leaseExpiresAt: toDate(row.leaseExpiresAt ?? new Date()) }
      return { kind: 'finished' }
    },

    async storeResult(jobId, runnerId, attempt, result) {
      return sql.begin(async (tx) => {
        // Lock order: the repository, then the job, as the cancel of a closed pull request does
        // (it locks the repository FOR UPDATE, then cancels the jobs). Without the first lock, the
        // foreign key of the review row waits for the repository while the cancel waits for the
        // job: a deadlock (measured in test/db/leases.test.ts, case 9). KEY SHARE does not wait for
        // the upsert of a push, which takes a weaker lock on the repository.
        await tx`
          select 1 from repos where id = (select repo_id from jobs where id = ${jobId})
          for key share`
        // The lock of the job orders this write with the sweep of the expired leases and with a
        // cancel: the first one to commit wins, and the other one sees its state.
        let [job] = await tx<
          { state: string; holds: boolean; kind: JobKind; repoId: string; prNumber: number; headSha: string }[]
        >`
          select state, (runner_id is not distinct from ${runnerId} and attempts = ${attempt}) as holds,
            kind, repo_id as "repoId", pr_number as "prNumber", head_sha as "headSha"
          from jobs where id = ${jobId}
          for update`
        if (!job) return 'not_found' as const
        if (!job.holds || job.state === 'queued') return 'lease_lost' as const
        if (job.state !== 'running') return 'not_running' as const

        if (result.outcome === 'failed') {
          await tx`
            update jobs set state = 'failed', failure_reason = ${result.reason}, finished_at = now(),
              lease_expires_at = null, updated_at = now()
            where id = ${jobId}`
          return 'stored' as const
        }

        if (result.outcome === 'resolved') {
          let { resolve } = result
          if (job.kind !== 'resolve') return 'wrong_kind' as const
          if (resolve.head !== job.headSha) return 'wrong_head' as const
          await tx`
            insert into resolutions (job_id, repo_id, pr_number, head_sha, model, cost_usd, result)
            values (${jobId}, ${job.repoId}, ${job.prNumber}, ${job.headSha}, ${resolve.model},
              ${resolve.costUsd}, ${JSON.stringify(resolve)}::jsonb)`
          await tx`
            update jobs set state = 'done', finished_at = now(), lease_expires_at = null, updated_at = now()
            where id = ${jobId}`
          return 'stored' as const
        }

        let { review } = result
        if (job.kind !== 'review') return 'wrong_kind' as const
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

    // One statement. `skip locked` leaves a job whose result or cancel is being written: the next
    // sweep sees it again if it is still running. The runner id stays on the row, as the last
    // runner of the job; a new claim replaces it.
    async expireLeases() {
      let rows = await sql<{ id: string; attempts: number; runnerId: string | null; state: 'queued' | 'failed' }[]>`
        with expired as (
          select id from jobs
          where state = 'running' and lease_expires_at < now()
          for update skip locked
        )
        update jobs set
          state = case when attempts < ${MAX_ATTEMPTS} then 'queued'::job_state else 'failed'::job_state end,
          failure_reason = case when attempts < ${MAX_ATTEMPTS} then null
            else 'lease expired ' || attempts || ' times' end,
          finished_at = case when attempts < ${MAX_ATTEMPTS} then null else now() end,
          not_before = case when attempts < ${MAX_ATTEMPTS}
            then now() + ${backoff}::interval * power(2, attempts - 1) else null end,
          lease_expires_at = null,
          updated_at = now()
        from expired
        where jobs.id = expired.id
        returning jobs.id, jobs.attempts, jobs.runner_id as "runnerId", jobs.state`
      let out: ExpiredLeases = { requeued: [], failed: [] }
      for (let { state, ...job } of rows) out[state === 'queued' ? 'requeued' : 'failed'].push({ ...job, attempts: Number(job.attempts) })
      return out
    },
  }
}
