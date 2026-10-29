import type { KeyObject } from 'node:crypto'

import packageJson from '../package.json' with { type: 'json' }

import { readPrivateKey } from './github/installation-token.ts'

/** The settings of the service. `loadConfig` reads them once, at startup. */
export interface Config {
  /** Postgres connection string. Required. */
  databaseUrl: string
  /** Maximum number of connections in the pool. */
  databasePoolMax: number
  /** Address and port the HTTP server listens on. */
  host: string
  port: number
  /** Apply the pending migrations before the server listens. */
  migrateOnStart: boolean
  /** The version of the package, and the commit of the image when the build gives it. */
  version: string
  commit: string | null
  /**
   * The secret of the GitHub App webhook, for `X-Hub-Signature-256`. Without it, `/webhooks/github`
   * answers 503 to every request. Never logged.
   */
  githubWebhookSecret: string | null
  /** The repositories that get a job, as lowercase `owner/name`. M3 replaces it with the Repos screen. */
  kentoRepos: ReadonlySet<string>
  /** The bot logins whose pull requests and pushes get a review, as a person's do. */
  trustedBots: ReadonlySet<string>
  /** The secret that a runner sends to register. Null closes the registration. */
  runnerRegistrationToken: string | null
  /** The GitHub App that makes the installation tokens of the jobs. Null: a claim gives no job. */
  githubApp: { appId: string; privateKey: KeyObject; apiUrl: string } | null
  /** The GitHub server that the runners clone from: `https://github.com`, or a GitHub Enterprise Server. */
  githubUrl: string
  /** The model key of the service, sent only to a trusted runner without its own key. */
  providerApiKey: string | null
  /**
   * The login of the GitHub App, as GitHub shows it on its reviews. The publisher finds the threads
   * and the reviews of the bot with it.
   */
  botLogin: string
  /**
   * The GitHub sign-in of the screens, with the user authorization of the GitHub App. Null when
   * one of its variables is missing: every screen then shows « Connexion indisponible ».
   */
  signIn: SignInConfig | null
}

export interface SignInConfig {
  /** The origin of the service as the browser sees it, `https://review.sakuga.dev`. */
  publicUrl: URL
  clientId: string
  /** A secret: never logged. */
  clientSecret: string
  /** Signs the session cookie. The first one signs; every one verifies, for a rotation. Secrets. */
  sessionSecrets: string[]
  /** Where the browser authorizes: `https://github.com`, a GitHub Enterprise Server, or a local fake. */
  oauthUrl: string
  /** The GitHub API, the one of GITHUB_API_URL. */
  apiUrl: string
}

/** The shortest session secret that `loadConfig` accepts. */
export const MIN_SESSION_SECRET_LENGTH = 32

/** The shortest webhook secret that `loadConfig` accepts. `openssl rand -hex 32` gives 64 characters. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32

const DEFAULT_TRUSTED_BOTS = 'sakuga-agent[bot]'
const DEFAULT_BOT_LOGIN = 'sakuga-review[bot]'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/**
 * Reads the configuration from environment variables. Throws a `ConfigError` that names every
 * invalid variable, so that the service stops before it listens. The error never contains a value.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  let problems: string[] = []

  let databaseUrl = env.DATABASE_URL?.trim() ?? ''
  if (databaseUrl === '') {
    problems.push('DATABASE_URL is required')
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL must start with postgres:// or postgresql://')
  }

  let port = readInteger(env, 'PORT', 3000, 1, 65535, problems)
  let databasePoolMax = readInteger(env, 'DATABASE_POOL_MAX', 10, 1, 100, problems)
  let migrateOnStart = readBoolean(env, 'MIGRATE_ON_START', true, problems)

  // The secret is not trimmed: GitHub signs with the exact string that the App settings hold.
  let githubWebhookSecret = env.GITHUB_WEBHOOK_SECRET ?? ''
  if (githubWebhookSecret !== '' && githubWebhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    problems.push(`GITHUB_WEBHOOK_SECRET must have at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`)
  }

  let kentoRepos = readList(env.KENTO_REPOS ?? '')
  for (let repo of kentoRepos) {
    if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repo)) {
      problems.push('KENTO_REPOS must be a comma-separated list of owner/name')
      break
    }
  }

  let runnerRegistrationToken = env.KENTO_RUNNER_REGISTRATION_TOKEN?.trim() || null
  if (runnerRegistrationToken !== null && runnerRegistrationToken.length < 32) {
    problems.push('KENTO_RUNNER_REGISTRATION_TOKEN must have at least 32 characters')
  }

  let githubApp: Config['githubApp'] = null
  let appId = env.GITHUB_APP_ID?.trim() ?? ''
  let privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim() ?? ''
  if (appId !== '' || privateKeyPem !== '') {
    if (!/^\d+$/.test(appId)) problems.push('GITHUB_APP_ID must be the number of the App')
    let privateKey: KeyObject | null = null
    try {
      privateKey = readPrivateKey(privateKeyPem)
    } catch {
      problems.push('GITHUB_APP_PRIVATE_KEY must be the PEM private key of the App')
    }
    // GitHub Enterprise Server (with GITHUB_URL), or a fake GitHub in a local test.
    let apiUrl = env.GITHUB_API_URL?.trim() || 'https://api.github.com'
    if (!/^https?:\/\/[^\s@]+$/.test(apiUrl)) problems.push('GITHUB_API_URL must be an http(s) URL')
    if (privateKey && /^\d+$/.test(appId)) githubApp = { appId, privateKey, apiUrl }
  }

  let botLogin = env.KENTO_BOT_LOGIN?.trim() || DEFAULT_BOT_LOGIN
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(botLogin)) problems.push('KENTO_BOT_LOGIN must be the login of an App, name[bot]')
  // The runners clone from this server with the installation token of GITHUB_API_URL, so both must
  // name the same server: GitHub.com (api.github.com and github.com), or one GitHub Enterprise
  // Server (https://<host>/api/v3 and https://<host>). Without GITHUB_URL, it is the server of
  // GITHUB_API_URL. HTTPS only: the runner refuses any other clone URL.
  let githubHost = githubServerHost(env.GITHUB_API_URL?.trim() || 'https://api.github.com')
  let githubUrl = (env.GITHUB_URL?.trim() || (githubHost ? `https://${githubHost}` : '')).replace(/\/+$/, '')
  if (githubHost === null) {
    // Name the variable that is wrong, once, even without the GitHub App.
    let message = 'GITHUB_API_URL must be an http(s) URL'
    if (!problems.includes(message)) problems.push(message)
  } else if (!/^https:\/\/[^\s@/]+(\/[^\s@]*)?$/.test(githubUrl)) {
    problems.push('GITHUB_URL must be an https:// URL')
  } else if (githubHost && new URL(githubUrl).host !== githubHost) {
    problems.push('GITHUB_URL must be on the server of GITHUB_API_URL')
  }

  let signIn = readSignIn(env, githubApp, githubUrl, problems)

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`)
  }

  let commit = env.APP_COMMIT?.trim()

  return {
    databaseUrl,
    databasePoolMax,
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    migrateOnStart,
    version: packageJson.version,
    commit: commit ? commit : null,
    githubWebhookSecret: githubWebhookSecret === '' ? null : githubWebhookSecret,
    kentoRepos: new Set(kentoRepos),
    trustedBots: new Set(readList(env.KENTO_TRUSTED_BOTS ?? DEFAULT_TRUSTED_BOTS)),
    runnerRegistrationToken,
    githubApp,
    githubUrl,
    providerApiKey: env.KENTO_PROVIDER_API_KEY?.trim() || null,
    botLogin,
    signIn,
  }
}

const SIGN_IN_VARIABLES = ['KENTO_PUBLIC_URL', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'KENTO_SESSION_SECRET'] as const

/**
 * The sign-in needs its four variables and the GitHub App (its installation tokens read the role of
 * a person in each org). None of them: the sign-in is off. Some of them: a configuration error that
 * names the missing ones.
 */
function readSignIn(
  env: Record<string, string | undefined>,
  githubApp: Config['githubApp'],
  githubUrl: string,
  problems: string[],
): SignInConfig | null {
  let values = Object.fromEntries(SIGN_IN_VARIABLES.map((name) => [name, env[name]?.trim() ?? ''])) as Record<
    (typeof SIGN_IN_VARIABLES)[number],
    string
  >
  let missing = SIGN_IN_VARIABLES.filter((name) => values[name] === '')
  if (missing.length === SIGN_IN_VARIABLES.length) return null
  if (missing.length > 0) {
    problems.push(`the GitHub sign-in also needs ${missing.join(', ')}`)
    return null
  }
  if (!githubApp) {
    problems.push('the GitHub sign-in needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, to read the role of a person')
    return null
  }

  let publicUrl: URL | null = null
  try {
    publicUrl = new URL(values.KENTO_PUBLIC_URL)
  } catch {
    // Reported below.
  }
  // HTTPS, except on the machine itself: the session cookie is Secure.
  if (
    !publicUrl ||
    !(publicUrl.protocol === 'https:' || (publicUrl.protocol === 'http:' && isLoopback(publicUrl.hostname))) ||
    publicUrl.pathname !== '/' ||
    publicUrl.search !== '' ||
    publicUrl.username !== ''
  ) {
    problems.push('KENTO_PUBLIC_URL must be the https:// origin of the service, with no path')
    return null
  }

  let sessionSecrets = values.KENTO_SESSION_SECRET.split(',').map((secret) => secret.trim())
  if (sessionSecrets.some((secret) => secret.length < MIN_SESSION_SECRET_LENGTH)) {
    problems.push(`KENTO_SESSION_SECRET must have at least ${MIN_SESSION_SECRET_LENGTH} characters in each of its comma-separated secrets`)
    return null
  }

  // A fake GitHub on this machine, for the tests in a browser, is served over plain HTTP: it signs
  // in on the same address as its API. Any other server signs in on GITHUB_URL, over HTTPS.
  let api = new URL(githubApp.apiUrl)
  let oauthUrl = api.protocol === 'http:' && isLoopback(api.hostname) ? api.origin : githubUrl

  return {
    publicUrl: new URL(publicUrl.origin),
    clientId: values.GITHUB_APP_CLIENT_ID,
    clientSecret: values.GITHUB_APP_CLIENT_SECRET,
    sessionSecrets,
    oauthUrl,
    apiUrl: githubApp.apiUrl.replace(/\/+$/, ''),
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

// GitHub logins and repository names are case-insensitive: the list keeps them in lowercase.
function readList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
}

function readInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  let raw = env[name]?.trim()
  if (!raw) return fallback
  let value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer from ${min} to ${max}`)
    return fallback
  }
  return value
}

function readBoolean(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
  problems: string[],
): boolean {
  let raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  problems.push(`${name} must be true or false`)
  return fallback
}

/** The host of the GitHub server of an API URL: github.com for api.github.com, else its own host. */
function githubServerHost(apiUrl: string): string | null {
  try {
    let host = new URL(apiUrl).host
    return host === 'api.github.com' ? 'github.com' : host
  } catch {
    return null
  }
}
