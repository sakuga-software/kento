import { SHA } from '@kento-review/protocol'

import type { MintInstallationToken } from '../github/installation-token.ts'
import { createGitHub } from '../publish/github.ts'

/** A pull request as GitHub sees it now. */
export interface PullRequestNow {
  open: boolean
  headSha: string
}

/** Reads the state and the head of a pull request on GitHub, for "Run again". */
export type ReadPullRequest = (target: {
  installationId: number
  githubRepoId: number
  fullName: string
  prNumber: number
}) => Promise<PullRequestNow>

/**
 * GitHub sends no event to Kentō for a push on a disabled repository, and a delivery can be lost:
 * the jobs of the database do not always know the head of a pull request. A retry asks GitHub,
 * with a token `pull_requests: read` for that repository only.
 */
export function createReadPullRequest(deps: { mintInstallationToken: MintInstallationToken; apiUrl: string; fetch?: typeof globalThis.fetch }): ReadPullRequest {
  return async ({ installationId, githubRepoId, fullName, prNumber }) => {
    let token = await deps.mintInstallationToken({ installationId, githubRepoId, permissions: { pull_requests: 'read' } })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
    let pr: { state?: unknown; head?: { sha?: unknown } } = await github.rest('GET', `/repos/${fullName}/pulls/${prNumber}`)
    let headSha = pr.head?.sha
    if (typeof headSha !== 'string' || !SHA.test(headSha)) {
      throw new Error('GitHub gave a pull request without head.sha')
    }
    return { open: pr.state === 'open', headSha }
  }
}
