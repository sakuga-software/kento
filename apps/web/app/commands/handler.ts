// The commands of the comments: `@kento-review [lite|balanced|heavy] [force]` and
// `@kento-review resolve [lite|balanced|heavy]`, with `@sakuga-review` as an alias (REV-7). The webhook gives the parsed command; this handler asks GitHub what the
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
//
// REV-93. `@kento-review reject <cause>` in the thread of a finding, or `@kento-review reject <id>
// <cause>` in the conversation, names a finding of the pull request. A command in a review thread
// (`pull_request_review_comment`) gets its reactions and its reply on the routes of the review
// comments. In a thread, only `reject` is read: the other commands go in the conversation.
import { SHA } from '@sakuga-review/protocol'
import { and, eq, sql } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { findings, repos } from '../db/schema.ts'
import { enqueueCommandJob, isRepoEnabled, type CommentCommandMessage, type HandleCommentCommand, type WebhookResult } from '../db/webhook-store.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { rejectProblem, rejectProblemText, USAGE, type CommentCommand } from '../github/comment-command.ts'
import type { CommandPlace } from '../github/events.ts'
import { WRITERS } from '../github/permissions.ts'
import { errorMessage, log } from '../log.ts'
import { capSentence } from '../org-settings/notice.ts'
import { createGitHub, GitHubError, type GitHub } from '../publish/github.ts'

/**
 * Read the pull request and the permission of the commenter, react and reply on the comment. No
 * `contents`: the handler reads no code. A reaction on a comment of a pull request needs
 * `pull_requests: write`: with `read`, GitHub answers 403.
 */
export const COMMAND_PERMISSIONS: TokenPermissions = { pull_requests: 'write', issues: 'write' }

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

const CONVERSATION: CommandPlace = { kind: 'conversation' }

/** The route of a comment: a comment of the conversation, or a review comment of a thread. */
function commentPath(fullName: string, commentId: number, place: CommandPlace): string {
  return `/repos/${fullName}/${place.kind === 'thread' ? 'pulls' : 'issues'}/comments/${commentId}`
}

async function reactWithId(github: GitHub, fullName: string, commentId: number, content: Reaction, place: CommandPlace = CONVERSATION) {
  let { status, body } = await github.send<{ id?: number }>('POST', `${commentPath(fullName, commentId, place)}/reactions`, { content })
  return { created: status === 201, id: typeof body?.id === 'number' ? body.id : null }
}

/**
 * Posts the reply of the bot: in the thread for a command of a thread, under the pull request for
 * a command of the conversation.
 */
function postReply(github: GitHub, fullName: string, prNumber: number, place: CommandPlace, body: string) {
  return place.kind === 'thread'
    ? github.rest('POST', `/repos/${fullName}/pulls/${prNumber}/comments/${place.rootCommentId}/replies`, { body })
    : github.rest('POST', `/repos/${fullName}/issues/${prNumber}/comments`, { body })
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
      place: message.place.kind,
    }
    let place = message.place
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
      let reaction = await reactWithId(github, fullName, message.commentId, 'confused', place)
      if (reaction.created) {
        try {
          await postReply(github, fullName, message.prNumber, place, reply)
        } catch (error) {
          if (reaction.id !== null) {
            await github
              .send('DELETE', `${commentPath(fullName, message.commentId, place)}/reactions/${reaction.id}`)
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
    if (command.verb === 'reject') {
      let problem = rejectProblem(command, place.kind)
      if (problem) return refuse(`reject: ${problem}`, `@${message.commenter.login} ${rejectProblemText(problem)}\n\n${USAGE}`)
      let target = await findRejectTarget(deps.db, message, command)
      if (target.kind !== 'found') {
        return refuse(`reject: ${target.kind}`, `@${message.commenter.login} ${targetProblemText(target, command)}`)
      }
      // A push fixed the finding, or the pull request closed: there is nothing to set aside.
      if (target.status === 'fixed' || target.status === 'stale') {
        let why = target.status === 'fixed' ? "un push l'a déjà corrigé" : 'il ne vaut plus pour cette PR (stale)'
        return refuse(`reject: finding is ${target.status}`, `@${message.commenter.login} Le constat \`#${target.key.slice(0, 6)}\` n'est plus ouvert : ${why}. Il n'y a rien à écarter.`)
      }
      // REV-94 sets the finding aside here. Until then, 👀 says that the command names a finding.
      await reactWithId(github, fullName, message.commentId, 'eyes', place)
      log('info', 'command.reject_accepted', { ...fields, findingId: target.findingId, reasonLength: command.reason.length })
      return { outcome: 'accepted', findingId: target.findingId }
    }
    if (place.kind === 'thread') {
      return refuse(
        'only reject is read in a review thread',
        `@${message.commenter.login} Dans le fil d'un constat, Kentō ne lit que \`@kento-review reject <cause>\`. Les autres commandes vont dans la conversation de la PR.`,
      )
    }
    let pr: PullRequest = await github.rest('GET', `/repos/${fullName}/pulls/${message.prNumber}`)
    if (pr.state !== 'open') return { outcome: 'skipped', reason: 'pull request is closed' }
    // The code of a fork is not the code of the repository. GitHub sends `head.repo: null` when the
    // fork was deleted.
    if (pr.head?.repo?.id !== message.repository.githubRepoId) {
      return refuse('pull request from a fork', `@${message.commenter.login} Kentō ne relit pas une PR qui vient d'un fork.`)
    }
    if (typeof pr.head.sha !== 'string' || !SHA.test(pr.head.sha) || typeof pr.base?.ref !== 'string') {
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
        author: message.author,
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
            `@${message.commenter.login} Une résolution des fils de cette PR est déjà en file ou en cours : attendez sa fin, puis relancez \`@kento-review resolve\` si des fils restent ouverts.`,
          )
        }
        return refuse(
          'head already has a review at this level',
          `@${message.commenter.login} Le commit \`${pr.head.sha.slice(0, 9)}\` a déjà une review \`${command.level}\` (en file, en cours ou publiée) : ` +
            `elle n'est pas payée deux fois. \`@kento-review ${command.level} force\` en demande une autre.`,
        )
      case 'skipped':
        return { outcome: 'skipped', reason: result.reason }
      case 'capped': {
        let { hit } = result
        let reason = `${hit.period === 'day' ? 'daily' : 'monthly'} cost limit of the org is reached`
        await refuse(reason, `@${message.commenter.login} ${capSentence(hit)}`)
        return { outcome: 'capped', reason, period: hit.period, spentUsd: hit.spentUsd, capUsd: hit.capUsd, resetsAt: hit.resetsAt.toISOString() }
      }
    }
  }
}

type RejectCommand = Extract<CommentCommand, { verb: 'reject' }>

type RejectTarget =
  | { kind: 'found'; findingId: string; key: string; status: string }
  /** The thread of the command is not the thread of a finding of Kentō. */
  | { kind: 'not_a_finding_thread' }
  /** No finding of the pull request has a key that starts with the id. */
  | { kind: 'unknown_id' }
  /** Several findings of the pull request have a key that starts with the id. */
  | { kind: 'ambiguous_id'; ids: string[] }

/**
 * The finding that a `reject` names, in the pull request of the command: the finding of the thread,
 * by the first comment of the thread, or the finding whose key starts with the id. A finding of
 * another pull request or of another repository is never found.
 */
export async function findRejectTarget(db: Db, message: CommentCommandMessage, command: RejectCommand): Promise<RejectTarget> {
  // The guard of `rejectProblem` asks for an id in the conversation. Without one, `starts_with` would
  // match every finding of the pull request.
  if (message.place.kind === 'conversation' && !command.id) return { kind: 'unknown_id' }
  let rows = await db
    .select({ id: findings.id, key: findings.key, status: findings.status })
    .from(findings)
    .innerJoin(repos, eq(repos.id, findings.repoId))
    .where(
      and(
        eq(repos.githubRepoId, message.repository.githubRepoId),
        eq(findings.prNumber, message.prNumber),
        message.place.kind === 'thread'
          ? eq(findings.githubCommentId, message.place.rootCommentId)
          : sql`starts_with(${findings.key}, ${command.id ?? ''})`,
      ),
    )
    .orderBy(findings.key)
    .limit(5)
  if (rows.length === 1) return { kind: 'found', findingId: rows[0]!.id, key: rows[0]!.key, status: rows[0]!.status }
  if (message.place.kind === 'thread') {
    // One thread has one finding: two rows would be a bug of the ledger. The thread is refused.
    return { kind: 'not_a_finding_thread' }
  }
  if (rows.length === 0) return { kind: 'unknown_id' }
  return { kind: 'ambiguous_id', ids: rows.map((row) => row.key) }
}

function targetProblemText(target: Exclude<RejectTarget, { kind: 'found' }>, command: RejectCommand): string {
  switch (target.kind) {
    case 'not_a_finding_thread':
      return "Ce fil n'est pas celui d'un constat de Kentō : `reject` se lance dans le fil d'un constat, ou dans la conversation avec son id."
    case 'unknown_id':
      return `Aucun constat de cette PR n'a l'id \`#${command.id}\`. Les ids sont dans la liste des constats de la description.`
    case 'ambiguous_id':
      return (
        `L'id \`#${command.id}\` désigne plusieurs constats de cette PR : ` +
        `${target.ids.map((key) => `\`#${key}\``).join(', ')}. Donnez plus de caractères de l'id.`
      )
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
