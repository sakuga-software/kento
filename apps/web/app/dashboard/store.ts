import type { JobKind, Level } from '@sakuga-review/protocol'
import { sql as query } from 'drizzle-orm'

import type { Database } from '../db/client.ts'
import { orgCapHit, readOrgCosts, type OrgCostsDetail } from '../db/costs.ts'
import { toDate } from '../db/rows.ts'
import { insertReviewJob } from '../db/webhook-store.ts'
import { jobConfig, readOverrides, resolveConfig } from '../repo-config/model.ts'
import { readMoney, type CapPeriod, type OrgCaps } from '../org-settings/model.ts'
import { QUEUE_STALL_MINUTES } from '../publish/queued.ts'
import { OFFLINE_SECONDS, ONLINE_SECONDS } from '../runner/admin.ts'

/** The days of the chart « Reviews publiées », today included. */
export const WEEK_DAYS = 7
/** The last reviews of the list. */
export const RECENT_LIMIT = 10
/** A failure older than this gets no banner. */
export const FAILURE_SHOWN_DAYS = 7
/** The failures of the list « Échecs », newest first. */
export const FAILURES_LIMIT = 5
/** The jobs of each part of the queue. More are counted, not listed. */
export const QUEUE_LIMIT = 20
/** REV-37. The runners online or late on the card « Runners ». */
export const RUNNERS_LIMIT = 10
/** REV-37. The offline runners on the card, the last ones seen first. More are counted, not listed. */
export const OFFLINE_RUNNERS_LIMIT = 5
/** The reviews of a level of a repository that the estimate of a retry averages, newest first. */
export const ESTIMATE_SAMPLE = 20

export interface LevelCounts {
  lite: number
  balanced: number
  heavy: number
}

/** One UTC day of the chart: the reviews published that day, by level, and the jobs that failed. */
export interface DayStats {
  /** `2026-10-29`, UTC. */
  day: string
  published: LevelCounts
  failed: number
  /** The mean time from the claim to the result of the reviews published that day. Null without one. */
  meanDurationMs: number | null
}

export interface RecentReview {
  id: string
  repoId: string
  repo: string
  prNumber: number
  level: Level
  verdict: string | null
  score: number
  findings: number
  costUsd: number | null
  durationMs: number | null
  createdAt: Date
  publishedAt: Date | null
}

/** A job that failed, with what the service knows of the failure. */
export interface FailedJob {
  id: string
  repoId: string
  repo: string
  prNumber: number
  kind: JobKind
  level: Level
  attempts: number
  reason: string | null
  runnerName: string | null
  finishedAt: Date | null
}

/** The banner of the last failure: the job, the review that stays published, and what a retry costs. */
export interface FailureBanner extends FailedJob {
  /** The last review published on the pull request, before the failure. */
  previous: { score: number; publishedAt: Date } | null
  /** A job of the same pull request queued or running since the failure: a retry is under way. */
  retry: { id: string; level: Level; state: 'queued' | 'running' } | null
  /** The mean cost of the last reviews of each level on the repository. Null: none yet. */
  estimates: Record<Level, number | null>
}

export interface QueueJob {
  id: string
  repo: string
  prNumber: number
  kind: JobKind
  level: Level
  attempts: number
  createdAt: Date
  startedAt: Date | null
  leaseExpiresAt: Date | null
  notBefore: Date | null
  runnerName: string | null
  /** The last call of the runner: a heartbeat, a claim or a result. */
  runnerSeenAt: Date | null
}

/**
 * REV-52. The queued jobs of the org that wait for more than QUEUE_STALL_MINUTES. Their pull requests
 * get a comment of the publisher too.
 */
export interface QueueStall {
  count: number
  /** Since when the oldest of them waits: its creation, or the end of its backoff. */
  since: Date
  /** The last call of a runner of the org or of the service, revoked ones aside. Null: never. */
  lastRunnerSeenAt: Date | null
}

export interface DashboardRunner {
  id: string
  name: string
  /** Null: a runner of the service. */
  orgId: string | null
  lastSeenAt: Date | null
  /** The jobs of the org that it runs now. */
  running: number
}

/** The runners in service of the org and of the service, by state, all of them (REV-37). */
export interface RunnerCounts {
  online: number
  late: number
  offline: number
}

/**
 * REV-26. What the list « Mise en route » reads, until the first review of the org is published:
 * the App, the providers, the runners and the repositories. The runners themselves are in
 * `DashboardScreen.runners`, the jobs in `DashboardScreen.queue`.
 */
export interface SetupState {
  /** A review of the org is published on GitHub: the list is not shown again. */
  published: boolean
  /** The installation of the App is suspended on GitHub. */
  suspended: boolean
  /** The repositories enabled on the Repos screen. */
  enabledRepos: number
  /** The providers of the org (REV-11). */
  providers: number
  /** The registration tokens of the org that are not used and not expired: a runner is on its way. */
  pendingRegistrations: number
}

export interface DashboardScreen {
  /** The clock of the database: every age on the screen has one clock. */
  now: Date
  banner: FailureBanner | null
  failures: FailedJob[]
  week: DayStats[]
  recent: RecentReview[]
  costs: OrgCostsDetail
  caps: OrgCaps
  queue: { running: QueueJob[]; queued: QueueJob[]; runningCount: number; queuedCount: number }
  /**
   * The runners of the card (REV-37): those late then online, up to `RUNNERS_LIMIT`, then the
   * offline ones, up to `OFFLINE_RUNNERS_LIMIT`. `runnerCounts` counts them all.
   */
  runners: DashboardRunner[]
  runnerCounts: RunnerCounts
  /** REV-52. Null: no job waits for too long. */
  stall: QueueStall | null
  /** The enabled repositories that still run the review workflow of GitHub Actions: no follow-up of findings. */
  workflowRepos: string[]
  setup: SetupState
}

export type RetryOutcome =
  | { kind: 'queued'; jobId: string }
  /** The pull request already has a job queued or running at this head and level. */
  | { kind: 'already'; jobId: string }
  /** A newer push replaced the head of the failed job: its review would be of an old head. */
  | { kind: 'stale' }
  /** The pull request is closed on GitHub. */
  | { kind: 'closed' }
  /** The org reached its cost limit of the day or of the month (REV-13). */
  | { kind: 'capped'; period: CapPeriod }
  /** No failed review job of the org with this id, a repository disabled, or an installation suspended. */
  | { kind: 'not_found' }

/** What a retry asks GitHub about: the pull request of a failed review job of the org. */
export interface RetryTarget {
  installationId: number
  githubRepoId: number
  fullName: string
  prNumber: number
  headSha: string
}

/** What the dashboard reads, and its one write: « Relancer ». Every query is for one org. */
export interface DashboardStore {
  screen(orgId: string): Promise<DashboardScreen>
  /** The pull request of a failed review job of the org. Null: no such job. */
  retryTarget(orgId: string, jobId: string): Promise<RetryTarget | null>
  /**
   * `githubHead`: the head of the pull request on GitHub now, or null when the service has no
   * GitHub App. A head that is not the one of the failed job makes the retry `stale`.
   */
  retry(orgId: string, jobId: string, level: Level, githubHead: string | null): Promise<RetryOutcome>
}

function num(value: string | number | null): number | null {
  return value === null ? null : Number(value)
}

export function createDashboardStore({ sql, db }: Pick<Database, 'sql' | 'db'>): DashboardStore {
  async function failures(orgId: string): Promise<FailedJob[]> {
    let rows = await sql<
      {
        id: string
        repoId: string
        repo: string
        prNumber: number
        kind: JobKind
        level: Level
        attempts: number
        reason: string | null
        runnerName: string | null
        finishedAt: Date | string | null
      }[]
    >`
      select jobs.id, jobs.repo_id as "repoId", repos.full_name as repo, jobs.pr_number as "prNumber", jobs.kind,
        jobs.level, jobs.attempts, jobs.failure_reason as reason, runners.name as "runnerName",
        jobs.finished_at as "finishedAt"
      from jobs
      join repos on repos.id = jobs.repo_id
      left join runners on runners.id = jobs.runner_id
      where repos.org_id = ${orgId} and jobs.state = 'failed'
        and jobs.finished_at > now() - ${`${FAILURE_SHOWN_DAYS} days`}::interval
      order by jobs.finished_at desc
      limit ${FAILURES_LIMIT}`
    return rows.map((row) => ({ ...row, attempts: Number(row.attempts), prNumber: Number(row.prNumber), finishedAt: toDate(row.finishedAt) }))
  }

  /**
   * The banner: the last failed review job whose pull request has no review published since. It
   * goes away when a later review of the pull request is published.
   */
  async function banner(list: FailedJob[]): Promise<FailureBanner | null> {
    for (let failed of list) {
      if (failed.kind !== 'review') continue
      let [state] = await sql<
        {
          laterPublished: boolean
          previousScore: number | null
          previousAt: Date | string | null
          retryId: string | null
          retryLevel: Level | null
          retryState: 'queued' | 'running' | null
        }[]
      >`
        select
          exists (
            select 1 from reviews r join jobs j on j.id = r.job_id
            where r.repo_id = ${failed.repoId} and r.pr_number = ${failed.prNumber}
              and r.published_at is not null and j.created_at > f.created_at
          ) as "laterPublished",
          prev.score as "previousScore", prev.published_at as "previousAt",
          retry.id as "retryId", retry.level as "retryLevel", retry.state as "retryState"
        from jobs f
        left join lateral (
          select r.score, r.published_at from reviews r
          where r.repo_id = f.repo_id and r.pr_number = f.pr_number and r.published_at is not null
            and r.published_at <= coalesce(f.finished_at, now())
          order by r.published_at desc limit 1
        ) prev on true
        left join lateral (
          select j.id, j.level, j.state from jobs j
          where j.repo_id = f.repo_id and j.pr_number = f.pr_number and j.kind = 'review'
            and j.state in ('queued', 'running') and j.created_at > f.created_at
          order by j.created_at desc limit 1
        ) retry on true
        where f.id = ${failed.id}`
      if (!state || state.laterPublished) continue
      let estimates = await sql<{ level: Level; mean: string | null }[]>`
        select levels.level, (
          select avg(sample.cost_usd) from (
            select r.cost_usd from reviews r join jobs j on j.id = r.job_id
            where r.repo_id = ${failed.repoId} and j.level = levels.level and r.cost_usd is not null
            order by r.created_at desc limit ${ESTIMATE_SAMPLE}
          ) sample
        ) as mean
        from unnest(enum_range(null::review_level)) as levels(level)`
      let byLevel = { lite: null, balanced: null, heavy: null } as Record<Level, number | null>
      for (let row of estimates) byLevel[row.level] = num(row.mean)
      return {
        ...failed,
        previous:
          state.previousScore !== null && state.previousAt !== null
            ? { score: Number(state.previousScore), publishedAt: toDate(state.previousAt) }
            : null,
        retry:
          state.retryId && state.retryLevel && state.retryState
            ? { id: state.retryId, level: state.retryLevel, state: state.retryState }
            : null,
        estimates: byLevel,
      }
    }
    return null
  }

  async function week(orgId: string): Promise<DayStats[]> {
    let rows = await sql<
      { day: string; lite: string; balanced: string; heavy: string; failed: string; meanMs: string | null }[]
    >`
      with days as (
        select generate_series(
          date_trunc('day', now() at time zone 'utc') - ${`${WEEK_DAYS - 1} days`}::interval,
          date_trunc('day', now() at time zone 'utc'),
          interval '1 day'
        ) as day
      ),
      published as (
        select date_trunc('day', r.published_at at time zone 'utc') as day, j.level,
          extract(epoch from (j.finished_at - j.started_at)) * 1000 as ms
        from reviews r
        join repos on repos.id = r.repo_id
        join jobs j on j.id = r.job_id
        where repos.org_id = ${orgId} and r.published_at is not null
          and r.created_at >= (select min(day) from days) at time zone 'utc' - interval '1 day'
          and r.published_at >= (select min(day) from days) at time zone 'utc'
      ),
      failed as (
        select date_trunc('day', j.finished_at at time zone 'utc') as day, count(*) as n
        from jobs j join repos on repos.id = j.repo_id
        where repos.org_id = ${orgId} and j.state = 'failed'
          and j.finished_at >= (select min(day) from days) at time zone 'utc'
        group by 1
      )
      select to_char(days.day, 'YYYY-MM-DD') as day,
        count(p.level) filter (where p.level = 'lite') as lite,
        count(p.level) filter (where p.level = 'balanced') as balanced,
        count(p.level) filter (where p.level = 'heavy') as heavy,
        coalesce(max(failed.n), 0) as failed,
        avg(p.ms) as "meanMs"
      from days
      left join published p on p.day = days.day
      left join failed on failed.day = days.day
      group by days.day
      order by days.day`
    return rows.map((row) => ({
      day: row.day,
      published: { lite: Number(row.lite), balanced: Number(row.balanced), heavy: Number(row.heavy) },
      failed: Number(row.failed),
      meanDurationMs: row.meanMs === null ? null : Math.round(Number(row.meanMs)),
    }))
  }

  async function recent(orgId: string): Promise<RecentReview[]> {
    let rows = await sql<
      {
        id: string
        repoId: string
        repo: string
        prNumber: number
        level: Level
        verdict: string | null
        score: number
        findings: number | null
        costUsd: string | null
        durationMs: string | null
        createdAt: Date | string
        publishedAt: Date | string | null
      }[]
    >`
      select r.id, r.repo_id as "repoId", repos.full_name as repo, r.pr_number as "prNumber", j.level, r.result->>'verdict' as verdict,
        r.score, jsonb_array_length(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) as findings,
        r.cost_usd as "costUsd",
        extract(epoch from (j.finished_at - j.started_at)) * 1000 as "durationMs",
        r.created_at as "createdAt", r.published_at as "publishedAt"
      from repos
      -- The last reviews of each repository through reviews_repo_created_at_idx, then the last of all.
      cross join lateral (
        select * from reviews where reviews.repo_id = repos.id order by reviews.created_at desc limit ${RECENT_LIMIT}
      ) r
      join jobs j on j.id = r.job_id
      where repos.org_id = ${orgId}
      order by r.created_at desc
      limit ${RECENT_LIMIT}`
    return rows.map((row) => ({
      ...row,
      prNumber: Number(row.prNumber),
      score: Number(row.score),
      findings: Number(row.findings ?? 0),
      costUsd: num(row.costUsd),
      durationMs: row.durationMs === null ? null : Math.round(Number(row.durationMs)),
      createdAt: toDate(row.createdAt),
      publishedAt: toDate(row.publishedAt),
    }))
  }

  async function queue(orgId: string): Promise<DashboardScreen['queue']> {
    let rows = await sql<
      {
        id: string
        state: 'queued' | 'running'
        repo: string
        prNumber: number
        kind: JobKind
        level: Level
        attempts: number
        createdAt: Date | string
        startedAt: Date | string | null
        leaseExpiresAt: Date | string | null
        notBefore: Date | string | null
        runnerName: string | null
        runnerSeenAt: Date | string | null
        total: string
      }[]
    >`
      select * from (
        select jobs.id, jobs.state, repos.full_name as repo, jobs.pr_number as "prNumber", jobs.kind, jobs.level,
          jobs.attempts, jobs.created_at as "createdAt", jobs.started_at as "startedAt",
          jobs.lease_expires_at as "leaseExpiresAt", jobs.not_before as "notBefore",
          runners.name as "runnerName", runners.last_seen_at as "runnerSeenAt",
          count(*) over (partition by jobs.state) as total,
          row_number() over (partition by jobs.state order by jobs.created_at, jobs.id) as rank
        from jobs
        join repos on repos.id = jobs.repo_id
        left join runners on runners.id = jobs.runner_id and jobs.state = 'running'
        where repos.org_id = ${orgId} and jobs.state in ('queued', 'running')
      ) ranked
      where rank <= ${QUEUE_LIMIT}
      order by state desc, rank`
    let out: DashboardScreen['queue'] = { running: [], queued: [], runningCount: 0, queuedCount: 0 }
    for (let { state, total, ...row } of rows) {
      let job: QueueJob = {
        ...row,
        prNumber: Number(row.prNumber),
        attempts: Number(row.attempts),
        createdAt: toDate(row.createdAt),
        startedAt: toDate(row.startedAt),
        leaseExpiresAt: toDate(row.leaseExpiresAt),
        notBefore: toDate(row.notBefore),
        runnerSeenAt: toDate(row.runnerSeenAt),
      }
      delete (job as Partial<{ rank: unknown }>).rank
      out[state].push(job)
      out[state === 'running' ? 'runningCount' : 'queuedCount'] = Number(total)
    }
    return out
  }

  async function runners(orgId: string): Promise<{ list: DashboardRunner[]; counts: RunnerCounts }> {
    // The states of runnerState() (app/ui/runners.tsx), in SQL: the card reads a bounded list, and the
    // counts of all the runners in service in the same query.
    let rows = await sql<
      {
        id: string
        name: string
        orgId: string | null
        lastSeenAt: Date | string | null
        running: string
        online: string
        late: string
        offline: string
      }[]
    >`
      with seen as (
        select runners.id, runners.name, runners.org_id, runners.last_seen_at,
          case
            -- Never seen: « offline », as runnerState() says for a null lastSeenAt.
            when runners.last_seen_at is null then 'offline'
            when runners.last_seen_at >= now() - ${`${ONLINE_SECONDS} seconds`}::interval then 'online'
            when runners.last_seen_at >= now() - ${`${OFFLINE_SECONDS} seconds`}::interval then 'late'
            else 'offline'
          end as state
        from runners
        where (runners.org_id = ${orgId} or runners.org_id is null) and runners.revoked_at is null
      ),
      ranked as (
        select seen.*,
          -- A late runner comes before the online ones: the limit never leaves it out.
          row_number() over (
            partition by state = 'offline'
            order by case state when 'late' then 0 when 'online' then 1 else 2 end, last_seen_at desc nulls last, name, id
          ) as n,
          count(*) filter (where state = 'online') over () as online,
          count(*) filter (where state = 'late') over () as late,
          count(*) filter (where state = 'offline') over () as offline
        from seen
      )
      select ranked.id, ranked.name, ranked.org_id as "orgId", ranked.last_seen_at as "lastSeenAt",
        ranked.online, ranked.late, ranked.offline,
        (select count(*) from jobs join repos on repos.id = jobs.repo_id
          where jobs.runner_id = ranked.id and jobs.state = 'running' and repos.org_id = ${orgId}) as running
      from ranked
      where ranked.n <= case when ranked.state = 'offline' then ${OFFLINE_RUNNERS_LIMIT}::int else ${RUNNERS_LIMIT}::int end
      order by case ranked.state when 'late' then 0 when 'online' then 1 else 2 end, ranked.n`
    let first = rows[0]
    return {
      list: rows.map(({ online: _online, late: _late, offline: _offline, ...row }) => ({
        ...row,
        lastSeenAt: toDate(row.lastSeenAt),
        running: Number(row.running),
      })),
      counts: { online: Number(first?.online ?? 0), late: Number(first?.late ?? 0), offline: Number(first?.offline ?? 0) },
    }
  }

  async function stall(orgId: string): Promise<QueueStall | null> {
    let [row] = await sql<{ count: string; since: Date | string | null; lastRunnerSeenAt: Date | string | null }[]>`
      select count(*) as count, min(coalesce(jobs.not_before, jobs.created_at)) as since,
        (select max(last_seen_at) from runners
          where (runners.org_id = ${orgId} or runners.org_id is null) and runners.revoked_at is null) as "lastRunnerSeenAt"
      from jobs
      join repos on repos.id = jobs.repo_id
      -- As the publisher: a job with no base is never claimed, and is no sign of a missing runner.
      where repos.org_id = ${orgId} and jobs.state = 'queued' and jobs.base_ref is not null
        and coalesce(jobs.not_before, jobs.created_at) < now() - ${`${QUEUE_STALL_MINUTES} minutes`}::interval`
    if (!row || Number(row.count) === 0 || row.since === null) return null
    return { count: Number(row.count), since: toDate(row.since), lastRunnerSeenAt: toDate(row.lastRunnerSeenAt) }
  }

  /** The cost limits of the org (REV-13). */
  async function readCaps(orgId: string): Promise<OrgCaps> {
    let [row] = await sql<{ daily: string | null; monthly: string | null; alert: number | null }[]>`
      select daily_cap_usd as daily, monthly_cap_usd as monthly, cap_alert_pct as alert from orgs where id = ${orgId}`
    return { dailyCapUsd: readMoney(row?.daily), monthlyCapUsd: readMoney(row?.monthly), alertPct: Number(row?.alert ?? 80) }
  }

  async function setup(orgId: string): Promise<SetupState> {
    let [row] = await sql<
      { published: boolean; suspended: boolean; enabledRepos: string; providers: string; pendingRegistrations: string }[]
    >`
      select
        exists (
          select 1 from reviews join repos on repos.id = reviews.repo_id
          where repos.org_id = ${orgId} and reviews.published_at is not null
        ) as published,
        (select suspended_at is not null from orgs where id = ${orgId}) as suspended,
        (select count(*) from repos where org_id = ${orgId} and enabled) as "enabledRepos",
        (select count(*) from providers where org_id = ${orgId}) as providers,
        (select count(*) from runner_registrations
          where org_id = ${orgId} and used_at is null and expires_at > now()) as "pendingRegistrations"`
    return {
      published: Boolean(row?.published),
      suspended: Boolean(row?.suspended),
      enabledRepos: Number(row?.enabledRepos ?? 0),
      providers: Number(row?.providers ?? 0),
      pendingRegistrations: Number(row?.pendingRegistrations ?? 0),
    }
  }

  return {
    async screen(orgId) {
      let [clock] = await sql<{ now: Date | string }[]>`select now() as now`
      let failed = await failures(orgId)
      let [bannerView, weekView, recentView, costs, caps, queueView, runnerViews, workflow, setupView, stallView] = await Promise.all([
        banner(failed),
        week(orgId),
        recent(orgId),
        readOrgCosts(db, orgId),
        readCaps(orgId),
        queue(orgId),
        runners(orgId),
        sql<{ fullName: string }[]>`
          select full_name as "fullName" from repos
          where org_id = ${orgId} and enabled and workflow in ('reusable', 'copy')
          order by full_name`,
        setup(orgId),
        stall(orgId),
      ])
      return {
        now: toDate(clock!.now),
        banner: bannerView,
        failures: failed,
        week: weekView,
        recent: recentView,
        costs,
        caps,
        queue: queueView,
        runners: runnerViews.list,
        runnerCounts: runnerViews.counts,
        stall: stallView,
        workflowRepos: workflow.map((row) => row.fullName),
        setup: setupView,
      }
    },

    async retryTarget(orgId, jobId) {
      let [row] = await sql<{ installationId: string; githubRepoId: string; fullName: string; prNumber: number; headSha: string }[]>`
        select orgs.github_installation_id as "installationId", repos.github_repo_id as "githubRepoId",
          repos.full_name as "fullName", jobs.pr_number as "prNumber", jobs.head_sha as "headSha"
        from jobs
        join repos on repos.id = jobs.repo_id
        join orgs on orgs.id = repos.org_id
        where jobs.id = ${jobId} and repos.org_id = ${orgId} and jobs.state = 'failed' and jobs.kind = 'review'`
      if (!row) return null
      return {
        installationId: Number(row.installationId),
        githubRepoId: Number(row.githubRepoId),
        fullName: row.fullName,
        prNumber: Number(row.prNumber),
        headSha: row.headSha,
      }
    },

    // « Relancer en <niveau> »: a new review job of the head and the base of the failed one, with the
    // config of today. As a command does, it skips the trigger, the paths and the monthly limit of
    // the repository: an admin asked for it.
    async retry(orgId, jobId, level, githubHead) {
      return db.transaction(async (tx) => {
        // The lock of the org first, as the upsert of a push or a command takes it: the check of the
        // cost limit of the org sees their jobs in the same order.
        await tx.execute(query`select 1 from orgs where id = ${orgId} for update`)
        // The lock of the repository orders this insert with a push and a command of the same
        // repository (they lock it too, by their upsert): the check of an active job sees theirs.
        // The base is the one of the failed job: a new base of the pull request moves it there (REV-57).
        let [failed] = await tx.execute<{
          repoId: string
          prNumber: number
          headSha: string
          baseRef: string | null
          orgConfig: unknown
          repoConfig: unknown
          configVersion: number
          defaultLevel: Level
          dailyCapUsd: string | null
          monthlyCapUsd: string | null
        }>(query`
          select jobs.repo_id as "repoId", jobs.pr_number as "prNumber", jobs.head_sha as "headSha", jobs.base_ref as "baseRef", orgs.config as "orgConfig", repos.config as "repoConfig", repos.config_version as "configVersion",
            repos.default_level as "defaultLevel", orgs.daily_cap_usd as "dailyCapUsd", orgs.monthly_cap_usd as "monthlyCapUsd"
          from jobs
          join repos on repos.id = jobs.repo_id
          join orgs on orgs.id = repos.org_id
          where jobs.id = ${jobId} and repos.org_id = ${orgId} and jobs.state = 'failed' and jobs.kind = 'review'
            and repos.enabled and orgs.suspended_at is null
          for update of repos`)
        if (!failed || failed.baseRef === null) return { kind: 'not_found' } as const
        // GitHub knows a push that Kentō did not get (a disabled repository, a lost delivery).
        if (githubHead !== null && githubHead !== failed.headSha) return { kind: 'stale' } as const
        let [newer] = await tx.execute(query`
          select 1 from jobs
          where repo_id = ${failed.repoId} and pr_number = ${failed.prNumber} and head_sha <> ${failed.headSha}
            and created_at > (select created_at from jobs where id = ${jobId})
          limit 1`)
        if (newer) return { kind: 'stale' } as const
        let [active] = await tx.execute<{ id: string }>(query`
          select id from jobs
          where repo_id = ${failed.repoId} and pr_number = ${failed.prNumber} and head_sha = ${failed.headSha}
            and kind = 'review' and level = ${level} and state in ('queued', 'running')
          limit 1`)
        if (active) return { kind: 'already', jobId: active.id } as const
        // REV-13. Like a command, a retry does not pass the cost limit of the org.
        let hit = await orgCapHit(tx, { id: orgId, dailyCapUsd: failed.dailyCapUsd, monthlyCapUsd: failed.monthlyCapUsd })
        if (hit) return { kind: 'capped', period: hit.period } as const
        let resolved = resolveConfig(readOverrides(failed.orgConfig), readOverrides(failed.repoConfig), failed.defaultLevel)
        let [job] = await insertReviewJob(tx, {
          repoId: failed.repoId,
          level,
          config: jobConfig(resolved, level, Number(failed.configVersion)),
          levelSource: 'retry',
          prNumber: Number(failed.prNumber),
          headSha: failed.headSha,
          baseRef: failed.baseRef,
        })
        if (!job) throw new Error('insert of the retry job returned no row')
        return { kind: 'queued', jobId: job.id } as const
      })
    },
  }
}
