// REV-94. The effect of `@kento-review reject <cause>`, at once and without a new review:
//
// 1. The finding becomes `dismissed`, with the cause as its reason and the login of the person as the
//    actor. A `wontfix` finding becomes `dismissed` too: the events keep the two decisions. Its event has the source `command`. It is the dismissal of the screens (REV-18): the
//    precision counts it as a false positive, and the next reviews never comment it again.
// 2. The reply `replyText` goes in the thread of the finding, and the thread is resolved. A command
//    of the conversation also gets the reply under the pull request.
// 3. When the last review of Kentō on the head asks for changes and no blocking finding stays open,
//    Kentō dismisses that review: the pull request is no longer blocked by a finding that a person set
//    aside. The confidence score does not change: the next review computes it again (REV-95).
//
// The database changes first. A redelivery, or a second `reject`, then finds the finding dismissed:
// it posts nothing that it already posted. It does again the resolve of the thread and the dismissal
// of the review, and posts a reply only where the hidden marker of the finding is missing: a step
// that failed the first time can still happen, and nothing is posted twice. GitHub never sends a
// delivery again by itself, whatever its status: after a 😕, the person writes the same `reject`
// again, or redelivers the webhook from the settings of the App.
import { findingKey } from '@kento-review/engine/findings'
import type { ReviewFinding } from '@kento-review/protocol'
import type postgres from 'postgres'

import { replyText } from '../findings/dismiss.ts'
import { setFindingStatus } from '../findings/store.ts'
import type { CommandPlace } from '../github/events.ts'
import { resolveReviewThread, reviewThreadPages } from '../github/graphql.ts'
import { errorMessage } from '../log.ts'
import type { TokenPermissions } from '../github/installation-token.ts'
import { GitHubError, type GitHub } from '../publish/github.ts'

/**
 * GitHub resolves a review thread only for a token that can write the contents, as for a resolve job
 * (`RESOLVE_THREAD_PERMISSIONS` of the publisher). Asked only at the moment of the resolve.
 */
export const REJECT_THREAD_PERMISSIONS: TokenPermissions = { contents: 'write', pull_requests: 'write' }

/** The finding that a `reject` names, as the handler read it. */
export interface RejectTarget {
  id: string
  orgId: string
  key: string
  title: string
  status: string
  /** The first comment of its thread, or null when the finding has no thread. */
  githubCommentId: number | null
  /** The node id of its thread (`PRRT_…`), or null. */
  githubThreadId: string | null
}

export interface RejectInput {
  sql: postgres.Sql
  /** A token with `pull_requests: write` and `issues: write`: replies and reviews. */
  github: GitHub
  /**
   * A GitHub with `contents: write`, which `resolveReviewThread` needs, or null when the App does not
   * have that permission: the reply then says that a person can resolve the thread.
   */
  writer: () => Promise<GitHub | null>
  fullName: string
  prNumber: number
  place: CommandPlace
  login: string
  botLogin: string
  reason: string
  finding: RejectTarget
  warn: (event: string, fields: Record<string, unknown>) => void
}

export interface RejectOutcome {
  /** False when the finding was already dismissed: nothing was posted. */
  changed: boolean
  /** The thread is resolved now (or was already). */
  resolved: boolean
  /** The id of the review of Kentō that this reject dismissed, or null. */
  dismissedReview: number | null
  /** Steps on GitHub that failed. The finding stays dismissed; the log says which. */
  failed: string[]
  /** The finding became `fixed` before its row was locked: the reject did nothing. */
  refusedStatus?: string
}

/**
 * The statuses that refuse a `reject`: a push or a `resolve` fixed the finding. A `stale` finding
 * (the reviews no longer see it, KNT-192, or its pull request closed and opened again) can still be
 * a false positive: `reject` dismisses it, with its cause.
 */
export const REJECT_REFUSED = new Set(['fixed'])

/** The short id of a finding, as the comments show it. */
const shortIdOf = (key: string) => `#${key.slice(0, 6)}`

export async function applyReject(input: RejectInput): Promise<RejectOutcome> {
  let { github, finding, fullName, prNumber } = input
  let outcome: RejectOutcome = { changed: false, resolved: false, dismissedReview: null, failed: [] }
  let change = await setFindingStatus(input.sql, {
    orgId: finding.orgId,
    findingId: finding.id,
    status: 'dismissed',
    reason: input.reason,
    actor: input.login,
    source: 'command',
    // A second reject with another cause keeps the first: it changes nothing and posts nothing.
    keepDismissed: true,
  })
  if (change.outcome === 'invalid' || change.outcome === 'not_found') {
    throw new Error(`the finding could not be dismissed: ${change.outcome === 'invalid' ? change.reason : 'not found'}`)
  }
  outcome.changed = change.outcome === 'changed'
  // A push or a `resolve` fixed the finding after the handler read it: nothing to do.
  if (REJECT_REFUSED.has(change.finding.status)) {
    outcome.refusedStatus = change.finding.status
    return outcome
  }

  // The thread first: its reply says whether the App could resolve it.
  let writer: GitHub | null = null
  if (finding.githubThreadId || finding.githubCommentId !== null) {
    try {
      writer = await input.writer()
    } catch (error) {
      input.warn('command.reject_write_token_refused', { error: errorMessage(error) })
    }
  }
  // KNT-160. The ledger knows the node id of a thread only once a later review read the threads: a
  // finding whose thread the last review opened has only the id of its first comment. Without this
  // lookup, the reject never tried to resolve the thread, and its reply said that it could not.
  let threadId = finding.githubThreadId
  if (writer && !threadId && finding.githubCommentId !== null) {
    try {
      threadId = await threadOfComment(writer, fullName, prNumber, finding.githubCommentId)
      if (threadId) await input.sql`update findings set github_thread_id = ${threadId} where id = ${finding.id} and github_thread_id is null`
      else input.warn('command.reject_thread_not_found', { comment: finding.githubCommentId })
    } catch (error) {
      input.warn('command.reject_thread_unread', { comment: finding.githubCommentId, error: errorMessage(error) })
    }
  }
  if (writer && threadId) {
    try {
      await resolveReviewThread(writer, threadId)
      outcome.resolved = true
    } catch (error) {
      input.warn('command.reject_thread_not_resolved', { thread: threadId, error: errorMessage(error) })
    }
  }

  // The replies carry a hidden marker of the finding. When the finding was already dismissed (a
  // redelivery, a second reject), a reply goes only where its marker is missing: a reply that failed
  // the first time is posted now, and a reply that went is never posted twice.
  let marker = rejectMarker(finding.id)
  let said = outcome.changed ? { reason: input.reason, login: input.login } : await dismissal(input, change.finding.statusReason)
  if (finding.githubCommentId !== null && (await replyNeeded(outcome, 'thread_reply', () => threadHas(input, marker)))) {
    let unresolved = !outcome.resolved ? '\n\nKentō could not resolve this thread. If it is still open, a person can resolve it.' : ''
    await step(outcome, input, 'thread_reply', () =>
      github.rest('POST', `/repos/${fullName}/pulls/${prNumber}/comments/${finding.githubCommentId}/replies`, {
        body: `${replyText('dismissed', said.reason, said.login)}${unresolved}\n\n${marker}`,
      }),
    )
  }
  if (input.place.kind === 'conversation' && (await replyNeeded(outcome, 'conversation_reply', () => conversationHas(input, marker)))) {
    let what = `The finding \`${shortIdOf(finding.key)}\` "${finding.title}"`
    await step(outcome, input, 'conversation_reply', () =>
      github.rest('POST', `/repos/${fullName}/issues/${prNumber}/comments`, {
        body: `@${said.login} ${what} is dismissed. Reason: "${said.reason}". The next reviews will not comment on it again.\n\n${marker}`,
      }),
    )
  }

  await step(outcome, input, 'review_dismissal', async () => {
    outcome.dismissedReview = await dismissBlockingReview(input)
  })
  return outcome
}

/** KNT-160. The node id of the review thread whose first comment is `commentId`, or null. */
async function threadOfComment(github: GitHub, fullName: string, prNumber: number, commentId: number): Promise<string | null> {
  let [owner = '', name = ''] = fullName.split('/')
  type Node = { id: string; comments: { nodes: { databaseId: number | null }[] } }
  for await (let page of reviewThreadPages<Node>(github, { owner, name, pr: prNumber }, 'id comments(first: 1) { nodes { databaseId } }')) {
    let found = page.find((thread) => thread.comments.nodes[0]?.databaseId === commentId)
    if (found) return found.id
  }
  return null
}

/** The hidden marker of the replies of the reject of a finding. */
export const rejectMarker = (findingId: string) => `<!-- kento:reject ${findingId} -->`

/** The cause and the person of the dismissal of a finding, from its last `dismissed` event. */
/**
 * The cause and the person of the dismissal of a finding: the cause of its row (`status_reason`, the
 * one that the screens show), and the person of its last `dismissed` event.
 */
async function dismissal(input: RejectInput, statusReason: string | null): Promise<{ reason: string; login: string }> {
  let [row] = await input.sql<{ actor: string; reason: string | null }[]>`
    select actor, reason from finding_events
    where finding_id = ${input.finding.id} and type = 'dismissed'
    order by created_at desc, id desc limit 1`
  return { reason: statusReason ?? row?.reason ?? input.reason, login: row?.actor ?? input.login }
}

/** Whether a reply already holds the marker: `unknown` when GitHub could not be read. */
type Seen = 'yes' | 'no' | 'unknown'

/** Whether a reply of the thread of the finding holds the marker. */
async function threadHas(input: RejectInput, marker: string): Promise<Seen> {
  try {
    for (let page = 1; ; page++) {
      let batch: { body?: string; in_reply_to_id?: number }[] =
        (await input.github.rest('GET', `/repos/${input.fullName}/pulls/${input.prNumber}/comments?per_page=100&page=${page}`)) ?? []
      if (batch.some((c) => c.in_reply_to_id === input.finding.githubCommentId && c.body?.includes(marker))) return 'yes'
      if (batch.length < 100) return 'no'
    }
  } catch (error) {
    input.warn('command.reject_replies_unread', { error: errorMessage(error) })
    return 'unknown'
  }
}

/** Whether a comment of the conversation holds the marker. */
async function conversationHas(input: RejectInput, marker: string): Promise<Seen> {
  try {
    for (let page = 1; ; page++) {
      let batch: { body?: string }[] = (await input.github.rest('GET', `/repos/${input.fullName}/issues/${input.prNumber}/comments?per_page=100&page=${page}`)) ?? []
      if (batch.some((c) => c.body?.includes(marker))) return 'yes'
      if (batch.length < 100) return 'no'
    }
  } catch (error) {
    input.warn('command.reject_replies_unread', { error: errorMessage(error) })
    return 'unknown'
  }
}

/**
 * Whether a reply must go: always after a new dismissal, else only when its marker is missing. A
 * read that failed posts nothing (never twice) and counts as a failed step: 😕, and the next try
 * reads again.
 */
async function replyNeeded(outcome: RejectOutcome, step: string, seen: () => Promise<Seen>): Promise<boolean> {
  if (outcome.changed) return true
  let state = await seen()
  if (state === 'unknown') outcome.failed.push(step)
  return state === 'no'
}

async function step(outcome: RejectOutcome, input: RejectInput, name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    outcome.failed.push(name)
    input.warn(`command.reject_${name}_failed`, { error: errorMessage(error) })
  }
}

type ListedReview = { id: number; state: string; commit_id?: string; user: { login: string } | null }

/**
 * Dismisses the last review of Kentō on the head when it asks for changes and no finding that the
 * engine marked blocking in it stays open. Returns the id of the dismissed review, or null.
 */
async function dismissBlockingReview(input: RejectInput): Promise<number | null> {
  let { github, fullName, prNumber } = input
  let pr: { head?: { sha?: string } } = await github.rest('GET', `/repos/${fullName}/pulls/${prNumber}`)
  let head = pr.head?.sha
  if (!head) return null
  let reviews: ListedReview[] = []
  for (let page = 1; ; page++) {
    let batch: ListedReview[] = (await github.rest('GET', `/repos/${fullName}/pulls/${prNumber}/reviews?per_page=100&page=${page}`)) ?? []
    reviews.push(...batch)
    if (batch.length < 100) break
  }
  // GitHub lists the reviews oldest first.
  let last = reviews.filter((r) => r.user?.login === input.botLogin && r.commit_id === head).at(-1)
  if (!last || last.state !== 'CHANGES_REQUESTED') return null
  // The blocking findings of that review, as the engine marked them when it asked for changes
  // (`blocking` of each finding of `reviews.result`): the same rule that produced the verdict. A
  // review that Kentō did not store, or that names no blocking finding, is left as it is.
  // REV-101. The review of a head that no reviewed file changed is a copy: its row names it in
  // `headReviewId`, and `github_review_id` is its source, the review with the findings.
  let [stored] = await input.sql<{ findings: ReviewFinding[] | null; source: string | null }[]>`
    select result->'findings' as findings, result->'reusedFrom'->>'githubReviewId' as source from reviews
    where (github_review_id = ${last.id} or result->>'headReviewId' = ${String(last.id)}) and pr_number = ${prNumber}
      and repo_id = (select repo_id from findings where id = ${input.finding.id})
    order by (github_review_id = ${last.id}) desc
    limit 1`
  if (!stored) {
    input.warn('command.reject_review_not_stored', { review: last.id })
    return null
  }
  let blockingFindings = (stored?.findings ?? []).filter((f) => f?.blocking === true)
  // A stored finding without its path or its title gives no key: the review is left as it is, and the
  // log says why, instead of a 😕 that hides the cause.
  if (blockingFindings.some((f) => typeof f.path !== 'string' || typeof f.title !== 'string')) {
    input.warn('command.reject_review_unreadable', { review: last.id })
    return null
  }
  // The same call as the ledger, which writes `findings.key` from the same stored finding
  // (lifecycle.ts: `s.key === findingKey(f)` on a ReviewFinding).
  let keys = [...new Set(blockingFindings.map((f) => findingKey(f)))]
  if (!keys.length) {
    input.warn('command.reject_review_without_blocking', { review: last.id })
    return null
  }
  // Each of them still blocks while a row of its key is open. The ledger writes a row for each finding
  // of a published review before the review counts as posted (ledger.ts), so a key without a row is a
  // bug, not a defect: it holds nothing, and the log names it.
  let rows = await input.sql<{ key: string; status: string }[]>`
    select key, status::text as status from findings
    where repo_id = (select repo_id from findings where id = ${input.finding.id}) and pr_number = ${prNumber}
      and key = any(${keys}::text[])`
  let setAside = (key: string) => {
    let of = rows.filter((r) => r.key === key)
    // As the ticket says: no blocking finding stays *open*. Dismissed, wontfix, fixed or stale: it
    // no longer holds the review.
    return of.every((r) => r.status !== 'open')
  }
  let rowless = keys.filter((key) => !rows.some((r) => r.key === key))
  if (rowless.length) input.warn('command.reject_blocking_without_row', { review: last.id, blocking: rowless.map((key) => `#${key.slice(0, 6)}`) })
  let holding = keys.filter((key) => !setAside(key))
  if (holding.length) {
    // The review stays: the log names the blocking findings that still hold it.
    input.warn('command.reject_review_kept', { review: last.id, blocking: holding.map((key) => `#${key.slice(0, 6)}`) })
    return null
  }
  // REV-101. The source of a copy asks for changes too, on an earlier head: it goes with the copy, or
  // it would keep the pull request blocked.
  let source = stored.source === null ? undefined : reviews.find((r) => r.id === Number(stored.source) && r.user?.login === input.botLogin)
  // A source that GitHub no longer lists (deleted, or of another login) cannot be dismissed: the log
  // says so, since an earlier REQUEST_CHANGES of the bot could still hold the pull request.
  if (stored.source !== null && !source) input.warn('command.reject_source_not_found', { review: last.id, source: Number(stored.source) })
  let dismissed = [last, ...(source && source.id !== last.id && source.state === 'CHANGES_REQUESTED' ? [source] : [])]
  for (let review of dismissed) {
    try {
      await github.rest('PUT', `/repos/${fullName}/pulls/${prNumber}/reviews/${review.id}/dismissals`, {
        message: `Dismissed by Kentō: @${input.login} dismissed the finding \`${shortIdOf(input.finding.key)}\` "${input.finding.title}", and no blocking finding stays open.`,
        event: 'DISMISS',
      })
    } catch (error) {
      // 422: another reject, or a new review, dismissed it between the list and the dismissal. The
      // review is no longer a CHANGES_REQUESTED: that is the aim, not a failure.
      if (!(error instanceof GitHubError && error.status === 422)) throw error
      input.warn('command.reject_review_already_dismissed', { review: review.id })
    }
  }
  return last.id
}
