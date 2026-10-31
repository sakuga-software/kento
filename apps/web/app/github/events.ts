import { SHA } from '@sakuga-review/protocol'

import { parseCommentCommand, type CommentCommand } from './comment-command.ts'

// Turns a verified webhook into one command for the store. The functions here read the payload
// only: no database, no network. A payload that lacks a field the command needs gives `invalid`.

export interface Installation {
  githubInstallationId: number
  githubAccountId: number
  login: string
}

export interface Repository {
  githubRepoId: number
  fullName: string
}

/** REV-22. The author of a pull request (`pull_request.user`, or `issue.user` of a comment). */
export interface PullAuthor {
  githubId: number
  login: string
}

export type WebhookCommand =
  | { type: 'ping' }
  | { type: 'ignore'; reason: string }
  | { type: 'invalid'; reason: string }
  | {
      type: 'enqueue_review'
      /** The `pull_request` action. After a close, only `reopened` queues a job again. */
      action: ReviewAction
      installation: Installation
      repository: Repository
      prNumber: number
      headSha: string
      /** The branch that the pull request targets, for the runner. */
      baseRef: string
      /** REV-22. Null when the payload lacks it: no preference of a person applies then. */
      author: PullAuthor | null
    }
  | {
      /**
       * A command in a new comment of a pull request (`@kento-review heavy`). The payload holds
       * neither the head nor the fork of the pull request, nor the permission of the commenter: the
       * command handler asks GitHub for them before it queues a job.
       */
      type: 'comment_command'
      installation: Installation
      repository: Repository
      prNumber: number
      commentId: number
      commenter: { login: string; isBot: boolean }
      command: CommentCommand
      /** REV-22. The author of the pull request, for the screen of a user. */
      author: PullAuthor | null
    }
  | { type: 'cancel_pull_request'; installation: Installation; repository: Repository; prNumber: number }
  /**
   * The pull request targets a new branch: GitHub moves a stacked pull request to the base of its
   * parent when the parent merges and its branch goes. The jobs that still read the base take it.
   */
  | { type: 'retarget_pull_request'; installation: Installation; repository: Repository; prNumber: number; baseRef: string }
  | { type: 'upsert_installation'; installation: Installation; repositories: Repository[]; suspended: boolean }
  | { type: 'delete_installation'; installation: Installation }
  | { type: 'add_repositories'; installation: Installation; repositories: Repository[] }
  | { type: 'remove_repositories'; installation: Installation; githubRepoIds: number[] }

export interface EventPolicy {
  /** Lowercase bot logins that act for a person. */
  trustedBots: ReadonlySet<string>
  /** The login of the App, `kento-review[bot]`. Its own comments never give a command. */
  botLogin?: string
}

/** The `pull_request` actions that create a review job: the same as `review.yml`. */
const REVIEW_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review'] as const

export type ReviewAction = (typeof REVIEW_ACTIONS)[number]

function isReviewAction(action: string | null): action is ReviewAction {
  return (REVIEW_ACTIONS as readonly (string | null)[]).includes(action)
}

export function commandFor(event: string, payload: unknown, policy: EventPolicy): WebhookCommand {
  if (!isObject(payload)) return { type: 'invalid', reason: 'payload is not an object' }
  switch (event) {
    case 'ping':
      return { type: 'ping' }
    case 'pull_request':
      return pullRequestCommand(payload, policy)
    case 'installation':
      return installationCommand(payload)
    case 'installation_repositories':
      return installationRepositoriesCommand(payload)
    case 'issue_comment':
      return issueCommentCommand(payload, policy)
    default:
      return { type: 'ignore', reason: `event ${event} is not handled` }
  }
}

function pullRequestCommand(payload: Obj, policy: EventPolicy): WebhookCommand {
  let action = str(payload.action)
  let pr = obj(payload.pull_request)
  let installation = installationFromRepository(payload)
  let repository = repositoryOf(obj(payload.repository))
  let prNumber = int(pr?.number) ?? int(payload.number)
  if (!pr || !installation || !repository || prNumber === null) {
    return { type: 'invalid', reason: 'pull_request payload lacks installation, repository or number' }
  }

  if (action === 'closed') {
    return { type: 'cancel_pull_request', installation, repository, prNumber }
  }
  if (action === 'edited') {
    // An edit of the title or of the body changes no job. Only a new base has `changes.base`.
    if (!obj(obj(payload.changes)?.base)) return { type: 'ignore', reason: 'pull_request edited without a new base' }
    let baseRef = str(obj(pr.base)?.ref)
    if (baseRef === null) return { type: 'invalid', reason: 'pull_request payload lacks base.ref' }
    return { type: 'retarget_pull_request', installation, repository, prNumber, baseRef }
  }
  if (!isReviewAction(action)) {
    return { type: 'ignore', reason: `pull_request action ${action ?? '(none)'} creates no job` }
  }
  if (pr.draft === true) return { type: 'ignore', reason: 'draft pull request' }

  let sender = obj(payload.sender)
  if (isUntrustedBot(sender, policy)) return { type: 'ignore', reason: 'pushed by an untrusted bot' }
  if (isUntrustedBot(obj(pr.user), policy)) return { type: 'ignore', reason: 'opened by an untrusted bot' }

  // A fork's pull request gets no job. GitHub sends `head.repo: null` when the fork was deleted.
  let head = obj(pr.head)
  let base = obj(pr.base)
  let headRepoId = int(obj(head?.repo)?.id)
  if (headRepoId === null || headRepoId !== repository.githubRepoId) {
    return { type: 'ignore', reason: 'pull request from a fork' }
  }

  let headSha = str(head?.sha)
  let baseRef = str(base?.ref)
  if (headSha === null || !SHA.test(headSha) || baseRef === null) {
    return { type: 'invalid', reason: 'pull_request payload lacks head.sha or base.ref' }
  }
  return { type: 'enqueue_review', action, installation, repository, prNumber, headSha, baseRef, author: authorOf(obj(pr.user)) }
}

/**
 * `issue_comment`: a new comment of an open pull request that starts with `@kento-review` or
 * `@sakuga-review`. An edited comment gives no command: a command costs money, and an edit would
 * run it again. The command handler drops the command of a repository that is not enabled: that
 * repository keeps its commands in the workflow `review.yml`.
 */
function issueCommentCommand(payload: Obj, policy: EventPolicy): WebhookCommand {
  let action = str(payload.action)
  if (action !== 'created') return { type: 'ignore', reason: `issue_comment action ${action ?? '(none)'} gives no command` }
  let issue = obj(payload.issue)
  let comment = obj(payload.comment)
  // A comment of an issue that is not a pull request.
  if (!obj(issue?.pull_request)) return { type: 'ignore', reason: 'comment is not on a pull request' }
  let body = typeof comment?.body === 'string' ? comment.body : ''
  let command = parseCommentCommand(body)
  if (command === null) return { type: 'ignore', reason: 'comment is not a command' }

  let installation = installationFromRepository(payload)
  let repository = repositoryOf(obj(payload.repository))
  let prNumber = int(issue?.number)
  let commentId = int(comment?.id)
  let user = obj(comment?.user)
  let login = str(user?.login)
  if (!installation || !repository || prNumber === null || commentId === null || login === null) {
    return { type: 'invalid', reason: 'issue_comment payload lacks installation, repository, number or comment' }
  }

  // The App first: even in KENTO_TRUSTED_BOTS, its own answers never run a command.
  let botLogin = (policy.botLogin ?? 'kento-review[bot]').toLowerCase()
  if (login.toLowerCase() === botLogin || str(obj(payload.sender)?.login)?.toLowerCase() === botLogin) {
    return { type: 'ignore', reason: 'comment of the App itself' }
  }
  if (isUntrustedBot(user, policy) || isUntrustedBot(obj(payload.sender), policy)) {
    return { type: 'ignore', reason: 'command of an untrusted bot' }
  }
  if (issue?.state !== 'open') return { type: 'ignore', reason: 'pull request is closed' }

  return {
    type: 'comment_command',
    installation,
    repository,
    prNumber,
    commentId,
    commenter: { login, isBot: user?.type === 'Bot' },
    command,
    author: authorOf(obj(issue?.user)),
  }
}

function installationCommand(payload: Obj): WebhookCommand {
  let installation = installationWithAccount(payload)
  if (!installation) return { type: 'invalid', reason: 'installation payload lacks installation.account' }
  let action = str(payload.action)
  switch (action) {
    case 'created':
    case 'new_permissions_accepted':
    case 'unsuspend':
      return {
        type: 'upsert_installation',
        installation,
        repositories: repositoryList(payload.repositories),
        suspended: false,
      }
    case 'suspend':
      return { type: 'upsert_installation', installation, repositories: [], suspended: true }
    case 'deleted':
      return { type: 'delete_installation', installation }
    default:
      return { type: 'ignore', reason: `installation action ${action ?? '(none)'} is not handled` }
  }
}

function installationRepositoriesCommand(payload: Obj): WebhookCommand {
  let installation = installationWithAccount(payload)
  if (!installation) return { type: 'invalid', reason: 'installation payload lacks installation.account' }
  let action = str(payload.action)
  if (action === 'added') {
    return { type: 'add_repositories', installation, repositories: repositoryList(payload.repositories_added) }
  }
  if (action === 'removed') {
    let ids = repositoryList(payload.repositories_removed).map((repo) => repo.githubRepoId)
    return { type: 'remove_repositories', installation, githubRepoIds: ids }
  }
  return { type: 'ignore', reason: `installation_repositories action ${action ?? '(none)'} is not handled` }
}

function isUntrustedBot(user: Obj | null, policy: EventPolicy): boolean {
  if (!user || user.type !== 'Bot') return false
  let login = str(user.login)
  return login === null || !policy.trustedBots.has(login.toLowerCase())
}

// The installation events carry the account. The other events carry only `installation.id`: the
// owner of the repository is the account of the installation.
function installationWithAccount(payload: Obj): Installation | null {
  let installation = obj(payload.installation)
  return toInstallation(int(installation?.id), obj(installation?.account))
}

function installationFromRepository(payload: Obj): Installation | null {
  return toInstallation(int(obj(payload.installation)?.id), obj(obj(payload.repository)?.owner))
}

function toInstallation(id: number | null, account: Obj | null): Installation | null {
  let accountId = int(account?.id)
  let login = str(account?.login)
  if (id === null || accountId === null || login === null) return null
  return { githubInstallationId: id, githubAccountId: accountId, login }
}

function repositoryOf(repo: Obj | null): Repository | null {
  let id = int(repo?.id)
  let fullName = str(repo?.full_name)
  if (id === null || fullName === null || !fullName.includes('/')) return null
  return { githubRepoId: id, fullName }
}

function repositoryList(value: unknown): Repository[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => repositoryOf(obj(item))).filter((repo) => repo !== null)
}

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authorOf(user: Obj | null): PullAuthor | null {
  let githubId = int(user?.id)
  let login = str(user?.login)
  return githubId === null || login === null ? null : { githubId, login }
}

function obj(value: unknown): Obj | null {
  return isObject(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}
