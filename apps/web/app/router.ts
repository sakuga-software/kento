import { fileURLToPath } from 'node:url'

import { render } from 'remix/middleware/render'
import { staticFiles } from 'remix/middleware/static'
import { createRouter, type RouterContext } from 'remix/router'

import { createController } from './actions/controller.ts'
import type { CheckDatabase } from './db/health.ts'
import type { WebhookDependencies } from './github/webhook.ts'
import { requestLogger } from './request-logger.ts'
import { pageRoutes, routes } from './routes.ts'
import { createRunnerController, type RunnerApiDependencies } from './runner/controller.ts'
import { runnerRoutes } from './runner/routes.ts'
import { createPagesController } from './ui/pages.tsx'

/** The stylesheet, the fonts and the one script of the screens, under `/assets/`. */
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

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
    middleware: [
      requestLogger(),
      staticFiles(PUBLIC_DIR, {
        filter: (path) => path.startsWith('assets/'),
        // In production, the URL of the stylesheet and of the script carries the release (`?v=`),
        // and the fonts never change under one name.
        cacheControl: process.env.NODE_ENV === 'production' ? 'public, max-age=31536000, immutable' : 'no-cache',
      }),
      render(),
    ],
  })
  router.map(routes, createController(deps))
  router.map(pageRoutes, createPagesController({ version: deps.version, commit: deps.commit }))
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
