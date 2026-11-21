// The controllers of the screens (`pageRoutes`), of the sign-in (`authRoutes`) and of the 404 page.
// REV-48. Each screen has its file in `./controllers/`; this file puts them on one router.
import { getCsrfToken } from 'remix/middleware/csrf'
import { createController, type Middleware } from 'remix/router'

import type { OrgRole } from '../db/schema.ts'
import { docsRoutes, fallbackRoutes, pageRoutes } from '../routes.ts'
import { assignmentActions } from './controllers/assignment.tsx'
import { createAuth } from './controllers/auth.tsx'
import { configActions } from './controllers/config.tsx'
import { dashboardActions } from './controllers/dashboard.tsx'
import type { UiDependencies } from './controllers/deps.ts'
import { findingsActions } from './controllers/findings.tsx'
import { createKit, forbidden, Person, redirect, Signed, signedOf, type SignedIn, type SignedPerson } from './controllers/kit.tsx'
import { CommandsPage } from './docs-commands.tsx'
import { reposActions } from './controllers/repos.tsx'
import { rulesActions } from './controllers/rules.tsx'
import { runnersActions } from './controllers/runners.tsx'
import { settingsActions } from './controllers/settings.tsx'
import { ErrorPage, type ErrorExit, type ErrorKind } from './not-found.tsx'
import { securityHeaders } from './security-headers.ts'
import type { PageFrame, Section } from './shell.tsx'
import { readTheme } from './theme.ts'

export type {
  AuthDependencies,
  DashboardDependencies,
  FindingsDependencies,
  OrgSettingsDependencies,
  ProvidersDependencies,
  RepoConfigDependencies,
  ReposDependencies,
  UiDependencies,
} from './controllers/deps.ts'
export { installationUrl, localPath } from './controllers/kit.tsx'

/** REV-32. The page of GitHub that installs the App `slug` on an org (`config.appSlug`). */
export function appInstallUrl(githubUrl: string, slug: string): string {
  return `${githubUrl.replace(/\/+$/, '')}/apps/${encodeURIComponent(slug)}/installations/new`
}

/** The controllers of the screens (`pageRoutes`) and of the sign-in (`authRoutes`). */
export function createUiControllers(deps: UiDependencies) {
  let kit = createKit(deps)
  let { sessionLayer, requireViewer, requirePerson, optionalViewer, signIn, frameActions } = createAuth(kit)

  let pages = createController(pageRoutes, {
    middleware: [securityHeaders(), ...sessionLayer, requireViewer],
    actions: {
      ...dashboardActions(kit),
      ...reposActions(kit),
      ...configActions(kit),
      ...findingsActions(kit),
      ...runnersActions(kit),
      ...settingsActions(kit),
      ...rulesActions(kit),
      ...assignmentActions(kit),
      ...frameActions,
    },
  })

  /**
   * REV-40. A page request that no route matches: the router sends it here (see `router.ts`). The
   * person is signed in or not; either way the 404 stays, in the frame, in English.
   */
  let notFound = createController(fallbackRoutes, {
    middleware: [securityHeaders(), ...sessionLayer, optionalViewer],
    actions: {
      notFound(context) {
        let signed = context.get(Signed)
        let page: PageFrame = signed
          ? kit.frame(signed, context, getCsrfToken(context))
          : {
              theme: readTheme(context.headers.get('Cookie')),
              version: deps.version,
              assetVersion: kit.assetVersion,
              viewer: null,
              csrfToken: null,
              path: `${context.url.pathname}${context.url.search}`,
            }
        return context.render(<ErrorPage frame={page} kind="page" />, { status: 404 })
      },
    },
  })

  /**
   * REV-96. The pages of documentation: no session, no sign-in. The link of a comment of Kentō on
   * GitHub opens them for every reader of the pull request.
   */
  let docs = createController(docsRoutes, {
    middleware: [securityHeaders()],
    actions: {
      commands(context) {
        let page = <CommandsPage theme={readTheme(context.headers.get('Cookie'))} version={deps.version} assetVersion={kit.assetVersion} />
        return context.render(page)
      },
      commandsLegacy(context) {
        return new Response(null, { status: 301, headers: { Location: `${docsRoutes.commands.href()}${context.url.search}` } })
      },
    },
  })

  /**
   * REV-17. What a screen in a file of its own needs from the frame: the middleware of the session,
   * the signed-in person, the frame of the page, and the 404 or 400 page.
   */
  let screens: ScreenKit = {
    middleware: [securityHeaders(), ...sessionLayer, requireViewer],
    signed: (context) => {
      let signed = signedOf(context)
      return { login: signed.user.login, orgId: signed.membership.org.id, orgName: signed.membership.org.name, role: signed.membership.role }
    },
    frame: (context) => kit.page(context),
    signedIn: (context) => signedOf(context),
    personMiddleware: [securityHeaders(), ...sessionLayer, requirePerson],
    person: (context) => {
      let person = context.get(Person)
      if (!person) throw new Error('requirePerson did not run')
      return person
    },
    personFrame: (context) => {
      let person = context.get(Person) as SignedPerson | undefined
      if (person?.signed) return kit.frame(person.signed, context, getCsrfToken(context))
      return {
        theme: readTheme(context.headers.get('Cookie')),
        version: deps.version,
        assetVersion: kit.assetVersion,
        viewer: null,
        csrfToken: getCsrfToken(context),
        path: `${context.url.pathname}${context.url.search}`,
      }
    },
    now: kit.now,
    setActiveOrg: async (sessionId, orgId) => {
      await deps.auth?.store.setActiveOrg(sessionId, orgId)
    },
    errorPage: kit.errorPage,
    redirect,
    forbidden,
  }

  return { pages, signIn, notFound, screens, docs }
}

/** The person on a screen, as a screen in a file of its own reads them. */
export interface ScreenViewer {
  login: string
  orgId: string
  orgName: string
  role: OrgRole
}

/** REV-17. The frame of the screens, for a controller in a file of its own. */
export interface ScreenKit {
  middleware: Middleware<any>[]
  signed(context: any): ScreenViewer
  frame(context: any): PageFrame
  /** KNT-150. The signed-in member of the request, with their org and its installations. */
  signedIn(context: any): SignedIn
  /** KNT-150. The middleware of a page that a person with only invitations reaches too. */
  personMiddleware: Middleware<any>[]
  person(context: any): SignedPerson
  /** The frame of such a page: the full frame for a member of an org, a bare one otherwise. */
  personFrame(context: any): PageFrame
  now: () => number
  /** KNT-150. Moves a session to an org (the person is a member of it now). */
  setActiveOrg(sessionId: string, orgId: string): Promise<void>
  errorPage(context: any, status: 400 | 404, kind: ErrorKind, section?: Section, exit?: ErrorExit): Response
  redirect(location: string): Response
  forbidden(): Response
}
