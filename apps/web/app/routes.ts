import { get, post, route } from 'remix/routes'

/** The routes of machines: the health check and the GitHub App webhook. */
export const routes = route({
  healthz: get('/healthz'),
  githubWebhook: post('/webhooks/github'),
})

/** The screens, and the forms of their frame. A signed-in member of an org only. */
export const pageRoutes = route({
  home: get('/'),
  /** REV-14: « Relancer en <niveau> » on the banner of the last failure. An admin only. */
  jobRetry: post('/jobs/:id/retry'),
  repos: get('/repos'),
  /** REV-9: an admin enables or disables a repository, or reads GitHub again. */
  repoEnable: post('/repos/:id/enable'),
  repoDisable: post('/repos/:id/disable'),
  reposCheck: post('/repos/check'),
  /** REV-12: the config of a repository. A member reads it; an admin changes it, one key at a time. */
  repoConfig: get('/repos/:id/config'),
  repoConfigSave: post('/repos/:id/config'),
  repoConfigReset: post('/repos/:id/config/reset'),
  findings: get('/findings'),
  runners: get('/runners'),
  runnerNew: post('/runners/new'),
  runnerRenew: post('/runners/registrations/:id/renew'),
  runnerDiscard: post('/runners/registrations/:id/discard'),
  runnerTrust: post('/runners/:id/trust'),
  runnerRevoke: post('/runners/:id/revoke'),
  settings: get('/settings'),
  /** REV-11: the providers of the org and their encrypted keys. An admin only. */
  providerAdd: post('/settings/providers'),
  providerTest: post('/settings/providers/:id/test'),
  providerKey: post('/settings/providers/:id/key'),
  providerDefault: post('/settings/providers/:id/default'),
  providerRemove: post('/settings/providers/:id/remove'),
  /** REV-13: the settings of the org. A member reads them; an admin changes them, one form at a time. */
  orgSettingsSave: post('/settings/org'),
  orgSettingsReset: post('/settings/org/reset'),
  theme: post('/preferences/theme'),
  org: post('/preferences/org'),
  signOut: post('/logout'),
})

/**
 * REV-40. A page that no route matches, for a browser. The router dispatches to it only from its
 * default handler: the routes of machines keep their own answers.
 */
export const fallbackRoutes = route({
  notFound: get('*path'),
})

/** The GitHub sign-in. Open to anyone. */
export const authRoutes = route({
  signIn: get('/login'),
  signInGitHub: get('/login/github'),
  callback: get('/auth/github/callback'),
})
