import * as http from 'node:http'

import { createRequestListener } from 'remix/node-fetch-server'

import { createCommandHandler } from './app/commands/handler.ts'
import { loadConfig } from './app/config.ts'
import { createDatabase } from './app/db/client.ts'
import { createDatabaseCheck } from './app/db/health.ts'
import { createWebhookStore } from './app/db/webhook-store.ts'
import { runMigrations } from './app/db/migrate.ts'
import { createInstallationTokenMinter } from './app/github/installation-token.ts'
import { errorMessage, log } from './app/log.ts'
import { createPublisher } from './app/publish/publisher.ts'
import { createGitHubSignIn, createRoleLookup } from './app/auth/github.ts'
import { createPostgresSessionStorage } from './app/auth/session-storage.ts'
import { createAuthStore } from './app/auth/store.ts'
import { createAppRouter } from './app/router.ts'
import { authRoutes } from './app/routes.ts'
import { startLeaseSweeper } from './app/runner/lease-sweeper.ts'
import { createRunnerStore } from './app/runner/store.ts'

// Startup order: configuration, database, migrations, then the server. A failure at any step stops
// the process with a non-zero code before the server listens, so Dokploy keeps the previous
// container.
let config
try {
  config = loadConfig()
} catch (error) {
  log('error', 'startup.config_invalid', { error: errorMessage(error) })
  process.exit(1)
}

let database = createDatabase(config.databaseUrl, { max: config.databasePoolMax })

if (config.migrateOnStart) {
  let start = performance.now()
  try {
    await runMigrations(config.databaseUrl)
    log('info', 'startup.migrations_applied', { durationMs: Math.round(performance.now() - start) })
  } catch (error) {
    log('error', 'startup.migrations_failed', { error: errorMessage(error) })
    await database.close()
    process.exit(1)
  }
}

let runnerStore = createRunnerStore(database.sql)

let mintInstallationToken = config.githubApp ? createInstallationTokenMinter(config.githubApp) : null

// The publisher posts the reviews that the runners send (REV-5). Without the App it has no token:
// the reviews stay in the database, unpublished.
let publisher =
  config.githubApp && mintInstallationToken
    ? createPublisher({
        sql: database.sql,
        mintInstallationToken,
        apiUrl: config.githubApp.apiUrl,
        webUrl: config.githubUrl,
        botLogin: config.botLogin,
      })
    : null

// The GitHub sign-in of the screens (REV-8). Without its variables, every screen says that the
// sign-in is not configured, and nobody gets in.
let sessionStorage = config.signIn ? createPostgresSessionStorage(database.sql) : null
let auth =
  config.signIn && config.githubApp && sessionStorage
    ? {
        publicUrl: config.signIn.publicUrl,
        sessionSecrets: config.signIn.sessionSecrets,
        sessionStorage,
        provider: createGitHubSignIn({
          clientId: config.signIn.clientId,
          clientSecret: config.signIn.clientSecret,
          redirectUri: new URL(authRoutes.callback.href(), config.signIn.publicUrl),
          oauthUrl: config.signIn.oauthUrl,
          apiUrl: config.signIn.apiUrl,
        }),
        store: createAuthStore(database.sql),
        lookupRole: createRoleLookup(config.githubApp),
      }
    : null

// Expired sessions leave the table every hour.
let sweepTimer = sessionStorage
  ? setInterval(() => {
      sessionStorage
        .sweep()
        .then((deleted) => {
          if (deleted > 0) log('info', 'sessions.swept', { deleted })
        })
        .catch((error) => log('warn', 'sessions.sweep_failed', { error: errorMessage(error) }))
    }, 60 * 60 * 1000).unref()
  : null

let router = createAppRouter({
  auth,
  checkDatabase: createDatabaseCheck(database.sql),
  version: config.version,
  commit: config.commit,
  webhook: {
    secret: config.githubWebhookSecret,
    kentoRepos: config.kentoRepos,
    trustedBots: config.trustedBots,
    botLogin: config.botLogin,
    apply: createWebhookStore(database.db, {
      kentoRepos: config.kentoRepos,
      // The commands of the comments (REV-7): `@kento review heavy`, `@sakuga-review review balanced`.
      handleCommentCommand: createCommandHandler({
        db: database.db,
        mintInstallationToken,
        apiUrl: config.githubApp?.apiUrl ?? 'https://api.github.com',
        kentoRepos: config.kentoRepos,
      }),
    }),
  },
  runner: {
    store: runnerStore,
    registrationToken: config.runnerRegistrationToken,
    mintInstallationToken,
    providerApiKey: config.providerApiKey,
    onReviewStored: publisher ? () => publisher.wake() : undefined,
    githubApiUrl: config.githubApp?.apiUrl,
    githubUrl: config.githubUrl,
  },
})

if (config.githubWebhookSecret === null) {
  log('warn', 'startup.webhook_disabled', { reason: 'GITHUB_WEBHOOK_SECRET is not set' })
}

// A job whose runner stopped sending heartbeats goes back to the queue, or fails after its last
// attempt. Each replica sweeps; two sweeps never take the same job.
let stopLeaseSweeper = startLeaseSweeper(runnerStore)

let server = http.createServer(
  createRequestListener(router.fetch, {
    onError(error) {
      log('error', 'http.unhandled_error', { error: errorMessage(error) })
      return new Response('Internal Server Error', { status: 500 })
    },
  }),
)

server.listen(config.port, config.host, () => {
  log('info', 'startup.listening', {
    host: config.host,
    port: config.port,
    version: config.version,
    commit: config.commit,
    kentoRepos: [...config.kentoRepos],
    publisher: publisher !== null,
    signIn: auth !== null,
  })
  publisher?.start()
})

let shuttingDown = false

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'shutdown.started', { signal })
  server.close(async () => {
    await stopLeaseSweeper()
    // A publication in progress ends before the database closes.
    if (sweepTimer) clearInterval(sweepTimer)
    await publisher?.stop()
    await database.close()
    log('info', 'shutdown.done')
    process.exit(0)
  })
  server.closeIdleConnections()
  // Requests still open after 10 seconds are cut. Docker sends SIGKILL after its own grace period.
  setTimeout(() => server.closeAllConnections(), 10_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
