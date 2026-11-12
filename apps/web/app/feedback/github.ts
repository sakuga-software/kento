// REV-107. What the feedback needs from GitHub: post the request once, and read the 👍 and 👎 on it.
import type postgres from 'postgres'

import { GitHubError, type GitHub } from '../publish/github.ts'
import { FEEDBACK_MARKER, requestText } from './request.ts'
import { claimRequest, findRequest, recordFeedback, releaseRequest, setRequestComment, type RequestRow } from './store.ts'

export interface AskInput {
  repoId: string
  fullName: string
  prNumber: number
  /** The author of the pull request, as GitHub gives it (`name[bot]` for an App). Null: no request. */
  author: string | null
}

/**
 * After a review is on GitHub: posts the request for feedback when the pull request has its third
 * published review and no request yet. The caller checked that the pull request is open. Returns the
 * id of the comment, or null when nothing was posted.
 */
export async function askForFeedback(sql: postgres.Sql, github: GitHub, input: AskInput): Promise<number | null> {
  if (!input.author) return null
  let reviews = await claimRequest(sql, input.repoId, input.prNumber, input.author)
  if (reviews === null) return null
  let posted: { id: number }
  try {
    posted = await github.rest('POST', `/repos/${input.fullName}/issues/${input.prNumber}/comments`, { body: requestText(input.author, reviews) })
  } catch (error) {
    // GitHub refused the comment: the claim goes back, and the next review asks again. Without an
    // answer (a timeout), the comment can be on GitHub: the claim stays, because one request missed
    // costs less than two.
    if (error instanceof GitHubError) await releaseRequest(sql, input.repoId, input.prNumber)
    throw error
  }
  await setRequestComment(sql, input.repoId, input.prNumber, posted.id)
  return posted.id
}

/**
 * The request of a post that got no answer (a timeout) can be on GitHub without its id in the row.
 * Finds the comment of the App by its marker, and keeps its id. Reads 1000 comments at most.
 */
async function findRequestComment(sql: postgres.Sql, github: GitHub, request: RequestRow, prNumber: number, botLogin: string): Promise<number | null> {
  for (let page = 1; page <= 10; page++) {
    let comments: { id: number; body: string | null; user: { login: string } | null }[] =
      (await github.rest('GET', `/repos/${request.fullName}/issues/${prNumber}/comments?per_page=100&page=${page}`)) ?? []
    let found = comments.find((c) => c.user?.login.toLowerCase() === botLogin.toLowerCase() && (c.body ?? '').includes(FEEDBACK_MARKER))
    if (found) {
      await setRequestComment(sql, request.repoId, prNumber, found.id)
      return found.id
    }
    if (comments.length < 100) return null
  }
  return null
}

type ReactionRow = { id?: number; content?: string; created_at?: string; user?: { login?: string; type?: string } | null }

const REACTIONS: Record<string, string> = { '+1': '👍', '-1': '👎' }

/**
 * Records the 👍 and 👎 on the request of a pull request. GitHub sends no event for a reaction: the
 * service reads them at the close of the pull request and at each new answer. A reaction of the App
 * does not count. Returns the reactions that are new.
 */
export async function collectReactions(
  sql: postgres.Sql,
  github: GitHub,
  pull: { githubRepoId: number; prNumber: number },
  botLogin: string,
  webUrl: string,
): Promise<number> {
  let request = await findRequest(sql, pull.githubRepoId, pull.prNumber)
  if (!request) return 0
  let commentId = request.githubCommentId ?? (await findRequestComment(sql, github, request, pull.prNumber, botLogin))
  if (commentId === null) return 0
  let url = `${webUrl.replace(/\/+$/, '')}/${request.fullName}/pull/${pull.prNumber}#issuecomment-${commentId}`
  let added = 0
  for (let page = 1; page <= 10; page++) {
    let rows: ReactionRow[] =
      (await github.rest('GET', `/repos/${request.fullName}/issues/comments/${commentId}/reactions?per_page=100&page=${page}`)) ?? []
    for (let reaction of rows) {
      let text = REACTIONS[reaction.content ?? '']
      let login = reaction.user?.login
      if (!text || !login || typeof reaction.id !== 'number' || login.toLowerCase() === botLogin.toLowerCase()) continue
      let created = await recordFeedback(sql, {
        repoId: request.repoId,
        prNumber: pull.prNumber,
        authorLogin: login,
        authorIsBot: reaction.user?.type === 'Bot',
        source: 'reaction',
        text,
        url,
        githubReactionId: reaction.id,
        createdAt: reaction.created_at ? new Date(reaction.created_at) : null,
      })
      if (created) added++
    }
    if (rows.length < 100) break
  }
  return added
}
