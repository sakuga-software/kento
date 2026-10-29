import { fileURLToPath } from 'node:url'

import { render } from 'remix/middleware/render'
import { staticFiles } from 'remix/middleware/static'
import { createRouter, type RouterContext } from 'remix/router'

import { createController } from './actions/controller.ts'
import type { CheckDatabase } from './db/health.ts'
import type { WebhookDependencies } from './github/webhook.ts'
import { requestLogger } from './request-logger.ts'
import { authRoutes, pageRoutes, routes } from './routes.ts'
import { createRunnerController, type RunnerApiDependencies } from './runner/controller.ts'
import type { RunnersAdminStore } from './runner/admin.ts'
import { runnerRoutes } from './runner/routes.ts'
import { createUiControllers, type AuthDependencies, type RepoConfigDependencies, type ReposDependencies } from './ui/pages.tsx'

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
  /** The GitHub sign-in of the screens. Without it, every screen leads to « Connexion indisponible ». */
  auth?: AuthDependencies | null
  /** The Repos screen. Without it, the screen shows its empty frame. */
  repos?: ReposDependencies | null
  /** What the Runners screen reads and writes. Without it, the screen stays empty. */
  runnersAdmin?: RunnersAdminStore | null
  /** The Config screen of a repository (REV-12). Without it, the screen answers 404. */
  repoConfig?: RepoConfigDependencies | null
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
  let ui = createUiControllers({
    version: deps.version,
    commit: deps.commit,
    auth: deps.auth ?? null,
    runners: deps.runnersAdmin ?? null,
    repos: deps.repos ?? null,
    repoConfig: deps.repoConfig ?? null,
  })
  router.map(pageRoutes, ui.pages)
  router.map(authRoutes, ui.signIn)
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
