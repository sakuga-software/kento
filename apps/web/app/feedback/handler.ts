// REV-107. The answers about the reviews of Kentō, from the webhook: the command `feedback`, a
// comment that quotes the request for feedback, and the reactions on the request at the close of the
// pull request. An answer costs nothing: no job, no check of the permission of the account.
import { eq } from 'drizzle-orm'
import type postgres from 'postgres'

import { COMMAND_PERMISSIONS, reactWithId } from '../commands/handler.ts'
import type { Db } from '../db/client.ts'
import { repos } from '../db/schema.ts'
import { isRepoEnabled, type StoreCommand, type WebhookResult } from '../db/webhook-store.ts'
import type { MintInstallationToken } from '../github/installation-token.ts'
import { mention } from '../instance.ts'
import { errorMessage, log } from '../log.ts'
import { createGitHub, type GitHub } from '../publish/github.ts'
import { collectReactions } from './github.ts'
import { findRequest, recordFeedback } from './store.ts'

export type FeedbackReply = Extract<StoreCommand, { type: 'feedback_reply' }>
export type PullClosed = Extract<StoreCommand, { type: 'cancel_pull_request' }>

export interface FeedbackHandlerDependencies {
  db: Db
  sql: postgres.Sql
  /** The login of the App, `kento-review[bot]`: its reactions do not count. */
  botLogin: string
  /** Null without the GitHub App: an answer is skipped. */
  mintInstallationToken: MintInstallationToken | null
  apiUrl: string
  /** The site of GitHub, for the link of a reaction. */
  webUrl: string
  fetch?: typeof globalThis.fetch
}

/** The reply to a `feedback` without a text, after the mention of the person. */
export function feedbackEmptyText(): string {
  return `The \`feedback\` command needs your opinion, on the same line or below it: \`${mention('feedback <your opinion>')}\`.`
}

export function createFeedbackHandler(deps: FeedbackHandlerDependencies) {
  async function githubFor(installationId: number, githubRepoId: number): Promise<GitHub> {
    let token = await deps.mintInstallationToken!({ installationId, githubRepoId, permissions: COMMAND_PERMISSIONS })
    return createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
  }

  async function handleReply(reply: FeedbackReply, deliveryId: string): Promise<WebhookResult> {
    let fields = { deliveryId, repo: reply.repository.fullName, pr: reply.prNumber, commentId: reply.commentId, commenter: reply.commenter.login, source: reply.source }
    let skip = (reason: string): WebhookResult => {
      log('info', 'feedback.skipped', { ...fields, reason })
      return { outcome: 'skipped', reason }
    }
    if (!(await isRepoEnabled(deps.db, reply.repository.githubRepoId))) return skip('repository is not enabled')
    if (!deps.mintInstallationToken) return skip('GitHub App is not configured')
    let [repo] = await deps.db.select({ id: repos.id }).from(repos).where(eq(repos.githubRepoId, reply.repository.githubRepoId))
    if (!repo) return skip('unknown repository')
    // A quote counts only on a pull request where Kentō asked.
    if (reply.source === 'quote' && !(await findRequest(deps.sql, reply.repository.githubRepoId, reply.prNumber))) {
      return skip('no request for feedback on the pull request')
    }

    let github = await githubFor(reply.installation.githubInstallationId, reply.repository.githubRepoId)
    let fullName = reply.repository.fullName
    if (reply.text === '') {
      let reaction = await reactWithId(github, fullName, reply.commentId, 'confused', reply.place)
      // A redelivery finds the reaction already there, and posts no second reply. When the reply
      // fails, the reaction goes away before the delivery fails: a redelivery then replies.
      if (reaction.created) {
        let body = `@${reply.commenter.login} ${feedbackEmptyText()}`
        try {
          await (reply.place.kind === 'thread'
            ? github.rest('POST', `/repos/${fullName}/pulls/${reply.prNumber}/comments/${reply.place.rootCommentId}/replies`, { body })
            : github.rest('POST', `/repos/${fullName}/issues/${reply.prNumber}/comments`, { body }))
        } catch (error) {
          if (reaction.id !== null) {
            let route = reply.place.kind === 'thread' ? 'pulls' : 'issues'
            await github
              .send('DELETE', `/repos/${fullName}/${route}/comments/${reply.commentId}/reactions/${reaction.id}`)
              .catch((cause) => log('warn', 'feedback.reaction_not_removed', { ...fields, error: errorMessage(cause) }))
          }
          throw error
        }
      }
      log('info', 'feedback.refused', { ...fields, reason: 'empty text' })
      return { outcome: 'refused', reason: 'feedback without a text' }
    }

    let created = await recordFeedback(deps.sql, {
      repoId: repo.id,
      prNumber: reply.prNumber,
      authorLogin: reply.commenter.login,
      authorIsBot: reply.commenter.isBot,
      source: reply.source,
      text: reply.text,
      url: reply.url,
      githubCommentId: reply.commentId,
      createdAt: reply.createdAt ? new Date(reply.createdAt) : null,
    })
    // The answer is recorded: a failure of the receipt or of the reactions is only logged.
    await reactWithId(github, fullName, reply.commentId, 'heart', reply.place).catch((error) =>
      log('warn', 'feedback.reaction_failed', { ...fields, error: errorMessage(error) }),
    )
    let reactions = await collectReactions(deps.sql, github, { githubRepoId: reply.repository.githubRepoId, prNumber: reply.prNumber }, deps.botLogin, deps.webUrl).catch(
      (error) => {
        log('warn', 'feedback.reactions_failed', { ...fields, error: errorMessage(error) })
        return 0
      },
    )
    log('info', 'feedback.recorded', { ...fields, created, reactions, textLength: reply.text.length, bot: reply.commenter.isBot })
    return { outcome: 'recorded', created, reactions }
  }

  /** Reads the reactions on the request of a pull request that closes. */
  async function onPullClosed(command: PullClosed): Promise<void> {
    if (!deps.mintInstallationToken) return
    if (!(await findRequest(deps.sql, command.repository.githubRepoId, command.prNumber))) return
    let github = await githubFor(command.installation.githubInstallationId, command.repository.githubRepoId)
    let added = await collectReactions(deps.sql, github, { githubRepoId: command.repository.githubRepoId, prNumber: command.prNumber }, deps.botLogin, deps.webUrl)
    log('info', 'feedback.reactions_read', { repo: command.repository.fullName, pr: command.prNumber, added })
  }

  return { handleReply, onPullClosed }
}
