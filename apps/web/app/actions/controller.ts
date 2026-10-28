import { createController as createRemixController } from 'remix/router'

import { handleGithubWebhook } from '../github/webhook.ts'
import type { AppDependencies } from '../router.ts'
import { routes } from '../routes.ts'

export function createController(deps: AppDependencies) {
  return createRemixController(routes, {
    actions: {
      // Reads the database on every call. 200 when the database answers, 503 otherwise, so that
      // the container health check and Dokploy see a service without its database as down.
      async healthz() {
        let database = await deps.checkDatabase()
        let ok = database.status === 'ok'
        return Response.json(
          {
            status: ok ? 'ok' : 'error',
            version: deps.version,
            commit: deps.commit,
            database,
          },
          { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
        )
      },

      // GitHub App webhook: signature first, then the job queue. See app/github/webhook.ts.
      githubWebhook(context) {
        return handleGithubWebhook(context.request, deps.webhook)
      },
    },
  })
}
