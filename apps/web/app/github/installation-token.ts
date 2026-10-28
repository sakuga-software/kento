import { createPrivateKey, sign, type KeyObject } from 'node:crypto'

/** A GitHub token that a runner uses to clone one repository. */
export interface InstallationToken {
  token: string
  /** ISO 8601, as GitHub gives it. GitHub makes it valid one hour. */
  expiresAt: string
}

export type MintInstallationToken = (target: {
  installationId: number
  githubRepoId: number
}) => Promise<InstallationToken>

export class InstallationTokenError extends Error {
  override name = 'InstallationTokenError'
}

/**
 * Reads the private key of the GitHub App from PEM text. An environment variable often holds the
 * PEM on one line with `\n`: they become new lines. Throws when the text is not a private key.
 */
export function readPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem.includes('\\n') ? pem.replaceAll('\\n', '\n') : pem)
}

/**
 * Makes installation tokens for the runners. The private key of the App stays in this process: a
 * runner gets only the token, which GitHub limits to the one repository of the job, with
 * `contents: read`, for one hour.
 */
export function createInstallationTokenMinter(options: {
  appId: string
  privateKey: KeyObject
  apiUrl?: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}): MintInstallationToken {
  let apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  let doFetch = options.fetch ?? globalThis.fetch
  let now = options.now ?? Date.now

  return async ({ installationId, githubRepoId }) => {
    let response = await doFetch(`${apiUrl}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt(options.appId, options.privateKey, now())}`,
        'Content-Type': 'application/json',
        'User-Agent': 'kento-web',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        repository_ids: [githubRepoId],
        permissions: { contents: 'read' },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status !== 201) {
      // The body of a GitHub error holds no secret; it says which permission or repository failed.
      let detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new InstallationTokenError(`GitHub answered ${response.status}: ${detail}`)
    }
    let body = (await response.json()) as { token?: unknown; expires_at?: unknown }
    if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
      throw new InstallationTokenError('GitHub answered without a token')
    }
    return { token: body.token, expiresAt: body.expires_at }
  }
}

/**
 * The JSON Web Token that authenticates the App itself, signed with RS256. GitHub accepts at most
 * 10 minutes; `iat` is one minute in the past for a clock that is a little ahead.
 */
export function appJwt(appId: string, privateKey: KeyObject, nowMs: number): string {
  let seconds = Math.floor(nowMs / 1000)
  let header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  let payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))
  let signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url')
}
