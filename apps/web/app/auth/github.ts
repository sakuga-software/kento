import type { KeyObject } from 'node:crypto'

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
 * KNT-150. The GitHub side of the sign-in, for the generic OAuth of Better Auth: the user
 * authorization of the GitHub App, authorization code with PKCE and `state` (checked by Better
 * Auth). The user token reads `GET /user` once and is dropped: it is never stored, and Kentō never
 * acts as the person.
 *
 * Not the `github` provider of Better Auth: it has the addresses of github.com built in (no GitHub
 * Enterprise Server, no fake GitHub in the tests), and it reads `/user/emails`, which the App is
 * not allowed to read and which Kentō does not need.
 */
export interface GitHubOAuth {
  clientId: string
  clientSecret: string
  authorizationUrl: string
  tokenUrl: string
  /** The callback URL of the GitHub App. */
  redirectUri: URL
  /** Trades the code of the callback for a user token. Throws when GitHub refuses it. */
  exchangeCode(input: { code: string; codeVerifier: string | null; redirectUri: string }): Promise<{ accessToken: string }>
  /** Reads `GET /user` with a user token. */
  readProfile(accessToken: string): Promise<GitHubProfile>
}

export function createGitHubOAuth(options: {
  clientId: string
  clientSecret: string
  redirectUri: URL
  oauthUrl: string
  apiUrl: string
  fetch?: typeof globalThis.fetch
}): GitHubOAuth {
  let doFetch = options.fetch ?? globalThis.fetch
  let oauthUrl = options.oauthUrl.replace(/\/+$/, '')
  let apiUrl = options.apiUrl.replace(/\/+$/, '')

  return {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorizationUrl: `${oauthUrl}/login/oauth/authorize`,
    tokenUrl: `${oauthUrl}/login/oauth/access_token`,
    redirectUri: options.redirectUri,

    async exchangeCode({ code, codeVerifier, redirectUri }) {
      let tokenResponse = await doFetch(`${oauthUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'kento-web' },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      })
      let token = (await tokenResponse.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null
      if (!tokenResponse.ok || typeof token?.access_token !== 'string') {
        // `error` is a code such as `bad_verification_code`; it holds no secret.
        throw new GitHubError(`GitHub refused the code: ${tokenResponse.status} ${String(token?.error ?? '')}`.trim())
      }
      return { accessToken: token.access_token }
    },

    async readProfile(accessToken) {
      let userResponse = await doFetch(`${apiUrl}/user`, {
        headers: { ...HEADERS, Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!userResponse.ok) throw new GitHubError(`GitHub answered ${userResponse.status} on /user`)
      let user = (await userResponse.json()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown }
      if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string') {
        throw new GitHubError('GitHub answered /user without an id or a login')
      }
      return {
        id: user.id as number,
        login: user.login,
        name: typeof user.name === 'string' ? user.name : null,
        avatarUrl: typeof user.avatar_url === 'string' && user.avatar_url.startsWith('https://') ? user.avatar_url : null,
      }
    },
  }
}

/**
 * The role of a person in the account of an installation, as GitHub gives it, or null when GitHub
 * does not count them as an active member.
 */
export type GitHubRole = 'admin' | 'member'

/** KNT-150. An installation of the App, and the GitHub account (organization or user) that holds it. */
export interface InstallationAccount {
  githubInstallationId: number
  githubAccountId: number
  login: string
}

/** Asks GitHub for the role of a person in the account of an installation. Throws when GitHub fails. */
export type LookupRole = (installation: InstallationAccount, person: { githubId: number; login: string }) => Promise<GitHubRole | null>

/**
 * KNT-150. Asks GitHub for the account of a login, with an installation token of the org that
 * invites. Null: GitHub has no such account, or it is not a person (an organization, a bot). Throws
 * when GitHub fails.
 */
export type LookupUser = (installation: InstallationAccount, login: string) => Promise<{ id: number; login: string } | null>

/**
 * KNT-150. Asks GitHub, with the JWT of the App, whether the account of an installation is a person
 * (`User`) or an organization. Throws when GitHub fails or answers neither.
 */
export type LookupAccountType = (installation: InstallationAccount) => Promise<'User' | 'Organization'>

/** A login of GitHub: what an invitation accepts. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/**
 * Reads the role with an installation token of the App that has only `members: read`:
 * `GET /orgs/{org}/memberships/{login}`. `admin` is an owner of the org, `member` anyone else
 * active; `pending` (invited, not joined) and 404 give no access. On an installation of a personal
 * account, its owner is the admin, and nobody else gets in.
 */
export function createRoleLookup(options: GitHubPeopleOptions): LookupRole {
  return createGitHubPeople(options).lookupRole
}

interface GitHubPeopleOptions {
  appId: string
  privateKey: KeyObject
  apiUrl: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

/** The role of a person in an org (`lookupRole`) and the account of a login (`lookupUser`), with one cache of tokens. */
export function createGitHubPeople(options: GitHubPeopleOptions): { lookupRole: LookupRole; lookupUser: LookupUser; lookupAccountType: LookupAccountType } {
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

  let lookupRole: LookupRole = async (installation, person) => {
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

  let lookupUser: LookupUser = async (installation, login) => {
    if (!GITHUB_LOGIN.test(login)) return null
    let token = await installationToken(installation.githubInstallationId)
    let headers: Record<string, string> = token === null ? { ...HEADERS } : { ...HEADERS, Authorization: `Bearer ${token}` }
    let response = await doFetch(`${apiUrl}/users/${encodeURIComponent(login)}`, { headers, signal: AbortSignal.timeout(10_000) })
    if (response.status === 404) return null
    if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} for the account ${login}`)
    let body = (await response.json()) as { id?: unknown; login?: unknown; type?: unknown }
    if (!Number.isSafeInteger(body.id) || typeof body.login !== 'string') throw new GitHubError('GitHub answered an account without an id or a login')
    if (body.type !== 'User') return null
    return { id: body.id as number, login: body.login }
  }

  let lookupAccountType: LookupAccountType = async (installation) => {
    let response = await doFetch(`${apiUrl}/app/installations/${installation.githubInstallationId}`, {
      headers: { ...HEADERS, Authorization: `Bearer ${appJwt(options.appId, options.privateKey, now())}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} for the installation ${installation.githubInstallationId}`)
    let body = (await response.json()) as { account?: { type?: unknown } }
    let type = body.account?.type
    if (type !== 'User' && type !== 'Organization') throw new GitHubError(`GitHub answered no account type for the installation ${installation.githubInstallationId}`)
    return type
  }

  return { lookupRole, lookupUser, lookupAccountType }
}

