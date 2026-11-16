// REV-17. "Run again at <level>" on the screen of a pull request: a new review job of its last head,
// at the level that an admin chooses, with an estimate of its cost. A newer push cancels it, as it
// cancels every job of an older head (app/db/webhook-store.ts, `cancelActive`).
import type { Level } from '@sakuga-review/protocol'
import type postgres from 'postgres'

import { ESTIMATE_SAMPLE } from '../dashboard/store.ts'
import { executorOf } from '../db/client.ts'
import { readOrgCosts } from '../db/costs.ts'
import { capReached, readMoney, type CapPeriod } from '../org-settings/model.ts'
import { jobConfig, readOverrides, resolveConfig } from '../repo-config/model.ts'

export type RerunOutcome =
  | { kind: 'queued'; jobId: string }
  /** A review job of this head and level is already queued or running. */
  | { kind: 'already'; jobId: string }
  /** GitHub knows a newer head than the last job of Kentō: its push will be reviewed, not this one. */
  | { kind: 'stale' }
  /** The pull request is closed on GitHub. */
  | { kind: 'closed' }
  /** The org reached its cost limit of the day or of the month (REV-13). */
  | { kind: 'capped'; period: CapPeriod }
  /** No job for this pull request in the org, the repository disabled, or the installation suspended. */
  | { kind: 'not_found' }

/** The mean cost of the last reviews of each level on the repository, or null for a level with none. */
export async function readEstimates(sql: postgres.Sql, repoId: string): Promise<Record<Level, number | null>> {
  let rows = await sql<{ level: Level; mean: string | null }[]>`
    select levels.level, (
      select avg(sample.cost_usd)::text from (
        select r.cost_usd from reviews r join jobs j on j.id = r.job_id
        where r.repo_id = ${repoId} and j.level = levels.level and r.cost_usd is not null
        order by r.created_at desc limit ${ESTIMATE_SAMPLE}
      ) sample
    ) as mean
    from unnest(enum_range(null::review_level)) as levels(level)`
  let out = { lite: null, balanced: null, heavy: null } as Record<Level, number | null>
  for (let row of rows) out[row.level] = row.mean === null ? null : Number(row.mean)
  return out
}

/**
 * Queues a review of the last head of the pull request at `level`, with the config of today. As a
 * command does, it skips the trigger, the paths and the monthly limit of the repository (an admin
 * asked for it), and it does not pass the cost limit of the org. `githubHead`: the head on GitHub now,
 * or null without the GitHub App.
 */
export async function rerunReview(
  sql: postgres.Sql,
  input: { orgId: string; repoId: string; prNumber: number; level: Level; githubHead: string | null },
): Promise<RerunOutcome> {
  return sql.begin(async (tx) => {
    // The lock of the org, then of the repository, in the order of a push and of a command: the
    // checks below see their jobs.
    await tx`select 1 from orgs where id = ${input.orgId} for update`
    let [repo] = await tx<
      { orgConfig: unknown; repoConfig: unknown; configVersion: number; defaultLevel: Level; dailyCapUsd: string | null; monthlyCapUsd: string | null }[]
    >`
      select orgs.config as "orgConfig", repos.config as "repoConfig", repos.config_version as "configVersion",
        repos.default_level as "defaultLevel", orgs.daily_cap_usd as "dailyCapUsd", orgs.monthly_cap_usd as "monthlyCapUsd"
      from repos join orgs on orgs.id = repos.org_id
      where repos.id = ${input.repoId} and repos.org_id = ${input.orgId} and repos.enabled and orgs.suspended_at is null
      for update of repos`
    if (!repo) return { kind: 'not_found' } as const
    let [last] = await tx<{ headSha: string; baseRef: string | null }[]>`
      select head_sha as "headSha", base_ref as "baseRef" from jobs
      where repo_id = ${input.repoId} and pr_number = ${input.prNumber}
      order by created_at desc limit 1`
    if (!last || last.baseRef === null) return { kind: 'not_found' } as const
    if (input.githubHead !== null && input.githubHead !== last.headSha) return { kind: 'stale' } as const
    let [active] = await tx<{ id: string }[]>`
      select id from jobs
      where repo_id = ${input.repoId} and pr_number = ${input.prNumber} and head_sha = ${last.headSha}
        and kind = 'review' and level = ${input.level} and state in ('queued', 'running')
      limit 1`
    if (active) return { kind: 'already', jobId: active.id } as const
    let limits = { dailyCapUsd: readMoney(repo.dailyCapUsd), monthlyCapUsd: readMoney(repo.monthlyCapUsd) }
    if (limits.dailyCapUsd !== null || limits.monthlyCapUsd !== null) {
      let hit = capReached(limits, await readOrgCosts(executorOf(tx), input.orgId), new Date())
      if (hit) return { kind: 'capped', period: hit.period } as const
    }
    let resolved = resolveConfig(readOverrides(repo.orgConfig), readOverrides(repo.repoConfig), repo.defaultLevel)
    let config = jobConfig(resolved, input.level, Number(repo.configVersion))
    let [job] = await tx<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, config, level_source)
      values (${input.repoId}, 'review', ${input.level}, 'queued', ${input.prNumber}, ${last.headSha}, ${last.baseRef},
        ${JSON.stringify(config)}::text::jsonb, 'command')
      returning id`
    return { kind: 'queued', jobId: job!.id } as const
  })
}
