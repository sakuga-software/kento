import { fileURLToPath } from 'node:url'

import { render } from 'remix/middleware/render'
import { staticFiles } from 'remix/middleware/static'
import { createRouter, type RouterContext } from 'remix/router'

import { createController } from './actions/controller.ts'
import type { CheckDatabase } from './db/health.ts'
import type { WebhookDependencies } from './github/webhook.ts'
import { requestLogger } from './request-logger.ts'
import { createPullControllers, type PullsDependencies } from './pulls/controller.tsx'
import type { AssignmentStore } from './assignment/store.ts'
import type { RulesStore } from './rules/store.ts'
import { authRoutes, fallbackRoutes, pageRoutes, pullRoutes, routes, userRoutes } from './routes.ts'
import { createRunnerController, type RunnerApiDependencies } from './runner/controller.ts'
import type { RunnersAdminStore } from './runner/admin.ts'
import { runnerRoutes } from './runner/routes.ts'
import { createUserControllers, type UsersDependencies } from './users/controller.tsx'
import {
  createUiControllers,
  type AuthDependencies,
  type DashboardDependencies,
  type FindingsDependencies,
  type OrgSettingsDependencies,
  type ProvidersDependencies,
  type RepoConfigDependencies,
  type ReposDependencies,
} from './ui/pages.tsx'

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
  /** The Findings screen (REV-18). Without it, the screen shows its empty frame. */
  findings?: FindingsDependencies | null
  /** What the Runners screen reads and writes. Without it, the screen stays empty. */
  runnersAdmin?: RunnersAdminStore | null
  /** The section « Providers et clés » of the settings (REV-11). Without it, the settings stay empty. */
  providers?: ProvidersDependencies | null
  /** The Config screen of a repository (REV-12). Without it, the screen answers 404. */
  repoConfig?: RepoConfigDependencies | null
  /** The dashboard (REV-14). Without it, the home screen shows its empty frame. */
  dashboard?: DashboardDependencies | null
  /** The settings of the org (REV-13). Without them, the settings show the providers only. */
  orgSettings?: OrgSettingsDependencies | null
  /** The rules of the repositories and of the org (REV-19). Without them, the tab Règles says « Bientôt ». */
  rules?: RulesStore | null
  /** The assignment rules of the repositories (REV-21). Without them, the tab Assignation says « Bientôt ». */
  assignment?: AssignmentStore | null
  /** The screen of a pull request (REV-17). Without it, the screen answers 404. */
  pulls?: PullsDependencies | null
  /** The screen of a user (REV-22). Without it, the screen answers 404. */
  users?: UsersDependencies | null
}

/**
 * The paths of machines: the runner API, the webhook, the health check and the files. A miss there
 * keeps the plain answer of the router, whoever asks.
 */
const MACHINE_PATHS = /^\/(?:api|webhooks|healthz|assets)(?:\/|$)/

/**
 * REV-40. A GET of a browser (it accepts HTML) outside of the paths of machines. Only such a request
 * gets the 404 page of the screens.
 */
export function isPageRequest(request: Request, url: URL): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (MACHINE_PATHS.test(url.pathname)) return false
  return (request.headers.get('Accept') ?? '').includes('text/html')
}

export function createAppRouter(deps: AppDependencies) {
  // The 404 page needs the session and the frame of the screens: its own router, with their middleware.
  let fallback = createRouter({ middleware: [render()] })
  let router = createRouter({
    defaultHandler: (context) =>
      isPageRequest(context.request, context.url)
        ? fallback.fetch(context.request)
        : new Response(`Not Found: ${context.url.pathname}`, { status: 404 }),
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
    findings: deps.findings ?? null,
    providers: deps.providers ?? null,
    repoConfig: deps.repoConfig ?? null,
    dashboard: deps.dashboard ?? null,
    orgSettings: deps.orgSettings ?? null,
    rules: deps.rules ?? null,
    assignment: deps.assignment ?? null,
  })
  router.map(pageRoutes, ui.pages)
  router.map(pullRoutes, createPullControllers(ui.screens, deps.pulls ?? null))
  router.map(userRoutes, createUserControllers(ui.screens, deps.users ?? null))
  router.map(authRoutes, ui.signIn)
  fallback.map(fallbackRoutes, ui.notFound)
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
