// REV-48. The session of the screens, the signed-in person, the sign-in with GitHub, and the forms of
// the frame (theme, org, sign-out).
import { renderToString } from 'remix/component/server'
import { completeAuth, finishExternalAuth, startExternalAuth } from 'remix/auth'
import { createCookie } from 'remix/cookie'
import { cop } from 'remix/middleware/cop'
import { csrf } from 'remix/middleware/csrf'
import { formData } from 'remix/middleware/form-data'
import { session as sessionMiddleware } from 'remix/middleware/session'
import { createAction, createController, type Middleware } from 'remix/router'
import { Session } from 'remix/session'

import { currentMemberships, decideSignIn, saveSignInRoles } from '../../auth/access.ts'
import type { GitHubProfile } from '../../auth/github.ts'
import { readSessionAuth, SESSION_TTL_MS } from '../../auth/session-storage.ts'
import { errorMessage, log } from '../../log.ts'
import { authRoutes, pageRoutes } from '../../routes.ts'
import { securityHeaders } from '../security-headers.ts'
import { SignInPage, type SignInNotice } from '../sign-in.tsx'
import { isTheme, readTheme, themeCookie, type Theme } from '../theme.ts'
import { localPath, redirect, sessionOf, Signed, signedOf, type SignedIn, type UiKit } from './kit.tsx'

const NOTICES: readonly SignInNotice[] = ['not_member', 'failed', 'signed_out', 'expired', 'disabled']

/** A login of GitHub: what the page « Access refused » accepts to show from its cookie. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export function createAuth(kit: UiKit) {
  let { deps, assetVersion, now, secure } = kit
  let auth = deps.auth

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

  // REV-32. The login of a GitHub account that the sign-in refused, for the page « Access refused » that
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

  /**
   * The signed-in member of the request, read without changing the session. The role comes from
   * GitHub again when it is older than ten minutes: a person removed from the org on GitHub loses
   * the access.
   */
  async function readViewer(
    context: { get(key: typeof Session): Session | undefined },
  ): Promise<
    | { kind: 'signed'; signed: SignedIn; orgMoved: boolean }
    | { kind: 'anonymous' | 'expired' | 'gone' }
    | { kind: 'unconfirmed'; login: string; orgs: number }
  > {
    if (!auth) return { kind: 'anonymous' }
    let session = sessionOf(context)
    let record = readSessionAuth(session)
    if (!record) return { kind: 'anonymous' }
    if (record.signedInAt + SESSION_TTL_MS <= now()) return { kind: 'expired' }
    let user = await auth.store.findUser(record.userId)
    if (!user) return { kind: 'gone' }
    let { memberships, unconfirmed } = await currentMemberships(auth.store, auth.lookupRole, user, now())
    // GitHub has not answered for over an hour: no access, but no sign-out either. The session
    // works again as soon as GitHub confirms the role.
    if (memberships.length === 0 && unconfirmed > 0) return { kind: 'unconfirmed', login: user.login, orgs: unconfirmed }
    if (memberships.length === 0) return { kind: 'gone' }
    let orgId = session.get('orgId')
    let membership = memberships.find((m) => m.org.id === orgId)
    // The org of the session is gone (left on GitHub, or suspended): the first org that remains.
    return { kind: 'signed', signed: { user, membership: membership ?? memberships[0]!, memberships }, orgMoved: !membership }
  }

  /** The 503 of the screens while GitHub does not confirm the role. */
  async function roleUnconfirmed(context: { headers: Headers }, login: string, orgs: number) {
    log('warn', 'auth.role_unconfirmed', { login, orgs })
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
      if (viewer.kind !== 'anonymous') sessionOf(context).destroy()
      let notice: SignInNotice | undefined = viewer.kind === 'anonymous' ? undefined : 'expired'
      return isGet ? toSignIn(path, notice) : new Response('Unauthorized', { status: 401 })
    }
    // The session moves to the org on screen, and stays there, so the org and the role match.
    if (viewer.orgMoved) sessionOf(context).set('orgId', viewer.signed.membership.org.id)
    context.set(Signed, viewer.signed)
    return next()
  }

  /**
   * REV-40. The middleware of the 404 page: the person is signed in or not; either way the 404 stays,
   * in the frame, in French.
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
        if (auth) {
          let record = readSessionAuth(sessionOf(context))
          if (record && record.signedInAt + SESSION_TTL_MS > now()) {
            let back = redirect(returnTo)
            if (leftover) back.headers.append('Set-Cookie', await clearRefused())
            return back
          }
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
        let response = await startExternalAuth(auth.provider, context, {
          returnTo: localPath(context.url.searchParams.get('returnTo')),
        })
        // REV-32. « Switch GitHub account »: GitHub shows its account picker instead of signing in
        // the same account again.
        // A new sign-in starts: the login of an earlier refusal has no use now.
        if (hasRefused(context.headers.get('Cookie'))) response.headers.append('Set-Cookie', await clearRefused())
        let location = response.headers.get('Location')
        if (context.url.searchParams.get('switch') !== '1' || !location) return response
        let url = new URL(location)
        url.searchParams.set('prompt', 'select_account')
        // A new response: the headers of the one of `remix/auth` may be immutable.
        let headers = new Headers(response.headers)
        headers.set('Location', url.href)
        return new Response(null, { status: response.status, headers })
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
          let refused = redirect(`${authRoutes.signIn.href()}?notice=${decision.kind === 'refused' ? 'not_member' : 'failed'}`)
          if (decision.kind === 'refused' && refusedCookie) refused.headers.append('Set-Cookie', await refusedCookie.serialize(profile.login))
          return refused
        }

        let user = await auth.store.upsertUser(profile)
        let signedIn = await clearRefused()
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
        let done = redirect(localPath(returnTo ?? '/'))
        done.headers.append('Set-Cookie', signedIn)
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
    org: createAction(pageRoutes.org, (context) => {
      let form = context.get(FormData)
      let orgId = form?.get('orgId')
      if (typeof orgId === 'string' && signedOf(context).memberships.some((m) => m.org.id === orgId)) {
        sessionOf(context).set('orgId', orgId)
      }
      return redirect(localPath(form?.get('returnTo')))
    }),

    signOut: createAction(pageRoutes.signOut, (context) => {
      log('info', 'auth.signed_out', { login: signedOf(context).user.login })
      sessionOf(context).destroy()
      return redirect(`${authRoutes.signIn.href()}?notice=signed_out`)
    }),
  }

  return { sessionLayer, requireViewer, optionalViewer, signIn, frameActions }
}
