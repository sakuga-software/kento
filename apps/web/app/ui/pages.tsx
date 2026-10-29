import type { Handle } from 'remix/component'
import { renderToString } from 'remix/component/server'
import { completeAuth, finishExternalAuth, startExternalAuth, type OAuthProvider } from 'remix/auth'
import { createCookie } from 'remix/cookie'
import { cop } from 'remix/middleware/cop'
import { csrf, getCsrfToken } from 'remix/middleware/csrf'
import { formData } from 'remix/middleware/form-data'
import { session as sessionMiddleware } from 'remix/middleware/session'
import { createContextKey, createController, type Middleware } from 'remix/router'
import { Session, type SessionStorage } from 'remix/session'

import { currentMemberships, decideSignIn, saveSignInRoles } from '../auth/access.ts'
import type { GitHubProfile, LookupRole } from '../auth/github.ts'
import { readSessionAuth, SESSION_TTL_MS } from '../auth/session-storage.ts'
import type { AuthStore, MembershipRow, UserRow } from '../auth/store.ts'
import { errorMessage, log } from '../log.ts'
import { authRoutes, pageRoutes } from '../routes.ts'
import { securityHeaders } from './security-headers.ts'
import { Shell, type PageFrame, type Section, type Viewer } from './shell.tsx'
import { SignInPage, type SignInNotice } from './sign-in.tsx'
import { isTheme, readTheme, themeCookie, type Theme } from './theme.ts'

/** The GitHub sign-in and the sessions. Null: nobody can sign in, and every screen says so. */
export interface AuthDependencies {
  /** The origin of the service as the browser sees it. Traefik ends TLS, so the request URL is http. */
  publicUrl: URL
  sessionSecrets: string[]
  sessionStorage: SessionStorage
  provider: OAuthProvider<GitHubProfile, 'github'>
  store: AuthStore
  lookupRole: LookupRole
  now?: () => number
}

export interface UiDependencies {
  version: string
  /** The commit of the image, when the build gives it: it versions the URLs of the assets. */
  commit: string | null
  auth: AuthDependencies | null
}

interface SignedIn {
  user: UserRow
  membership: MembershipRow
  memberships: MembershipRow[]
}

/** The signed-in person on the screen, set by `requireViewer`. */
const Signed = createContextKey<SignedIn>()

const NOTICES: readonly SignInNotice[] = ['not_member', 'failed', 'signed_out', 'expired', 'disabled']

/**
 * The screens of milestone M3. Each one is a frame with an empty state until its own ticket fills
 * it: REV-14 the dashboard, REV-9 the repos, REV-18 the findings, REV-10 the runners, REV-13 the
 * settings of the org.
 */
const PLACEHOLDERS: Record<Section, { title: string; lead: string; empty: string }> = {
  dashboard: {
    title: 'Tableau de bord',
    lead: 'Ce qui tourne, ce qui a échoué, et ce que ça coûte.',
    empty: 'Les dernières reviews, la file de jobs, le coût du jour et les runners s’afficheront ici.',
  },
  repos: {
    title: 'Repos',
    lead: 'Les repos de l’installation, et où en est chacun dans sa bascule.',
    empty: 'La liste des repos, leur mode et leur compteur de bascule s’afficheront ici.',
  },
  findings: {
    title: 'Findings',
    lead: 'Chaque finding, et la précision des reviews.',
    empty: 'Les findings filtrables et la précision par repo s’afficheront ici.',
  },
  runners: {
    title: 'Runners',
    lead: 'Les machines qui font les reviews.',
    empty: 'Les runners, leur dernier signal et leurs jobs s’afficheront ici.',
  },
  settings: {
    title: 'Réglages',
    lead: 'Ce qui vaut pour toute l’organisation.',
    empty: 'Le plafond de coût, les valeurs par défaut, les providers et l’état de l’App s’afficheront ici.',
  },
}

/** The session of a request; the session middleware runs before every action that calls it. */
function sessionOf(context: { get(key: typeof Session): Session | undefined }): Session {
  let session = context.get(Session)
  if (!session) throw new Error('the session middleware did not run')
  return session
}

/** The signed-in person of a request; `requireViewer` runs before every action that calls it. */
function signedOf(context: { get(key: typeof Signed): SignedIn | undefined }): SignedIn {
  let signed = context.get(Signed)
  if (!signed) throw new Error('requireViewer did not run')
  return signed
}

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } })
}

/** The controllers of the screens (`pageRoutes`) and of the sign-in (`authRoutes`). */
export function createUiControllers(deps: UiDependencies) {
  let assetVersion = deps.commit ?? deps.version
  let auth = deps.auth
  let now = auth?.now ?? Date.now
  let secure = auth?.publicUrl.protocol === 'https:'

  // cop() refuses a cross-site POST from what the browser says (Sec-Fetch-Site, Origin); csrf()
  // wants the token of the session in each form, and an Origin that is the public URL. The session
  // cookie is signed, HttpOnly, SameSite=Lax (the callback from GitHub is a top-level GET from
  // another site, and must carry it), and `__Host-` over HTTPS (no Domain, Path=/, Secure).
  let sessionLayer: Middleware<any>[] = auth
    ? [
        cop({ trustedOrigins: [auth.publicUrl.origin] }),
        sessionMiddleware(
          createCookie(secure ? '__Host-kento_session' : 'kento_session', {
            secrets: auth.sessionSecrets,
            httpOnly: true,
            secure,
            sameSite: 'lax',
            path: '/',
            maxAge: SESSION_TTL_MS / 1000,
          }),
          auth.sessionStorage,
        ),
        formData(),
        csrf({ origin: auth.publicUrl.origin }),
      ]
    : []

  function toSignIn(path: string, notice?: SignInNotice) {
    let query = new URLSearchParams()
    if (notice) query.set('notice', notice)
    if (path !== '/') query.set('returnTo', path)
    let search = query.toString()
    return redirect(`${authRoutes.signIn.href()}${search ? `?${search}` : ''}`)
  }

  /**
   * Every screen needs a signed-in member of an org. The role comes from GitHub again when it is
   * older than ten minutes: a person removed from the org on GitHub loses the access.
   */
  let requireViewer: Middleware = async (context, next) => {
    let path = `${context.url.pathname}${context.url.search}`
    let isGet = context.request.method === 'GET' || context.request.method === 'HEAD'
    if (!auth) return isGet ? toSignIn(path) : new Response('Unauthorized', { status: 401 })
    let session = sessionOf(context)
    let record = readSessionAuth(session)
    if (!record || record.signedInAt + SESSION_TTL_MS <= now()) {
      if (record) session.destroy()
      return isGet ? toSignIn(path, record ? 'expired' : undefined) : new Response('Unauthorized', { status: 401 })
    }
    let user = await auth.store.findUser(record.userId)
    let { memberships, unconfirmed } = user
      ? await currentMemberships(auth.store, auth.lookupRole, user, now())
      : { memberships: [], unconfirmed: 0 }
    if (user && memberships.length === 0 && unconfirmed > 0) {
      // GitHub has not answered for over an hour: no access, but no sign-out either. The session
      // works again as soon as GitHub confirms the role.
      log('warn', 'auth.role_unconfirmed', { login: user.login, orgs: unconfirmed })
      let html = await renderToString(
        <SignInPage
          theme={readTheme(context.headers.get('Cookie'))}
          version={deps.version}
          assetVersion={assetVersion}
          signInHref={null}
          notice="unavailable"
        />,
      )
      return new Response(`<!DOCTYPE html>${html}`, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '60' },
      })
    }
    if (!user || memberships.length === 0) {
      session.destroy()
      return isGet ? toSignIn(path, 'expired') : new Response('Unauthorized', { status: 401 })
    }
    let orgId = session.get('orgId')
    let membership = memberships.find((m) => m.org.id === orgId)
    if (!membership) {
      // The org of the session is gone (left on GitHub, or suspended): the session moves to the
      // first org that remains, and stays there, so the org on screen and the role match.
      membership = memberships[0]!
      session.set('orgId', membership.org.id)
    }
    context.set(Signed, { user, membership, memberships })
    return next()
  }

  function frame(signed: SignedIn, context: { headers: Headers; url: URL }, csrfToken: string): PageFrame {
    let viewer: Viewer = {
      login: signed.user.login,
      name: signed.user.name,
      avatarUrl: signed.user.avatarUrl,
      role: signed.membership.role,
      org: { id: signed.membership.org.id, login: signed.membership.org.login },
      orgs: signed.memberships.map((m) => ({ id: m.org.id, login: m.org.login })),
    }
    return {
      theme: readTheme(context.headers.get('Cookie')),
      version: deps.version,
      assetVersion,
      viewer,
      csrfToken,
      path: `${context.url.pathname}${context.url.search}`,
    }
  }

  function signInPage(theme: Theme, notice: SignInNotice | null, returnTo: string) {
    let href = auth
      ? `${authRoutes.signInGitHub.href()}${returnTo !== '/' ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`
      : null
    return (
      <SignInPage
        theme={theme}
        version={deps.version}
        assetVersion={assetVersion}
        signInHref={href}
        notice={auth ? notice : 'disabled'}
      />
    )
  }

  let pages = createController(pageRoutes, {
    middleware: [securityHeaders(), ...sessionLayer, requireViewer],
    actions: {
      home(context) {
        let page = frame(signedOf(context), context, getCsrfToken(context))
        return context.render(<PlaceholderPage frame={page} section="dashboard" />)
      },
      repos(context) {
        let page = frame(signedOf(context), context, getCsrfToken(context))
        return context.render(<PlaceholderPage frame={page} section="repos" />)
      },
      findings(context) {
        let page = frame(signedOf(context), context, getCsrfToken(context))
        return context.render(<PlaceholderPage frame={page} section="findings" />)
      },
      runners(context) {
        let page = frame(signedOf(context), context, getCsrfToken(context))
        return context.render(<PlaceholderPage frame={page} section="runners" />)
      },
      settings(context) {
        let page = frame(signedOf(context), context, getCsrfToken(context))
        return context.render(<PlaceholderPage frame={page} section="settings" />)
      },

      // The theme form, for a browser without JavaScript: public/assets/theme.js does the same at once.
      theme(context) {
        let form = context.get(FormData)
        let theme = form?.get('theme')
        let response = redirect(localPath(form?.get('returnTo')))
        if (isTheme(theme)) response.headers.append('Set-Cookie', themeCookie(theme, secure))
        return response
      },

      // The org on screen, for a person who is a member of several.
      org(context) {
        let form = context.get(FormData)
        let orgId = form?.get('orgId')
        if (typeof orgId === 'string' && signedOf(context).memberships.some((m) => m.org.id === orgId)) {
          sessionOf(context).set('orgId', orgId)
        }
        return redirect(localPath(form?.get('returnTo')))
      },

      signOut(context) {
        log('info', 'auth.signed_out', { login: signedOf(context).user.login })
        sessionOf(context).destroy()
        return redirect(`${authRoutes.signIn.href()}?notice=signed_out`)
      },
    },
  })

  let signIn = createController(authRoutes, {
    middleware: [securityHeaders(), ...sessionLayer],
    actions: {
      signIn(context) {
        let notice = context.url.searchParams.get('notice')
        let returnTo = localPath(context.url.searchParams.get('returnTo'))
        if (auth) {
          let record = readSessionAuth(sessionOf(context))
          if (record && record.signedInAt + SESSION_TTL_MS > now()) return redirect(returnTo)
        }
        let theme = readTheme(context.headers.get('Cookie'))
        return context.render(signInPage(theme, NOTICES.find((n) => n === notice) ?? null, returnTo))
      },

      signInGitHub(context) {
        if (!auth) return redirect(authRoutes.signIn.href())
        return startExternalAuth(auth.provider, context, {
          returnTo: localPath(context.url.searchParams.get('returnTo')),
        })
      },

      // GitHub comes back here. The person gets a session only when GitHub counts them in an org
      // of the App: nothing is written for anyone else.
      async callback(context) {
        if (!auth) return redirect(authRoutes.signIn.href())
        let profile: GitHubProfile
        let returnTo: string | undefined
        try {
          let finished = await finishExternalAuth(auth.provider, context)
          profile = finished.result.profile
          returnTo = finished.returnTo
        } catch (error) {
          log('warn', 'auth.sign_in_failed', { error: errorMessage(error) })
          sessionOf(context).destroy()
          return redirect(`${authRoutes.signIn.href()}?notice=failed`)
        }

        let decision = await decideSignIn(auth.store, auth.lookupRole, profile)
        if (decision.kind !== 'allowed') {
          log('info', 'auth.sign_in_refused', { login: profile.login, reason: decision.kind })
          sessionOf(context).destroy()
          return redirect(`${authRoutes.signIn.href()}?notice=${decision.kind === 'refused' ? 'not_member' : 'failed'}`)
        }

        let user = await auth.store.upsertUser(profile)
        await saveSignInRoles(auth.store, user, decision.roles, decision.unconfirmed)
        // A new session id: an id known before the sign-in never becomes a signed-in one.
        let session = completeAuth(context)
        // A sign-in from a session that was already signed in (another account, or the same one)
        // keeps nothing of it: not its user, its org, nor its CSRF token.
        for (let key of ['auth', 'orgId', '_csrf']) session.unset(key)
        session.set('auth', { userId: user.id, signedInAt: now() })
        let first = decision.roles.find((r) => r.role === 'admin') ?? decision.roles[0]!
        session.set('orgId', first.org.id)
        log('info', 'auth.signed_in', {
          login: user.login,
          orgs: decision.roles.map((r) => `${r.org.login}:${r.role}`),
        })
        return redirect(localPath(returnTo ?? '/'))
      },
    },
  })

  return { pages, signIn }
}

/** A path of this site, or `/`: never another origin (`//host`, `/\host`, a scheme). */
export function localPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  try {
    let url = new URL(value, 'http://kento.invalid')
    return url.origin === 'http://kento.invalid' ? `${url.pathname}${url.search}` : '/'
  } catch {
    return '/'
  }
}

function PlaceholderPage(handle: Handle<{ frame: PageFrame; section: Section }>) {
  return () => {
    let { frame, section } = handle.props
    let page = PLACEHOLDERS[section]
    return (
      <Shell frame={frame} section={section} title={page.title} lead={page.lead}>
        <section class="empty" aria-labelledby="empty-title">
          <h2 id="empty-title">Bientôt ici</h2>
          <p>{page.empty}</p>
        </section>
      </Shell>
    )
  }
}
