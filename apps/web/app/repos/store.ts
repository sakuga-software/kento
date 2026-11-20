import { UUID as LOWER_UUID, type Level } from '@sakuga-review/protocol'
import type postgres from 'postgres'

import { toDate } from '../db/rows.ts'
import { CANCEL_REASON } from '../db/webhook-store.ts'
import type { DetectedWorkflow, WorkflowMode } from './workflow.ts'

/** The reviews that Kentō must publish in a row, with no failure and no double publication, before review.yml goes. */
export const SWITCH_TARGET = 20

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
   * the repository (all of them when there was none), counted up to `SWITCH_TARGET` (REV-36).
   */
  streak: number
  /** What set the streak back to zero last; null when nothing did, or at `SWITCH_TARGET`. */
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

/** The filters of the Repos screen (REV-36). "To switch": review.yml is still in the repository. */
export type RepoFilter = 'all' | 'enabled' | 'disabled' | 'switching'

export const REPO_FILTERS: readonly RepoFilter[] = ['all', 'enabled', 'disabled', 'switching']

/** The rows of one page of the Repos screen. */
export const REPOS_PAGE_SIZE = 50

/** What the Repos screen asks for: a filter, a part of the name, and a page. */
export interface RepoListQuery {
  filter?: RepoFilter
  /** A part of `owner/name`, any case. */
  search?: string
  /** The rows after this repository, in the order of the screen (the next page). */
  after?: string | null
  /** The rows before this repository (the previous page). Ignored with `after`. */
  before?: string | null
  /** `REPOS_PAGE_SIZE` by default. */
  limit?: number
}

/** One page of the Repos screen, and the counts of the whole org. */
export interface RepoPage {
  rows: RepoView[]
  /** The repositories of the org, by filter, with no search. */
  counts: Record<RepoFilter, number>
  /** The repositories that match the filter and the search. */
  matching: number
  /** The rows of the filter and the search before this page: the first row is number `offset + 1`. */
  offset: number
  /** `after` of the next page, or null on the last one. */
  next: string | null
  /** `before` of the previous page, or null on the first one. */
  previous: string | null
  /** The oldest check of a repository of the org on GitHub; null before the first one. */
  checkedAt: Date | null
  /** A repository of the org was never checked. */
  unchecked: boolean
}

export interface ReposStore {
  /**
   * One page of the repositories of an org: the enabled ones first, then by name. The streak and
   * the last review are read for the rows of the page only.
   */
  list(orgId: string, query?: RepoListQuery): Promise<RepoPage>
  /** The `owner/name` of a repository of the org, or null. */
  fullName(orgId: string, repoId: string): Promise<string | null>
  /**
   * Enables or disables a repository of the org. Disabling cancels its queued jobs: a running job
   * ends and its review is published, and the published reviews stay. Null: no such repository in
   * the org.
   */
  setEnabled(orgId: string, repoId: string, enabled: boolean): Promise<{ fullName: string; cancelled: number } | null>
  /**
   * Writes what GitHub said about the repositories of an installation of an org. A new repository
   * comes in disabled; an existing one keeps `enabled` and its level.
   */
  saveCheck(installation: { orgId: string; installationId: string }, repos: CheckedRepo[]): Promise<void>
}

// Postgres reads a uuid in any case: an id in upper case finds the row too.
const UUID = new RegExp(LOWER_UUID.source, 'i')

type Row = Omit<RepoView, 'githubRepoId' | 'streak' | 'lastReview' | 'workflowCheckedAt'> & {
  githubRepoId: string
  streak: string | number
  workflowCheckedAt: Date | string | null
  lastPr: number | null
  lastScore: number | null
  lastModel: string | null
  lastPublishedAt: Date | string | null
}

/** `%`, `_` and `\\` stand for themselves in a search. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

interface CountRow {
  all: string | number
  enabled: string | number
  disabled: string | number
  switching: string | number
  matching: string | number
  offset: string | number
  checkedAt: Date | string | null
  unchecked: boolean
}

export function createReposStore(sql: postgres.Sql): ReposStore {
  return {
    async list(orgId, query = {}) {
      let filter = query.filter ?? 'all'
      let search = query.search?.trim().toLowerCase() ?? ''
      let limit = query.limit ?? REPOS_PAGE_SIZE
      let after = query.after && UUID.test(query.after) ? query.after : null
      let before = !after && query.before && UUID.test(query.before) ? query.before : null
      let cursor = after ?? before

      // The order of the screen: the enabled repositories first, then by name. The id breaks a tie,
      // so that the key of a row is unique and a page starts where the last one ended (keyset).
      let key = sql`(not repos.enabled, lower(repos.full_name), repos.id)`
      let matches = sql`
        ${filter === 'enabled' ? sql`and repos.enabled` : filter === 'disabled' ? sql`and not repos.enabled` : sql``}
        ${filter === 'switching' ? sql`and repos.workflow in ('reusable', 'copy')` : sql``}
        ${search ? sql`and lower(repos.full_name) like ${likePattern(search)}` : sql``}`
      let from = cursor
        ? sql`and ${key} ${after ? sql`>` : sql`<`} (
            select not enabled, lower(full_name), id from repos where id = ${cursor} and org_id = ${orgId})`
        : sql``

      // The page comes first: the streak, the reset and the last review are read for its rows only.
      // Each lateral reads the reviews and jobs of one repository, by its indexes: the time of the
      // screen does not grow with the history of the other repositories, nor of the other orgs.
      //
      // The streak starts after the last failed job, or after the last double publication: a second
      // review that Kentō published on the same head at the same level for a push (a command can ask
      // for a second one on purpose, with `force`).
      //
      // The laterals make the estimated cost of the plan high (one per row), and Postgres would spend
      // more time on its JIT than on the query.
      let { rows, more, counts } = await sql.begin(async (tx) => {
        await tx`set local jit = off`
        let fetched = await tx<Row[]>`
          with page as (
            select * from repos
            where repos.org_id = ${orgId} ${matches} ${from}
            order by ${before ? sql`not repos.enabled desc, lower(repos.full_name) desc, repos.id desc` : sql`not repos.enabled, lower(repos.full_name), repos.id`}
            limit ${limit + 1}
          )
          select
            page.id, page.github_repo_id as "githubRepoId", page.full_name as "fullName", page.enabled,
            page.default_level as "defaultLevel", page.private, page.default_branch as "defaultBranch",
            page.workflow, page.workflow_path as "workflowPath", page.workflow_ref as "workflowRef",
            page.workflow_checked_at as "workflowCheckedAt",
            -- A reset before the last SWITCH_TARGET reviews no longer counts: the switch is done.
            case
              when recent.streak >= ${SWITCH_TARGET} or (failed.at is null and recent.doubled_at is null) then null
              when recent.doubled_at is null or failed.at >= recent.doubled_at then 'failure'
              else 'double'
            end as "resetBy",
            case
              when recent.streak >= ${SWITCH_TARGET} or (failed.at is null and recent.doubled_at is null) then null
              when recent.doubled_at is null or failed.at >= recent.doubled_at then failed.pr_number
              else recent.doubled_pr
            end as "resetPr",
            coalesce(recent.streak, 0) as streak,
            recent.last_pr as "lastPr", recent.last_score as "lastScore", recent.last_model as "lastModel",
            recent.last_published_at as "lastPublishedAt"
          from page
          left join lateral (
            -- The last one, and of two at the same instant the same one at every load (id desc).
            select coalesce(finished_at, updated_at) as at, pr_number from jobs
            where jobs.repo_id = page.id and jobs.state = 'failed'
            order by coalesce(finished_at, updated_at) desc, id desc
            limit 1
          ) failed on true
          left join lateral (
            -- The last SWITCH_TARGET reviews that Kentō published: the streak counts up to its target,
            -- so an older review changes nothing on screen.
            with recent as (
              select recent.*, jobs.level, jobs.github_comment_id
              from (
                select id, job_id, pr_number, head_sha, score, model, published_at from reviews
                where reviews.repo_id = page.id and reviews.github_review_id is not null
                order by published_at desc, id desc
                limit ${SWITCH_TARGET}
              ) recent
              join jobs on jobs.id = recent.job_id
            ),
            doubled as (
              -- Only a double publication after the last failed job can set the streak back.
              select later.published_at as at, later.pr_number from recent later
              where later.github_comment_id is null
                and later.published_at > coalesce(failed.at, '-infinity'::timestamptz)
                and exists (
                  select 1 from reviews earlier
                  join jobs earlier_job on earlier_job.id = earlier.job_id
                  where earlier.repo_id = page.id and earlier.pr_number = later.pr_number
                    and earlier.head_sha = later.head_sha and earlier_job.level = later.level
                    and earlier.github_review_id is not null and earlier.id <> later.id
                    and (earlier.published_at, earlier.id) < (later.published_at, later.id)
                )
              order by later.published_at desc, later.id desc
              limit 1
            ),
            last as (
              select pr_number, score, model, published_at from recent order by published_at desc, id desc limit 1
            )
            select
              (
                select count(*) from recent
                where recent.published_at > coalesce(greatest(failed.at, (select at from doubled)), '-infinity'::timestamptz)
              ) as streak,
              (select at from doubled) as doubled_at,
              (select pr_number from doubled) as doubled_pr,
              last.pr_number as last_pr, last.score as last_score, last.model as last_model, last.published_at as last_published_at
            from (select 1) one
            left join last on true
          ) recent on true
        `
        let more = fetched.length > limit
        let rows = fetched.slice(0, limit)
        if (before) rows.reverse()

        let first = rows[0]?.id ?? null
        let [counts] = await tx<CountRow[]>`
          select
            count(*) as "all",
            count(*) filter (where repos.enabled) as enabled,
            count(*) filter (where not repos.enabled) as disabled,
            count(*) filter (where repos.workflow in ('reusable', 'copy')) as switching,
            count(*) filter (where true ${matches}) as matching,
            count(*) filter (where true ${matches} and ${key} < (
              select not enabled, lower(full_name), id from repos where id = ${first} and org_id = ${orgId})) as "offset",
            min(repos.workflow_checked_at) as "checkedAt",
            coalesce(bool_or(repos.workflow_checked_at is null), false) as unchecked
          from repos where repos.org_id = ${orgId}
        `
        return { rows, more, counts: counts! }
      })
      let first = rows[0]?.id ?? null
      let last = rows.at(-1)?.id ?? null
      return {
        rows: rows.map(({ lastPr, lastScore, lastModel, lastPublishedAt, ...row }) => ({
          ...row,
          githubRepoId: Number(row.githubRepoId),
          streak: Number(row.streak),
          workflowCheckedAt: row.workflowCheckedAt === null ? null : toDate(row.workflowCheckedAt),
          lastReview:
            lastPr !== null && lastScore !== null && lastModel !== null && lastPublishedAt !== null
              ? { prNumber: lastPr, score: lastScore, model: lastModel, publishedAt: toDate(lastPublishedAt) }
              : null,
        })),
        counts: {
          all: Number(counts.all),
          enabled: Number(counts.enabled),
          disabled: Number(counts.disabled),
          switching: Number(counts.switching),
        },
        matching: Number(counts.matching),
        offset: Number(counts.offset),
        // Going back, the extra row says that there is a page before; going forward, one after.
        next: (before ? cursor !== null : more) ? last : null,
        previous: (before ? more : after !== null) && first !== null ? first : null,
        checkedAt: counts.checkedAt === null ? null : toDate(counts.checkedAt),
        unchecked: counts.unchecked,
      }
    },

    async fullName(orgId, repoId) {
      if (!UUID.test(repoId)) return null
      let [repo] = await sql<{ fullName: string }[]>`
        select full_name as "fullName" from repos where id = ${repoId} and org_id = ${orgId}`
      return repo?.fullName ?? null
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

    async saveCheck({ orgId, installationId }, checked) {
      if (checked.length === 0) return
      let unique = [...new Map(checked.map((repo) => [repo.githubRepoId, repo])).values()]
      let now = new Date().toISOString()
      let rows = unique.map((repo) => ({
        org_id: orgId,
        installation_id: installationId,
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
        insert into repos ${sql(rows, 'org_id', 'installation_id', 'github_repo_id', 'full_name', 'private', 'default_branch', 'workflow', 'workflow_path', 'workflow_ref', 'workflow_checked_at')}
        on conflict (github_repo_id) do update set
          org_id = excluded.org_id, installation_id = excluded.installation_id, full_name = excluded.full_name, private = excluded.private,
          default_branch = excluded.default_branch, workflow = excluded.workflow,
          workflow_path = excluded.workflow_path, workflow_ref = excluded.workflow_ref,
          workflow_checked_at = excluded.workflow_checked_at, updated_at = now()
      `
    },
  }
}
