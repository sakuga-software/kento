// The commands of the comments: `@kento review [lite|balanced|heavy] [force]` and
// `@kento resolve [lite|balanced|heavy]`, with `@sakuga-review` as an alias (REV-7). The webhook gives the parsed command; this handler asks GitHub what the
// payload does not hold (the permission of the commenter, the head and the fork of the pull
// request), queues the job, and answers on the comment.
//
// The answers on the comment:
// - 👀 when a job is queued. The publisher adds 🚀 after the review or the resolution, or 😕 when
//   the job fails.
// - 😕 and a short reply when the command is refused: unknown command, fork, head already reviewed.
//   The reply goes only with a reaction that GitHub has just created (201, not 200): a redelivery of
//   the same comment posts no second reply.
// - Nothing for a person who cannot write to the repository: the bot does not answer every comment
//   of every visitor. The log says why.
import type { Db } from '../db/client.ts'
import { enqueueCommandJob, isRepoEnabled, type CommentCommandMessage, type HandleCommentCommand, type WebhookResult } from '../db/webhook-store.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { USAGE } from '../github/comment-command.ts'
import { errorMessage, log } from '../log.ts'
import { createGitHub, GitHubError, type GitHub } from '../publish/github.ts'

/**
 * Read the pull request and the permission of the commenter, react and reply on the comment. No
 * `contents`: the handler reads no code. A reaction on a comment of a pull request needs
 * `pull_requests: write`: with `read`, GitHub answers 403.
 */
export const COMMAND_PERMISSIONS: TokenPermissions = { pull_requests: 'write', issues: 'write' }

/** The permissions of GitHub that can give a command. `maintain` reads as `write` in `permission`. */
const WRITERS = new Set(['admin', 'maintain', 'write'])

export type Reaction = 'eyes' | 'rocket' | 'confused'

export interface CommandHandlerDependencies {
  db: Db
  /** Null without the GitHub App: a command is then skipped. */
  mintInstallationToken: MintInstallationToken | null
  apiUrl: string
  fetch?: typeof globalThis.fetch
}

/**
 * Adds a reaction of the App to a comment of a pull request. `created` is true when GitHub created
 * it (201), false when the App had already left it (200).
 */
export async function react(github: GitHub, fullName: string, commentId: number, content: Reaction): Promise<boolean> {
  return (await reactWithId(github, fullName, commentId, content)).created
}

async function reactWithId(github: GitHub, fullName: string, commentId: number, content: Reaction) {
  let { status, body } = await github.send<{ id?: number }>('POST', `/repos/${fullName}/issues/comments/${commentId}/reactions`, { content })
  return { created: status === 201, id: typeof body?.id === 'number' ? body.id : null }
}

export function createCommandHandler(deps: CommandHandlerDependencies): HandleCommentCommand {
  return async (message, deliveryId) => {
    let fields = {
      deliveryId,
      repo: message.repository.fullName,
      pr: message.prNumber,
      commentId: message.commentId,
      commenter: message.commenter.login,
      verb: message.command.verb,
    }
    // A repository that Kentō does not serve keeps its commands in `review.yml`: no token, no
    // reaction, no reply, so the comment never gets two answers.
    if (!(await isRepoEnabled(deps.db, message.repository.githubRepoId))) {
      log('info', 'command.repo_not_enabled', fields)
      return { outcome: 'skipped', reason: 'repository is not enabled: the workflow keeps the command' }
    }
    let mint = deps.mintInstallationToken
    if (!mint) return { outcome: 'skipped', reason: 'GitHub App is not configured' }

    let token = await mint({
      installationId: message.installation.githubInstallationId,
      githubRepoId: message.repository.githubRepoId,
      permissions: COMMAND_PERMISSIONS,
    })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
    let fullName = message.repository.fullName

    if (!(await canCommand(github, message))) {
      log('info', 'command.not_allowed', fields)
      return { outcome: 'refused', reason: 'commenter cannot write to the repository' }
    }

    /**
     * 😕 on the comment, and the reply when the reaction is new. When the reply fails, the reaction
     * goes away before the delivery fails: a redelivery then creates it again, and replies.
     */
    async function refuse(reason: string, reply: string): Promise<WebhookResult> {
      let reaction = await reactWithId(github, fullName, message.commentId, 'confused')
      if (reaction.created) {
        try {
          await github.rest('POST', `/repos/${fullName}/issues/${message.prNumber}/comments`, { body: reply })
        } catch (error) {
          if (reaction.id !== null) {
            await github
              .send('DELETE', `/repos/${fullName}/issues/comments/${message.commentId}/reactions/${reaction.id}`)
              .catch((cause) => log('warn', 'command.reaction_not_removed', { ...fields, error: errorMessage(cause) }))
          }
          throw error
        }
      }
      log('info', 'command.refused', { ...fields, reason, replied: reaction.created })
      return { outcome: 'refused', reason }
    }

    let { command } = message
    if (command.verb === 'unknown') {
      return refuse('unknown command', `@${message.commenter.login} \`${command.text.replaceAll('`', "'")}\` n'est pas une commande de Kentō.\n\n${USAGE}`)
    }
    let pr: PullRequest = await github.rest('GET', `/repos/${fullName}/pulls/${message.prNumber}`)
    if (pr.state !== 'open') return { outcome: 'skipped', reason: 'pull request is closed' }
    // The code of a fork is not the code of the repository. GitHub sends `head.repo: null` when the
    // fork was deleted.
    if (pr.head?.repo?.id !== message.repository.githubRepoId) {
      return refuse('pull request from a fork', `@${message.commenter.login} Kentō ne relit pas une PR qui vient d'un fork.`)
    }
    if (typeof pr.head.sha !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(pr.head.sha) || typeof pr.base?.ref !== 'string') {
      throw new Error('GitHub gave a pull request without head.sha or base.ref')
    }

    let result = await enqueueCommandJob(
      deps.db,
      {
        installation: message.installation,
        repository: message.repository,
        prNumber: message.prNumber,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        kind: command.verb,
        level: command.level,
        force: command.force,
        commentId: message.commentId,
        deliveryId,
      },
    )
    switch (result.outcome) {
      case 'queued':
      case 'duplicate': {
        // A redelivery reacts again: GitHub keeps one reaction.
        await react(github, fullName, message.commentId, 'eyes')
        let out: WebhookResult =
          result.outcome === 'queued'
            ? { outcome: 'queued', jobId: result.jobId, cancelled: 0 }
            : { outcome: 'duplicate', reason: result.reason }
        log('info', 'command.accepted', { ...fields, reviewLevel: command.level, force: command.force, head: pr.head.sha, ...out })
        return out
      }
      case 'already':
        if (command.verb === 'resolve') {
          return refuse(
            'a resolve of the pull request is already running',
            `@${message.commenter.login} Une résolution des fils de cette PR est déjà en file ou en cours : attendez sa fin, puis relancez \`@kento resolve\` si des fils restent ouverts.`,
          )
        }
        return refuse(
          'head already has a review at this level',
          `@${message.commenter.login} Le commit \`${pr.head.sha.slice(0, 9)}\` a déjà une review \`${command.level}\` (en file, en cours ou publiée) : ` +
            `elle n'est pas payée deux fois. \`@kento review ${command.level} force\` en demande une autre.`,
        )
      case 'skipped':
        return { outcome: 'skipped', reason: result.reason }
    }
  }
}

type PullRequest = {
  state: string
  head?: { sha?: unknown; repo?: { id?: unknown } | null }
  base?: { ref?: unknown }
}

/**
 * A command costs money: only a person who can write to the repository, or a bot of
 * KENTO_TRUSTED_BOTS, can give one. The webhook has already dropped the other bots; the API of the
 * collaborators does not know the bots of an App.
 */
async function canCommand(github: GitHub, message: CommentCommandMessage): Promise<boolean> {
  if (message.commenter.isBot) return true
  try {
    let out: { permission?: string; role_name?: string } = await github.rest(
      'GET',
      `/repos/${message.repository.fullName}/collaborators/${encodeURIComponent(message.commenter.login)}/permission`,
    )
    return WRITERS.has(out.permission ?? '') || WRITERS.has(out.role_name ?? '')
  } catch (error) {
    // 404: the login is not a collaborator. Any other error goes up: the delivery fails, and GitHub
    // can send it again.
    if (error instanceof GitHubError && error.status === 404) return false
    throw error
  }
}
