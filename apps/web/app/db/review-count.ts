// KNT-157, KNT-175. The one rule that counts and numbers the reviews of a pull request. The request
// for feedback, the screen of a pull request (its count, its R numbers, "Run R{n+1}", the change of
// the score), the detail and the history of a finding, the user screen and the finding ledger read it.
//
// A review counts when a model read the code for it and GitHub shows it:
// - `github_review_id` is set. Null: the publisher did not post it, on purpose (a newer push, a
//   close, a later review replaced a copy) or not yet.
// - `result.reusedFrom` is absent. Present: a copy of an earlier review on a head with no changed
//   reviewed file (REV-89). It has the `github_review_id` of its source, but no model read the code.
//   The publisher removes the key when the source is gone from GitHub: the copy is then posted as a
//   review of its own, and it counts.
//
// R1 is the first review that counts, in the order of creation. A copy and a review that is not
// published get no R number: the screen names them "same as R2" and "not published".

/** An alias of `reviews` in a query. The SQL of this module goes into queries as text. */
const ALIAS = /^[a-z_][a-z0-9_]*$/

function alias(name: string): string {
  if (!ALIAS.test(name)) throw new Error(`not a table alias: ${name}`)
  return name
}

const UUID_TEXT = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`

/** SQL: true when the row `r` of `reviews` counts. */
export function countsSql(r = 'reviews'): string {
  r = alias(r)
  return `(${r}.github_review_id is not null and ${r}.result -> 'reusedFrom' is null)`
}

/** SQL: the R number of the row `r` of `reviews`, an int. Null when the row does not count. */
export function numberSql(r: string): string {
  r = alias(r)
  let e = `${r}_earlier`
  return `(case when ${countsSql(r)} then (
    select count(*)::int from reviews ${e}
    where ${e}.repo_id = ${r}.repo_id and ${e}.pr_number = ${r}.pr_number and ${countsSql(e)}
      and (${e}.created_at, ${e}.id) <= (${r}.created_at, ${r}.id)) end)`
}

/**
 * SQL: the columns that `rankOf` reads, for the row `r` of `reviews`. `copyNumber`: the R number of
 * the source of a copy (`reusedFrom.reviewId`, on the same pull request), null when the retention
 * removed it.
 */
export function rankColumnsSql(r: string): string {
  r = alias(r)
  let s = `${r}_source`
  let source = `${r}.result -> 'reusedFrom' ->> 'reviewId'`
  return `${numberSql(r)} as number, (${r}.github_review_id is not null) as published,
    (${r}.result -> 'reusedFrom' is not null) as copy, ${r}.result -> 'reusedFrom' ->> 'head' as "copyHead",
    (select ${numberSql(s)} from reviews ${s}
      where ${s}.repo_id = ${r}.repo_id and ${s}.pr_number = ${r}.pr_number
        and ${s}.id = (case when ${source} ~* ${UUID_TEXT} then (${source})::uuid end)) as "copyNumber"`
}

/** What a review is among the reviews of its pull request. */
export type ReviewRank =
  /** A review that counts: R{number}. */
  | { kind: 'counted'; number: number }
  /** A copy of the review R{of} (null: the source is gone from the database), at the commit `head`. */
  | { kind: 'copy'; of: number | null; head: string }
  /** GitHub does not show it. */
  | { kind: 'unpublished' }

/** The columns of `rankColumnsSql`, as a row gives them. */
export interface RankRow {
  number: number | null
  published: boolean
  copy: boolean
  copyHead: string | null
  copyNumber: number | null
}

export function rankOf(row: RankRow): ReviewRank {
  if (!row.published) return { kind: 'unpublished' }
  if (row.copy) return { kind: 'copy', of: row.copyNumber, head: row.copyHead ?? '' }
  if (row.number !== null) return { kind: 'counted', number: Number(row.number) }
  return { kind: 'unpublished' }
}

/** "R3", "same as R2", "same as 1a2b3c4" (its source is gone), "not published". */
export function rankLabel(rank: ReviewRank): string {
  if (rank.kind === 'counted') return `R${rank.number}`
  if (rank.kind === 'copy') return rank.of !== null ? `same as R${rank.of}` : `same as ${rank.head.slice(0, 7) || 'an earlier review'}`
  return 'not published'
}
