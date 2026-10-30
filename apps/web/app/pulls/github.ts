// REV-17. The header of the screen of a pull request: its title, its author and its branches, which
// only GitHub holds. One read per pull request and minute at most: a person who opens a finding and
// comes back makes no second call.
import { fetchWithin, SCREEN_GITHUB_TIMEOUT_MS } from '../github/fetch.ts'
import type { MintInstallationToken } from '../github/installation-token.ts'
import { createGitHub } from '../publish/github.ts'
import type { PullTarget } from './store.ts'

export interface PullHeader {
  title: string
  author: string
  headRef: string
  baseRef: string
  state: 'open' | 'closed' | 'merged'
  headSha: string
}

export type ReadPullHeader = (target: PullTarget) => Promise<PullHeader>

/** How long a header read on GitHub stays good. */
export const HEADER_TTL_MS = 60_000
/** The pull requests whose header the service keeps. */
const HEADER_CACHE_MAX = 200

/** Reads the pull request on GitHub, with a token `pull_requests: read` for its repository only. */
export function createReadPullHeader(deps: {
  mintInstallationToken: MintInstallationToken
  apiUrl: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}): ReadPullHeader {
  let now = deps.now ?? Date.now
  let cache = new Map<string, { at: number; header: PullHeader }>()
  return async (target) => {
    let key = `${target.installationId}:${target.githubRepoId}#${target.prNumber}`
    let hit = cache.get(key)
    if (hit && now() - hit.at < HEADER_TTL_MS) return hit.header
    let token = await deps.mintInstallationToken({
      installationId: target.installationId,
      githubRepoId: target.githubRepoId,
      permissions: { pull_requests: 'read' },
    })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: fetchWithin(SCREEN_GITHUB_TIMEOUT_MS, deps.fetch) })
    let pr: {
      title?: unknown
      state?: unknown
      merged_at?: unknown
      user?: { login?: unknown }
      head?: { ref?: unknown; sha?: unknown }
      base?: { ref?: unknown }
    } = await github.rest('GET', `/repos/${target.fullName}/pulls/${target.prNumber}`)
    let text = (value: unknown) => (typeof value === 'string' ? value : '')
    let header: PullHeader = {
      title: text(pr.title),
      author: text(pr.user?.login),
      headRef: text(pr.head?.ref),
      baseRef: text(pr.base?.ref),
      state: pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'closed',
      headSha: text(pr.head?.sha),
    }
    cache.delete(key)
    cache.set(key, { at: now(), header })
    if (cache.size > HEADER_CACHE_MAX) cache.delete(cache.keys().next().value!)
    return header
  }
}
