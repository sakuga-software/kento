import type postgres from 'postgres'

import { CANCEL_REASON } from '../db/webhook-store.ts'
import type { DetectedWorkflow, WorkflowMode } from './workflow.ts'

/** The reviews that Kentō must publish in a row, with no failure and no double publication, before review.yml goes. */
export const SWITCH_TARGET = 20

export type Level = 'lite' | 'balanced' | 'heavy'

/** One row of the Repos screen. */
export interface RepoView {
  id: string
  githubRepoId: number
  fullName: string
  enabled: boolean
  defaultLevel: Level
  /** From GitHub at the last check; null before it. */
  private: boolean | null
  defaultBranch: string | null
  workflow: WorkflowMode | null
  workflowPath: string | null
  workflowRef: string | null
  workflowCheckedAt: Date | null
  /**
   * The reviews that Kentō published on GitHub since the last failed job or double publication of
   * the repository (all of them when there was none). The screen shows it up to `SWITCH_TARGET`.
   */
  streak: number
  /** What set the streak back to zero last, or null when nothing did. */
  resetBy: 'failure' | 'double' | null
  /** The pull request of the failed job or of the double publication that did it. */
  resetPr: number | null
  /** The last review that Kentō published on GitHub. */
  lastReview: { prNumber: number; score: number; model: string; publishedAt: Date } | null
}

/** What GitHub says about a repository of the installation, at a check of the Repos screen. */
export interface CheckedRepo {
  githubRepoId: number
  fullName: string
  private: boolean
  defaultBranch: string | null
  workflow: DetectedWorkflow
}

export interface ReposStore {
  /** The repositories of an org, by name. */
  list(orgId: string): Promise<RepoView[]>
  /**
   * Enables or disables a repository of the org. Disabling cancels its queued jobs: a running job
   * ends and its review is published, and the published reviews stay. Null: no such repository in
   * the org.
   */
  setEnabled(orgId: string, repoId: string, enabled: boolean): Promise<{ fullName: string; cancelled: number } | null>
  /**
   * Writes what GitHub said about the repositories of an org. A new repository comes in disabled; an
   * existing one keeps `enabled` and its level.
   */
  saveCheck(orgId: string, repos: CheckedRepo[]): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Row = Omit<RepoView, 'githubRepoId' | 'streak' | 'lastReview' | 'workflowCheckedAt'> & {
  githubRepoId: string
  streak: string | number
  workflowCheckedAt: Date | string | null
  lastPr: number | null
  lastScore: number | null
  lastModel: string | null
  lastPublishedAt: Date | string | null
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export function createReposStore(sql: postgres.Sql): ReposStore {
  return {
    async list(orgId) {
      // The streak starts after the last failed job, or after the last double publication: a second
      // review that Kentō published on the same head at the same level for a push (a command can ask
      // for a second one on purpose, with `force`).
      let rows = await sql<Row[]>`
        with failed as (
          -- The last one, and of two at the same instant the same one at every load (id desc).
          select distinct on (repo_id) repo_id, coalesce(finished_at, updated_at) as at, pr_number
          from jobs where state = 'failed' and repo_id in (select id from repos where org_id = ${orgId})
          order by repo_id, coalesce(finished_at, updated_at) desc, id desc
        ),
        doubled as (
          select distinct on (later.repo_id) later.repo_id, later.published_at as at, later.pr_number
          from reviews later
          join jobs later_job on later_job.id = later.job_id
          where later.github_review_id is not null
            and later_job.github_comment_id is null
            and later.repo_id in (select id from repos where org_id = ${orgId})
            and exists (
              select 1 from reviews earlier
              join jobs earlier_job on earlier_job.id = earlier.job_id
              where earlier.repo_id = later.repo_id and earlier.pr_number = later.pr_number
                and earlier.head_sha = later.head_sha and earlier_job.level = later_job.level
                and earlier.github_review_id is not null and earlier.id <> later.id
                and (earlier.published_at, earlier.id) < (later.published_at, later.id)
            )
          order by later.repo_id, later.published_at desc, later.id desc
        )
        select
          repos.id, repos.github_repo_id as "githubRepoId", repos.full_name as "fullName", repos.enabled,
          repos.default_level as "defaultLevel", repos.private, repos.default_branch as "defaultBranch",
          repos.workflow, repos.workflow_path as "workflowPath", repos.workflow_ref as "workflowRef",
          repos.workflow_checked_at as "workflowCheckedAt",
          case
            when failed.at is null and doubled.at is null then null
            when doubled.at is null or failed.at >= doubled.at then 'failure'
            else 'double'
          end as "resetBy",
          case
            when failed.at is null and doubled.at is null then null
            when doubled.at is null or failed.at >= doubled.at then failed.pr_number
            else doubled.pr_number
          end as "resetPr",
          (
            select count(*) from reviews
            where reviews.repo_id = repos.id and reviews.github_review_id is not null
              and reviews.published_at > coalesce(greatest(failed.at, doubled.at), '-infinity'::timestamptz)
          ) as streak,
          last.pr_number as "lastPr", last.score as "lastScore", last.model as "lastModel",
          last.published_at as "lastPublishedAt"
        from repos
        left join failed on failed.repo_id = repos.id
        left join doubled on doubled.repo_id = repos.id
        left join lateral (
          select pr_number, score, model, published_at from reviews
          where reviews.repo_id = repos.id and reviews.github_review_id is not null
          order by published_at desc limit 1
        ) last on true
        where repos.org_id = ${orgId}
        order by lower(repos.full_name)
      `
      return rows.map(({ lastPr, lastScore, lastModel, lastPublishedAt, ...row }) => ({
        ...row,
        githubRepoId: Number(row.githubRepoId),
        streak: Number(row.streak),
        workflowCheckedAt: row.workflowCheckedAt === null ? null : toDate(row.workflowCheckedAt),
        lastReview:
          lastPr !== null && lastScore !== null && lastModel !== null && lastPublishedAt !== null
            ? { prNumber: lastPr, score: lastScore, model: lastModel, publishedAt: toDate(lastPublishedAt) }
            : null,
      }))
    },

    async setEnabled(orgId, repoId, enabled) {
      if (!UUID.test(repoId)) return null
      return sql.begin(async (tx) => {
        // The lock orders the change with the enqueue of a push, which locks the same row: a push
        // after the commit sees the new value, and a job queued before it is cancelled below.
        let [repo] = await tx<{ fullName: string }[]>`
          select full_name as "fullName" from repos where id = ${repoId} and org_id = ${orgId} for update`
        if (!repo) return null
        await tx`update repos set enabled = ${enabled}, updated_at = now() where id = ${repoId}`
        if (enabled) return { fullName: repo.fullName, cancelled: 0 }
        let cancelled = await tx`
          update jobs set state = 'cancelled', finished_at = now(), failure_reason = ${CANCEL_REASON.disabled}, updated_at = now()
          where repo_id = ${repoId} and state = 'queued'
          returning id`
        return { fullName: repo.fullName, cancelled: cancelled.length }
      })
    },

    async saveCheck(orgId, checked) {
      if (checked.length === 0) return
      let unique = [...new Map(checked.map((repo) => [repo.githubRepoId, repo])).values()]
      let now = new Date().toISOString()
      let rows = unique.map((repo) => ({
        org_id: orgId,
        github_repo_id: repo.githubRepoId,
        full_name: repo.fullName,
        private: repo.private,
        default_branch: repo.defaultBranch,
        workflow: repo.workflow.mode,
        workflow_path: repo.workflow.path,
        workflow_ref: repo.workflow.ref,
        workflow_checked_at: now,
      }))
      await sql`
        insert into repos ${sql(rows, 'org_id', 'github_repo_id', 'full_name', 'private', 'default_branch', 'workflow', 'workflow_path', 'workflow_ref', 'workflow_checked_at')}
        on conflict (github_repo_id) do update set
          org_id = excluded.org_id, full_name = excluded.full_name, private = excluded.private,
          default_branch = excluded.default_branch, workflow = excluded.workflow,
          workflow_path = excluded.workflow_path, workflow_ref = excluded.workflow_ref,
          workflow_checked_at = excluded.workflow_checked_at, updated_at = now()
      `
    },
  }
}
