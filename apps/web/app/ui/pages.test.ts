import { createHash } from 'node:crypto'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { OWNER_ACTIVE_MS, ROLE_GRACE_MS, ROLE_TTL_MS } from '../auth/access.ts'
import { githubEmail, SESSION_TTL_MS } from '../auth/better-auth.ts'
import { CAMILLE, cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, OTHER_ORG, SESSION_COOKIE, STRANGER } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { rememberClientAddress } from '../auth/rate-limit.ts'
import { createAppRouter } from '../router.ts'
import { ICON_FILES, ICON_VERSION } from '@kento-review/engine/render'
import { appInstallUrl, localPath } from './pages.tsx'
import { readTheme } from './theme.ts'

const COOKIE = SESSION_COOKIE

const INSTALL_URL = 'https://github.com/apps/kento-review/installations/new'

function setup(options: Parameters<typeof fakeAuth>[0] = {}) {
  let auth = fakeAuth(options)
  auth.setRole(ORG, OCTOCAT, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: 'abc1234',
    webhook: disabledWebhook,
    auth: { ...auth.deps, installUrl: INSTALL_URL },
  })

  function request(
    path: string,
    init: { method?: string; cookie?: string | null; headers?: Record<string, string>; form?: Record<string, string>; ip?: string } = {},
  ) {
    let headers = new Headers(init.headers)
    if (init.cookie) headers.set('Cookie', init.cookie)
    let req = new Request(new URL(path, 'http://localhost'), {
      method: init.method ?? (init.form ? 'POST' : 'GET'),
      headers,
      body: init.form ? new URLSearchParams(init.form) : undefined,
    })
    // As server.ts does: the address of the socket of the request.
    if (init.ip) rememberClientAddress(req, init.ip)
    return router.fetch(req)
  }

  /** Signs in through the GitHub flow; returns the session cookie, or the refusal. */
  async function signIn(profile = OCTOCAT, returnTo?: string, ip?: string) {
    auth.as(profile)
    let start = await request(`/login/github${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`, { ip })
    assert.equal(start.status, 303)
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let pending = cookiesOf(start)
    assert.ok(pending, 'the start of the sign-in sets the cookie of its state')
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: pending, ip })
    return { callback, pending, cookie: cookieOf(callback, COOKIE) }
  }

  async function csrfOf(cookie: string, path = '/') {
    let html = await (await request(path, { cookie })).text()
    return /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
  }

  return { auth, request, signIn, csrfOf }
}

/** A full sign-in with the router of `setup`, as `signIn` does. */
async function setupSignIn(request: ReturnType<typeof setup>['request'], auth: ReturnType<typeof setup>['auth']) {
  let start = await request('/login/github')
  let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
  let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookiesOf(start) })
  assert.ok(auth)
  return { callback, cookie: cookieOf(callback, COOKIE) }
}

describe('without the sign-in configured', () => {
  it('sends every screen to the sign-in page, which says the sign-in is not available', async () => {
    let router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '1.2.3',
      commit: null,
      webhook: disabledWebhook,
    })
    let screen = await router.fetch(new Request('http://localhost/repos'))
    assert.equal(screen.status, 303)
    assert.equal(screen.headers.get('Location'), '/login?returnTo=%2Frepos')

    let page = await (await router.fetch(new Request('http://localhost/login'))).text()
    assert.match(page, /Sign-in unavailable/)
  })
})

describe('the GitHub sign-in', () => {
  it('sends an anonymous visitor to the sign-in page, and back to the screen after it', async () => {
    let { request, signIn } = setup()

    let screen = await request('/runners')
    assert.equal(screen.status, 303)
    assert.equal(screen.headers.get('Location'), '/login?returnTo=%2Frunners')
    // No session for a visit: no cookie, no row.
    assert.equal(cookieOf(screen, COOKIE), null)

    let page = await request('/login?returnTo=%2Frunners')
    assert.equal(cookieOf(page, COOKIE), null)
    assert.match(await page.text(), /href="\/login\/github\?returnTo=%2Frunners"/)

    let { callback, cookie } = await signIn(OCTOCAT, '/runners')
    assert.equal(callback.status, 303)
    assert.equal(callback.headers.get('Location'), '/runners')
    assert.ok(cookie)
  })

  it('gives an admin of the org the full frame, with no "Read only"', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)

    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<a href="\/users\/octocat" title="octocat" class="bar-avatar"><span aria-hidden="true">OC<\/span>/)
    // KNT-150: the first admin on GitHub of an org that has no owner becomes its owner.
    assert.match(html, /<span class="who-role">Owner<\/span>/)
    assert.match(html, /<span class="org-menu-name">sakuga-software<\/span>/)
    assert.doesNotMatch(html, /Read only/)
    assert.match(html, /action="\/logout"/)
    assert.equal(auth.memberships.get(`${auth.userIdOf(OCTOCAT)}/org-1`)?.role, 'owner')
  })

  it('shows "Read only" to a member', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(CAMILLE)

    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /<span class="who-role">Member<\/span>/)
    assert.match(html, /<strong class="banner-title">Read only<\/strong> You are a member of sakuga-software/)
  })

  it('refuses a person outside of every org, and writes nothing', async () => {
    let { request, signIn, auth } = setup()
    let { callback, cookie } = await signIn(STRANGER)

    assert.equal(callback.headers.get('Location'), '/login?notice=not_member')
    // No session and no user: the person never gets a session cookie.
    assert.equal(cookie, null)
    assert.equal(auth.users.length, 0)
    assert.equal((await request('/', { cookie })).status, 303)
    assert.match(await (await request('/login?notice=not_member')).text(), /Access refused\./)
  })

  it('names the refused account and offers another account or the App on an org (REV-32)', async () => {
    let { request, signIn } = setup()
    let { callback } = await signIn(STRANGER)
    let refused = cookieOf(callback, '__Host-kento_refused')
    assert.ok(refused, 'the refusal sets a signed cookie with the login')
    let header = callback.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!
    for (let attribute of ['HttpOnly', 'Max-Age=300', 'Path=/', 'SameSite=Lax', 'Secure']) assert.ok(header.includes(attribute), attribute)

    let shown = await request('/login?notice=not_member', { cookie: refused })
    // Shown once: the page empties the cookie for the next person at this browser.
    assert.match(shown.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!, /^__Host-kento_refused=;.*Max-Age=0/)
    let html = await shown.text()
    assert.match(html, /Signed in to GitHub as <strong class="mono">@stranger<\/strong>/)
    assert.match(html, /href="\/login\/github\?switch=1"[^>]*>.*Switch GitHub account/s)
    assert.match(html, new RegExp(`href="${INSTALL_URL}"[^>]*>Install Kentō on an organization`))
    assert.match(html, /href="\/login\/github">Try again with @stranger<\/a>/)

    // Without the cookie, or with a forged one, the page names no account.
    let bare = await (await request('/login?notice=not_member')).text()
    assert.doesNotMatch(bare, /Signed in to GitHub as/)
    assert.match(bare, /Switch GitHub account/)
    let forged = await (await request('/login?notice=not_member', { cookie: '__Host-kento_refused=evil' })).text()
    assert.doesNotMatch(forged, /@evil/)
    // The cookie names the account on "Access refused" only, and any visit of the page empties it,
    // forged or not.
    let other = await request('/login?notice=signed_out', { cookie: refused })
    assert.doesNotMatch(await other.text(), /@stranger/)
    for (let response of [other, await request('/login', { cookie: '__Host-kento_refused=evil' })]) {
      assert.match(response.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!, /Max-Age=0/)
    }
    assert.equal((await request('/login')).headers.getSetCookie().some((c) => c.startsWith('__Host-kento_refused=')), false)
  })

  it('a sign-in that works empties the cookie of an earlier refusal (REV-32)', async () => {
    let { signIn, request } = setup()
    let { callback } = await signIn(OCTOCAT)
    // A signed-in visit of /login goes back to the screens, and empties a leftover cookie on its way.
    let session = cookieOf(callback, COOKIE)!
    let back = await request('/login', { cookie: `${session}; __Host-kento_refused=leftover` })
    assert.equal(back.status, 303)
    assert.match(back.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!, /Max-Age=0/)
    assert.match(callback.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!, /^__Host-kento_refused=;.*Max-Age=0/)
    assert.notEqual(cookieOf(callback, COOKIE) ?? `${COOKIE}=`, `${COOKIE}=`, 'the session cookie is still set')
  })

  it('makes the link "Install Kentō" from the slug of the App, on github.com or a GitHub Enterprise Server (REV-32)', () => {
    assert.equal(appInstallUrl('https://github.com', 'kento-review'), 'https://github.com/apps/kento-review/installations/new')
    assert.equal(appInstallUrl('https://ghe.example.com/', 'sakuga-review'), 'https://ghe.example.com/apps/sakuga-review/installations/new')
  })

  it('a new sign-in empties the cookie of an earlier refusal (REV-32)', async () => {
    let { request } = setup()
    let start = await request('/login/github?switch=1', { cookie: '__Host-kento_refused=leftover' })
    assert.equal(start.status, 303)
    assert.match(start.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!, /Max-Age=0/)
    assert.equal((await request('/login/github')).headers.getSetCookie().some((c) => c.startsWith('__Host-kento_refused=')), false)
  })

  it('"Switch GitHub account" asks GitHub for its account picker (REV-32)', async () => {
    let { request } = setup()
    let plain = new URL((await request('/login/github')).headers.get('Location')!)
    assert.equal(plain.searchParams.get('prompt'), null)
    let picker = new URL((await request('/login/github?switch=1&returnTo=%2Frepos')).headers.get('Location')!)
    assert.equal(picker.searchParams.get('prompt'), 'select_account')
    assert.ok(picker.searchParams.get('state'))
  })

  it('links Findings in the bar, with no "Soon" left (REV-18)', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/', { cookie })).text()
    assert.equal(html.match(/href="\/findings"/g)?.length, 1)
    assert.doesNotMatch(html, /class="bar-link">[^<]*<span class="tag tag-quiet">Soon/)
  })

  it('says the sign-in failed when GitHub cannot tell, and lets nobody in', async () => {
    let { signIn, auth } = setup()
    auth.setRole(ORG, OCTOCAT, 'error')

    let { callback } = await signIn(OCTOCAT)

    assert.equal(callback.headers.get('Location'), '/login?notice=failed')
    assert.equal(auth.users.length, 0)
  })

  it('refuses a callback with a wrong state or a refused code', async () => {
    let { request, auth } = setup()
    auth.as(OCTOCAT)
    let start = await request('/login/github')
    let pending = cookiesOf(start)
    assert.match(pending, /__Host-kento_state=/)

    // The cookie of the state is there, the state of the URL is not the one of the start: GitHub is
    // never asked for a token.
    let wrongState = await request('/auth/github/callback?code=good&state=forged', { cookie: pending })
    assert.equal(wrongState.headers.get('Location'), '/login?notice=failed')
    assert.equal(auth.exchanges.length, 0)

    // The right state and its cookie, and a code that GitHub refuses: one exchange, then nothing.
    let again = await request('/login/github')
    let state = new URL(again.headers.get('Location')!).searchParams.get('state')!
    let badCode = await request(`/auth/github/callback?code=bad&state=${state}`, { cookie: cookiesOf(again) })
    assert.equal(badCode.headers.get('Location'), '/login?notice=failed')
    assert.equal(auth.exchanges.length, 1)
    assert.equal(auth.exchanges[0]!.code, 'bad')
    assert.equal(auth.users.length, 0)
    assert.equal(auth.tables.sessions!.length, 0)
    assert.equal(auth.tables.verifications!.length, 1, 'only the state of the first start is left, unused')
  })

  it('KNT-150: a callback without the cookie of its state signs nobody in (no login CSRF)', async () => {
    let { request, auth } = setup()
    auth.as(OCTOCAT)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    // Another browser follows the link of the callback, with the code and the state of this start.
    let foreign = await request(`/auth/github/callback?code=good&state=${state}`)
    assert.equal(foreign.headers.get('Location'), '/login?notice=failed')
    assert.equal(cookieOf(foreign, COOKIE), null)
    assert.equal(auth.tables.sessions!.length, 0)
    assert.equal(auth.exchanges.length, 0, 'GitHub is never asked for a token')
    // The state is single use: even a refused try uses it up.
    let late = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookiesOf(start) })
    assert.equal(late.headers.get('Location'), '/login?notice=failed')
    // A new start in the browser of the person signs in.
    let { cookie } = await setupSignIn(request, auth)
    assert.ok(cookie)
  })

  it('a sign-in from a signed-in session keeps nothing of the previous one', async () => {
    let { request, signIn, auth, csrfOf } = setup()
    let first = await signIn(OCTOCAT)
    let oldToken = await csrfOf(first.cookie!)

    auth.as(CAMILLE)
    let start = await request('/login/github', { cookie: first.cookie })
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let pending = [first.cookie, cookiesOf(start)].filter(Boolean).join('; ')
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: pending })
    let cookie = cookieOf(callback, COOKIE)!

    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<a href="\/users\/camille" title="camille" class="bar-avatar">/)
    assert.notEqual(await csrfOf(cookie), oldToken)
    // The cookie of the first session no longer opens anything.
    assert.equal((await request('/', { cookie: first.cookie })).status, 303)
  })

  it('KNT-150: trades the code with the redirect_uri and the PKCE verifier of the authorization', async () => {
    let { auth, request } = setup()
    auth.as(OCTOCAT)
    let start = await request('/login/github')
    let authorize = new URL(start.headers.get('Location')!)
    assert.equal(authorize.origin + authorize.pathname, 'https://github.test/login/oauth/authorize')
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorize.searchParams.get('allow_signup'), 'false')
    let callback = await request(`/auth/github/callback?code=good&state=${authorize.searchParams.get('state')}`, { cookie: cookiesOf(start) })
    assert.equal(callback.status, 303)
    let [exchange] = auth.exchanges
    assert.equal(exchange!.redirectUri, authorize.searchParams.get('redirect_uri'))
    assert.equal(exchange!.redirectUri, 'https://review.test/auth/github/callback')
    assert.equal(createHash('sha256').update(exchange!.codeVerifier!).digest('base64url'), authorize.searchParams.get('code_challenge'))
    assert.ok(!authorize.href.includes(exchange!.codeVerifier!), 'the verifier never goes to the browser')
  })

  it('KNT-150: a refused or failed sign-in from a signed-in session keeps that session', async () => {
    let { request, signIn, auth } = setup()
    let first = await signIn(OCTOCAT)
    auth.as(STRANGER)
    let start = await request('/login/github', { cookie: first.cookie })
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let refused = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: [first.cookie, cookiesOf(start)].join('; ') })
    assert.equal(refused.headers.get('Location'), '/login?notice=not_member')
    assert.equal((await request('/', { cookie: first.cookie })).status, 200, 'octocat is still signed in after a refusal')
    // A fresh start, and a code that GitHub refuses.
    auth.as(OCTOCAT)
    let again = await request('/login/github', { cookie: first.cookie })
    let fresh = new URL(again.headers.get('Location')!).searchParams.get('state')!
    let exchanges = auth.exchanges.length
    let failed = await request(`/auth/github/callback?code=bad&state=${fresh}`, { cookie: [first.cookie, cookiesOf(again)].join('; ') })
    assert.equal(failed.headers.get('Location'), '/login?notice=failed')
    assert.equal(auth.exchanges.length, exchanges + 1, 'the code reached GitHub')
    assert.equal(cookieOf(failed, COOKIE), null, 'no session cookie, set or cleared')
    assert.equal((await request('/', { cookie: first.cookie })).status, 200, 'octocat is still signed in after a failure')
    assert.equal(auth.tables.sessions!.length, 1)
  })

  it('gives a new session token at the sign-in, never one that the browser brought (no fixation)', async () => {
    let { request, signIn, auth } = setup()
    auth.as(OCTOCAT)
    let fixed = `${COOKIE}=attacker.fixed`
    let start = await request('/login/github', { cookie: fixed })
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: `${fixed}; ${cookiesOf(start)}` })
    let first = cookieOf(callback, COOKIE)!
    assert.ok(first)
    assert.notEqual(first, fixed)
    assert.notEqual(first.split('=')[1]!.split('.')[0], 'attacker')
    // Two sign-ins, two tokens, and the first one opens nothing once the second replaced it.
    let second = await request(`/login/github`, { cookie: first })
    let again = await request(`/auth/github/callback?code=good&state=${new URL(second.headers.get('Location')!).searchParams.get('state')}`, {
      cookie: `${first}; ${cookiesOf(second)}`,
    })
    let next = cookieOf(again, COOKIE)!
    assert.notEqual(next.split('.')[0], first.split('.')[0])
    assert.equal((await request('/', { cookie: first })).status, 303)
    assert.equal((await request('/', { cookie: next })).status, 200)
    assert.ok(signIn)
  })

  it('sets hardened __Host- cookies for the state of a sign-in and for the session', async () => {
    let { request, auth } = setup()
    auth.as(OCTOCAT)
    let start = await request('/login/github')
    let state = start.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_state=')) ?? ''
    let callback = await request(`/auth/github/callback?code=good&state=${new URL(start.headers.get('Location')!).searchParams.get('state')}`, {
      cookie: cookiesOf(start),
    })
    let session = callback.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? ''
    assert.match(COOKIE, /^__Host-/)
    for (let [header, maxAge] of [
      [state, 600],
      [session, 604800],
    ] as const) {
      assert.match(header, /^__Host-/)
      assert.match(header, /; Path=\/(;|$)/)
      assert.match(header, /; HttpOnly/)
      assert.match(header, /; Secure/)
      assert.match(header, /; SameSite=Lax/)
      assert.match(header, new RegExp(`; Max-Age=${maxAge}`))
      assert.doesNotMatch(header, /Domain=/i)
    }
    // No other cookie of Better Auth: no `__Secure-` one, no cache of the session.
    let names = [...start.headers.getSetCookie(), ...callback.headers.getSetCookie()].map((c) => c.split('=')[0]!)
    assert.deepEqual(names.filter((n) => n.startsWith('__Secure-') || n.includes('session_data')), [])
  })

  it('KNT-150: a session is not extended by its use: it ends 7 days after the sign-in', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)
    // As if the sign-in was 2 days ago: Better Auth would extend a session older than a day.
    let row = auth.tables.sessions![0]!
    let end = new Date(Date.now() + SESSION_TTL_MS - 2 * 24 * 60 * 60 * 1000)
    row.expiresAt = end
    assert.equal((await request('/', { cookie })).status, 200)
    assert.equal((await request('/repos', { cookie })).status, 200)
    assert.equal(new Date(auth.tables.sessions![0]!.expiresAt as Date).getTime(), end.getTime())
  })

  it('KNT-150: never links a GitHub account to a user found by e-mail', async () => {
    let { signIn, auth } = setup()
    // A user with the e-mail of octocat, and no account row.
    auth.tables.users!.push({
      id: 'user-orphan', githubId: OCTOCAT.id, login: 'octocat', email: githubEmail(OCTOCAT.id), emailVerified: false,
      createdAt: new Date(), updatedAt: new Date(),
    })
    let { callback, cookie } = await signIn(OCTOCAT)
    assert.equal(callback.headers.get('Location'), '/login?notice=failed')
    assert.equal(cookie, null)
    assert.equal(auth.tables.accounts!.length, 0)
  })

  it('KNT-150: a returnTo that holds "error=" still ends in a sign-in, once', async () => {
    let { signIn, auth } = setup()
    let { callback, cookie } = await signIn(OCTOCAT, '/findings?error=1')
    assert.equal(callback.headers.get('Location'), '/findings?error=1')
    assert.ok(cookie)
    assert.equal(auth.tables.sessions!.length, 1)
  })

  it('KNT-150: no path of the API of Better Auth is served', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    for (let path of [
      '/api/auth/get-session', '/api/auth/list-sessions', '/api/auth/sign-out', '/api/auth/revoke-session',
      '/api/auth/revoke-sessions', '/api/auth/revoke-other-sessions', '/api/auth/callback/github', '/api/auth/ok',
      '/api/auth/error', '/api/auth/sign-in/social', '/api/auth/oauth2/callback/github', '/api/auth/organization/list',
      '/api/auth/multi-session/list-device-sessions', '/api/auth/admin/list-user-sessions',
    ]) {
      for (let method of ['GET', 'POST']) {
        let response = await request(path, { method, cookie, headers: { Origin: 'https://review.test', 'Content-Type': 'application/json' } })
        assert.equal(response.status, 404, `${method} ${path}`)
      }
    }
  })

  it('KNT-150: limits the sign-ins of one client, and not the others', async () => {
    let { request, signIn, auth } = setup()
    auth.as(OCTOCAT)
    let codes: number[] = []
    for (let n = 0; n < 12; n++) codes.push((await request('/login/github', { ip: '203.0.113.7' })).status)
    assert.deepEqual(codes, [...Array(10).fill(303), 429, 429])
    let refused = await request('/login/github', { ip: '203.0.113.7' })
    assert.equal(refused.headers.get('Retry-After'), '60')
    assert.match(await refused.text(), /Too many sign-ins\./)
    assert.equal(auth.tables.verifications!.length, 10, 'no row past the limit')
    // A flood of callbacks from one client stops at its limit; another client still signs in.
    for (let n = 0; n < 25; n++) await request('/auth/github/callback?code=x&state=y', { ip: '203.0.113.8' })
    assert.equal((await request('/auth/github/callback?code=x&state=y', { ip: '203.0.113.8' })).status, 429)
    let other = await signIn(OCTOCAT, undefined, '198.51.100.20')
    assert.ok(other.cookie)
    // A forged X-Forwarded-For changes nothing: without trusted proxies, the socket is the client.
    let forged = await request('/login/github', { ip: '203.0.113.7', headers: { 'X-Forwarded-For': '192.0.2.99' } })
    assert.equal(forged.status, 429)
    // After a minute, the client signs in again.
    auth.clock.now += 60_000
    assert.equal((await request('/login/github', { ip: '203.0.113.7' })).status, 303)
  })

  it('KNT-150: callbacks from many clients never lock the others out (no shared bucket)', async () => {
    let { request, signIn } = setup()
    // 150 callbacks with a wrong state, each one from a client of its own, each under its limit.
    for (let n = 0; n < 150; n++) {
      let response = await request('/auth/github/callback?code=x&state=y', { ip: `10.0.${n >> 8}.${n & 255}` })
      assert.equal(response.headers.get('Location'), '/login?notice=failed')
    }
    // The next person signs in, from another client or with no address at all.
    assert.ok((await signIn(OCTOCAT, undefined, '198.51.100.30')).cookie)
    assert.ok((await signIn(CAMILLE)).cookie)
  })

  it('sends a signed-in person from the sign-in page to the screens', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let page = await request('/login?returnTo=%2Frepos', { cookie })
    assert.equal(page.status, 303)
    assert.equal(page.headers.get('Location'), '/repos')
  })
})

describe('the role, from GitHub', () => {
  it('is read again after ten minutes: a person removed from the org loses the access', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(CAMILLE)
    auth.setRole(ORG, CAMILLE, null)

    auth.clock.now += ROLE_TTL_MS - 1000
    assert.equal((await request('/', { cookie })).status, 200)

    auth.clock.now += 2000
    let after = await request('/', { cookie })
    assert.equal(after.status, 303)
    assert.equal(after.headers.get('Location'), '/login?notice=expired')
    assert.equal(auth.memberships.size, 0)
  })

  it('follows a change of role on GitHub', async () => {
    let { request, signIn, auth } = setup()
    // octocat, the first admin, is the owner: camille becomes an admin, not the owner.
    await signIn(OCTOCAT)
    let { cookie } = await signIn(CAMILLE)
    auth.setRole(ORG, CAMILLE, 'admin')
    auth.clock.now += ROLE_TTL_MS + 1000

    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<span class="who-role">Admin<\/span>/)
  })

  it('keeps a role while GitHub fails, asks GitHub again on each request, and after an hour refuses without signing out', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)
    auth.setRole(ORG, OCTOCAT, 'error')
    let signedInAt = auth.clock.now

    auth.clock.now = signedInAt + ROLE_TTL_MS + 1000
    let before = auth.lookups.length
    assert.equal((await request('/', { cookie })).status, 200)
    assert.equal((await request('/', { cookie })).status, 200)
    // The failed check left checked_at as it was: each request asks GitHub again.
    assert.equal(auth.lookups.length - before, 2)

    auth.clock.now = signedInAt + ROLE_GRACE_MS + 1000
    let down = await request('/', { cookie })
    assert.equal(down.status, 503)
    assert.match(await down.text(), /GitHub does not answer\./)
    assert.equal(cookieOf(down, COOKIE), null, 'the session is not cleared')

    auth.setRole(ORG, OCTOCAT, 'admin')
    assert.equal((await request('/', { cookie })).status, 200)
  })

  it('logs a role that GitHub has not confirmed for over an hour', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)
    auth.setRole(ORG, OCTOCAT, 'error')
    auth.clock.now += ROLE_GRACE_MS + 1000

    let lines: string[] = []
    let write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      assert.equal((await request('/', { cookie })).status, 503)
    } finally {
      process.stderr.write = write
    }
    let events = lines.map((line) => JSON.parse(line) as { event: string; login?: string; orgs?: number })
    assert.ok(events.some((e) => e.event === 'auth.role_unconfirmed' && e.login === 'octocat' && e.orgs === 1), lines.join(''))
  })

  it('moves the session to a remaining org when its org is gone, and keeps it there', async () => {
    let { request, signIn, auth } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    let { cookie } = await signIn(CAMILLE)
    assert.match(await (await request('/', { cookie })).text(), /<span class="org-menu-name">orchard<\/span>/)

    // Camille leaves orchard on GitHub: the screens move to sakuga-software, where she reads.
    auth.setRole(OTHER_ORG, CAMILLE, null)
    auth.clock.now += ROLE_TTL_MS + 1000
    let alone = await (await request('/', { cookie })).text()
    assert.match(alone, /<span class="org-menu-name">sakuga-software<\/span>/)
    assert.match(alone, /Read only/)

    // She comes back to orchard: the session stays on the org it moved to.
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    await auth.deps.store.saveMembership(auth.userIdOf(CAMILLE), 'org-2', 'admin')
    assert.match(await (await request('/', { cookie })).text(), /<span class="org-menu-name">sakuga-software<\/span>/)
  })

  it('answers 503 and keeps the cookie while the sessions cannot be read, then works again', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)
    auth.failSessions(true)
    let down = await request('/repos', { cookie })
    assert.equal(down.status, 503)
    assert.equal(down.headers.get('Retry-After'), '60')
    assert.equal(down.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`)), false, 'the cookie stays')
    auth.failSessions(false)
    assert.equal((await request('/repos', { cookie })).status, 200)
  })

  it('ends the session seven days after the sign-in', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)
    auth.setRole(ORG, OCTOCAT, 'admin')

    auth.clock.now += SESSION_TTL_MS
    let after = await request('/', { cookie })
    assert.equal(after.headers.get('Location'), '/login?notice=expired')
  })

  it('keeps the membership of an org where GitHub fails at the sign-in', async () => {
    let { signIn, auth } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    let { cookie } = await signIn(CAMILLE)
    assert.equal(auth.memberships.get(`${auth.userIdOf(CAMILLE)}/org-2`)?.role, 'owner')

    // GitHub fails for orchard at the next sign-in, and answers for sakuga-software.
    auth.clock.now += 60_000
    auth.setRole(OTHER_ORG, CAMILLE, 'error')
    await signIn(CAMILLE)
    assert.equal(auth.memberships.get(`${auth.userIdOf(CAMILLE)}/org-2`)?.role, 'owner', 'GitHub never said that camille left orchard')

    // A "not a member" from GitHub does forget it.
    auth.setRole(OTHER_ORG, CAMILLE, null)
    await signIn(CAMILLE)
    assert.equal(auth.memberships.get(`${auth.userIdOf(CAMILLE)}/org-2`), undefined)
    assert.ok(cookie)
  })

  it('switches the org on screen, only to an org of the person', async () => {
    let { request, signIn, auth, csrfOf } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    let { cookie } = await signIn(CAMILLE)

    // The admin org comes first.
    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<span class="org-menu-name">orchard<\/span>/)
    assert.doesNotMatch(html, /Read only/)

    let token = await csrfOf(cookie!)
    let switched = await request('/preferences/org', { cookie, form: { _csrf: token, orgId: 'org-1', returnTo: '/repos' } })
    assert.equal(switched.headers.get('Location'), '/repos')
    let member = await (await request('/repos', { cookie })).text()
    assert.match(member, /<span class="org-menu-name">sakuga-software<\/span>/)
    assert.match(member, /Read only/)

    await request('/preferences/org', { cookie, form: { _csrf: token, orgId: 'org-9' } })
    assert.match(await (await request('/', { cookie })).text(), /<span class="org-menu-name">sakuga-software<\/span>/)
  })

  it('KNT-150: a switch that Better Auth refuses (the membership went in between) goes back to the page, not to a 500', async () => {
    let { request, signIn, auth, csrfOf } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    let { cookie } = await signIn(CAMILLE)
    let token = await csrfOf(cookie!)
    let api = auth.deps.auth.api as { setActiveOrganization: (...args: unknown[]) => Promise<unknown> }
    let original = api.setActiveOrganization
    api.setActiveOrganization = async () => {
      throw new Error('You are not a member of this organization')
    }
    try {
      let switched = await request('/preferences/org', { cookie, form: { _csrf: token, orgId: 'org-1', returnTo: '/repos' } })
      assert.equal(switched.status, 303)
      assert.equal(switched.headers.get('Location'), '/repos')
    } finally {
      api.setActiveOrganization = original
    }
    assert.match(await (await request('/', { cookie })).text(), /<span class="org-menu-name">orchard<\/span>/)
  })
})

describe('the forms of the frame', () => {
  it('refuse a form without the CSRF token of the session', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)

    let response = await request('/logout', { cookie, form: {} })
    assert.equal(response.status, 403)
    let forged = await request('/logout', { cookie, form: { _csrf: 'f'.repeat(64) } })
    assert.equal(forged.status, 403)
    assert.equal((await request('/', { cookie })).status, 200)
  })

  it('refuse a form that another site sent, even with the token', async () => {
    let { request, signIn, csrfOf } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let token = await csrfOf(cookie!)

    for (let headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }] as Record<string, string>[]) {
      let response = await request('/preferences/theme', { cookie, headers, form: { _csrf: token, theme: 'sumi' } })
      assert.equal(response.status, 403, JSON.stringify(headers))
      assert.equal(response.headers.get('Set-Cookie'), null)
    }
  })

  it('sign out: the session ends, and the screens need a new sign-in', async () => {
    let { request, signIn, csrfOf } = setup()
    let { cookie } = await signIn(OCTOCAT)

    let response = await request('/logout', { cookie, form: { _csrf: await csrfOf(cookie!) } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/login?notice=signed_out')
    // The browser drops the cookie: no Domain, the same Path, Max-Age=0.
    let cleared = response.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? ''
    assert.match(cleared, new RegExp(`^${COOKIE}=;`))
    assert.match(cleared, /; Max-Age=0/)
    assert.match(cleared, /; Path=\//)
    assert.match(cleared, /; Secure/)
    assert.equal((await request('/', { cookie })).status, 303)
  })

  it('the theme form sets a Secure cookie on an https service, and goes back to the page', async () => {
    let { request, signIn, csrfOf } = setup()
    let { cookie } = await signIn(OCTOCAT)

    let response = await request('/preferences/theme', {
      cookie,
      form: { _csrf: await csrfOf(cookie!), theme: 'paper', returnTo: '/repos' },
    })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/repos')
    assert.ok(response.headers.getSetCookie().includes('kento_theme=paper; Path=/; Max-Age=31536000; SameSite=Lax; Secure'))
  })

  it('the theme form ignores a theme it does not know, and never goes to another site', async () => {
    let { request, signIn, csrfOf } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let token = await csrfOf(cookie!)

    let response = await request('/preferences/theme', { cookie, form: { _csrf: token, theme: 'neon', returnTo: '//evil.example/x' } })
    assert.equal(response.headers.get('Location'), '/')
    assert.ok(!response.headers.getSetCookie().some((c) => c.startsWith('kento_theme=')))
  })
})

describe('the frame of a screen', () => {
  it('renders the navigation, the title, and the footer with the version', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let response = await request('/', { cookie })

    assert.equal(response.status, 200)
    let html = await response.text()
    assert.match(html, /<html lang="en" data-theme="system">/)
    assert.match(html, /<title>Dashboard · Kentō<\/title>/)
    for (let label of ['Dashboard', 'Repos', 'Runners', 'Settings']) {
      assert.ok(html.includes(`${label}</a>`), `the navigation has ${label}`)
    }
    assert.match(html, /Kentō 1\.2\.3 · by Sakuga/)
    assert.match(html, /\/assets\/kento\.css\?v=abc1234/)
  })

  it('marks the screen on display as the current page, in the bar', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/runners', { cookie })).text()

    let current = [...html.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((match) => match[1])
    assert.deepEqual(current, ['/runners'])
  })

  it('sends the security headers, and no cache, on the screens and the sign-in page', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    for (let response of [await request('/settings', { cookie }), await request('/login')]) {
      let csp = response.headers.get('Content-Security-Policy') ?? ''
      assert.match(csp, /script-src 'self'/)
      assert.match(csp, /frame-ancestors 'none'/)
      assert.doesNotMatch(csp, /unsafe-inline/)
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    }
  })

  it('keeps the theme of the cookie on every screen, with no theme form in the foot (KNT-142)', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    for (let path of ['/', '/repos', '/findings', '/runners', '/settings']) {
      let html = await (await request(path, { cookie: `${cookie}; kento_theme=sumi` })).text()
      assert.match(html, /<html lang="en" data-theme="sumi">/, path)
      let footer = html.slice(html.indexOf('<footer'))
      assert.match(footer, /Sign out/, path)
      assert.doesNotMatch(html, /data-theme-switch|name="theme"|\/preferences\/theme/, path)
    }
  })
})

describe('localPath', () => {
  it('keeps a path of this site, with its query', () => {
    assert.equal(localPath('/repos?x=1'), '/repos?x=1')
  })

  it('refuses another origin, a backslash, a scheme, or no value', () => {
    for (let value of ['//evil.example', '/\\evil.example', 'https://evil.example', 'repos', '', null, 42]) {
      assert.equal(localPath(value), '/', String(value))
    }
  })

  it('refuses a path that the parse turns into another origin (REV-130)', () => {
    for (let value of ['/.//evil.example', '/a/..//evil.example', '/%2e//evil.example', '/.//evil.example/phish?x=1']) {
      assert.equal(localPath(value), '/', value)
    }
  })
})

describe('readTheme', () => {
  it('reads the cookie, and falls back to the theme of the device', () => {
    assert.equal(readTheme('kento_theme=paper'), 'paper')
    assert.equal(readTheme('a=b; kento_theme=sumi'), 'sumi')
    assert.equal(readTheme('kento_theme=neon'), 'system')
    assert.equal(readTheme(null), 'system')
  })
})

describe('the assets', () => {
  it('serves the stylesheet, the script and the fonts, with no sign-in', async () => {
    let { request } = setup()
    for (let path of ['/assets/kento.css', '/assets/theme.js', '/assets/favicon.svg', '/assets/fonts/archivo-latin-wght-normal.woff2']) {
      assert.equal((await request(path)).status, 200, path)
    }
  })

  it('serves each icon of the texts on GitHub as an SVG image, in its two themes (REV-106)', async () => {
    let { request } = setup()
    for (let name of ICON_FILES) {
      for (let file of [`${name}.v${ICON_VERSION}.svg`, `${name}-dark.v${ICON_VERSION}.svg`]) {
        let response = await request(`/assets/pr/${file}`)
        assert.equal(response.status, 200, file)
        assert.equal(response.headers.get('Content-Type'), 'image/svg+xml', file)
        assert.match(await response.text(), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="(20|26)" /, file)
      }
    }
  })

  it('serves nothing outside of /assets/', async () => {
    let { request } = setup()
    assert.equal((await request('/fonts/LICENSE-Archivo.txt')).status, 404)
  })
})

describe('KNT-150: a pending invitation', () => {
  it('lets a person whom GitHub counts nowhere sign in, to the page of the invitations only', async () => {
    let { request, signIn, auth } = setup()
    assert.equal((await signIn(STRANGER)).cookie, null, 'no invitation: refused')
    auth.invite(STRANGER)
    let { callback, cookie } = await signIn(STRANGER)
    assert.ok(cookie)
    assert.equal(callback.headers.get('Location'), '/')
    assert.equal(auth.tables.sessions!.at(-1)!.activeOrganizationId, null, 'a session with no org')
    for (let path of ['/', '/repos', '/settings', '/runners']) {
      let screen = await request(path, { cookie })
      assert.equal(screen.headers.get('Location'), '/invitations', path)
    }
    assert.equal((await request('/repos/check', { cookie, form: {} })).status, 403)
    // The invitation goes (declined, canceled, expired): the next request ends the session.
    auth.invite(STRANGER, 0)
    assert.equal((await request('/', { cookie })).headers.get('Location'), '/login?notice=expired')
  })

  it('a member with a pending invitation of another org sees a banner that leads to it', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)
    assert.doesNotMatch(await (await request('/', { cookie })).text(), /See the invitations/)
    auth.invite(OCTOCAT, 2)
    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<strong class="banner-title">2 invitations<\/strong> Organizations invite you to Kentō\. <a href="\/invitations">See the invitations<\/a>/)
    assert.match(html, /<a href="\/settings\/members" class="org-menu-link">Members<\/a>/)
  })
})

describe('KNT-150: the roles owner, admin and member, and the menu of the orgs', () => {
  it('makes the first admin on GitHub of an org the owner; the next admins are admins, the members members', async () => {
    let { request, signIn, auth } = setup()
    auth.setRole(ORG, STRANGER, 'admin')
    let owner = await signIn(OCTOCAT)
    await signIn(STRANGER)
    await signIn(CAMILLE)
    assert.equal(auth.memberships.get(`${auth.userIdOf(OCTOCAT)}/org-1`)?.role, 'owner')
    assert.equal(auth.memberships.get(`${auth.userIdOf(STRANGER)}/org-1`)?.role, 'admin')
    assert.equal(auth.memberships.get(`${auth.userIdOf(CAMILLE)}/org-1`)?.role, 'member')
    // An owner edits, as an admin does: the frame has no "Read only".
    assert.doesNotMatch(await (await request('/settings', { cookie: owner.cookie })).text(), /Read only/)
  })

  it('keeps an owner an owner while GitHub says admin, makes them a member when GitHub demotes them, and removes them when they left', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)
    auth.clock.now += ROLE_TTL_MS + 1000
    assert.match(await (await request('/', { cookie })).text(), /<span class="who-role">Owner<\/span>/)
    // GitHub demotes octocat to member: owner holds only while GitHub says admin.
    auth.setRole(ORG, OCTOCAT, 'member')
    auth.clock.now += ROLE_TTL_MS + 1000
    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<span class="who-role">Member<\/span>/)
    assert.match(html, /Read only/)
    // A new sign-in changes nothing.
    let again = await signIn(OCTOCAT)
    assert.match(await (await request('/', { cookie: again.cookie })).text(), /<span class="who-role">Member<\/span>/)
    auth.setRole(ORG, OCTOCAT, null)
    auth.clock.now += ROLE_TTL_MS + 1000
    assert.equal((await request('/', { cookie: again.cookie })).status, 303)
    assert.equal(auth.memberships.get(`${auth.userIdOf(OCTOCAT)}/org-1`), undefined)
  })

  it('makes an admin the owner at its next check when the org has no owner any more', async () => {
    let { request, signIn, auth } = setup()
    auth.setRole(ORG, STRANGER, 'admin')
    let owner = await signIn(OCTOCAT)
    let admin = await signIn(STRANGER)
    assert.equal(auth.memberships.get(`${auth.userIdOf(STRANGER)}/org-1`)?.role, 'admin')
    // The owner leaves the org on GitHub; their next request ends the membership.
    auth.setRole(ORG, OCTOCAT, null)
    auth.clock.now += ROLE_TTL_MS + 1000
    assert.equal((await request('/', { cookie: owner.cookie })).status, 303)
    // The admin, at its next check, becomes the owner, without a new sign-in.
    assert.match(await (await request('/', { cookie: admin.cookie })).text(), /<span class="who-role">Owner<\/span>/)
  })

  it('gives the org back an owner after a release that wrote admin over owner', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(OCTOCAT)
    // The release before, during the deploy, read GitHub again and wrote `admin`.
    await auth.deps.store.saveMembership(auth.userIdOf(OCTOCAT), ORG.id, 'admin', 'github')
    auth.clock.now += ROLE_TTL_MS + 1000
    assert.match(await (await request('/', { cookie })).text(), /<span class="who-role">Owner<\/span>/)
  })

  it('an owner who has not been seen for 30 days does not stop the next GitHub admin from becoming the owner', async () => {
    let { signIn, auth } = setup()
    auth.setRole(ORG, STRANGER, 'admin')
    await signIn(OCTOCAT)
    auth.clock.now += OWNER_ACTIVE_MS - 60_000
    await signIn(STRANGER)
    assert.equal(auth.memberships.get(`${auth.userIdOf(STRANGER)}/org-1`)?.role, 'admin', 'the owner was seen within 30 days')
    auth.clock.now += 2 * 60_000
    auth.clock.now += ROLE_TTL_MS
    await signIn(STRANGER)
    assert.equal(auth.memberships.get(`${auth.userIdOf(STRANGER)}/org-1`)?.role, 'owner')
    // The old owner keeps their row; when they come back as an admin of GitHub, they stay an owner.
    assert.equal(auth.memberships.get(`${auth.userIdOf(OCTOCAT)}/org-1`)?.role, 'owner')
  })

  it('follows GitHub between admin and member for a membership from GitHub', async () => {
    let { request, signIn, auth } = setup()
    await signIn(OCTOCAT)
    auth.setRole(ORG, STRANGER, 'admin')
    let { cookie } = await signIn(STRANGER)
    assert.doesNotMatch(await (await request('/', { cookie })).text(), /Read only/)
    auth.setRole(ORG, STRANGER, 'member')
    auth.clock.now += ROLE_TTL_MS + 1000
    assert.match(await (await request('/', { cookie })).text(), /Read only/)
    assert.equal(auth.memberships.get(`${auth.userIdOf(STRANGER)}/org-1`)?.role, 'member')
  })

  it('never asks GitHub about a membership from an invitation, and keeps it when GitHub does not count the person', async () => {
    let { request, signIn, auth } = setup({ orgs: [ORG, OTHER_ORG] })
    let { cookie } = await signIn(CAMILLE)
    await auth.deps.store.saveMembership(auth.userIdOf(CAMILLE), 'org-2', 'admin', 'invitation')
    auth.setRole(OTHER_ORG, CAMILLE, null)
    auth.clock.now += ROLE_GRACE_MS + 1000
    let before = auth.lookups.length
    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<span class="org-menu-item-name">orchard<\/span><span class="tag tag-quiet">Admin<\/span>/)
    assert.deepEqual(auth.lookups.slice(before), ['sakuga-software/camille'], 'only the membership from GitHub is read again')
    assert.equal(auth.memberships.get(`${auth.userIdOf(CAMILLE)}/org-2`)?.source, 'invitation')
  })

  it('lists every org of the person in the menu with their role, and the current one is not a form', async () => {
    let { request, signIn, auth } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    let { cookie } = await signIn(CAMILLE)
    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<details class="bar-org org-menu"><summary class="bar-org-box"><span class="visually-hidden">Organization: <\/span><span class="org-menu-name">orchard<\/span>/)
    assert.match(html, /<span aria-current="true" class="org-menu-item"><span class="org-menu-item-name">orchard<\/span><span class="tag tag-quiet">Owner<\/span>/)
    assert.match(html, /<input type="hidden" name="orgId" value="org-1" \/><button type="submit" class="org-menu-item"><span class="org-menu-item-name">sakuga-software<\/span><span class="tag tag-quiet">Member<\/span>/)
    assert.doesNotMatch(html, /name="orgId" value="org-2"/)
    assert.match(html, /<a href="\/settings" class="org-menu-link">Organization settings<\/a>/)
  })

  it('a member of one org cannot move a session to another org: the form changes nothing', async () => {
    let { request, signIn, auth, csrfOf } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, OCTOCAT, null)
    let { cookie } = await signIn(OCTOCAT)
    let token = await csrfOf(cookie!)
    let response = await request('/preferences/org', { cookie, form: { _csrf: token, orgId: 'org-2', returnTo: '/settings' } })
    assert.equal(response.status, 303)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /<span class="org-menu-name">sakuga-software<\/span>/)
    assert.doesNotMatch(html, /orchard/)
  })
})

describe('KNT-150: a member from an invitation', () => {
  it('signs in to the org of the invitation when GitHub counts them nowhere, and reads it', async () => {
    let { request, signIn, auth } = setup({ orgs: [ORG, OTHER_ORG] })
    // Refused before: GitHub counts the stranger in no org.
    assert.equal((await signIn(STRANGER)).callback.headers.get('Location'), '/login?notice=not_member')
    // An admin of orchard invited them (the invitation flow comes later): a user and a membership.
    auth.tables.users!.push({ id: 'user-stranger', githubId: STRANGER.id, login: STRANGER.login, email: `${STRANGER.id}@users.github.invalid`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() })
    auth.tables.accounts!.push({ id: 'account-stranger', userId: 'user-stranger', providerId: 'github', accountId: String(STRANGER.id), createdAt: new Date(), updatedAt: new Date() })
    await auth.deps.store.saveMembership('user-stranger', 'org-2', 'member', 'invitation')
    let { callback, cookie } = await signIn(STRANGER)
    assert.equal(callback.headers.get('Location'), '/')
    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<span class="org-menu-name">orchard<\/span>/)
    assert.match(html, /Read only/)
    assert.equal(auth.memberships.get('user-stranger/org-2')?.source, 'invitation')
  })
})

describe('KNT-150: an invitation and GitHub on the same org', () => {
  it('the invitation wins: GitHub neither changes the role nor ends the membership', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(CAMILLE)
    // An admin of Kentō made camille an admin by invitation; GitHub counts her as a member.
    await auth.deps.store.deleteMembership(auth.userIdOf(CAMILLE), 'org-1')
    await auth.deps.store.saveMembership(auth.userIdOf(CAMILLE), 'org-1', 'admin', 'invitation')
    auth.clock.now += ROLE_TTL_MS + 1000
    assert.doesNotMatch(await (await request('/', { cookie })).text(), /Read only/)
    // A new sign-in where GitHub counts her as a member keeps the invitation and its role.
    await signIn(CAMILLE)
    assert.deepEqual({ ...auth.memberships.get(`${auth.userIdOf(CAMILLE)}/org-1`) }.role, 'admin')
    // GitHub says she left: the membership from the invitation stays.
    auth.setRole(ORG, CAMILLE, null)
    auth.clock.now += ROLE_TTL_MS + 1000
    assert.equal((await request('/', { cookie })).status, 200)
    assert.equal(auth.memberships.get(`${auth.userIdOf(CAMILLE)}/org-1`)?.source, 'invitation')
  })
})
