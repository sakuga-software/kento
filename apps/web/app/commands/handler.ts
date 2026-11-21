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
// <cause>` in the conversation, names a finding of the pull request. REV-94 sets it aside at once
// (reject.ts): 👀 on receipt, 🚀 after the effect, 😕 when a step on GitHub failed. A command in a review thread
// (`pull_request_review_comment`) gets its reactions and its reply on the routes of the review
// comments. In a thread, `reject` and `feedback` are read. KNT-160: the other commands get an answer at
// once that says where to write them; from the conversation, `resolve` reads the open threads, that one among them.
import { SHA } from '@kento-review/protocol'
import { and, eq, sql } from 'drizzle-orm'

import type postgres from 'postgres'

import type { Db } from '../db/client.ts'
import { findings, repos } from '../db/schema.ts'
import { enqueueCommandJob, isRepoEnabled, type CommentCommandMessage, type HandleCommentCommand, type WebhookResult } from '../db/webhook-store.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { rejectProblem, rejectProblemText, usage, type CommentCommand } from '../github/comment-command.ts'
import type { CommandPlace } from '../github/events.ts'
import { WRITERS } from '../github/permissions.ts'
import { mention } from '../instance.ts'
import { applyReject, REJECT_REFUSED, REJECT_THREAD_PERMISSIONS, type RejectTarget as RejectFinding } from './reject.ts'
import { errorMessage, log } from '../log.ts'
import { capSentence } from '../org-settings/notice.ts'
import { createGitHub, GitHubError, type GitHub } from '../publish/github.ts'

/**
 * Read the pull request and the permission of the commenter, react and reply on the comment. No
 * `contents`: the handler reads no code. A reaction on a comment of a pull request needs
 * `pull_requests: write`: with `read`, GitHub answers 403.
 */
export const COMMAND_PERMISSIONS: TokenPermissions = { pull_requests: 'write', issues: 'write' }

/** REV-107. `heart`: the receipt of an answer about the reviews. */
export type Reaction = 'eyes' | 'rocket' | 'confused' | 'heart'

export interface CommandHandlerDependencies {
  db: Db
  /** REV-94. The same database, for the status of the findings (`setFindingStatus`). */
  sql: postgres.Sql
  /** REV-94. The login of the App: the reviews that a `reject` can dismiss are its own. */
  botLogin?: string
  /** Null without the GitHub App: a command is then skipped. */
  mintInstallationToken: MintInstallationToken | null
  apiUrl: string
  /** REV-96. The public page of the commands, linked in the list of the commands. Null: no link. */
  docsUrl?: string | null
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

/** Adds a reaction of the App to a comment of the conversation or of a thread, and gives its id. */
export async function reactWithId(github: GitHub, fullName: string, commentId: number, content: Reaction, place: CommandPlace = CONVERSATION) {
  let { status, body } = await github.send<{ id?: number }>('POST', `${commentPath(fullName, commentId, place)}/reactions`, { content })
  return { created: status === 201, id: typeof body?.id === 'number' ? body.id : null }
}

/**
 * Removes a reaction of the App from a comment. GitHub gives the id of a reaction only when it is
 * posted (200 when it was already there, 201 when it is new): the call then deletes that id, so the
 * reaction is gone either way. A failure is logged, never thrown: it is a reaction.
 */
async function clearReaction(github: GitHub, fullName: string, commentId: number, content: Reaction, place: CommandPlace) {
  try {
    let { id } = await reactWithId(github, fullName, commentId, content, place)
    if (id !== null) await github.send('DELETE', `${commentPath(fullName, commentId, place)}/reactions/${id}`)
  } catch (error) {
    log('warn', 'command.reaction_not_removed', { repo: fullName, commentId, content, error: errorMessage(error) })
  }
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
      return refuse('unknown command', `@${message.commenter.login} \`${command.text.replaceAll('`', "'")}\` is not a Kentō command.\n\n${usage(deps.docsUrl)}`)
    }
    if (command.verb === 'reject') {
      let problem = rejectProblem(command, place.kind)
      if (problem) return refuse(`reject: ${problem}`, `@${message.commenter.login} ${rejectProblemText(problem)}\n\n${usage(deps.docsUrl)}`)
      let target = await findRejectTarget(deps.db, message, command)
      if (target.kind !== 'found') {
        return refuse(`reject: ${target.kind}`, `@${message.commenter.login} ${targetProblemText(target, command)}`)
      }
      let finding = target.finding
      // The status of the finding first: it costs no call to GitHub.
      if (REJECT_REFUSED.has(finding.status)) {
        return refuse(`reject: finding is ${finding.status}`, `@${message.commenter.login} ${closedText(finding.key)}`)
      }
      // As for the other commands: a pull request closed since the comment gets nothing.
      let open: { state?: string } = await github.rest('GET', `/repos/${fullName}/pulls/${message.prNumber}`)
      if (open.state !== 'open') return { outcome: 'skipped', reason: 'pull request is closed' }
      await reactWithId(github, fullName, message.commentId, 'eyes', place)
      let rejecting = applyReject({
        sql: deps.sql,
        github,
        writer: async () => {
          let write = await mint({
            installationId: message.installation.githubInstallationId,
            githubRepoId: message.repository.githubRepoId,
            permissions: REJECT_THREAD_PERMISSIONS,
          })
          return createGitHub({ apiUrl: deps.apiUrl, token: write.token, fetch: deps.fetch })
        },
        fullName,
        prNumber: message.prNumber,
        place,
        login: message.commenter.login,
        botLogin: deps.botLogin ?? 'kento-review[bot]',
        reason: command.reason,
        finding,
        warn: (event, extra) => log('warn', event, { ...fields, findingId: finding.id, ...extra }),
      })
      // The status could not be written: 😕, then the delivery fails (500). GitHub never sends it
      // again by itself: a redelivery from the settings of the App, or the same reject again, retries.
      let result = await rejecting.catch(async (error: unknown) => {
        await reactWithId(github, fullName, message.commentId, 'confused', place).catch(() => {})
        throw error
      })
      if (result.refusedStatus) {
        return refuse(`reject: finding is ${result.refusedStatus}`, `@${message.commenter.login} ${closedText(finding.key)}`)
      }
      // A redelivery or a second reject reacts again: GitHub keeps one reaction.
      if (result.failed.length) {
        // A redelivery that fails after a try that succeeded: the 🚀 of that try goes too.
        await clearReaction(github, fullName, message.commentId, 'rocket', place)
        await reactWithId(github, fullName, message.commentId, 'confused', place)
      } else {
        // A delivery sent again after a 😕 that now succeeds: the handler tries to take its 😕 back
        // (a failure is only logged), then adds 🚀.
        await clearReaction(github, fullName, message.commentId, 'confused', place)
        await reactWithId(github, fullName, message.commentId, 'rocket', place)
      }
      log('info', 'command.rejected', { ...fields, findingId: finding.id, reasonLength: command.reason.length, ...result })
      return { outcome: result.changed ? 'dismissed' : 'unchanged', findingId: finding.id, dismissedReview: result.dismissedReview }
    }
    if (place.kind === 'thread') return refuse('only reject is read in a review thread', `@${message.commenter.login} ${threadCommandText(command)}`)
    let pr: PullRequest = await github.rest('GET', `/repos/${fullName}/pulls/${message.prNumber}`)
    if (pr.state !== 'open') return { outcome: 'skipped', reason: 'pull request is closed' }
    // The code of a fork is not the code of the repository. GitHub sends `head.repo: null` when the
    // fork was deleted.
    if (pr.head?.repo?.id !== message.repository.githubRepoId) {
      return refuse('pull request from a fork', `@${message.commenter.login} Kentō does not review a PR from a fork.`)
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
            `@${message.commenter.login} A thread resolution of this PR is already queued or in progress. Wait for its end, then run \`${mention('resolve')}\` again if threads stay open.`,
          )
        }
        return refuse(
          'head already has a review at this level',
          `@${message.commenter.login} Commit \`${pr.head.sha.slice(0, 9)}\` already has a \`${command.level}\` review (queued, in progress or published). ` +
            `Kentō does not pay for it twice. \`${mention(`${command.level} force`)}\` asks for another one.`,
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
  | { kind: 'found'; finding: RejectFinding }
  /** The thread of the command is not the thread of a finding of Kentō. */
  | { kind: 'not_a_finding_thread' }
  /** No finding of the pull request has a key that starts with the id. */
  | { kind: 'unknown_id' }
  /** Several findings of the pull request have a key that starts with the id. */
  | { kind: 'ambiguous_id'; ids: string[] }
  /** KNT-160. In a thread, the id names another finding than the one of the thread (`key`). */
  | { kind: 'other_finding'; key: string }

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
    .select({
      id: findings.id,
      orgId: repos.orgId,
      key: findings.key,
      title: findings.title,
      status: findings.status,
      githubCommentId: findings.githubCommentId,
      githubThreadId: findings.githubThreadId,
    })
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
  if (rows.length === 1) {
    let finding = rows[0]!
    // KNT-160. In a thread, an id is optional; when it is there, it must be the id of the finding of
    // the thread. An id of no finding of the pull request gets the reply of an unknown id.
    if (message.place.kind === 'thread' && command.id) {
      // The findings of the pull request that the id names, as in the conversation: an id of several
      // is ambiguous even when one of them is the finding of the thread.
      let named = await db
        .select({ key: findings.key })
        .from(findings)
        .innerJoin(repos, eq(repos.id, findings.repoId))
        .where(and(eq(repos.githubRepoId, message.repository.githubRepoId), eq(findings.prNumber, message.prNumber), sql`starts_with(${findings.key}, ${command.id})`))
        .orderBy(findings.key)
        .limit(5)
      if (named.length > 1) return { kind: 'ambiguous_id', ids: named.map((row) => row.key) }
      if (!finding.key.startsWith(command.id)) return named.length ? { kind: 'other_finding', key: finding.key } : { kind: 'unknown_id' }
    }
    return { kind: 'found', finding }
  }
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
      return 'This thread is not the thread of a Kentō finding. Use `reject` in the thread of a finding, or in the conversation with its id.'
    case 'unknown_id':
      return `No finding of this PR has the id \`#${command.id}\`. The ids are in the list of findings in the description.`
    case 'ambiguous_id':
      return (
        `The id \`#${command.id}\` matches several findings of this PR: ` +
        `${target.ids.map((key) => `\`#${key}\``).join(', ')}. Give more characters of the id.`
      )
    case 'other_finding':
      return (
        `This thread holds the finding \`#${target.key.slice(0, 6)}\`, not \`#${command.id}\`. ` +
        `To dismiss \`#${target.key.slice(0, 6)}\`, write \`${mention('reject <cause>')}\` here. ` +
        `To dismiss \`#${command.id}\`, reply in its thread, or write \`${mention(`reject #${command.id} <cause>`)}\` in the conversation of the PR.`
      )
  }
}

/**
 * KNT-160. The reply to a `reject` of a finding that is no longer open. `fixed`: a later review did
 * not find it again after a push changed its file, near its line when GitHub gave the patch (publish.ts). Kentō does not know that the push
 * fixed it, so the reply does not say so.
 */
export function closedText(key: string): string {
  // What the publisher or `resolve` checked: a change of its file (near its line for a review), and
  // the review did not find it again, or the model read the thread against the code. Not that the
  // push fixed it for sure. KNT-192: a `stale` finding is no longer refused.
  return (
    `The finding \`#${key.slice(0, 6)}\` is no longer open: it is fixed. A later review did not find it again after a push changed its file, ` +
    `or \`${mention('resolve')}\` read its thread against the code. There is nothing to dismiss.`
  )
}

/**
 * KNT-160. The reply to a command other than `reject` and `feedback` in a review thread: Kentō does not
 * run it there, and says at once where it goes.
 */
export function threadCommandText(command: Exclude<CommentCommand, { verb: 'reject' | 'feedback' | 'unknown' }>): string {
  let read = `In a thread, Kentō reads \`${mention('reject <cause>')}\` and \`${mention('feedback <opinion>')}\`.`
  if (command.verb === 'resolve') {
    return (
      `\`${mention('resolve')}\` goes in the conversation of the PR, not in a thread. From there, Kentō reads the open threads of the PR, ` +
      `this one among them, within the limits of the command. ${read}`
    )
  }
  return `${read} A review command goes in the conversation of the PR.`
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
