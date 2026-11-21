import { limitOfReason, RATE_LIMIT_MAX_MS } from '@kento-review/engine/providers'
import type postgres from 'postgres'

import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  MAX_JOB_RULES,
  MAX_REJECTED_FINDINGS,
  MAX_DELTA_FINDINGS,
  MAX_EARLIER_FINDINGS,
  MAX_SETTLED,
  parseEarlierFinding,
  parseReviewFinding,
  parseSettledFinding,
  REUSE_KEY,
  SHA,
  type EarlierFinding,
  type JobDelta,
  type JobEarlier,
  type JobKind,
  type JobReuse,
  type JobRule,
  type Level,
  type ProviderKind,
  type RejectedFinding,
  type ResolvePayload,
  type ReviewPayload,
  type UnchangedPayload,
} from '@kento-review/protocol'

import { withoutSettled } from '@kento-review/engine/findings'

import { jsonOf, toDate } from '../db/rows.ts'
import type { ProviderModels } from '../db/schema.ts'
import { log } from '../log.ts'
import { leftOutReason, sendablePaths } from '../rules/model.ts'
import { sendableRejected, type RejectedRow } from './rejected.ts'
import { refusalMessage } from '../providers/store.ts'

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
  /** The org of the runner, read in the same statement; null for a runner of the service. */
  runnerOrgId: string | null
  /** The provider of the org that the claim gave the job; null: the OpenRouter key of the service. */
  provider: ClaimedProvider | null
  /** REV-12. The config resolved when the job was queued (`JobConfig`), or null for a job queued before it. */
  config: unknown
}

/** A provider of an org, as the claim reads it: the key is still encrypted. */
export interface ClaimedProvider {
  id: string
  orgId: string
  kind: ProviderKind
  label: string
  baseUrl: string | null
  keyCiphertext: string | null
  runnerHeld: boolean
  models: ProviderModels
}

/**
 * What a claim can run, from its body and the configuration of the service.
 *
 * - `ownProvider`: the kind of the runner's own key or server, or null.
 * - `readsProviders`: the runner reads `providers` (FEATURES). A runner that does not gets only the
 *   jobs of an org without a provider: it knows only the OpenRouter key.
 * - `serviceKey`: the service has its OpenRouter key (KENTO_PROVIDER_API_KEY).
 * - `secrets`: the service has its master key, so it can decrypt the key of a provider.
 */
export interface ClaimOptions {
  kinds?: readonly JobKind[]
  ownProvider?: ProviderKind | null
  readsProviders?: boolean
  serviceKey?: boolean
  secrets?: boolean
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
  | { outcome: 'unchanged'; unchanged: UnchangedPayload }
  | { outcome: 'failed'; reason: string; providerStatus?: number | null }

/**
 * REV-89. A review as `reviews.result` keeps it. `reusedFrom`: the review was not made by a model,
 * it is the review of an earlier head with the same input (outcome `unchanged`). The publisher then
 * writes the block of the description, the label, the check and a review on the head without
 * comments (REV-101): the findings are already on GitHub, in the review `githubReviewId`.
 */
export type StoredReview = ReviewPayload & {
  reusedFrom?: { reviewId: string; head: string; githubReviewId: number }
  /** REV-101. The review that the publisher posted on the head of a copy: same score, no comment. */
  headReviewId?: number
}

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

/**
 * A result that the service stores means that the provider of the job answered: its key is valid.
 * Called once the result passed its checks. `called`: false for a resolve that had no thread to
 * answer and called no model, which tells nothing about the key.
 */
async function markValid(tx: postgres.TransactionSql, jobId: string, providerId: string | null, called: boolean) {
  if (!providerId || !called) return
  await tx`
    update providers set last_ok_at = now(), refused_at = null, refused_status = null, refused_message = null
    where id = ${providerId} and ${sameKey(tx, jobId)}
      -- REV-31. Several runners hold the key of a runner-held provider: a job that started before a
      -- refusal says nothing about it.
      and (not runner_held or refused_at is null or refused_at <= (select started_at from jobs where id = ${jobId}))`
}

/**
 * The key of the provider is still the one that the claim of the job gave: an admin did not replace
 * it since. The answer to an old key says nothing about the new one.
 */
function sameKey(tx: postgres.TransactionSql, jobId: string) {
  // A runner-held provider has no key in the service (key_set_at null): its state follows each job.
  return tx`(key_set_at is null or key_set_at <= (select started_at from jobs where id = ${jobId}))`
}

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
   * Takes the oldest queued job that this runner can run, or null. Two calls never get the same job,
   * and a runner revoked since the start of its request gets none. A job runs with the default
   * provider of its org, or with the OpenRouter key of the service when the org has none. A runner
   * gets it when it holds that kind itself, or when it is trusted at that moment and the service
   * holds the key: otherwise it could only fail the job. The key of the service goes only to a
   * runner of the service (REV-130).
   */
  claimJob(runnerId: string, options?: ClaimOptions): Promise<ClaimedJob | null>
  /**
   * Gives a claimed job back, for example when no installation token could be made: queued again
   * after the backoff while attempts remain, failed with `reason` after the last one.
   */
  releaseJob(jobId: string, runnerId: string, attempt: number, reason: string): Promise<'queued' | 'failed' | 'lease_lost'>
  heartbeat(jobId: string, runnerId: string, attempt: number): Promise<HeartbeatOutcome>
  /**
   * REV-19. The active rules of the repository of a job, then those of its org, at most
   * MAX_JOB_RULES. The claim reads them just after it takes the job, not when the job is queued: a
   * rule disabled while the job waited is not sent. A rule disabled after this read still applies
   * to this job, as a rule disabled during its run.
   */
  jobRules(jobId: string): Promise<JobRule[]>
  /**
   * REV-95. The findings of the pull request of a review job that a person set aside (`dismissed`,
   * `wontfix`), the most recently changed first, MAX_REJECTED_FINDINGS at most.
   */
  jobRejected(jobId: string, options?: { severity: boolean }): Promise<RejectedFinding[]>
  /**
   * REV-19. Keeps the rules that this claim sends to its runner, on the job: the result can cite
   * these only, with the title that they had then.
   */
  recordSentRules(jobId: string, runnerId: string, attempt: number, rules: JobRule[]): Promise<void>
  /**
   * REV-89. The last review on GitHub of the pull request of a review job, when the runner may reuse
   * it: the job comes from a push (not a command, a "Run again" or a retry), and that review has a
   * reuse key. Null otherwise: the runner then reviews the head. A copy that waits for its
   * publication (outcome `unchanged`) is not read yet: its source, still the last review on GitHub,
   * has the same key and the same findings, so the runner compares with the same input.
   */
  reusableReview(jobId: string): Promise<JobReuse | null>
  /**
   * REV-88. What the runner needs to review only the change since the review `reuse` names: its
   * score, its findings still open, and the settled findings of the pull request. Null when that
   * review is of another level than the job (a command at another level): the runner then reviews
   * the whole pull request. `patch`: the runner claims the feature `patch` (REV-104) and reads the
   * `patch` of a finding.
   */
  jobDelta(jobId: string, reuse: JobReuse, options?: { patch: boolean }): Promise<JobDelta | null>
  /**
   * REV-99. Every finding of the pull request of a review job, whatever its status, the open ones
   * first, then the most recently changed, MAX_EARLIER_FINDINGS at most; and the head and the score
   * of the last review of the pull request at the level of the job, or null.
   */
  jobEarlier(jobId: string): Promise<JobEarlier>
  /**
   * REV-100. The head of the last review of Kentō published on the pull request of a review job, of
   * any level (the head of the job too), or null before the first one.
   */
  jobReviewed(jobId: string): Promise<string | null>
  /**
   * Stores the result of an attempt. A finding of a review keeps its `rule_id` only when it names a
   * rule of the repository of the job or of its org, and then gets the title of that rule.
   */
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
      // A runner of an earlier release does not say what it runs: review jobs only.
      let kinds = [...(options.kinds ?? ['review'])]
      let ownProvider = options.ownProvider ?? null
      let readsProviders = options.readsProviders ?? false
      let serviceKey = options.serviceKey ?? false
      let secrets = options.secrets ?? false
      let [row] = await sql<
        (Omit<ClaimedJob, 'githubRepoId' | 'githubInstallationId' | 'leaseExpiresAt' | 'provider'> & {
          leaseExpiresAt: Date | string
          githubRepoId: string
          githubInstallationId: string
          provider: ClaimedProvider | null
        })[]
      >`
        with me as (
          -- A claim waits up to 30 s: the runner may have been revoked since its request began, so
          -- it is read again here, with its trust. FOR SHARE orders the claim with a revocation:
          -- the revocation waits for this claim and then gives its job back to the queue, or this
          -- claim waits for the revocation and then sees it.
          select id, org_id, labels, trusted from runners
          where id = ${runnerId} and revoked_at is null
          for share
        ),
        pick as (
          select jobs.id, prov.id as provider_id,
            -- The service gives the key of the provider: its state follows the result of the job.
            -- A runner that calls with its own key or server says nothing about that key.
            (prov.id is not null and not prov.runner_held and prov.kind::text is distinct from ${ownProvider}::text) as key_from_service,
            -- REV-31. The key of a runner-held provider is on the runners of the org: the result of
            -- the job says whether that key works, so the job records the provider too.
            coalesce(prov.runner_held, false) as runner_held
          from jobs
          join repos on repos.id = jobs.repo_id
          cross join me
          -- The provider of the job (REV-11, REV-12): the provider of the org that the config of the
          -- repository or of the org chose for the level (jobs.config); the key of the service when the
          -- config chose "service"; else, with no choice (the values of Kentō), the default provider of
          -- the org. A provider of another org never matches, and a provider removed since leaves the
          -- key of the service.
          left join providers prov on prov.org_id = repos.org_id and case
            when jobs.config->'models'->>'provider' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then prov.id = (jobs.config->'models'->>'provider')::uuid
            when jobs.config->>'source' in ('repo', 'org') then false
            else prov.is_default
          end
          where jobs.state = 'queued' and jobs.kind = any(${kinds}::job_kind[]) and jobs.base_ref is not null
            and jobs.attempts < ${MAX_ATTEMPTS}
            and (jobs.not_before is null or jobs.not_before <= now())
            -- A runner of an org runs the jobs of that org only; a runner of the service, every job.
            and (me.org_id is null or repos.org_id = me.org_id)
            -- The pool of the repository: a runner without its label never gets the job.
            and (repos.default_runner_pool is null or repos.default_runner_pool = any(me.labels))
            -- A job only for a runner that can call its provider: with its own key or server of
            -- that kind, or trusted with the key that the service holds. The key of a provider
            -- goes only to a runner of its org or of the service (the line above).
            and case
              when prov.id is null then
                ${ownProvider}::text = 'openrouter' or (me.trusted and me.org_id is null and ${serviceKey}::boolean)
              when not ${readsProviders}::boolean then false
              when prov.kind::text = ${ownProvider}::text then true
              when prov.runner_held then false
              else me.trusted and ${secrets}::boolean
            end
          order by jobs.created_at
          for update of jobs skip locked
          limit 1
        ),
        claimed as (
          update jobs set
            state = 'running',
            runner_id = ${runnerId},
            provider_id = case when pick.key_from_service or pick.runner_held then pick.provider_id end,
            lease_expires_at = now() + ${lease}::interval,
            started_at = now(),
            attempts = attempts + 1,
            -- REV-19. Each claim starts with no rule sent: only the claim of this attempt fills it.
            sent_rules = null,
            updated_at = now()
          from pick
          where jobs.id = pick.id
          returning jobs.id, jobs.attempts, jobs.kind, jobs.repo_id, jobs.level, jobs.pr_number, jobs.head_sha,
            jobs.base_ref, jobs.lease_expires_at, jobs.config, pick.provider_id
        )
        select
          claimed.id, claimed.attempts as "attempt", claimed.kind, claimed.level, claimed.pr_number as "prNumber", claimed.head_sha as "headSha",
          claimed.base_ref as "baseRef", claimed.lease_expires_at as "leaseExpiresAt",
          repos.full_name as "fullName", repos.github_repo_id as "githubRepoId",
          installations.github_installation_id as "githubInstallationId",
          me.trusted as "runnerTrusted", me.org_id as "runnerOrgId", claimed.config,
          case when p.id is null then null else json_build_object(
            'id', p.id, 'orgId', p.org_id, 'kind', p.kind, 'label', p.label, 'baseUrl', p.base_url,
            'keyCiphertext', p.key_ciphertext, 'runnerHeld', p.runner_held, 'models', p.models) end as provider
        from claimed
        cross join me
        join repos on repos.id = claimed.repo_id
        join installations on installations.id = repos.installation_id
        left join providers p on p.id = claimed.provider_id`
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

    async jobRejected(jobId, options = { severity: false }) {
      let rows = await sql<RejectedRow[]>`
        select findings.path, findings.line, findings.title, findings.category, findings.severity, findings.status::text as status,
          findings.status_reason as reason, findings.last_seen_sha as commit
        from jobs
        join findings on findings.repo_id = jobs.repo_id and findings.pr_number = jobs.pr_number
        where jobs.id = ${jobId} and findings.status in ('dismissed', 'wontfix')
        order by findings.updated_at desc, findings.id
        limit ${MAX_REJECTED_FINDINGS}`
      let sent = sendableRejected(rows, (fields) => log('warn', 'job.rejected_left_out', { jobId, ...fields }))
      // A runner without `rejected-severity` reads `rejected` strictly: no key that it does not know.
      return options.severity ? sent : sent.map(({ severity: _severity, ...rest }) => rest)
    },

    async jobRules(jobId) {
      let rows = await sql<JobRule[]>`
        select rules.id, case when rules.repo_id is null then 'org' else 'repo' end as scope,
          rules.title, rules.body as text, rules.paths, rules.severity_floor as "severityFloor"
        from jobs
        join repos on repos.id = jobs.repo_id
        join rules on rules.org_id = repos.org_id and (rules.repo_id = repos.id or rules.repo_id is null)
        where jobs.id = ${jobId} and rules.active
        -- The rules of the repository first: the engine drops the last ones when the pack is full.
        order by rules.repo_id is null, rules.created_at, rules.id
        limit ${MAX_JOB_RULES}`
      // A row written outside the screens never makes the job fail the check of the runner
      // (leftOutReason of app/rules/model.ts); the screens show such a rule as left out.
      let sent: JobRule[] = []
      for (let r of rows) {
        let reason = leftOutReason(r)
        if (reason) {
          log('warn', 'job.rule_left_out', { jobId, ruleId: r.id, reason: reason === 'no_pattern' ? 'no pattern within the limits of the protocol' : 'title or text beyond the limits of the protocol' })
          continue
        }
        sent.push({ ...r, paths: sendablePaths(r.paths) })
      }
      return sent
    },

    async reusableReview(jobId) {
      let [job] = await sql<{ repoId: string; prNumber: number; headSha: string; push: boolean }[]>`
        select repo_id as "repoId", pr_number as "prNumber", head_sha as "headSha",
          (github_comment_id is null and level_source is distinct from 'command'
            and level_source is distinct from 'retry') as push
        from jobs
        where id = ${jobId} and kind = 'review'`
      if (!job || !job.push) return null
      let last = await lastReviewOnGitHub(sql, job.repoId, job.prNumber, job.headSha)
      if (!last || last.key === null || !REUSE_KEY.test(last.key)) return null
      // The head of the row: a published copy names its own head, and its key is that of its source.
      return { head: last.headSha, key: last.key }
    },

    async jobDelta(jobId, reuse, options = { patch: false }) {
      let [row] = await sql<{ result: unknown; level: Level; repoId: string; prNumber: number }[]>`
        select reviews.result, jobs.level, jobs.repo_id as "repoId", jobs.pr_number as "prNumber"
        from jobs
        join reviews on reviews.repo_id = jobs.repo_id and reviews.pr_number = jobs.pr_number
          and reviews.head_sha = ${reuse.head} and reviews.github_review_id is not null
          and reviews.result->>'reuseKey' = ${reuse.key}
          -- Only a review of the level of the job: another level reads another pack.
          and reviews.result->>'level' = jobs.level::text
        where jobs.id = ${jobId}
        order by reviews.published_at desc
        limit 1`
      if (!row) return null
      let previous = jsonOf<StoredReview>(row.result)
      if (previous.level !== row.level) return null
      let settled = await sql<{ path: string; line: number; title: string; status: JobDelta['settled'][number]['status']; key: string; fingerprint: string }[]>`
        select path, line, title, status, key, fingerprint from findings
        where repo_id = ${row.repoId} and pr_number = ${row.prNumber} and status in ('fixed', 'dismissed', 'wontfix')
        order by updated_at desc
        limit ${MAX_SETTLED}`
      // The findings of that review that a person or a later review has not settled since: by
      // fingerprint, or by key (the path and the title) when no finding has that fingerprint.
      let open = withoutSettled(previous.findings, settled, (f) => f.fingerprint)
      // The job carries only what the runner accepts (the protocol): a stored finding has keys of the
      // service (`rule_title`), and an older row can fail a check. One of them would fail the claim.
      // At most MAX_DELTA_FINDINGS, the limit of the job: a longer list would fail the claim.
      let valid = open.map((f) => sendableFinding(f, options.patch)).filter((f) => parseReviewFinding(f).ok)
      let findings = valid.slice(0, MAX_DELTA_FINDINGS)
      let sent = settled.map((f) => ({ ...f, title: f.title.slice(0, 1000), line: Math.max(0, f.line) })).filter((f) => parseSettledFinding(f).ok)
      let dropped = open.length - valid.length + settled.length - sent.length
      if (valid.length > findings.length) log('warn', 'job.delta_findings_cut', { jobId, kept: findings.length, of: valid.length })
      if (dropped) log('warn', 'job.delta_findings_dropped', { jobId, dropped })
      return { score: previous.score, findings, settled: sent }
    },

    async jobEarlier(jobId) {
      let rows = await sql<(Omit<EarlierFinding, 'reason'> & { reason: string | null })[]>`
        select findings.key, findings.path, findings.line, findings.title, findings.severity, findings.category,
          findings.status::text as status, findings.status_reason as reason, findings.last_seen_sha as commit
        from jobs
        join findings on findings.repo_id = jobs.repo_id and findings.pr_number = jobs.pr_number
        where jobs.id = ${jobId}
        order by findings.status in ('open', 'stale') desc, findings.updated_at desc, findings.id
        limit ${MAX_EARLIER_FINDINGS}`
      // A row that the protocol would refuse would fail the claim: it stays out, and the log says so.
      let findings = rows
        .map((r) => ({ ...r, title: r.title.slice(0, 1000), line: Math.max(0, r.line), reason: r.reason === null ? null : r.reason.slice(0, 500) }))
        .filter((r) => parseEarlierFinding(r).ok)
      if (findings.length < rows.length) log('warn', 'job.earlier_findings_dropped', { jobId, dropped: rows.length - findings.length })
      let [last] = await sql<{ head: string; result: unknown }[]>`
        select reviews.head_sha as head, reviews.result
        from jobs
        join reviews on reviews.repo_id = jobs.repo_id and reviews.pr_number = jobs.pr_number
          and reviews.github_review_id is not null
          and reviews.result->>'level' = jobs.level::text
        where jobs.id = ${jobId}
        order by reviews.published_at desc nulls last
        limit 1`
      let score = last ? Number(jsonOf<StoredReview>(last.result).score) : NaN
      return { findings, last: last && Number.isInteger(score) && score >= 1 && score <= 5 ? { head: last.head, score } : null }
    },

    async jobReviewed(jobId) {
      let [row] = await sql<{ head: string }[]>`
        select reviews.head_sha as head
        from jobs
        join reviews on reviews.repo_id = jobs.repo_id and reviews.pr_number = jobs.pr_number
          and reviews.github_review_id is not null
        where jobs.id = ${jobId}
        order by reviews.published_at desc nulls last, reviews.created_at desc
        limit 1`
      return row && SHA.test(row.head) ? row.head : null
    },

    async recordSentRules(jobId, runnerId, attempt, rules) {
      await sql`
        update jobs set sent_rules = ${JSON.stringify(rules)}::jsonb
        where id = ${jobId} and runner_id = ${runnerId} and attempts = ${attempt}`
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
          { state: string; holds: boolean; kind: JobKind; repoId: string; prNumber: number; headSha: string; providerId: string | null }[]
        >`
          select state, (runner_id is not distinct from ${runnerId} and attempts = ${attempt}) as holds,
            kind, repo_id as "repoId", pr_number as "prNumber", head_sha as "headSha", provider_id as "providerId"
          from jobs where id = ${jobId}
          for update`
        if (!job) return 'not_found' as const
        if (!job.holds || job.state === 'queued') return 'lease_lost' as const
        if (job.state !== 'running') return 'not_running' as const

        if (result.outcome === 'failed') {
          let limit = limitOfReason(result.reason)
          if (limit?.kind === 'rate') {
            // KNT-161. Every model got a short rate limit: the job goes back to the queue until the
            // limit ends (at least the backoff), while attempts remain. After the last attempt it
            // fails, and the publisher says that the review did not happen.
            let wait = limit.resetAt ? Math.min(RATE_LIMIT_MAX_MS, Math.max(0, Date.parse(limit.resetAt) - Date.now())) / 1000 : 0
            await tx`
              update jobs set
                state = case when attempts < ${MAX_ATTEMPTS} then 'queued'::job_state else 'failed'::job_state end,
                failure_reason = case when attempts < ${MAX_ATTEMPTS} then null else ${result.reason} end,
                finished_at = case when attempts < ${MAX_ATTEMPTS} then null else now() end,
                not_before = case when attempts < ${MAX_ATTEMPTS}
                  then greatest(now() + ${backoff}::interval * power(2, attempts - 1), now() + ${wait} * interval '1 second')
                  else null end,
                lease_expires_at = null,
                updated_at = now()
              where id = ${jobId}`
            return 'stored' as const
          }
          // KNT-161. A usage limit (a 403 "key limit" of a provider among them) is not a wrong key.
          let refused = (result.providerStatus === 401 || result.providerStatus === 403) && !limit
          let reason = result.reason
          if (refused && job.providerId) {
            // The provider refused its key: the state of the provider says it on the screen, with a
            // banner, until an admin replaces the key or a call works again.
            // REV-31. The key of a runner-held provider is on each runner of the org, and one of them
            // may hold a wrong one: the message names the runner that got the refusal.
            let message = refusalMessage(`${result.providerStatus} ${result.reason}`)
            let [provider] = await tx<{ label: string }[]>`
              update providers set refused_at = coalesce(refused_at, now()), refused_status = ${result.providerStatus!},
                refused_message = case when runner_held
                  then left('runner "' || coalesce((select name from runners where id = ${runnerId}), '?') || '": ' || ${message}, 300)
                  else ${message} end
              where id = ${job.providerId} and ${sameKey(tx, jobId)}
                -- A slow job of a runner with a wrong key never hides a later success on another runner.
                and (not runner_held or last_ok_at is null or last_ok_at <= (select started_at from jobs where id = ${jobId}))
              returning label`
            if (provider) reason = `the provider "${provider.label}" refused its key (${result.providerStatus}): ${result.reason}`.slice(0, 2000)
          }
          await tx`
            update jobs set state = 'failed', failure_reason = ${reason}, finished_at = now(),
              lease_expires_at = null, updated_at = now()
            where id = ${jobId}`
          return 'stored' as const
        }


        if (result.outcome === 'resolved') {
          let { resolve } = result
          if (job.kind !== 'resolve') return 'wrong_kind' as const
          if (resolve.head !== job.headSha) return 'wrong_head' as const
          await markValid(tx, jobId, job.providerId, resolve.model !== null)
          await tx`
            insert into resolutions (job_id, repo_id, pr_number, head_sha, model, cost_usd, result)
            values (${jobId}, ${job.repoId}, ${job.prNumber}, ${job.headSha}, ${resolve.model},
              ${resolve.costUsd}, ${JSON.stringify(resolve)}::jsonb)`
          await tx`
            update jobs set state = 'done', finished_at = now(), lease_expires_at = null, updated_at = now()
            where id = ${jobId}`
          return 'stored' as const
        }

        if (result.outcome === 'unchanged') {
          let { unchanged } = result
          if (job.kind !== 'review') return 'wrong_kind' as const
          if (unchanged.head !== job.headSha) return 'wrong_head' as const
          // REV-89. The review to publish again is the last review on GitHub of the pull request, the
          // one that `reusableReview` gave the claim, with the same head and key: never an older
          // review of the pull request. The runner called no model: the copy costs nothing, and keeps
          // the findings, the score and the verdict.
          let last = await lastReviewOnGitHub(tx, job.repoId, job.prNumber, job.headSha)
          let source = last && last.headSha === unchanged.of && last.key === unchanged.reuseKey ? last : null
          if (!source) {
            // The retention removed it, or another review is now the last one. The job goes back to
            // the queue, as `releaseJob` does: the next claim reads the last review again, and the
            // runner reviews the head unless its key is that one. After the last attempt, it fails.
            let reason = `the review of ${unchanged.of.slice(0, 9)} to publish again is gone, or is no longer the last one`
            await tx`
              update jobs set
                state = case when attempts < ${MAX_ATTEMPTS} then 'queued'::job_state else 'failed'::job_state end,
                failure_reason = case when attempts < ${MAX_ATTEMPTS} then null else ${reason} end,
                finished_at = case when attempts < ${MAX_ATTEMPTS} then null else now() end,
                not_before = case when attempts < ${MAX_ATTEMPTS}
                  then now() + ${backoff}::interval * power(2, attempts - 1) else null end,
                lease_expires_at = null,
                updated_at = now()
              where id = ${jobId}`
            log('warn', 'job.reuse_source_moved', { jobId, of: unchanged.of })
            return 'stored' as const
          }
          // The review on the head of the source is not the review of this head (REV-101).
          let { headReviewId: _sourceHead, ...previous } = jsonOf<StoredReview>(source.result)
          let copy: StoredReview = {
            ...previous,
            base: unchanged.base,
            head: unchanged.head,
            costUsd: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            diffHash: unchanged.diffHash,
            reuseKey: unchanged.reuseKey,
            // A copy of a copy keeps the review that a model made: its head and its review on GitHub.
            // A copy that the publisher posted as a review of its own (its source was gone) has
            // another review on GitHub: it is then the source.
            reusedFrom:
              previous.reusedFrom && previous.reusedFrom.githubReviewId === Number(source.githubReviewId)
                ? previous.reusedFrom
                : { reviewId: source.id, head: unchanged.of, githubReviewId: Number(source.githubReviewId) },
          }
          await tx`
            insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
            values (${jobId}, ${job.repoId}, ${job.prNumber}, ${job.headSha}, ${source.score},
              ${source.model}, 0, ${JSON.stringify(copy)}::jsonb)`
          await tx`
            update jobs set state = 'done', finished_at = now(), lease_expires_at = null, updated_at = now()
            where id = ${jobId}`
          return 'stored' as const
        }

        let { review } = result
        if (job.kind !== 'review') return 'wrong_kind' as const
        if (review.head !== job.headSha) return 'wrong_head' as const
        await markValid(tx, jobId, job.providerId, true)
        review = { ...review, findings: await citedRules(tx, jobId, review.findings) }
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

/**
 * REV-88. A stored finding with the keys of the protocol only. `withPatch`: the runner reads `patch`
 * (REV-104); a runner of an earlier release refuses the key.
 */
function sendableFinding(f: ReviewPayload['findings'][number], withPatch: boolean): ReviewPayload['findings'][number] {
  let { path, start_line, line, severity, category, confidence, title, scenario, fix, suggestion, patch, anchor, blocking, suggestion_range, rule_id, fingerprint } = f
  return {
    path,
    start_line,
    line,
    severity,
    category,
    confidence,
    title,
    scenario,
    fix,
    suggestion,
    ...(withPatch && patch ? { patch } : {}),
    anchor,
    blocking,
    suggestion_range,
    ...(rule_id ? { rule_id } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  }
}

/**
 * REV-89. The last review on GitHub of a pull request, of a head other than `head`: the one that the
 * claim gives the runner (`reusableReview`), and the only one that an `unchanged` result can copy
 * (`storeResult`). One definition for both, so that they never name two reviews. A published copy
 * counts with its own head: its key and its findings are those of its source.
 */
async function lastReviewOnGitHub(q: postgres.Sql | postgres.TransactionSql, repoId: string, prNumber: number, head: string) {
  let [last] = await q<{ id: string; headSha: string; key: string | null; result: unknown; score: number; model: string; githubReviewId: string | number }[]>`
    select id, head_sha as "headSha", result->>'reuseKey' as key, result, score, model, github_review_id as "githubReviewId"
    from reviews
    where repo_id = ${repoId} and pr_number = ${prNumber} and github_review_id is not null and head_sha <> ${head}
    order by published_at desc, created_at desc
    limit 1`
  return last ?? null
}

/**
 * REV-19. The findings, each with the rule that it cites when the claim of this attempt sent that rule
 * (`jobs.sent_rules`): `rule_id` stays, and `rule_title` is the title that the rule had when it was
 * sent. A rule disabled, changed or removed while the job ran stays cited as the runner got it: the
 * model applied it, and its floor is already in the severity. Any other `rule_id` (a rule that the
 * job did not carry) is dropped, and the log says which: a runner can never make a finding cite it.
 */
async function citedRules(
  tx: postgres.TransactionSql,
  jobId: string,
  findings: ReviewPayload['findings'],
): Promise<(ReviewPayload['findings'][number] & { rule_title?: string })[]> {
  let ids = [...new Set(findings.flatMap((f) => (f.rule_id ? [f.rule_id] : [])))]
  if (!ids.length) return findings
  let [row] = await tx<{ sent: unknown }[]>`select sent_rules as sent from jobs where id = ${jobId}`
  let raw = jsonOf<unknown>(row?.sent)
  let carried = Array.isArray(raw)
  let sent = carried ? (raw as { id?: unknown; title?: unknown }[]) : []
  let titles = new Map(sent.flatMap((r) => (typeof r.id === 'string' && typeof r.title === 'string' ? [[r.id, r.title] as const] : [])))
  let dropped = ids.filter((id) => !titles.has(id))
  if (dropped.length) {
    // No list: this attempt was sent no rule at all (a runner without the feature `rules`).
    let reason = carried ? 'the job did not carry this rule' : 'this attempt was sent no rules'
    log('warn', 'job.rule_citation_dropped', { jobId, rules: dropped, reason })
  }
  return findings.map(({ rule_id, ...f }) => {
    let title = rule_id ? titles.get(rule_id) : undefined
    return title !== undefined ? { ...f, rule_id: rule_id!, rule_title: title } : f
  })
}
