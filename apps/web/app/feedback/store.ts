// REV-107. The requests for feedback and the answers, in Postgres.
import { UUID } from '@kento-review/protocol'
import type postgres from 'postgres'

import { toDate } from '../db/rows.ts'
import { cursorAt, decodeCursor, encodeCursor, type Cursor } from '../findings/store.ts'
import { FEEDBACK_AFTER_REVIEWS } from './request.ts'

export const FEEDBACK_SOURCES = ['command', 'quote', 'reaction'] as const
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number]

/** Who answered: a person, or an agent (a bot account). */
export const FEEDBACK_KINDS = ['person', 'agent'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

/** The answers on one page of the screen. */
export const FEEDBACK_PAGE_SIZE = 25

export interface FeedbackInput {
  repoId: string
  prNumber: number
  authorLogin: string
  authorIsBot: boolean
  source: FeedbackSource
  text: string
  url: string | null
  /** Exactly one of the two ids. */
  githubCommentId?: number
  githubReactionId?: number
  createdAt: Date | null
}

/**
 * Writes the row of the request when the pull request has at least FEEDBACK_AFTER_REVIEWS published
 * reviews and no request yet. KNT-157: a copy of an earlier review on a head with no changed reviewed
 * file (`result.reusedFrom`, REV-89) does not count. It has the `github_review_id` of its source, but no
 * model read the code for it. A pull request with a skipped row (its third review came before the
 * migration 0025) has a row already, so it is never asked. A count above FEEDBACK_AFTER_REVIEWS
 * occurs after GitHub refused an earlier request. Returns the number of these reviews when the row is new, else null.
 * The row comes before the comment: of two publications, or of two tries, one only gets it.
 */
export async function claimRequest(sql: postgres.Sql, repoId: string, prNumber: number, authorLogin: string): Promise<number | null> {
  let [row] = await sql<{ reviews: string | number }[]>`
    with published as (
      select count(*) as reviews from reviews
      where repo_id = ${repoId} and pr_number = ${prNumber} and github_review_id is not null and result -> 'reusedFrom' is null
    ),
    claimed as (
      insert into feedback_requests (repo_id, pr_number, author_login)
      select ${repoId}, ${prNumber}, ${authorLogin} from published where reviews >= ${FEEDBACK_AFTER_REVIEWS}
      on conflict (repo_id, pr_number) do nothing
      returning 1
    )
    select published.reviews from published, claimed`
  return row ? Number(row.reviews) : null
}

/** Keeps the id of the comment that GitHub gave. */
export async function setRequestComment(sql: postgres.Sql, repoId: string, prNumber: number, commentId: number): Promise<void> {
  await sql`update feedback_requests set github_comment_id = ${commentId} where repo_id = ${repoId} and pr_number = ${prNumber}`
}

/** Gives the claim back after GitHub refused the comment: the next review tries again. */
export async function releaseRequest(sql: postgres.Sql, repoId: string, prNumber: number): Promise<void> {
  await sql`delete from feedback_requests where repo_id = ${repoId} and pr_number = ${prNumber} and github_comment_id is null and not skipped`
}

export interface RequestRow {
  repoId: string
  fullName: string
  githubCommentId: number | null
}

/** The request of a pull request, by the id of its repository on GitHub, or null. */
export async function findRequest(sql: postgres.Sql, githubRepoId: number, prNumber: number): Promise<RequestRow | null> {
  let [row] = await sql<{ repoId: string; fullName: string; githubCommentId: string | number | null }[]>`
    select feedback_requests.repo_id as "repoId", repos.full_name as "fullName", feedback_requests.github_comment_id as "githubCommentId"
    from feedback_requests
    join repos on repos.id = feedback_requests.repo_id
    where repos.github_repo_id = ${githubRepoId} and feedback_requests.pr_number = ${prNumber} and not feedback_requests.skipped`
  if (!row) return null
  return { ...row, githubCommentId: row.githubCommentId === null ? null : Number(row.githubCommentId) }
}

/** Records an answer. Returns false when an earlier delivery already recorded the same comment or reaction. */
export async function recordFeedback(sql: postgres.Sql, input: FeedbackInput): Promise<boolean> {
  let rows = await sql`
    insert into feedback (repo_id, pr_number, author_login, author_is_bot, source, text, url, github_comment_id, github_reaction_id, created_at)
    values (${input.repoId}, ${input.prNumber}, ${input.authorLogin}, ${input.authorIsBot}, ${input.source}, ${input.text}, ${input.url},
      ${input.githubCommentId ?? null}, ${input.githubReactionId ?? null}, coalesce(${input.createdAt?.toISOString() ?? null}::timestamptz, now()))
    on conflict do nothing
    returning id`
  return rows.length > 0
}

export interface FeedbackQuery {
  repoId?: string | null
  source?: FeedbackSource | null
  kind?: FeedbackKind | null
  /** KNT-176. `?before=`: the page starts after this answer, in the order of the list. */
  before?: string | null
}

export interface FeedbackRow {
  id: string
  repoId: string
  repo: string
  prNumber: number
  authorLogin: string
  authorIsBot: boolean
  source: FeedbackSource
  text: string
  url: string | null
  /** The score of the last published review of the pull request. */
  score: number | null
  createdAt: Date
}

export interface FeedbackScreen {
  /** At most FEEDBACK_PAGE_SIZE answers, the newest first. */
  rows: FeedbackRow[]
  /** The `before` of the next page, with older answers. Null on the last page. */
  older: string | null
  /**
   * The page with newer answers: its `before`, or null for the first page. Null itself when no
   * answer is newer, on the first page and when the cursor is invalid.
   */
  newer: { before: string | null } | null
  /** The repositories of the org that have an answer: the choices of the filter. */
  repos: { id: string; fullName: string }[]
}

type Row = Omit<FeedbackRow, 'prNumber' | 'score' | 'createdAt'> & {
  prNumber: number | string
  score: number | string | null
  createdAt: Date | string
  cursorAt: string
}

/** The cursor of `?before=`, or null: a value that is not a cursor gives the first page. */
export function readFeedbackCursor(value: string | null | undefined): Cursor | null {
  try {
    return decodeCursor(value)
  } catch {
    return null
  }
}

/**
 * KNT-176. One page of the answers of an org, the newest first: keyset pages on (`created_at`, `id`),
 * so that two answers of the same instant keep their order, and a new answer does not move a page.
 */
export async function listFeedback(sql: postgres.Sql, orgId: string, query: FeedbackQuery = {}): Promise<FeedbackScreen> {
  let repoId = query.repoId && UUID.test(query.repoId) ? query.repoId : null
  let source = query.source && FEEDBACK_SOURCES.includes(query.source) ? query.source : null
  let kind = query.kind && FEEDBACK_KINDS.includes(query.kind) ? query.kind : null
  let cursor = readFeedbackCursor(query.before)
  let limit = FEEDBACK_PAGE_SIZE + 1

  /**
   * The `limit` answers nearest to the cursor: older than it, the newest first, or from it on, the
   * oldest first. Each repository of the org reads its own nearest ones backward or forward in the
   * index `feedback_repo_created_at_idx` (repo_id, created_at), and the page is the nearest of
   * those: no read of the whole org. The bound on `created_at` alone lets the index start at the
   * cursor; the pair keeps the ties in order.
   */
  let nearest = (direction: 'older' | 'newer') => {
    let order = direction === 'older' ? sql`feedback.created_at desc, feedback.id desc` : sql`feedback.created_at asc, feedback.id asc`
    let bound = !cursor
      ? sql``
      : direction === 'older'
        ? sql`and feedback.created_at <= ${cursor.at}::timestamptz
            and (feedback.created_at, feedback.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
        : sql`and feedback.created_at >= ${cursor.at}::timestamptz
            and (feedback.created_at, feedback.id) >= (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
    return sql`
      select feedback.*, repos.full_name, ${sql.unsafe(cursorAt('feedback.created_at'))} as cursor_at
      from repos
      cross join lateral (
        select * from feedback
        where feedback.repo_id = repos.id
          ${source ? sql`and feedback.source = ${source}` : sql``}
          ${kind ? sql`and feedback.author_is_bot = ${kind === 'agent'}` : sql``}
          ${bound}
        order by ${order}
        limit ${limit}
      ) feedback
      where repos.org_id = ${orgId} ${repoId ? sql`and repos.id = ${repoId}` : sql``}
      order by ${order}
      limit ${limit}`
  }

  let rows = await sql<Row[]>`
    with page as (${nearest('older')})
    select page.id, page.repo_id as "repoId", page.full_name as repo, page.pr_number as "prNumber",
      page.author_login as "authorLogin", page.author_is_bot as "authorIsBot", page.source, page.text, page.url,
      page.created_at as "createdAt", page.cursor_at as "cursorAt", last.score
    from page
    left join lateral (
      select reviews.score from reviews
      where reviews.repo_id = page.repo_id and reviews.pr_number = page.pr_number and reviews.github_review_id is not null
      order by reviews.published_at desc nulls last, reviews.created_at desc limit 1
    ) last on true
    order by page.created_at desc, page.id desc`
  let shown = rows.slice(0, FEEDBACK_PAGE_SIZE)
  let last = shown.at(-1)
  let older = rows.length > FEEDBACK_PAGE_SIZE && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null

  // The page before: the answers from the cursor on, the oldest first. The one after the
  // FEEDBACK_PAGE_SIZE nearest is its cursor; with fewer, it is the first page.
  let newer: FeedbackScreen['newer'] = null
  if (cursor) {
    let above = await sql<{ id: string; cursorAt: string }[]>`
      with near as (${nearest('newer')}) select near.id, near.cursor_at as "cursorAt" from near order by near.created_at asc, near.id asc`
    let start = above[FEEDBACK_PAGE_SIZE]
    if (above.length > 0) newer = { before: start ? encodeCursor({ at: start.cursorAt, id: start.id }) : null }
  }

  let repos = await sql<{ id: string; fullName: string }[]>`
    select repos.id, repos.full_name as "fullName" from repos
    where repos.org_id = ${orgId} and exists (select 1 from feedback where feedback.repo_id = repos.id)
    order by lower(repos.full_name), repos.id`
  return {
    repos,
    older,
    newer,
    rows: shown.map(({ cursorAt: _cursorAt, ...row }) => ({
      ...row,
      prNumber: Number(row.prNumber),
      score: row.score === null ? null : Number(row.score),
      createdAt: toDate(row.createdAt),
    })),
  }
}

/** What the page of the answers reads. Tests of the routes can pass a fake. */
export interface FeedbackStore {
  list(orgId: string, query?: FeedbackQuery): Promise<FeedbackScreen>
}

export function createFeedbackStore(sql: postgres.Sql): FeedbackStore {
  return { list: (orgId, query) => listFeedback(sql, orgId, query) }
}
