import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { ROLE_GRACE_MS, ROLE_TTL_MS } from '../auth/access.ts'
import { SESSION_TTL_MS } from '../auth/session-storage.ts'
import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG, OTHER_ORG, STRANGER } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { appInstallUrl, localPath } from './pages.tsx'
import { readTheme } from './theme.ts'

const COOKIE = '__Host-kento_session'

const INSTALL_URL = 'https://github.com/apps/kento-review/installations/new'

function setup(options: Parameters<typeof fakeAuth>[0] = {}) {
  let auth = fakeAuth(options)
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: 'abc1234',
    webhook: disabledWebhook,
    auth: { ...auth.deps, installUrl: INSTALL_URL },
  })

  function request(path: string, init: { method?: string; cookie?: string | null; headers?: Record<string, string>; form?: Record<string, string> } = {}) {
    let headers = new Headers(init.headers)
    if (init.cookie) headers.set('Cookie', init.cookie)
    return router.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: init.method ?? (init.form ? 'POST' : 'GET'),
        headers,
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
    )
  }

  /** Signs in through the GitHub flow; returns the session cookie, or the refusal. */
  async function signIn(profile = ALEX, returnTo?: string) {
    auth.as(profile)
    let start = await request(`/login/github${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`)
    assert.equal(start.status, 302)
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let pending = cookieOf(start, COOKIE)
    assert.ok(pending, 'the start of the sign-in sets a session cookie')
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: pending })
    return { callback, pending, cookie: cookieOf(callback, COOKIE) }
  }

  async function csrfOf(cookie: string, path = '/') {
    let html = await (await request(path, { cookie })).text()
    return /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
  }

  return { auth, request, signIn, csrfOf }
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
    assert.match(page, /Connexion indisponible/)
    assert.doesNotMatch(page, /Continuer avec GitHub/)
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

    let { callback, cookie } = await signIn(ALEX, '/runners')
    assert.equal(callback.status, 303)
    assert.equal(callback.headers.get('Location'), '/runners')
    assert.ok(cookie)
  })

  it('gives an admin of the org the full frame, with no « Lecture seule »', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(ALEX)

    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<a href="\/users\/alex" class="who-login">alex<\/a>/)
    assert.match(html, /<span class="who-role">Admin<\/span>/)
    assert.match(html, /<span class="org-name">sakuga-software<\/span>/)
    assert.doesNotMatch(html, /Lecture seule/)
    assert.match(html, /action="\/logout"/)
    assert.equal(auth.memberships.get('user-1/org-1')?.role, 'admin')
  })

  it('shows « Lecture seule » to a member', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(CAMILLE)

    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /<span class="who-role">Membre<\/span>/)
    assert.match(html, /<strong>Lecture seule\.<\/strong> Vous êtes membre de sakuga-software/)
  })

  it('refuses a person outside of every org, and writes nothing', async () => {
    let { request, signIn, auth } = setup()
    let { callback, cookie } = await signIn(STRANGER)

    assert.equal(callback.headers.get('Location'), '/login?notice=not_member')
    // The pending sign-in is dropped: the cookie is cleared, and there is no user.
    assert.equal(cookie, `${COOKIE}=`)
    assert.equal(auth.users.size, 0)
    assert.equal((await request('/', { cookie })).status, 303)
    assert.match(await (await request('/login?notice=not_member')).text(), /Accès refusé\./)
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
    assert.match(html, /Connecté à GitHub en tant que <strong class="mono">@stranger<\/strong>/)
    assert.match(html, /href="\/login\/github\?switch=1"[^>]*>.*Changer de compte GitHub/s)
    assert.match(html, new RegExp(`href="${INSTALL_URL}"[^>]*>Installer Kentō sur une organisation`))
    assert.match(html, /href="\/login\/github">Réessayer avec @stranger<\/a>/)
    assert.doesNotMatch(html, /Continuer avec GitHub/)

    // Without the cookie, or with a forged one, the page names no account.
    let bare = await (await request('/login?notice=not_member')).text()
    assert.doesNotMatch(bare, /Connecté à GitHub en tant que/)
    assert.match(bare, /Changer de compte GitHub/)
    let forged = await (await request('/login?notice=not_member', { cookie: '__Host-kento_refused=evil' })).text()
    assert.doesNotMatch(forged, /@evil/)
    // The cookie names the account on « Accès refusé » only, and any visit of the page empties it,
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
    let { callback } = await signIn(ALEX)
    // A signed-in visit of /login goes back to the screens, and empties a leftover cookie on its way.
    let session = cookieOf(callback, COOKIE)!
    let back = await request('/login', { cookie: `${session}; __Host-kento_refused=leftover` })
    assert.equal(back.status, 303)
    assert.match(back.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!, /Max-Age=0/)
    assert.match(callback.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!, /^__Host-kento_refused=;.*Max-Age=0/)
    assert.notEqual(cookieOf(callback, COOKIE) ?? `${COOKIE}=`, `${COOKIE}=`, 'the session cookie is still set')
  })

  it('makes the link « Installer Kentō » from the slug of the App, on github.com or a GitHub Enterprise Server (REV-32)', () => {
    assert.equal(appInstallUrl('https://github.com', 'kento-review'), 'https://github.com/apps/kento-review/installations/new')
    assert.equal(appInstallUrl('https://ghe.example.com/', 'sakuga-review'), 'https://ghe.example.com/apps/sakuga-review/installations/new')
  })

  it('a new sign-in empties the cookie of an earlier refusal (REV-32)', async () => {
    let { request } = setup()
    let start = await request('/login/github?switch=1', { cookie: '__Host-kento_refused=leftover' })
    assert.equal(start.status, 302)
    assert.match(start.headers.getSetCookie().find((c) => c.startsWith('__Host-kento_refused='))!, /Max-Age=0/)
    assert.equal((await request('/login/github')).headers.getSetCookie().some((c) => c.startsWith('__Host-kento_refused=')), false)
  })

  it('« Changer de compte GitHub » asks GitHub for its account picker (REV-32)', async () => {
    let { request } = setup()
    let plain = new URL((await request('/login/github')).headers.get('Location')!)
    assert.equal(plain.searchParams.get('prompt'), null)
    let picker = new URL((await request('/login/github?switch=1&returnTo=%2Frepos')).headers.get('Location')!)
    assert.equal(picker.searchParams.get('prompt'), 'select_account')
    assert.ok(picker.searchParams.get('state'))
  })

  it('links Findings in the sidebar and in the tab bar, with no « Bientôt » left (REV-18)', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/', { cookie })).text()
    assert.equal(html.match(/href="\/findings"/g)?.length, 2)
    assert.doesNotMatch(html, /nav-soon/)
  })

  it('says the sign-in failed when GitHub cannot tell, and lets nobody in', async () => {
    let { signIn, auth } = setup()
    auth.setRole(ORG, ALEX, 'error')

    let { callback } = await signIn(ALEX)

    assert.equal(callback.headers.get('Location'), '/login?notice=failed')
    assert.equal(auth.users.size, 0)
  })

  it('refuses a callback with a wrong state or a refused code', async () => {
    let { request, auth } = setup()
    auth.as(ALEX)
    let start = await request('/login/github')
    let pending = cookieOf(start, COOKIE)!
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!

    let wrongState = await request('/auth/github/callback?code=good&state=forged', { cookie: pending })
    assert.equal(wrongState.headers.get('Location'), '/login?notice=failed')

    let again = await request('/login/github')
    let badCode = await request(`/auth/github/callback?code=bad&state=${new URL(again.headers.get('Location')!).searchParams.get('state')}`, {
      cookie: cookieOf(again, COOKIE),
    })
    assert.equal(badCode.headers.get('Location'), '/login?notice=failed')
    assert.equal(auth.users.size, 0)
    assert.ok(state)
  })

  it('a sign-in from a signed-in session keeps nothing of the previous one', async () => {
    let { request, signIn, auth, csrfOf } = setup()
    let first = await signIn(ALEX)
    let oldToken = await csrfOf(first.cookie!)

    auth.as(CAMILLE)
    let start = await request('/login/github', { cookie: first.cookie })
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let pending = cookieOf(start, COOKIE) ?? first.cookie
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: pending })
    let cookie = cookieOf(callback, COOKIE)!

    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<a href="\/users\/camille" class="who-login">camille<\/a>/)
    assert.notEqual(await csrfOf(cookie), oldToken)
    // The cookie of the first session no longer opens anything.
    assert.equal((await request('/', { cookie: first.cookie })).status, 303)
  })

  it('gives a new session id at the sign-in', async () => {
    let { signIn } = setup()
    let { pending, cookie } = await signIn(ALEX)
    assert.notEqual(cookie, pending)
  })

  it('sets a hardened session cookie', async () => {
    let { auth, request } = setup()
    auth.as(ALEX)
    let start = await request('/login/github')
    let header = start.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? ''
    assert.match(header, /; Path=\//)
    assert.match(header, /; HttpOnly/)
    assert.match(header, /; Secure/)
    assert.match(header, /; SameSite=Lax/)
    assert.match(header, /; Max-Age=604800/)
    assert.doesNotMatch(header, /Domain=/)
  })

  it('sends a signed-in person from the sign-in page to the screens', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(ALEX)
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
    let { cookie } = await signIn(CAMILLE)
    auth.setRole(ORG, CAMILLE, 'admin')
    auth.clock.now += ROLE_TTL_MS + 1000

    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<span class="who-role">Admin<\/span>/)
  })

  it('keeps a role while GitHub fails, asks GitHub again on each request, and after an hour refuses without signing out', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(ALEX)
    auth.setRole(ORG, ALEX, 'error')
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
    assert.match(await down.text(), /GitHub ne répond pas\./)
    assert.equal(cookieOf(down, COOKIE), null, 'the session is not cleared')

    auth.setRole(ORG, ALEX, 'admin')
    assert.equal((await request('/', { cookie })).status, 200)
  })

  it('logs a role that GitHub has not confirmed for over an hour', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(ALEX)
    auth.setRole(ORG, ALEX, 'error')
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
    assert.ok(events.some((e) => e.event === 'auth.role_unconfirmed' && e.login === 'alex' && e.orgs === 1), lines.join(''))
  })

  it('moves the session to a remaining org when its org is gone, and keeps it there', async () => {
    let { request, signIn, auth } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    let { cookie } = await signIn(CAMILLE)
    assert.match(await (await request('/', { cookie })).text(), /<option value="org-2" selected>orchard<\/option>/)

    // Camille leaves orchard on GitHub: the screens move to sakuga-software, where she reads.
    auth.setRole(OTHER_ORG, CAMILLE, null)
    auth.clock.now += ROLE_TTL_MS + 1000
    let alone = await (await request('/', { cookie })).text()
    assert.match(alone, /<span class="org-name">sakuga-software<\/span>/)
    assert.match(alone, /Lecture seule/)

    // She comes back to orchard: the session stays on the org it moved to.
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    await auth.deps.store.saveMembership('user-2', 'org-2', 'admin')
    assert.match(await (await request('/', { cookie })).text(), /<option value="org-1" selected>sakuga-software<\/option>/)
  })

  it('ends the session seven days after the sign-in', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn(ALEX)
    auth.setRole(ORG, ALEX, 'admin')

    auth.clock.now += SESSION_TTL_MS
    let after = await request('/', { cookie })
    assert.equal(after.headers.get('Location'), '/login?notice=expired')
  })

  it('keeps the membership of an org where GitHub fails at the sign-in', async () => {
    let { signIn, auth } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    let { cookie } = await signIn(CAMILLE)
    assert.equal(auth.memberships.get('user-2/org-2')?.role, 'admin')

    // GitHub fails for orchard at the next sign-in, and answers for sakuga-software.
    auth.clock.now += 60_000
    auth.setRole(OTHER_ORG, CAMILLE, 'error')
    await signIn(CAMILLE)
    assert.equal(auth.memberships.get('user-2/org-2')?.role, 'admin', 'GitHub never said that camille left orchard')

    // A « not a member » from GitHub does forget it.
    auth.setRole(OTHER_ORG, CAMILLE, null)
    await signIn(CAMILLE)
    assert.equal(auth.memberships.get('user-2/org-2'), undefined)
    assert.ok(cookie)
  })

  it('switches the org on screen, only to an org of the person', async () => {
    let { request, signIn, auth, csrfOf } = setup({ orgs: [ORG, OTHER_ORG] })
    auth.setRole(OTHER_ORG, CAMILLE, 'admin')
    let { cookie } = await signIn(CAMILLE)

    // The admin org comes first.
    let html = await (await request('/', { cookie })).text()
    assert.match(html, /<option value="org-2" selected>orchard<\/option>/)
    assert.doesNotMatch(html, /Lecture seule/)

    let token = await csrfOf(cookie!)
    let switched = await request('/preferences/org', { cookie, form: { _csrf: token, orgId: 'org-1', returnTo: '/repos' } })
    assert.equal(switched.headers.get('Location'), '/repos')
    let member = await (await request('/repos', { cookie })).text()
    assert.match(member, /<option value="org-1" selected>sakuga-software<\/option>/)
    assert.match(member, /Lecture seule/)

    await request('/preferences/org', { cookie, form: { _csrf: token, orgId: 'org-9' } })
    assert.match(await (await request('/', { cookie })).text(), /<option value="org-1" selected>/)
  })
})

describe('the forms of the frame', () => {
  it('refuse a form without the CSRF token of the session', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(ALEX)

    let response = await request('/logout', { cookie, form: {} })
    assert.equal(response.status, 403)
    let forged = await request('/logout', { cookie, form: { _csrf: 'f'.repeat(64) } })
    assert.equal(forged.status, 403)
    assert.equal((await request('/', { cookie })).status, 200)
  })

  it('refuse a form that another site sent, even with the token', async () => {
    let { request, signIn, csrfOf } = setup()
    let { cookie } = await signIn(ALEX)
    let token = await csrfOf(cookie!)

    for (let headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }] as Record<string, string>[]) {
      let response = await request('/preferences/theme', { cookie, headers, form: { _csrf: token, theme: 'sumi' } })
      assert.equal(response.status, 403, JSON.stringify(headers))
      assert.equal(response.headers.get('Set-Cookie'), null)
    }
  })

  it('sign out: the session ends, and the screens need a new sign-in', async () => {
    let { request, signIn, csrfOf } = setup()
    let { cookie } = await signIn(ALEX)

    let response = await request('/logout', { cookie, form: { _csrf: await csrfOf(cookie!) } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/login?notice=signed_out')
    assert.equal((await request('/', { cookie })).status, 303)
  })

  it('the theme form sets a Secure cookie on an https service, and goes back to the page', async () => {
    let { request, signIn, csrfOf } = setup()
    let { cookie } = await signIn(ALEX)

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
    let { cookie } = await signIn(ALEX)
    let token = await csrfOf(cookie!)

    let response = await request('/preferences/theme', { cookie, form: { _csrf: token, theme: 'neon', returnTo: '//evil.example/x' } })
    assert.equal(response.headers.get('Location'), '/')
    assert.ok(!response.headers.getSetCookie().some((c) => c.startsWith('kento_theme=')))
  })
})

describe('the frame of a screen', () => {
  it('renders the navigation, the title, and the footer with the version', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(ALEX)
    let response = await request('/', { cookie })

    assert.equal(response.status, 200)
    let html = await response.text()
    assert.match(html, /<html lang="fr" data-theme="system">/)
    assert.match(html, /<title>Tableau de bord · Kentō<\/title>/)
    for (let label of ['Tableau de bord', 'Repos', 'Runners', 'Réglages']) {
      assert.ok(html.includes(`${label}</a>`), `the navigation has ${label}`)
    }
    assert.match(html, /Kentō 1\.2\.3 · par Sakuga/)
    assert.match(html, /\/assets\/kento\.css\?v=abc1234/)
  })

  it('marks the screen on display as the current page, in the sidebar and the tab bar', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/runners', { cookie })).text()

    let current = [...html.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((match) => match[1])
    assert.deepEqual(current, ['/runners', '/runners'])
  })

  it('sends the security headers, and no cache, on the screens and the sign-in page', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(ALEX)
    for (let response of [await request('/settings', { cookie }), await request('/login')]) {
      let csp = response.headers.get('Content-Security-Policy') ?? ''
      assert.match(csp, /script-src 'self'/)
      assert.match(csp, /frame-ancestors 'none'/)
      assert.doesNotMatch(csp, /unsafe-inline/)
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    }
  })

  it('renders the theme of the cookie, and checks it in the switch', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/', { cookie: `${cookie}; kento_theme=sumi` })).text()

    assert.match(html, /data-theme="sumi"/)
    assert.match(html, /<input type="radio" name="theme" value="sumi" checked/)
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

  it('serves nothing outside of /assets/', async () => {
    let { request } = setup()
    assert.equal((await request('/fonts/LICENSE-Archivo.txt')).status, 404)
  })
})
