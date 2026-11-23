import { fileURLToPath } from 'node:url'
import { constants } from 'node:zlib'

import { AcceptEncoding, Vary } from 'remix/headers'
import { compression } from 'remix/middleware/compression'
import { render } from 'remix/middleware/render'
import { staticFiles } from 'remix/middleware/static'
import { createRouter, type Middleware, type RouterContext } from 'remix/router'

import { createController } from './actions/controller.ts'
import { clientAssets, clientEntries } from './assets.ts'
import type { CheckDatabase } from './db/health.ts'
import type { WebhookDependencies } from './github/webhook.ts'
import { legacyQueryRedirect } from './legacy-urls.ts'
import { requestLogger } from './request-logger.ts'
import { createPullControllers, type PullsDependencies } from './pulls/controller.tsx'
import type { AssignmentStore } from './assignment/store.ts'
import type { RulesStore } from './rules/store.ts'
import { authRoutes, costRoutes, docsRoutes, fallbackRoutes, feedbackRoutes, invitationRoutes, memberRoutes, organizationRoutes, pageRoutes, pullRoutes, routes, userRoutes } from './routes.ts'
import { createOrganizationController, type OrganizationDependencies } from './organizations/controller.tsx'
import { createMemberControllers, type MembersDependencies } from './members/controller.tsx'
import { createFeedbackControllers, type FeedbackDependencies } from './feedback/controller.tsx'
import { createCostControllers, type CostsDependencies } from './costs/controller.tsx'
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

/**
 * KNT-202. The quality of brotli for the responses that `compressed()` compresses on each request.
 * 11, the default of node:zlib, costs about 195 ms of CPU for the 167 KB of chart.js and 130 ms for
 * kento.css; 5 costs about 4 ms and 2 ms, for a body 10 to 15 % larger.
 */
const BROTLI_QUALITY = 5

/** KNT-202. The encodings of `compressed()`: every browser accepts both. */
const ENCODINGS: ('br' | 'gzip')[] = ['br', 'gzip']

/** KNT-202. The media types that `compressed()` compresses. */
const COMPRESSED_TYPES = new Set(['text/html', 'text/css', 'text/javascript', 'application/javascript', 'image/svg+xml'])

/**
 * KNT-202. Compresses the HTML pages, the files of public/assets/ and the browser modules, with
 * brotli or gzip, as the browser accepts. These responses stay as they are:
 * - the stream of the live card (`text/event-stream`), so that each event goes out at once;
 * - the JSON of the runners and of the webhook;
 * - the fonts, which are compressed already, and a byte range (`compression()` skips both).
 */
export function compressed(): Middleware {
  let compress = compression({
    filterMediaType: (mediaType) => COMPRESSED_TYPES.has(mediaType),
    encodings: ENCODINGS,
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } },
  })
  return async (context, next) => {
    if (acceptsOneOf(context.request, ENCODINGS)) return compress(context, next)
    // compression() of remix 3.2.0 answers 406 when the header names none of ENCODINGS and not
    // `identity` (`Accept-Encoding: zstd`). RFC 9110 accepts `identity` unless the header refuses it.
    let response = await next()
    let mediaType = response.headers.get('Content-Type')?.split(';')[0]?.trim() ?? ''
    if (!COMPRESSED_TYPES.has(mediaType)) return response
    let headers = new Headers(response.headers)
    let vary = Vary.from(headers.get('Vary'))
    vary.add('Accept-Encoding')
    headers.set('Vary', vary.toString())
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}

/** True when the request has no `Accept-Encoding`, or when it accepts one of `encodings`. */
function acceptsOneOf(request: Request, encodings: string[]): boolean {
  let header = request.headers.get('Accept-Encoding')
  if (header === null) return true
  let accept = AcceptEncoding.from(header)
  return accept.encodings.length === 0 || accept.getPreferred(encodings) !== null
}

/** What the routes need from the outside. Tests pass fakes. */
export interface AppDependencies {
  checkDatabase: CheckDatabase
  version: string
  commit: string | null
  webhook: WebhookDependencies
  /** The runner API. Without it, its routes answer 404. */
  runner?: RunnerApiDependencies
  /** The GitHub sign-in of the screens. Without it, every screen leads to "Sign-in unavailable". */
  auth?: AuthDependencies | null
  /** The Repos screen. Without it, the screen shows its empty frame. */
  repos?: ReposDependencies | null
  /** The Findings screen (REV-18). Without it, the screen shows its empty frame. */
  findings?: FindingsDependencies | null
  /** What the Runners screen reads and writes. Without it, the screen stays empty. */
  runnersAdmin?: RunnersAdminStore | null
  /** The section "Providers and keys" of the settings (REV-11). Without it, the settings stay empty. */
  providers?: ProvidersDependencies | null
  /** The Config screen of a repository (REV-12). Without it, the screen answers 404. */
  repoConfig?: RepoConfigDependencies | null
  /** The dashboard (REV-14). Without it, the home screen shows its empty frame. */
  dashboard?: DashboardDependencies | null
  /** The settings of the org (REV-13). Without them, the settings show the providers only. */
  orgSettings?: OrgSettingsDependencies | null
  /** The rules of the repositories and of the org (REV-19). Without them, the tab Rules says "Soon". */
  rules?: RulesStore | null
  /** The assignment rules of the repositories (REV-21). Without them, the tab Assignment says "Soon". */
  assignment?: AssignmentStore | null
  /** The screen of a pull request (REV-17). Without it, the screen answers 404. */
  pulls?: PullsDependencies | null
  /** The screen of a user (REV-22). Without it, the screen answers 404. */
  users?: UsersDependencies | null
  /** The answers about the reviews (REV-107). Without them, the screen answers 404. */
  feedback?: FeedbackDependencies | null
  /** KNT-188. The Costs screen. Without it, the screen answers 404. */
  costs?: CostsDependencies | null
  /** KNT-150. The members and the invitations. Without them, their screens answer 404. */
  members?: MembersDependencies | null
  /** KNT-150. The name and the installations of an org. Without them, the screen answers 404. */
  organization?: OrganizationDependencies | null
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
  let fallback = createRouter({ middleware: [render({ assets: clientEntries })] })
  let router = createRouter({
    defaultHandler: (context) =>
      isPageRequest(context.request, context.url)
        ? fallback.fetch(context.request)
        : new Response(`Not Found: ${context.url.pathname}`, { status: 404 }),
    middleware: [
      requestLogger(),
      compressed(),
      staticFiles(PUBLIC_DIR, {
        filter: (path) => path.startsWith('assets/'),
        // In production, the URL of the stylesheet and of the script carries the release (`?v=`),
        // and the fonts never change under one name.
        cacheControl: process.env.NODE_ENV === 'production' ? 'public, max-age=31536000, immutable' : 'no-cache',
      }),
      // KNT-163: the browser modules (`/assets/app/…`, `/assets/npm/…`), compiled on request.
      clientAssets(),
      render({ assets: clientEntries }),
      legacyQueryRedirect(),
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
  router.map(feedbackRoutes, createFeedbackControllers(ui.screens, deps.feedback ?? null))
  router.map(costRoutes, createCostControllers(ui.screens, deps.costs ?? null))
  let members = createMemberControllers(ui.screens, deps.members ?? null)
  router.map(memberRoutes, members.members)
  router.map(invitationRoutes, members.invitations)
  router.map(organizationRoutes, createOrganizationController(ui.screens, deps.organization ?? null))
  router.map(authRoutes, ui.signIn)
  router.map(docsRoutes, ui.docs)
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
