import { render } from 'remix/middleware/render'
import { createRouter, type RouterContext } from 'remix/router'

import { createController } from './actions/controller.tsx'
import type { CheckDatabase } from './db/health.ts'
import type { WebhookDependencies } from './github/webhook.ts'
import { requestLogger } from './request-logger.ts'
import { routes } from './routes.ts'
import { createRunnerController, type RunnerApiDependencies } from './runner/controller.ts'
import { runnerRoutes } from './runner/routes.ts'

/** What the routes need from the outside. Tests pass fakes. */
export interface AppDependencies {
  checkDatabase: CheckDatabase
  version: string
  commit: string | null
  webhook: WebhookDependencies
  /** The runner API. Without it, its routes answer 404. */
  runner?: RunnerApiDependencies
}

export function createAppRouter(deps: AppDependencies) {
  let router = createRouter({
    middleware: [requestLogger(), render()],
  })
  router.map(routes, createController(deps))
  if (deps.runner) router.map(runnerRoutes, createRunnerController(deps.runner))
  return router
}

export type AppRouter = ReturnType<typeof createAppRouter>
export type AppContext = RouterContext<AppRouter>

declare module 'remix' {
  interface RouterTypes {
    context: AppContext
  }
}
