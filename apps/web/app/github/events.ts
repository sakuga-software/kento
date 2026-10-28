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

export type WebhookCommand =
  | { type: 'ping' }
  | { type: 'ignore'; reason: string }
  | { type: 'invalid'; reason: string }
  | {
      type: 'enqueue_review'
      installation: Installation
      repository: Repository
      prNumber: number
      headSha: string
      /** The branch that the pull request targets, for the runner. */
      baseRef: string
    }
  | { type: 'cancel_pull_request'; installation: Installation; repository: Repository; prNumber: number }
  | { type: 'upsert_installation'; installation: Installation; repositories: Repository[]; suspended: boolean }
  | { type: 'delete_installation'; installation: Installation }
  | { type: 'add_repositories'; installation: Installation; repositories: Repository[] }
  | { type: 'remove_repositories'; installation: Installation; githubRepoIds: number[] }

export interface EventPolicy {
  /** Lowercase `owner/name` of the repositories that get a job. */
  kentoRepos: ReadonlySet<string>
  /** Lowercase bot logins that act for a person. */
  trustedBots: ReadonlySet<string>
}

/** The `pull_request` actions that create a review job: the same as `review.yml`. */
const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review'])

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
      // The `@kento` commands have their own ticket.
      return { type: 'ignore', reason: 'issue_comment is not handled yet' }
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
  if (action === null || !REVIEW_ACTIONS.has(action)) {
    return { type: 'ignore', reason: `pull_request action ${action ?? '(none)'} creates no job` }
  }
  if (!policy.kentoRepos.has(repository.fullName.toLowerCase())) {
    return { type: 'ignore', reason: 'repository is not in KENTO_REPOS' }
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
  if (headSha === null || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headSha) || baseRef === null) {
    return { type: 'invalid', reason: 'pull_request payload lacks head.sha or base.ref' }
  }
  return { type: 'enqueue_review', installation, repository, prNumber, headSha, baseRef }
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

function obj(value: unknown): Obj | null {
  return isObject(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}
