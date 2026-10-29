import type { ListChangedFiles } from '../db/webhook-store.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { createGitHub } from '../publish/github.ts'

/** The list of the files of a pull request. No `contents`: the paths only. */
export const CHANGED_FILES_PERMISSIONS: TokenPermissions = { pull_requests: 'read' }

/** GitHub lists at most 3,000 files of a pull request, 100 a page. */
const PAGE = 100
const MAX_PAGES = 30

/**
 * Reads the paths that a pull request changes (REV-12), for the paths of the config. A renamed file
 * counts at its old path and at its new one.
 */
export function createListChangedFiles(deps: { mintInstallationToken: MintInstallationToken; apiUrl: string; fetch?: typeof globalThis.fetch }): ListChangedFiles {
  return async (command) => {
    let token = await deps.mintInstallationToken({
      installationId: command.installation.githubInstallationId,
      githubRepoId: command.repository.githubRepoId,
      permissions: CHANGED_FILES_PERMISSIONS,
    })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
    let files: string[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      let batch: { filename?: unknown; previous_filename?: unknown }[] = await github.rest(
        'GET',
        `/repos/${command.repository.fullName}/pulls/${command.prNumber}/files?per_page=${PAGE}&page=${page}`,
      )
      if (!Array.isArray(batch)) throw new Error('GitHub gave the files of a pull request as something else than a list')
      for (let file of batch) {
        if (typeof file.filename === 'string') files.push(file.filename)
        if (typeof file.previous_filename === 'string') files.push(file.previous_filename)
      }
      if (batch.length < PAGE) break
    }
    return files
  }
}
