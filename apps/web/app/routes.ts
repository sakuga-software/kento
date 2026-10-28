import { get, post, route } from 'remix/routes'

export const routes = route({
  home: get('/'),
  healthz: get('/healthz'),
  githubWebhook: post('/webhooks/github'),
})
