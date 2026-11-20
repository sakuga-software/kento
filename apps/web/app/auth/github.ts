import { createHash, type KeyObject } from 'node:crypto'

import { createOAuthProvider, type OAuthProvider } from 'remix/auth'

import { appJwt } from '../github/installation-token.ts'

/** What Kentō keeps of a GitHub account. */
export interface GitHubProfile {
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

export class GitHubError extends Error {
  override name = 'GitHubError'
}

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'kento-web',
  'X-GitHub-Api-Version': '2022-11-28',
}

/**
 * The sign-in with the user authorization of the GitHub App: authorization code with PKCE and
 * `state` (checked by `remix/auth`). The user token reads `GET /user` once and is dropped: it is
 * never stored, and Kentō never acts as the person.
 *
 * Not `createGitHubAuthProvider` of `remix/auth`: it has the addresses of github.com built in (no
 * GitHub Enterprise Server, no fake GitHub in the tests), and it reads `/user/emails`, which the
 * App is not allowed to read and which Kentō does not need.
 */
export function createGitHubSignIn(options: {
  clientId: string
  clientSecret: string
  redirectUri: URL
  oauthUrl: string
  apiUrl: string
  fetch?: typeof globalThis.fetch
}): OAuthProvider<GitHubProfile, 'github'> {
  let doFetch = options.fetch ?? globalThis.fetch
  let oauthUrl = options.oauthUrl.replace(/\/+$/, '')
  let apiUrl = options.apiUrl.replace(/\/+$/, '')

  return createOAuthProvider<GitHubProfile, 'github'>('github', {
    async createAuthorizationURL(transaction) {
      let url = new URL(`${oauthUrl}/login/oauth/authorize`)
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', options.redirectUri.href)
      url.searchParams.set('state', transaction.state)
      url.searchParams.set('code_challenge', createHash('sha256').update(transaction.codeVerifier).digest('base64url'))
      url.searchParams.set('code_challenge_method', 'S256')
      // A GitHub App takes its permissions from its settings, not from scopes.
      url.searchParams.set('allow_signup', 'false')
      return url
    },

    async handleCallback(context, transaction) {
      let code = context.url.searchParams.get('code')
      if (!code) throw new GitHubError('GitHub sent no code')

      let tokenResponse = await doFetch(`${oauthUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'kento-web' },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: options.redirectUri.href,
          code_verifier: transaction.codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      let token = (await tokenResponse.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null
      if (!tokenResponse.ok || typeof token?.access_token !== 'string') {
        // `error` is a code such as `bad_verification_code`; it holds no secret.
        throw new GitHubError(`GitHub refused the code: ${tokenResponse.status} ${String(token?.error ?? '')}`.trim())
      }

      let userResponse = await doFetch(`${apiUrl}/user`, {
        headers: { ...HEADERS, Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!userResponse.ok) throw new GitHubError(`GitHub answered ${userResponse.status} on /user`)
      let user = (await userResponse.json()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown }
      if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string') {
        throw new GitHubError('GitHub answered /user without an id or a login')
      }
      let profile: GitHubProfile = {
        id: user.id as number,
        login: user.login,
        name: typeof user.name === 'string' ? user.name : null,
        avatarUrl: typeof user.avatar_url === 'string' && user.avatar_url.startsWith('https://') ? user.avatar_url : null,
      }
      return {
        provider: 'github',
        account: { provider: 'github', providerAccountId: String(profile.id) },
        profile,
        // `remix/auth` wants the tokens in its result. The route never reads or stores them.
        tokens: { accessToken: token.access_token },
      }
    },
  })
}

/** The role of a person in an org, or null when GitHub does not count them as an active member. */
export type OrgRole = 'admin' | 'member'

/** KNT-150. An installation of the App, and the GitHub account (organization or user) that holds it. */
export interface InstallationAccount {
  githubInstallationId: number
  githubAccountId: number
  login: string
}

/** Asks GitHub for the role of a person in the account of an installation. Throws when GitHub fails. */
export type LookupRole = (installation: InstallationAccount, person: { githubId: number; login: string }) => Promise<OrgRole | null>

/**
 * Reads the role with an installation token of the App that has only `members: read`:
 * `GET /orgs/{org}/memberships/{login}`. `admin` is an owner of the org, `member` anyone else
 * active; `pending` (invited, not joined) and 404 give no access. On an installation of a personal
 * account, its owner is the admin, and nobody else gets in.
 */
export function createRoleLookup(options: {
  appId: string
  privateKey: KeyObject
  apiUrl: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}): LookupRole {
  let doFetch = options.fetch ?? globalThis.fetch
  let now = options.now ?? Date.now
  let apiUrl = options.apiUrl.replace(/\/+$/, '')
  // One token per installation, kept in memory until 5 minutes before its end.
  let tokens = new Map<number, { token: string; expiresAt: number }>()

  async function installationToken(installationId: number): Promise<string | null> {
    let cached = tokens.get(installationId)
    if (cached && cached.expiresAt - 5 * 60_000 > now()) return cached.token
    let response = await doFetch(`${apiUrl}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        Authorization: `Bearer ${appJwt(options.appId, options.privateKey, now())}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permissions: { members: 'read' } }),
      signal: AbortSignal.timeout(10_000),
    })
    // 422: the installation does not grant `members: read` (a personal account has no members, or
    // the org has not accepted the permission). Nobody but the owner of a personal account gets in.
    if (response.status === 422) return null
    if (response.status !== 201) throw new GitHubError(`GitHub answered ${response.status} for an installation token`)
    let body = (await response.json()) as { token?: unknown; expires_at?: unknown }
    if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
      throw new GitHubError('GitHub answered without a token')
    }
    tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) })
    return body.token
  }

  return async (installation, person) => {
    if (installation.githubAccountId === person.githubId) return 'admin'
    let token = await installationToken(installation.githubInstallationId)
    if (token === null) return null
    let response = await doFetch(
      `${apiUrl}/orgs/${encodeURIComponent(installation.login)}/memberships/${encodeURIComponent(person.login)}`,
      { headers: { ...HEADERS, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    )
    if (response.status === 404) return null
    if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} for the membership in ${installation.login}`)
    let body = (await response.json()) as { state?: unknown; role?: unknown }
    if (body.state !== 'active') return null
    return body.role === 'admin' ? 'admin' : body.role === 'member' ? 'member' : null
  }
}
