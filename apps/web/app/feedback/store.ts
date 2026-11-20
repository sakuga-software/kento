// REV-107. The requests for feedback and the answers, in Postgres.
import { UUID } from '@kento-review/protocol'
import type postgres from 'postgres'

import { toDate } from '../db/rows.ts'
import { FEEDBACK_AFTER_REVIEWS } from './request.ts'

export const FEEDBACK_SOURCES = ['command', 'quote', 'reaction'] as const
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number]

/** Who answered: a person, or an agent (a bot account). */
export const FEEDBACK_KINDS = ['person', 'agent'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

/** The most answers that the page shows. */
export const FEEDBACK_PAGE_MAX = 200

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
 * reviews and no request yet. A pull request with a skipped row (its third review came before the
 * migration 0025) has a row already, so it is never asked. A count above FEEDBACK_AFTER_REVIEWS
 * occurs after GitHub refused an earlier request. Returns the number of these reviews when the row is new, else null.
 * The row comes before the comment: of two publications, or of two tries, one only gets it.
 */
export async function claimRequest(sql: postgres.Sql, repoId: string, prNumber: number, authorLogin: string): Promise<number | null> {
  let [row] = await sql<{ reviews: string | number }[]>`
    with published as (
      select count(*) as reviews from reviews
      where repo_id = ${repoId} and pr_number = ${prNumber} and github_review_id is not null
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
  rows: FeedbackRow[]
  /** The answers that match the filters, beyond FEEDBACK_PAGE_MAX too. */
  total: number
  /** The repositories of the org that have an answer: the choices of the filter. */
  repos: { id: string; fullName: string }[]
}

type Row = Omit<FeedbackRow, 'prNumber' | 'score' | 'createdAt'> & {
  prNumber: number | string
  score: number | string | null
  createdAt: Date | string
  total: string | number
}

/** The answers of an org, the newest first. */
export async function listFeedback(sql: postgres.Sql, orgId: string, query: FeedbackQuery = {}): Promise<FeedbackScreen> {
  let repoId = query.repoId && UUID.test(query.repoId) ? query.repoId : null
  let source = query.source && FEEDBACK_SOURCES.includes(query.source) ? query.source : null
  let kind = query.kind && FEEDBACK_KINDS.includes(query.kind) ? query.kind : null
  let rows = await sql<Row[]>`
    select feedback.id, feedback.repo_id as "repoId", repos.full_name as repo, feedback.pr_number as "prNumber",
      feedback.author_login as "authorLogin", feedback.author_is_bot as "authorIsBot", feedback.source, feedback.text, feedback.url,
      feedback.created_at as "createdAt", last.score, count(*) over () as total
    from feedback
    join repos on repos.id = feedback.repo_id
    left join lateral (
      select reviews.score from reviews
      where reviews.repo_id = feedback.repo_id and reviews.pr_number = feedback.pr_number and reviews.github_review_id is not null
      order by reviews.published_at desc nulls last, reviews.created_at desc limit 1
    ) last on true
    where repos.org_id = ${orgId}
      ${repoId ? sql`and feedback.repo_id = ${repoId}` : sql``}
      ${source ? sql`and feedback.source = ${source}` : sql``}
      ${kind ? sql`and feedback.author_is_bot = ${kind === 'agent'}` : sql``}
    order by feedback.created_at desc, feedback.id desc
    limit ${FEEDBACK_PAGE_MAX}`
  let repos = await sql<{ id: string; fullName: string }[]>`
    select repos.id, repos.full_name as "fullName" from repos
    where repos.org_id = ${orgId} and exists (select 1 from feedback where feedback.repo_id = repos.id)
    order by lower(repos.full_name), repos.id`
  return {
    total: Number(rows[0]?.total ?? 0),
    repos,
    rows: rows.map(({ total: _total, ...row }) => ({
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
