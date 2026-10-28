import packageJson from '../package.json' with { type: 'json' }

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
}

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
  }
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
