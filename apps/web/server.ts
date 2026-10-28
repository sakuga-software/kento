import * as http from 'node:http'

import { createRequestListener } from 'remix/node-fetch-server'

import { loadConfig } from './app/config.ts'
import { createDatabase } from './app/db/client.ts'
import { createDatabaseCheck } from './app/db/health.ts'
import { createWebhookStore } from './app/db/webhook-store.ts'
import { runMigrations } from './app/db/migrate.ts'
import { errorMessage, log } from './app/log.ts'
import { createAppRouter } from './app/router.ts'

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

let router = createAppRouter({
  checkDatabase: createDatabaseCheck(database.sql),
  version: config.version,
  commit: config.commit,
  webhook: {
    secret: config.githubWebhookSecret,
    kentoRepos: config.kentoRepos,
    trustedBots: config.trustedBots,
    apply: createWebhookStore(database.db, { kentoRepos: config.kentoRepos }),
  },
})

if (config.githubWebhookSecret === null) {
  log('warn', 'startup.webhook_disabled', { reason: 'GITHUB_WEBHOOK_SECRET is not set' })
}

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
  })
})

let shuttingDown = false

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'shutdown.started', { signal })
  server.close(async () => {
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
