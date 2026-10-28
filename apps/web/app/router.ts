import { render } from 'remix/middleware/render'
import { createRouter, type RouterContext } from 'remix/router'

import { createController } from './actions/controller.tsx'
import type { CheckDatabase } from './db/health.ts'
import { requestLogger } from './request-logger.ts'
import { routes } from './routes.ts'

/** What the routes need from the outside. Tests pass fakes. */
export interface AppDependencies {
  checkDatabase: CheckDatabase
  version: string
  commit: string | null
}

export function createAppRouter(deps: AppDependencies) {
  let router = createRouter({
    middleware: [requestLogger(), render()],
  })
  router.map(routes, createController(deps))
  return router
}

export type AppRouter = ReturnType<typeof createAppRouter>
export type AppContext = RouterContext<AppRouter>

declare module 'remix' {
  interface RouterTypes {
    context: AppContext
  }
}
