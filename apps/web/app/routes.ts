import { get, post, route } from 'remix/routes'

/** The routes of machines: the health check and the GitHub App webhook. */
export const routes = route({
  healthz: get('/healthz'),
  githubWebhook: post('/webhooks/github'),
})

/** The screens, and the forms of their frame. A signed-in member of an org only. */
export const pageRoutes = route({
  home: get('/'),
  /** REV-14: "Run again at <level>" on the banner of the last failure. An admin only. */
  jobRetry: post('/jobs/:id/retry'),
  /** REV-59: "Hide" hides a failure of the dashboard. An admin only. */
  jobDismiss: post('/jobs/:id/dismiss'),
  repos: get('/repos'),
  /** REV-9: an admin enables or disables a repository, or reads GitHub again. */
  repoEnable: post('/repos/:id/enable'),
  repoDisable: post('/repos/:id/disable'),
  reposCheck: post('/repos/check'),
  /** REV-12: the config of a repository. A member reads it; an admin changes it, one key at a time. */
  repoConfig: get('/repos/:id/config'),
  repoConfigSave: post('/repos/:id/config'),
  repoConfigReset: post('/repos/:id/config/reset'),
  /** REV-21: the assignment rules of a repository. A member reads them on the Config screen; an admin changes them. */
  assignmentAdd: post('/repos/:id/assignment'),
  assignmentMove: post('/repos/:id/assignment/:rule/move'),
  assignmentRemove: post('/repos/:id/assignment/:rule/remove'),
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
  /** "Run again at <level>": a new review of the last head. An admin only: it costs. */
  pullRerun: post('/repos/:id/pulls/:number/rerun'),
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
 * REV-22. The screen of a user. Every member of the org reads it; only the user changes their own
 * preferences.
 */
export const userRoutes = route({
  user: get('/users/:login'),
  /** The preferences for every repository (field `repo` empty) or for one repository of the org. */
  userPrefs: post('/users/:login/prefs'),
  userPrefRemove: post('/users/:login/prefs/:repoId/remove'),
})

/** REV-107. The answers about the reviews of Kentō. Every member of the org reads them. */
export const feedbackRoutes = route({
  feedback: get('/feedback'),
})

/**
 * REV-40. A page that no route matches, for a browser. The router dispatches to it only from its
 * default handler: the routes of machines keep their own answers.
 */
export const fallbackRoutes = route({
  notFound: get('*path'),
})

/** REV-96. The pages of documentation. Open to anyone, without a sign-in: the comments of Kentō link to them. */
export const docsRoutes = route({
  commands: get('/docs/commands'),
  /** REV-114. The address of the page before REV-114, in the comments posted before it: a permanent redirect. */
  commandsLegacy: get('/docs/commandes'),
})

/** The GitHub sign-in. Open to anyone. */
export const authRoutes = route({
  signIn: get('/login'),
  signInGitHub: get('/login/github'),
  callback: get('/auth/github/callback'),
})
