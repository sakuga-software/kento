// The check of the Repos screen: it reads on GitHub the repositories of an installation and their
// review workflow, and writes them in `repos`. It never enables a repository.
//
// A screen starts it in the background when the last check is older than CHECK_MAX_AGE_MS; an admin
// can run it at once ("Reload"). One check per org at a time; it reads each installation of the org.
import type { MintInstallationToken } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
import { createGitHub, GitHubError, type GitHub } from '../publish/github.ts'
import type { CheckedRepo, RepoPage, ReposStore } from './store.ts'
import { detectWorkflow, isWorkflowFile, type WorkflowFile } from './workflow.ts'

/** A check older than this starts a new one when a screen shows the repositories. */
export const CHECK_MAX_AGE_MS = 10 * 60_000
/** After a failed check, the screens wait this long before they start another one. */
const RETRY_AFTER_MS = 60_000
/** The installation lists 100 repositories a page; the check reads 10 pages at most. */
const MAX_PAGES = 10
/** The workflow files read in one repository, at most. */
const MAX_FILES = 30
/** Repositories read at the same time. */
const CONCURRENCY = 4

const WORKFLOWS_DIR = '.github/workflows'

export interface CheckedOrg {
  id: string
  name: string
  installations: { id: string; githubInstallationId: number; login: string }[]
}

export interface RepoCheckDependencies {
  store: ReposStore
  mintInstallationToken: MintInstallationToken
  apiUrl: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export interface RepoCheck {
  /** Reads GitHub and writes the result. Throws when GitHub fails for a whole installation. */
  run(org: CheckedOrg): Promise<{ repos: number; failed: number }>
  /**
   * Starts a check in the background when the rows are older than `CHECK_MAX_AGE_MS`, or never
   * checked. Returns true while a check of the org runs.
   */
  refreshIfStale(org: CheckedOrg, repos: Pick<RepoPage, 'counts' | 'checkedAt' | 'unchecked'>): boolean
}

interface InstallationRepo {
  id: number
  full_name: string
  private: boolean
  default_branch?: string | null
  archived?: boolean
}

export function createRepoCheck(deps: RepoCheckDependencies): RepoCheck {
  let now = deps.now ?? Date.now
  let running = new Map<string, Promise<{ repos: number; failed: number }>>()
  let failedAt = new Map<string, number>()
  // The end of the last check of each org in this process, even when a repository failed in it:
  // a row that the check could not write (GitHub failed for it, or it left the installation) must
  // not start a full check at each load of the screen.
  let checkedAt = new Map<string, number>()

  async function check(org: CheckedOrg) {
    let total = { repos: 0, failed: 0 }
    let firstError: unknown = null
    // One installation after the other: each one writes its repositories, even when another one fails
    // (an installation removed on GitHub whose event was lost). The check fails at the end if one did.
    for (let installation of org.installations) {
      try {
        let result = await checkInstallation(org, installation)
        total.repos += result.repos
        total.failed += result.failed
      } catch (error) {
        log('warn', 'repos.check_installation_failed', { org: org.name, installation: installation.login, error: errorMessage(error) })
        firstError ??= error
      }
    }
    if (firstError !== null) throw firstError
    return total
  }

  async function checkInstallation(org: CheckedOrg, installation: CheckedOrg['installations'][number]) {
    let start = now()
    // `contents: read` on every repository of the installation, for the list and the workflow files.
    let token = await deps.mintInstallationToken({
      installationId: installation.githubInstallationId,
      githubRepoId: null,
      permissions: { contents: 'read' },
    })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })

    let listed: InstallationRepo[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      let body: { repositories?: InstallationRepo[] } = await github.rest('GET', `/installation/repositories?per_page=100&page=${page}`)
      let repositories = body.repositories ?? []
      listed.push(...repositories)
      if (repositories.length < 100) break
    }

    let checked: CheckedRepo[] = []
    let failed = 0
    let queue = listed.filter((repo) => !repo.archived)
    async function worker() {
      for (let repo = queue.shift(); repo; repo = queue.shift()) {
        try {
          let files = await readWorkflows(github, repo.full_name)
          checked.push({
            githubRepoId: repo.id,
            fullName: repo.full_name,
            private: repo.private,
            defaultBranch: repo.default_branch ?? null,
            workflow: detectWorkflow(files),
          })
        } catch (error) {
          // The row keeps what the last check found.
          failed++
          log('warn', 'repos.check_repo_failed', { org: org.name, installation: installation.login, repo: repo.full_name, error: errorMessage(error) })
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    await deps.store.saveCheck({ orgId: org.id, installationId: installation.id }, checked)
    log('info', 'repos.checked', { org: org.name, installation: installation.login, repos: checked.length, failed, durationMs: now() - start })
    return { repos: checked.length, failed }
  }

  function run(org: CheckedOrg) {
    let current = running.get(org.id)
    if (current) return current
    let promise = check(org)
      .then((result) => {
        failedAt.delete(org.id)
        checkedAt.set(org.id, now())
        return result
      })
      .catch((error: unknown) => {
        failedAt.set(org.id, now())
        log('warn', 'repos.check_failed', { org: org.name, error: errorMessage(error) })
        throw error
      })
      .finally(() => running.delete(org.id))
    running.set(org.id, promise)
    return promise
  }

  return {
    run,
    refreshIfStale(org, repos) {
      if (running.has(org.id)) return true
      let lastFailure = failedAt.get(org.id)
      if (lastFailure !== undefined && now() - lastFailure < RETRY_AFTER_MS) return false
      let lastCheck = checkedAt.get(org.id)
      if (lastCheck !== undefined && now() - lastCheck < CHECK_MAX_AGE_MS) return false
      // No check in this process yet (a restart): the rows say how old the last one is.
      let stale =
        repos.counts.all === 0 ||
        repos.unchecked ||
        (repos.checkedAt !== null && now() - repos.checkedAt.getTime() > CHECK_MAX_AGE_MS)
      if (!stale) return false
      // The error is in the log already.
      run(org).catch(() => {})
      return true
    },
  }
}

/** The workflow files of a repository, on its default branch. No `.github/workflows`: none. */
async function readWorkflows(github: GitHub, fullName: string): Promise<WorkflowFile[]> {
  let entries: { type?: string; name?: string; path?: string }[]
  try {
    entries = await github.rest('GET', `/repos/${fullName}/contents/${WORKFLOWS_DIR}`)
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return []
    throw error
  }
  if (!Array.isArray(entries)) return []
  let paths = entries
    .filter((entry) => entry.type === 'file' && typeof entry.name === 'string' && isWorkflowFile(entry.name))
    .map((entry) => entry.path ?? `${WORKFLOWS_DIR}/${entry.name}`)
    .slice(0, MAX_FILES)
  let files: WorkflowFile[] = []
  for (let path of paths) {
    let file: { content?: string; encoding?: string } = await github.rest('GET', `/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}`)
    if (typeof file.content !== 'string') continue
    let text = file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content
    files.push({ path, text })
  }
  return files
}
