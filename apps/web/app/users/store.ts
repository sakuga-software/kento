// REV-22. The screen of a user: their preferences for the reviews of their own pull requests, the
// findings that those pull requests received, and the pull requests that Kentō reviewed. Every read
// is for one org; the author of a pull request comes from `pull_authors`.
import { isLevel, type Level } from '@kento-review/protocol'
import type postgres from 'postgres'

import { countsSql } from '../db/review-count.ts'
import { toDate } from '../db/rows.ts'
import { CANCEL_REASON } from '../db/webhook-store.ts'
import { listFindingScreen, type FindingView } from '../findings/screen.ts'
import type { OrgRole } from '../db/schema.ts'

/** The days of "Findings received". The link to the Findings screen carries the same period. */
export const RECEIVED_DAYS = 30
/** The pull requests of "My reviewed PRs" at first, and each "Show N more PRs". */
export const PULLS_STEP = 10
/** The most pull requests that one page shows. */
export const PULLS_MAX = 200

export interface UserPref {
  autoReview: boolean
  /** Null: the level of the repository. */
  level: Level | null
}

export interface RepoPref extends UserPref {
  repoId: string
  fullName: string
}

export interface ReviewedPull {
  repoId: string
  repo: string
  prNumber: number
  /** `closed`: the last job of the pull request was cancelled by its close. */
  state: 'open' | 'closed'
  /** KNT-175. The reviews of Kentō on the pull request that count (db/review-count.ts): no copy. */
  reviews: number
  findings: { open: number; fixed: number; dismissed: number; wontfix: number; stale: number }
  /** The verdict and the score of the last published review. */
  verdict: string | null
  score: number | null
  lastReviewAt: Date
}

export interface UserScreen {
  user: { id: string; githubId: number; login: string; name: string | null; avatarUrl: string | null }
  /** The role in the org on screen. */
  role: OrgRole
  prefs: { global: UserPref | null; repos: RepoPref[] }
  /** The enabled repositories of the org without a preference of the user: the choices of "Add a repo". */
  addable: { id: string; fullName: string }[]
  /** The findings of their pull requests over RECEIVED_DAYS days, by status: the counts of the Findings screen. */
  received: Record<FindingView, number>
  pulls: { rows: ReviewedPull[]; total: number }
}

export type PrefChange =
  | { outcome: 'saved' }
  /** The repository is not an enabled repository of the org. */
  | { outcome: 'not_found' }

export interface UsersStore {
  /** The member of the org with this login, any case. Null: no such member. */
  member(orgId: string, login: string): Promise<{ id: string; login: string } | null>
  /** The screen of the member of the org with this login, any case. Null: no such member. */
  screen(orgId: string, login: string, pulls?: number): Promise<UserScreen | null>
  /** Sets the preferences of the user, for every repository (`repoId` null) or for one repository of the org. */
  savePref(orgId: string, userId: string, repoId: string | null, pref: UserPref): Promise<PrefChange>
  /** Removes the preferences of the user for one repository: those for every repository apply again. */
  removePref(userId: string, repoId: string): Promise<void>
}

type PullRow = Omit<ReviewedPull, 'lastReviewAt' | 'findings' | 'reviews' | 'prNumber' | 'score'> & {
  prNumber: number | string
  reviews: number | string
  score: number | string | null
  lastReviewAt: Date | string
  open: string
  fixed: string
  dismissed: string
  wontfix: string
  stale: string
  total: string
}

export function createUsersStore(sql: postgres.Sql): UsersStore {
  // A login is unique on GitHub, but a renamed account can leave an old row with the same login: the
  // last one signed in is the person.
  async function member(orgId: string, login: string) {
    let [user] = await sql<(UserScreen['user'] & { githubId: string | number; role: OrgRole })[]>`
      select users.id, users.github_id as "githubId", users.login, users.name, users.avatar_url as "avatarUrl", memberships.role
      from users
      join memberships on memberships.user_id = users.id and memberships.org_id = ${orgId}
      where lower(users.login) = lower(${login})
      order by users.last_sign_in_at desc nulls last
      limit 1`
    return user ?? null
  }

  return {
    async member(orgId, login) {
      let user = await member(orgId, login)
      return user ? { id: user.id, login: user.login } : null
    },

    async screen(orgId, login, pulls = PULLS_STEP) {
      let limit = Math.min(PULLS_MAX, Math.max(PULLS_STEP, Math.trunc(Number.isFinite(pulls) ? pulls : PULLS_STEP)))
      let user = await member(orgId, login)
      if (!user) return null
      let githubId = Number(user.githubId)

      let prefRows = await sql<{ repoId: string | null; fullName: string | null; autoReview: boolean; level: string | null }[]>`
        select user_prefs.repo_id as "repoId", repos.full_name as "fullName", user_prefs.auto_review as "autoReview", user_prefs.level
        from user_prefs
        left join repos on repos.id = user_prefs.repo_id
        where user_prefs.user_id = ${user.id} and (user_prefs.repo_id is null or repos.org_id = ${orgId})
        order by user_prefs.repo_id is not null, lower(repos.full_name)`
      let levelOf = (value: string | null): Level | null => (value !== null && isLevel(value) ? value : null)
      let global = prefRows.find((row) => row.repoId === null)
      let repoPrefs = prefRows
        .filter((row) => row.repoId !== null)
        .map((row) => ({ repoId: row.repoId!, fullName: row.fullName!, autoReview: row.autoReview, level: levelOf(row.level) }))

      let addable = await sql<{ id: string; fullName: string }[]>`
        select repos.id, repos.full_name as "fullName" from repos
        where repos.org_id = ${orgId} and repos.enabled
          and not exists (select 1 from user_prefs where user_prefs.user_id = ${user.id} and user_prefs.repo_id = repos.id)
        order by lower(repos.full_name), repos.id`

      // The same query as the Findings screen with "?author=<login>&days=30": the counts are its tabs.
      let received = (await listFindingScreen(sql, orgId, { author: user.login, days: RECEIVED_DAYS, limit: 1 })).counts

      let rows = await sql<PullRow[]>`
        with mine as (
          select pull_authors.repo_id, pull_authors.pr_number, repos.full_name
          from pull_authors
          join repos on repos.id = pull_authors.repo_id
          where pull_authors.github_id = ${githubId} and repos.org_id = ${orgId}
        ),
        -- KNT-175. A pull request with a review on GitHub. Its count is the rule of db/review-count.ts,
        -- as on its own screen and in the request for feedback: a copy (REV-89) does not count.
        -- The date, the verdict and the score are those of the last review on GitHub, a copy included:
        -- a copy is the review of a newer head, and it has the score and the verdict of its source,
        -- the last review that counts.
        reviewed as (
          select mine.repo_id, mine.pr_number, mine.full_name,
            count(*) filter (where ${sql.unsafe(countsSql())}) as reviews, max(reviews.published_at) as last_review_at
          from mine
          join reviews on reviews.repo_id = mine.repo_id and reviews.pr_number = mine.pr_number and reviews.github_review_id is not null
          group by mine.repo_id, mine.pr_number, mine.full_name
        ),
        page as (
          select reviewed.*, count(*) over () as total from reviewed
          order by reviewed.last_review_at desc, reviewed.repo_id, reviewed.pr_number
          limit ${limit}
        )
        select page.repo_id as "repoId", page.full_name as repo, page.pr_number as "prNumber", page.reviews,
          page.last_review_at as "lastReviewAt", page.total,
          last.verdict, last.score,
          case when closed.failure_reason = ${CANCEL_REASON.closed} and closed.state = 'cancelled' then 'closed' else 'open' end as state,
          coalesce(f.open, 0) as open, coalesce(f.fixed, 0) as fixed, coalesce(f.dismissed, 0) as dismissed,
          coalesce(f.wontfix, 0) as wontfix, coalesce(f.stale, 0) as stale
        from page
        cross join lateral (
          select reviews.result->>'verdict' as verdict, reviews.score from reviews
          where reviews.repo_id = page.repo_id and reviews.pr_number = page.pr_number and reviews.github_review_id is not null
          order by reviews.published_at desc, reviews.created_at desc limit 1
        ) last
        left join lateral (
          select jobs.state, jobs.failure_reason from jobs
          where jobs.repo_id = page.repo_id and jobs.pr_number = page.pr_number
          order by jobs.created_at desc, jobs.id desc limit 1
        ) closed on true
        left join lateral (
          select
            count(*) filter (where findings.status = 'open') as open,
            count(*) filter (where findings.status = 'fixed') as fixed,
            count(*) filter (where findings.status = 'dismissed') as dismissed,
            count(*) filter (where findings.status = 'wontfix') as wontfix,
            count(*) filter (where findings.status = 'stale') as stale
          from findings where findings.repo_id = page.repo_id and findings.pr_number = page.pr_number
        ) f on true
        order by page.last_review_at desc, page.repo_id, page.pr_number`

      return {
        user: { id: user.id, githubId, login: user.login, name: user.name, avatarUrl: user.avatarUrl },
        role: user.role,
        prefs: { global: global ? { autoReview: global.autoReview, level: levelOf(global.level) } : null, repos: repoPrefs },
        addable,
        received,
        pulls: {
          total: Number(rows[0]?.total ?? 0),
          rows: rows.map((row) => ({
            repoId: row.repoId,
            repo: row.repo,
            prNumber: Number(row.prNumber),
            state: row.state,
            reviews: Number(row.reviews),
            findings: {
              open: Number(row.open),
              fixed: Number(row.fixed),
              dismissed: Number(row.dismissed),
              wontfix: Number(row.wontfix),
              stale: Number(row.stale),
            },
            verdict: row.verdict,
            score: row.score === null ? null : Number(row.score),
            lastReviewAt: toDate(row.lastReviewAt),
          })),
        },
      }
    },

    async savePref(orgId, userId, repoId, pref) {
      if (repoId === null) {
        await sql`
          insert into user_prefs (user_id, repo_id, auto_review, level)
          values (${userId}, null, ${pref.autoReview}, ${pref.level})
          on conflict (user_id) where repo_id is null
          do update set auto_review = excluded.auto_review, level = excluded.level, updated_at = now()`
        return { outcome: 'saved' }
      }
      let saved = await sql`
        insert into user_prefs (user_id, repo_id, auto_review, level)
        select ${userId}, repos.id, ${pref.autoReview}, ${pref.level} from repos
        where repos.id = ${repoId} and repos.org_id = ${orgId} and repos.enabled
        on conflict (user_id, repo_id) where repo_id is not null
        do update set auto_review = excluded.auto_review, level = excluded.level, updated_at = now()
        returning id`
      return saved.length ? { outcome: 'saved' } : { outcome: 'not_found' }
    },

    async removePref(userId, repoId) {
      await sql`delete from user_prefs where user_id = ${userId} and repo_id = ${repoId}`
    },
  }
}
