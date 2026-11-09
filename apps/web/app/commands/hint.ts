// REV-96. A reply in the thread of a finding that seems to set the finding aside, without
// `@kento-review reject`: Kentō answers once in that thread with the command and a link to its page
// of documentation. The hint changes no status: only `reject` sets the finding aside.
//
// Two ways lead to the hint:
// - at once, from the webhook of the reply (`pull_request_review_comment`): the pattern of
//   refutation.ts on the start of the reply, with no call to a model;
// - at the next review, from the verdict `refuted` that the model gives on each answered thread
//   (REV-71): the publisher posts the same hint when the thread has none (publish.ts).
//
// The rules: one hint per finding (claimed in `findings.reject_hint_at` before the post, so that two
// deliveries or a delivery and a review never both post it), never in a resolved thread or in the
// thread of a finding that is no longer open, never on a reply that already holds `reject`, never on
// a reply of a person who cannot write to the repository or of a bot that Kentō does not trust: they
// could not run the command.
import { and, eq } from 'drizzle-orm'
import type postgres from 'postgres'

import type { Db } from '../db/client.ts'
import { findings, repos } from '../db/schema.ts'
import { isRepoEnabled, type StoreCommand, type WebhookResult } from '../db/webhook-store.ts'
import { claimRejectHint, releaseRejectHint } from '../findings/ledger.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
import { canWrite } from '../findings/reactions.ts'
import { createGitHub, GitHubError } from '../publish/github.ts'
import { readOpenThreads } from '../resolve/threads.ts'
import { hintText } from './refutation.ts'

/** Reply in a review thread, read its comments: what the hint needs. */
export const HINT_PERMISSIONS: TokenPermissions = { pull_requests: 'write' }

/** The reply of the webhook that the pattern read as a refutation (events.ts). */
export type RefutationReply = Extract<StoreCommand, { type: 'refutation_reply' }>

export type HandleRefutationReply = (reply: RefutationReply, deliveryId: string) => Promise<WebhookResult>

export interface HintHandlerDependencies {
  db: Db
  /** The same database: the claim of the hint (`findings.reject_hint_at`). */
  sql: postgres.Sql
  /** The login of the App, `kento-review[bot]`. */
  botLogin: string
  /** Null without the GitHub App: the reply is skipped. */
  mintInstallationToken: MintInstallationToken | null
  apiUrl: string
  /** The page of the commands, or null. */
  docsUrl: string | null
  fetch?: typeof globalThis.fetch
}

/** The hint at once, for a reply that the pattern reads as a refutation. */
export function createHintHandler(deps: HintHandlerDependencies): HandleRefutationReply {
  return async (reply, deliveryId) => {
    let fields = { deliveryId, repo: reply.repository.fullName, pr: reply.prNumber, commentId: reply.commentId, commenter: reply.commenter.login }
    let skip = (reason: string): WebhookResult => {
      log('info', 'hint.skipped', { ...fields, reason })
      return { outcome: 'skipped', reason }
    }
    // A repository that Kentō does not serve: the bot says nothing there.
    if (!(await isRepoEnabled(deps.db, reply.repository.githubRepoId))) return skip('repository is not enabled')
    let mint = deps.mintInstallationToken
    if (!mint) return skip('GitHub App is not configured')

    // The finding of the thread, by the first comment of the thread. A thread of a person, or of a
    // finding of another pull request, has none.
    let [finding] = await deps.db
      .select({ id: findings.id, status: findings.status })
      .from(findings)
      .innerJoin(repos, eq(repos.id, findings.repoId))
      .where(
        and(
          eq(repos.githubRepoId, reply.repository.githubRepoId),
          eq(findings.prNumber, reply.prNumber),
          eq(findings.githubCommentId, reply.rootCommentId),
        ),
      )
      .limit(1)
    if (!finding) return skip('thread is not the thread of a finding')
    // A finding set aside, kept, fixed or stale: there is nothing left to reject.
    if (finding.status !== 'open') return skip(`finding is ${finding.status}`)

    let token = await mint({
      installationId: reply.installation.githubInstallationId,
      githubRepoId: reply.repository.githubRepoId,
      permissions: HINT_PERMISSIONS,
    })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
    let fullName = reply.repository.fullName

    // A bot of KENTO_TRUSTED_BOTS can run a command; the webhook has already dropped the others.
    if (!reply.commenter.isBot && !(await canWrite(github, fullName, reply.commenter.login))) {
      return skip('commenter cannot write to the repository')
    }

    // The open threads only: a resolved thread gets no hint.
    let threads = await readOpenThreads(github, fullName, reply.prNumber)
    if (!threads.some((t) => t.comments[0]?.id === reply.rootCommentId)) return skip('thread is resolved')
    // One hint per finding: the claim in the database, before the post. Of two deliveries, or of a
    // delivery and a review, that race for it, one only posts. A hint of an earlier try that GitHub
    // took holds the claim too.
    if (!(await claimRejectHint(deps.sql, finding.id))) return skip('thread already has a hint')

    try {
      await github.rest('POST', `/repos/${fullName}/pulls/${reply.prNumber}/comments/${reply.rootCommentId}/replies`, {
        body: hintText(reply.commenter.login, deps.docsUrl),
      })
    } catch (error) {
      // GitHub answered with an error: the hint did not go, and the claim goes back, so that the next
      // refutation, or a redelivery, tries again. Without an answer (a timeout, a lost connection) the
      // hint may be on GitHub: the claim stays, and a missed hint costs less than a second one.
      if (error instanceof GitHubError) {
        await releaseRejectHint(deps.sql, finding.id).catch((cause) => log('warn', 'hint.release_failed', { ...fields, error: errorMessage(cause) }))
      }
      // 404: the first comment of the thread was deleted meanwhile. Nothing to answer.
      if (error instanceof GitHubError && error.status === 404) return skip('thread is gone')
      log('warn', 'hint.failed', { ...fields, error: errorMessage(error) })
      throw error
    }
    log('info', 'hint.posted', { ...fields, findingId: finding.id, source: 'pattern' })
    return { outcome: 'hinted', findingId: finding.id }
  }
}
