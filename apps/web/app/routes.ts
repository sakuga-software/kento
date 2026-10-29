import { get, post, route } from 'remix/routes'

/** The routes of machines: the health check and the GitHub App webhook. */
export const routes = route({
  healthz: get('/healthz'),
  githubWebhook: post('/webhooks/github'),
})

/** The screens, and the forms of their frame. A signed-in member of an org only. */
export const pageRoutes = route({
  home: get('/'),
  repos: get('/repos'),
  findings: get('/findings'),
  runners: get('/runners'),
  runnerNew: post('/runners/new'),
  runnerRenew: post('/runners/registrations/:id/renew'),
  runnerDiscard: post('/runners/registrations/:id/discard'),
  runnerTrust: post('/runners/:id/trust'),
  runnerRevoke: post('/runners/:id/revoke'),
  settings: get('/settings'),
  theme: post('/preferences/theme'),
  org: post('/preferences/org'),
  signOut: post('/logout'),
})

/** The GitHub sign-in. Open to anyone. */
export const authRoutes = route({
  signIn: get('/login'),
  signInGitHub: get('/login/github'),
  callback: get('/auth/github/callback'),
})
