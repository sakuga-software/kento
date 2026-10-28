import { createController as createRemixController } from 'remix/router'

import type { AppDependencies } from '../router.ts'
import { routes } from '../routes.ts'
import { HomePage } from './home-page.tsx'

export function createController(deps: AppDependencies) {
  return createRemixController(routes, {
    actions: {
      home(context) {
        return context.render(<HomePage version={deps.version} />)
      },

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
    },
  })
}
