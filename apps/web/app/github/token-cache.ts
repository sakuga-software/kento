// REV-92. The service keeps one installation token per (installation, repository) for as long as it
// is valid, instead of one mint for each claim. Only the service uses these tokens: a runner never
// gets one (see THREADS_PERMISSIONS in resolve/threads.ts).
import { errorMessage, log } from '../log.ts'
import { GitHubError } from '../publish/github.ts'
import type { InstallationToken, MintInstallationToken, TokenPermissions } from './installation-token.ts'

/** A token that expires in less than this time is minted again. GitHub makes a token valid one hour. */
export const REFRESH_MARGIN_MS = 5 * 60_000

/** The installation and the one repository of a token. */
export interface TokenTarget {
  installationId: number
  githubRepoId: number
}

export interface InstallationTokenCache {
  /**
   * Runs `use` with the kept token of the target, or with a new one. When GitHub answers 401, the
   * cache forgets the token, mints a new one, and runs `use` again once.
   */
  run<T>(target: TokenTarget, use: (token: InstallationToken) => Promise<T>): Promise<T>
}

interface Entry {
  pending: Promise<InstallationToken>
  /** Null until the mint answers. */
  token: InstallationToken | null
}

export function createInstallationTokenCache(options: {
  mint: MintInstallationToken
  permissions: TokenPermissions
  now?: () => number
  refreshMarginMs?: number
}): InstallationTokenCache {
  let now = options.now ?? Date.now
  let margin = options.refreshMarginMs ?? REFRESH_MARGIN_MS
  let entries = new Map<string, Entry>()

  // A token without a valid `expiresAt` is never kept: NaN is never fresh.
  let fresh = (token: InstallationToken) => Date.parse(token.expiresAt) - margin > now()

  function mint(key: string, target: TokenTarget): Promise<InstallationToken> {
    // An expired entry of another repository goes now: the map holds only the tokens that are still valid.
    for (let [other, entry] of entries) if (entry.token && !fresh(entry.token)) entries.delete(other)
    let entry: Entry = { pending: options.mint({ ...target, permissions: options.permissions }), token: null }
    entries.set(key, entry)
    entry.pending.then(
      (token) => {
        entry.token = token
        log('info', 'github.token_minted', { ...target, permissions: options.permissions, expiresAt: token.expiresAt })
      },
      // A failed mint is not kept: the next claim tries again.
      () => {
        if (entries.get(key) === entry) entries.delete(key)
      },
    )
    return entry.pending
  }

  /**
   * The kept token, or a new one. No await before the mint: the claims that come together find the
   * entry of the first one and wait for the same mint.
   */
  function get(key: string, target: TokenTarget): Promise<InstallationToken> {
    let entry = entries.get(key)
    // A mint in progress serves every claim that waits for it, even when GitHub gives a token with
    // less time than the margin: the margin is for keeping a token, and this one is new.
    if (entry && !entry.token) return entry.pending
    if (entry?.token && fresh(entry.token)) return Promise.resolve(entry.token)
    return mint(key, target)
  }

  return {
    async run(target, use) {
      let key = `${target.installationId}:${target.githubRepoId}`
      let token = await get(key, target)
      try {
        return await use(token)
      } catch (cause) {
        if (!(cause instanceof GitHubError) || cause.status !== 401) throw cause
        // GitHub refused the token, for example after a reinstallation of the App. Forget it, only
        // when no other claim replaced it yet, and try once with a new token.
        let entry = entries.get(key)
        if (entry?.token === token) entries.delete(key)
        log('warn', 'github.token_refused', { ...target, permissions: options.permissions, error: errorMessage(cause).slice(0, 300) })
        return use(await get(key, target))
      }
    },
  }
}
