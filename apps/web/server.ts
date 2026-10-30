import * as http from 'node:http'

import { createRequestListener } from 'remix/node-fetch-server'

import { createCommandHandler } from './app/commands/handler.ts'
import { loadConfig } from './app/config.ts'
import { createDatabase } from './app/db/client.ts'
import { createDatabaseCheck } from './app/db/health.ts'
import { startJobsPurge } from './app/db/retention.ts'
import { createWebhookStore } from './app/db/webhook-store.ts'
import { runMigrations } from './app/db/migrate.ts'
import { createInstallationTokenMinter } from './app/github/installation-token.ts'
import { errorMessage, log } from './app/log.ts'
import { createPublisher } from './app/publish/publisher.ts'
import { createGitHubSignIn, createRoleLookup } from './app/auth/github.ts'
import { createPostgresSessionStorage } from './app/auth/session-storage.ts'
import { createAuthStore } from './app/auth/store.ts'
import { createListChangedFiles } from './app/repo-config/changed-files.ts'
import { createConfigProviders } from './app/providers/catalog.ts'
import { createRepoConfigStore } from './app/repo-config/store.ts'
import { createRulesStore } from './app/rules/store.ts'
import { createRepoCheck } from './app/repos/check.ts'
import { createProbe } from './app/providers/probe.ts'
import { createSecretBox } from './app/providers/secrets.ts'
import { createProvidersStore } from './app/providers/store.ts'
import { createAppStatusReader } from './app/org-settings/app-status.ts'
import { createCapNotice } from './app/org-settings/notice.ts'
import { createOrgSettingsStore } from './app/org-settings/store.ts'
import { createReposStore } from './app/repos/store.ts'
import { createAppRouter } from './app/router.ts'
import { authRoutes } from './app/routes.ts'
import { appInstallUrl } from './app/ui/pages.tsx'
import { createRunnersAdminStore } from './app/runner/admin.ts'
import { createDashboardStore } from './app/dashboard/store.ts'
import { createReadPullRequest } from './app/dashboard/github.ts'
import { createReadPullHeader } from './app/pulls/github.ts'
import { createPullsStore } from './app/pulls/store.ts'
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
        publicUrl: config.signIn?.publicUrl ?? null,
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
        // REV-32: « Installer Kentō sur une organisation » on the page « Accès refusé ».
        installUrl: appInstallUrl(config.githubUrl, config.appSlug),
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

// The Repos screen (REV-9): an admin enables a repository there. The check reads the repositories
// and their workflows on GitHub with an installation token.
let reposStore = createReposStore(database.sql)
let repos = {
  store: reposStore,
  check:
    mintInstallationToken && config.githubApp
      ? createRepoCheck({ store: reposStore, mintInstallationToken, apiUrl: config.githubApp.apiUrl })
      : null,
  githubUrl: config.githubUrl,
}

// The providers of the orgs and their encrypted keys (REV-11). Without KENTO_SECRETS_KEY, the
// screen stores no key and no job of a provider with a key runs.
let secrets = config.secretsKeys ? createSecretBox(config.secretsKeys.current, config.secretsKeys.previous) : null
if (!secrets) log('warn', 'startup.secrets_disabled', { reason: 'KENTO_SECRETS_KEY is not set: the keys of the providers cannot be stored' })
else log('info', 'startup.secrets', { keyId: secrets.keyId, previousKeys: config.secretsKeys!.previous.length })

let providersStore = createProvidersStore(database.sql, secrets)
let configProviders = createConfigProviders(providersStore, { serviceKey: config.providerApiKey !== null })

// The settings of the org (REV-13): its cost limits, its defaults, its trusted bots, and the state of
// the App on GitHub.
let orgSettingsStore = createOrgSettingsStore(database.sql)
let publicUrl = config.signIn?.publicUrl ?? null

let router = createAppRouter({
  auth,
  repos,
  // The section « Providers et clés » of the settings (REV-11).
  providers: {
    store: providersStore,
    probe: createProbe(),
    secretsConfigured: secrets !== null,
    serviceKey: config.providerApiKey !== null,
  },
  // The Config screen of a repository (REV-12). The providers of the org come with REV-11.
  repoConfig: { store: createRepoConfigStore(database.sql), providers: configProviders },
  // The rules of the repositories and of the org (REV-19), on the Config screen and in the settings.
  rules: createRulesStore(database.sql),
  orgSettings: {
    store: orgSettingsStore,
    providers: configProviders,
    readAppStatus: config.githubApp
      ? createAppStatusReader({ appId: config.githubApp.appId, privateKey: config.githubApp.privateKey, apiUrl: config.githubApp.apiUrl, githubUrl: config.githubUrl })
      : null,
    webhookUrl: publicUrl ? new URL('/webhooks/github', publicUrl).toString() : null,
    webhookSecret: config.githubWebhookSecret !== null,
  },
  // The Runners screen (REV-10): registration tokens, trust and revocation, for the admins of an org.
  runnersAdmin: createRunnersAdminStore(database.sql),
  // The dashboard (REV-14): reviews, failures, queue, cost of the day and runners of the org.
  dashboard: {
    store: createDashboardStore(database.sql),
    githubUrl: config.githubUrl,
    readPullRequest:
      mintInstallationToken && config.githubApp ? createReadPullRequest({ mintInstallationToken, apiUrl: config.githubApp.apiUrl }) : null,
    serviceKey: config.providerApiKey !== null,
  },
  // The screen of a pull request (REV-17): its sheet of reviews and findings.
  pulls: {
    store: createPullsStore(database.sql),
    githubUrl: config.githubUrl,
    readHeader: mintInstallationToken && config.githubApp ? createReadPullHeader({ mintInstallationToken, apiUrl: config.githubApp.apiUrl }) : null,
  },
  checkDatabase: createDatabaseCheck(database.sql),
  version: config.version,
  commit: config.commit,
  webhook: {
    secret: config.githubWebhookSecret,
    // REV-13: the trusted bots of each org, from its settings; each delivery that passes the
    // signature is kept 30 days for the section « App GitHub ».
    trustedBotsFor: (installationId) => orgSettingsStore.trustedBotsFor(installationId),
    recordDelivery: (record) => orgSettingsStore.recordDelivery(record),
    botLogin: config.botLogin,
    apply: createWebhookStore(database.db, {
      // REV-12: the paths of the config of a repository read the files of the pull request.
      listChangedFiles:
        mintInstallationToken && config.githubApp
          ? createListChangedFiles({ mintInstallationToken, apiUrl: config.githubApp.apiUrl })
          : undefined,
      // REV-13: a push stopped by the cost limit of its org gets the check « Kentō · plafond ».
      onCapReached:
        mintInstallationToken && config.githubApp
          ? createCapNotice({
              mintInstallationToken,
              apiUrl: config.githubApp.apiUrl,
              settingsUrl: publicUrl ? new URL('/settings#plafond', publicUrl).toString() : `${config.githubUrl}`,
            })
          : undefined,
      // The commands of the comments (REV-7): `@kento-review heavy`, `@sakuga-review review balanced`.
      handleCommentCommand: createCommandHandler({
        db: database.db,
        mintInstallationToken,
        apiUrl: config.githubApp?.apiUrl ?? 'https://api.github.com',
      }),
    }),
  },
  runner: {
    store: runnerStore,
    registrationToken: config.runnerRegistrationToken,
    mintInstallationToken,
    providerApiKey: config.providerApiKey,
    secrets,
    onReviewStored: publisher ? () => publisher.wake() : undefined,
    githubApiUrl: config.githubApp?.apiUrl,
    githubUrl: config.githubUrl,
  },
})

// REV-9: an admin enables a repository on the Repos screen. The variable of M2 changes nothing now.
if (process.env.KENTO_REPOS !== undefined) {
  log('warn', 'startup.kento_repos_ignored', { reason: 'KENTO_REPOS is not read any more: enable a repository on the Repos screen' })
}

// REV-13: the trusted bots are a setting of each org. The variable changes nothing now: copy its
// value into « Bots de confiance » of the settings, then remove it.
if (process.env.KENTO_TRUSTED_BOTS !== undefined) {
  log('warn', 'startup.kento_trusted_bots_ignored', {
    reason: 'KENTO_TRUSTED_BOTS is not read any more: set the trusted bots of each org in its settings',
    value: process.env.KENTO_TRUSTED_BOTS.slice(0, 500),
  })
}

if (config.githubWebhookSecret === null) {
  log('warn', 'startup.webhook_disabled', { reason: 'GITHUB_WEBHOOK_SECRET is not set' })
}

// A job whose runner stopped sending heartbeats goes back to the queue, or fails after its last
// attempt. Each replica sweeps; two sweeps never take the same job.
let stopLeaseSweeper = startLeaseSweeper(runnerStore)

// REV-38. The jobs that ended more than 180 days ago leave the database, with their reviews and
// resolutions, once an hour. Each replica purges; two purges never take the same job.
let stopJobsPurge = startJobsPurge(database.sql)

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
    await stopJobsPurge()
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
