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
  /** The model key of the service, sent only to a trusted runner without its own key. */
  providerApiKey: string | null
}

/** The shortest webhook secret that `loadConfig` accepts. `openssl rand -hex 32` gives 64 characters. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32

const DEFAULT_TRUSTED_BOTS = 'sakuga-agent[bot]'

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
    // GitHub Enterprise Server, or a fake GitHub in a local test.
    let apiUrl = env.GITHUB_API_URL?.trim() || 'https://api.github.com'
    if (!/^https?:\/\/[^\s@]+$/.test(apiUrl)) problems.push('GITHUB_API_URL must be an http(s) URL')
    if (privateKey && /^\d+$/.test(appId)) githubApp = { appId, privateKey, apiUrl }
  }

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
    providerApiKey: env.KENTO_PROVIDER_API_KEY?.trim() || null,
  }
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
