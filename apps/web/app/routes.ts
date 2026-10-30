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
  /** REV-18: an admin marks the findings checked on the Findings screen dismissed or wontfix. */
  findingsStatus: post('/findings/status'),
  runners: get('/runners'),
  runnerNew: post('/runners/new'),
  runnerRenew: post('/runners/registrations/:id/renew'),
  runnerDiscard: post('/runners/registrations/:id/discard'),
  runnerTrust: post('/runners/:id/trust'),
  runnerRevoke: post('/runners/:id/revoke'),
  /** REV-37: an admin revokes the runners silent for 24 hours, at once. */
  runnersRevokeSilent: post('/runners/revoke-silent'),
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
  /**
   * REV-19: the rules of a repository (the field `repo` of the form) or of the org (`repo` empty). A
   * member reads them on the Config screen and in the settings; an admin changes them.
   */
  ruleAdd: post('/rules'),
  ruleSave: post('/rules/:id'),
  ruleActive: post('/rules/:id/active'),
  ruleRemove: post('/rules/:id/remove'),
  theme: post('/preferences/theme'),
  org: post('/preferences/org'),
  signOut: post('/logout'),
})

/**
 * REV-17. The screen of a pull request, and its forms. A signed-in member of an org only: the routes
 * go through the session of the screens.
 */
export const pullRoutes = route({
  pull: get('/repos/:id/pulls/:number'),
  /** One finding: where it comes from, its code, its history, its thread on GitHub. */
  finding: get('/findings/:id'),
  /**
   * A member of the org dismisses a finding with one of four reasons, keeps it (wontfix) or reopens
   * it. Each one writes an event, and the bot says so in the thread of the finding on GitHub.
   */
  findingDismiss: post('/findings/:id/dismiss'),
  findingWontfix: post('/findings/:id/wontfix'),
  findingReopen: post('/findings/:id/reopen'),
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
