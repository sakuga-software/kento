import { get, post, route } from 'remix/routes'

/** The routes of machines: the health check and the GitHub App webhook. */
export const routes = route({
  healthz: get('/healthz'),
  githubWebhook: post('/webhooks/github'),
})

/** The screens, and the forms of their frame. */
export const pageRoutes = route({
  home: get('/'),
  repos: get('/repos'),
  findings: get('/findings'),
  runners: get('/runners'),
  settings: get('/settings'),
  theme: post('/preferences/theme'),
})
