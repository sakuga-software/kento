// REV-48, KNT-150. The session of the screens, the signed-in person, the sign-in with GitHub through
// Better Auth, and the forms of the frame (theme, org, sign-out).
import { createHmac, randomBytes } from 'node:crypto'

import { renderToString } from 'remix/component/server'
import { createCookie } from 'remix/cookie'
import { cop } from 'remix/middleware/cop'
import { csrf } from 'remix/middleware/csrf'
import { formData } from 'remix/middleware/form-data'
import { createAction, createContextKey, createController, type Middleware } from 'remix/router'
import { createSession, Session } from 'remix/session'

import { currentMemberships } from '../../auth/access.ts'
import { AUTH_BASE_PATH, signInScope, type SignInScope } from '../../auth/better-auth.ts'
import { errorMessage, log } from '../../log.ts'
import { authRoutes, pageRoutes } from '../../routes.ts'
import { securityHeaders } from '../security-headers.ts'
import { SignInPage, type SignInNotice } from '../sign-in.tsx'
import { isTheme, readTheme, themeCookie, type Theme } from '../theme.ts'
import { localPath, redirect, Signed, signedOf, type SignedIn, type UiKit } from './kit.tsx'

const NOTICES: readonly SignInNotice[] = ['not_member', 'failed', 'signed_out', 'expired', 'disabled']

/** A login of GitHub: what the page "Access refused" accepts to show from its cookie. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** The name of the session cookie of Better Auth, without the `__Secure-` of HTTPS. */
const SESSION_COOKIE = 'kento_session'

/** The session of Better Auth of a request, read once by the session layer. Null: no valid session. */
interface AuthSession {
  sessionId: string
  userId: string
  activeOrgId: string | null
  /** 7 days after the sign-in, on the clock of Kentō. */
  expiresAt: number
}

const CurrentSession = createContextKey<AuthSession | null>()

/** The org on screen of a session of Better Auth (an additional field of the session). */
function activeOrgOf(session: object): string | null {
  let value = (session as { activeOrganizationId?: unknown }).activeOrganizationId
  return typeof value === 'string' ? value : null
}

export function createAuth(kit: UiKit) {
  let { deps, assetVersion, now, secure } = kit
  let auth = deps.auth

  /**
   * The CSRF token of a session: an HMAC of its id. Nothing to store, and it changes with the
   * session. A visitor without a session gets a random token: no form of theirs passes.
   */
  function csrfToken(sessionId: string | null): string {
    if (!auth || sessionId === null) return randomBytes(32).toString('hex')
    return createHmac('sha256', auth.sessionSecrets[0]!).update(`kento.csrf:${sessionId}`).digest('hex')
  }

  /** The request carries a session cookie, valid or not. */
  function hasSessionCookie(cookies: string | null): boolean {
    return (cookies ?? '').split(/;\s*/).some((pair) => pair.startsWith(`${SESSION_COOKIE}=`) || pair.startsWith(`__Secure-${SESSION_COOKIE}=`))
  }

  // Reads the session of Better Auth once, then gives remix/middleware/csrf the token of that
  // session in a `Session` of the request only: it is never stored.
  //
  // When the session cannot be read (the database does not answer), the screens answer 503 and keep
  // the cookie: the session works again as soon as the database answers.
  let readSession: Middleware = async (context, next) => {
    let found: Awaited<ReturnType<NonNullable<typeof auth>['auth']['api']['getSession']>> = null
    if (auth) {
      try {
        found = await auth.auth.api.getSession({ headers: context.headers, query: { disableCookieCache: true } })
      } catch (error) {
        log('warn', 'auth.session_read_failed', { error: errorMessage(error) })
        return unavailable(context)
      }
    }
    let session: AuthSession | null = found
      ? {
          sessionId: found.session.id,
          userId: found.user.id,
          activeOrgId: activeOrgOf(found.session),
          expiresAt: new Date(found.session.expiresAt).getTime(),
        }
      : null
    context.set(CurrentSession, session)
    context.set(Session, createSession(undefined, [{ _csrf: csrfToken(session?.sessionId ?? null) }, {}]))
    return next()
  }

  // cop() refuses a cross-site POST from what the browser says (Sec-Fetch-Site, Origin); csrf()
  // wants the token of the session in each form, and an Origin that is the public URL.
  let sessionLayer: Middleware<any>[] = auth
    ? [cop({ trustedOrigins: [auth.publicUrl.origin] }), readSession, formData(), csrf({ origin: auth.publicUrl.origin })]
    : []

  // REV-32. The login of a GitHub account that the sign-in refused, for the page "Access refused" that
  // follows. A signed cookie of 5 minutes, not a session: a refusal writes nothing on the server.
  let refusedCookie = auth
    ? createCookie(secure ? '__Host-kento_refused' : 'kento_refused', {
        secrets: auth.sessionSecrets,
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 5 * 60,
      })
    : null

  /** The request carries a cookie of a refused sign-in, signed or not. */
  function hasRefused(cookies: string | null): boolean {
    return refusedCookie !== null && (cookies ?? '').split(/;\s*/).some((pair) => pair.startsWith(`${refusedCookie.name}=`))
  }

  /** Empties the cookie of a refused sign-in. */
  function clearRefused(): Promise<string> {
    return refusedCookie!.serialize('', { maxAge: 0 })
  }

  function toSignIn(path: string, notice?: SignInNotice) {
    let query = new URLSearchParams()
    if (notice) query.set('notice', notice)
    if (path !== '/') query.set('returnTo', path)
    let search = query.toString()
    return redirect(`${authRoutes.signIn.href()}${search ? `?${search}` : ''}`)
  }

  /** A response of Better Auth with its cookies, as a redirect of Kentō to `location`. */
  function withCookiesOf(source: Headers, location: string): Response {
    let response = redirect(location)
    for (let cookie of source.getSetCookie()) response.headers.append('Set-Cookie', cookie)
    return response
  }

  /** Clears the session cookie on a response, whatever the state of the session. */
  function clearSessionCookie(response: Response): Response {
    let name = secure ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE
    response.headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`)
    return response
  }

  /**
   * The signed-in member of the request. The role comes from GitHub again when it is older than
   * ten minutes: a person removed from the org on GitHub loses the access.
   */
  async function readViewer(context: {
    get(key: typeof CurrentSession): AuthSession | null | undefined
    headers: Headers
  }): Promise<
    | { kind: 'signed'; signed: SignedIn; orgMoved: boolean }
    | { kind: 'anonymous' | 'expired' }
    | { kind: 'gone'; sessionId: string; expired?: boolean }
    | { kind: 'unconfirmed'; login: string; orgs: number }
  > {
    if (!auth) return { kind: 'anonymous' }
    let session = context.get(CurrentSession) ?? null
    if (!session) return { kind: hasSessionCookie(context.headers.get('Cookie')) ? 'expired' : 'anonymous' }
    // Better Auth ends a session at its `expires_at`; Kentō checks it again on its own clock.
    if (session.expiresAt <= now()) return { kind: 'gone', sessionId: session.sessionId, expired: true }
    let user = await auth.store.findUser(session.userId)
    if (!user) return { kind: 'gone', sessionId: session.sessionId }
    let { memberships, unconfirmed } = await currentMemberships(auth.store, auth.lookupRole, user, now())
    // GitHub has not answered for over an hour: no access, but no sign-out either. The session
    // works again as soon as GitHub confirms the role.
    if (memberships.length === 0 && unconfirmed > 0) return { kind: 'unconfirmed', login: user.login, orgs: unconfirmed }
    if (memberships.length === 0) return { kind: 'gone', sessionId: session.sessionId }
    let membership = memberships.find((m) => m.org.id === session.activeOrgId)
    // The org of the session is gone (left on GitHub, or suspended): the first org that remains.
    return {
      kind: 'signed',
      signed: { sessionId: session.sessionId, user, membership: membership ?? memberships[0]!, memberships },
      orgMoved: !membership,
    }
  }

  /** The 503 of the screens while GitHub does not confirm the role. */
  async function roleUnconfirmed(context: { headers: Headers }, login: string, orgs: number) {
    log('warn', 'auth.role_unconfirmed', { login, orgs })
    return unavailable(context)
  }

  /** The 503 of the screens: the sign-in cannot be checked now. Nothing changes in the session. */
  async function unavailable(context: { headers: Headers }) {
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

  /** Every screen needs a signed-in member of an org. */
  let requireViewer: Middleware = async (context, next) => {
    let path = `${context.url.pathname}${context.url.search}`
    let isGet = context.request.method === 'GET' || context.request.method === 'HEAD'
    let viewer = await readViewer(context)
    if (viewer.kind === 'unconfirmed') return roleUnconfirmed(context, viewer.login, viewer.orgs)
    if (viewer.kind !== 'signed') {
      // A session whose person has no org left ends here, and its cookie with it.
      if (viewer.kind === 'gone') await auth!.store.deleteSession(viewer.sessionId)
      let notice: SignInNotice | undefined = viewer.kind === 'anonymous' ? undefined : 'expired'
      let response = isGet ? toSignIn(path, notice) : new Response('Unauthorized', { status: 401 })
      return viewer.kind === 'anonymous' ? response : clearSessionCookie(response)
    }
    // The session moves to the org on screen, and stays there, so the org and the role match.
    if (viewer.orgMoved) await auth!.store.setActiveOrg(viewer.signed.sessionId, viewer.signed.membership.org.id)
    context.set(Signed, viewer.signed)
    return next()
  }

  /**
   * REV-40. The middleware of the 404 page: the person is signed in or not; either way the 404 stays,
   * in the frame.
   */
  let optionalViewer: Middleware = async (context, next) => {
    // Reads the session and changes nothing in it: an unknown URL never signs a person out.
    let viewer = await readViewer(context)
    // GitHub has not confirmed the role for over an hour: the 503 of the screens says so. A 404
    // page would offer a sign-in that cannot help.
    if (viewer.kind === 'unconfirmed') return roleUnconfirmed(context, viewer.login, viewer.orgs)
    if (viewer.kind === 'signed') context.set(Signed, viewer.signed)
    return next()
  }

  function signInPage(theme: Theme, notice: SignInNotice | null, returnTo: string, refusedLogin: string | null = null) {
    let query = new URLSearchParams()
    if (returnTo !== '/') query.set('returnTo', returnTo)
    let search = query.toString()
    let href = auth ? `${authRoutes.signInGitHub.href()}${search ? `?${search}` : ''}` : null
    query.set('switch', '1')
    return (
      <SignInPage
        theme={theme}
        version={deps.version}
        assetVersion={assetVersion}
        signInHref={href}
        notice={auth ? notice : 'disabled'}
        refusedLogin={refusedLogin}
        switchHref={auth ? `${authRoutes.signInGitHub.href()}?${query}` : null}
        installHref={auth?.installUrl ?? null}
      />
    )
  }

  let signIn = createController(authRoutes, {
    middleware: [securityHeaders(), ...sessionLayer],
    actions: {
      async signIn(context) {
        let notice = context.url.searchParams.get('notice')
        let returnTo = localPath(context.url.searchParams.get('returnTo'))
        let cookies = context.headers.get('Cookie')
        // Any visit of the page empties the cookie of a refusal, forged or not, whatever the answer.
        let leftover = hasRefused(cookies)
        let current = context.get(CurrentSession)
        if (auth && current && current.expiresAt > now()) {
          let back = redirect(returnTo)
          if (leftover) back.headers.append('Set-Cookie', await clearRefused())
          return back
        }
        let theme = readTheme(cookies)
        let known = NOTICES.find((n) => n === notice) ?? null
        let refusedLogin = known === 'not_member' && refusedCookie ? await refusedCookie.parse(cookies) : null
        let page = await context.render(signInPage(theme, known, returnTo, refusedLogin && GITHUB_LOGIN.test(refusedLogin) ? refusedLogin : null))
        // The login is shown once: the next person at this browser does not see it.
        if (leftover) page.headers.append('Set-Cookie', await clearRefused())
        return page
      },

      async signInGitHub(context) {
        if (!auth) return redirect(authRoutes.signIn.href())
        let started: { headers: Headers; response: { url?: string } }
        try {
          started = (await auth.auth.api.signInSocial({
            body: {
              provider: 'github',
              callbackURL: localPath(context.url.searchParams.get('returnTo')),
              errorCallbackURL: authRoutes.signIn.href(),
              disableRedirect: true,
            },
            headers: context.headers,
            returnHeaders: true,
          })) as { headers: Headers; response: { url?: string } }
        } catch (error) {
          log('warn', 'auth.sign_in_failed', { error: errorMessage(error) })
          return redirect(`${authRoutes.signIn.href()}?notice=failed`)
        }
        if (!started.response.url) return redirect(`${authRoutes.signIn.href()}?notice=failed`)
        let url = new URL(started.response.url)
        // REV-32. "Switch GitHub account": GitHub shows its account picker instead of signing in
        // the same account again.
        if (context.url.searchParams.get('switch') === '1') url.searchParams.set('prompt', 'select_account')
        let response = withCookiesOf(started.headers, url.href)
        response.headers.set('Location', url.href)
        // A new sign-in starts: the login of an earlier refusal has no use now.
        if (hasRefused(context.headers.get('Cookie'))) response.headers.append('Set-Cookie', await clearRefused())
        return response
      },

      // GitHub comes back here, at the callback URL of the GitHub App. The callback of Better Auth
      // runs it: the person gets a session only when GitHub counts them in an org of the App, and
      // nothing is written for anyone else.
      async callback(context) {
        if (!auth) return redirect(authRoutes.signIn.href())
        let previous = context.get(CurrentSession) ?? null
        let scope: SignInScope = { profile: null, decision: null }
        let target = new URL(`${AUTH_BASE_PATH}/callback/github${context.url.search}`, auth.publicUrl)
        let answer: Response
        try {
          answer = await signInScope.run(scope, () =>
            auth!.auth.handler(new Request(target, { method: 'GET', headers: context.request.headers })),
          )
        } catch (error) {
          log('warn', 'auth.sign_in_failed', { error: errorMessage(error) })
          return redirect(`${authRoutes.signIn.href()}?notice=failed`)
        }
        let location = new URL(answer.headers.get('Location') ?? authRoutes.signIn.href(), auth.publicUrl)
        let error = answer.status >= 300 && answer.status < 400 ? location.searchParams.get('error') : 'no_redirect'
        if (error !== null || scope.decision?.kind !== 'allowed') {
          if (scope.decision?.kind !== 'refused' && scope.decision?.kind !== 'unknown') {
            log('warn', 'auth.sign_in_failed', { error: error ?? 'no decision' })
          }
          let refused = scope.decision?.kind === 'refused'
          let response = redirect(`${authRoutes.signIn.href()}?notice=${refused ? 'not_member' : 'failed'}`)
          // The cookies of Better Auth: the state of the sign-in, cleared.
          for (let cookie of answer.headers.getSetCookie()) response.headers.append('Set-Cookie', cookie)
          if (refused && refusedCookie && scope.profile) response.headers.append('Set-Cookie', await refusedCookie.serialize(scope.profile.login))
          return response
        }
        // A sign-in from a session that was already signed in (another account, or the same one)
        // keeps nothing of it: its row goes.
        if (previous) await auth.store.deleteSession(previous.sessionId)
        let done = withCookiesOf(answer.headers, localPath(`${location.pathname}${location.search}`))
        // The login of an earlier refusal has no use now.
        if (refusedCookie) done.headers.append('Set-Cookie', await clearRefused())
        return done
      },
    },
  })

  /** The forms of the frame of every screen. */
  let frameActions = {
    // The theme form, for a browser without JavaScript: public/assets/theme.js does the same at once.
    theme: createAction(pageRoutes.theme, (context) => {
      let form = context.get(FormData)
      let theme = form?.get('theme')
      let response = redirect(localPath(form?.get('returnTo')))
      if (isTheme(theme)) response.headers.append('Set-Cookie', themeCookie(theme, secure))
      return response
    }),

    // The org on screen, for a person who is a member of several.
    org: createAction(pageRoutes.org, async (context) => {
      let form = context.get(FormData)
      let orgId = form?.get('orgId')
      let signed = signedOf(context)
      // Only an org where the person is a member now, as GitHub and Kentō say: an id of another org
      // changes nothing, and gets no answer that tells it exists.
      if (typeof orgId === 'string' && signed.memberships.some((m) => m.org.id === orgId)) {
        await auth!.auth.api.setActiveOrganization({ headers: context.headers, body: { organizationId: orgId } })
        log('info', 'auth.org_switched', { login: signed.user.login, org: orgId })
      }
      return redirect(localPath(form?.get('returnTo')))
    }),

    signOut: createAction(pageRoutes.signOut, async (context) => {
      let signed = signedOf(context)
      log('info', 'auth.signed_out', { login: signed.user.login })
      await auth!.store.deleteSession(signed.sessionId)
      return clearSessionCookie(redirect(`${authRoutes.signIn.href()}?notice=signed_out`))
    }),
  }

  return { sessionLayer, requireViewer, optionalViewer, signIn, frameActions }
}
