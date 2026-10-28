import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { pageRoutes } from '../routes.ts'
import { localPath } from './pages.tsx'
import { readTheme } from './theme.ts'

function router() {
  return createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: 'abc1234',
    webhook: disabledWebhook,
  })
}

function get(href: string, headers: HeadersInit = {}) {
  return router().fetch(new Request(new URL(href, 'http://localhost'), { headers }))
}

describe('the frame of a screen', () => {
  it('renders the navigation, the title, and the footer with the version', async () => {
    let response = await get(pageRoutes.home.href())

    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type') ?? '', /text\/html/)
    let html = await response.text()
    assert.match(html, /<html lang="fr" data-theme="system">/)
    assert.match(html, /<title>Tableau de bord · Kentō<\/title>/)
    assert.match(html, /<h1 class="page-title">Tableau de bord<\/h1>/)
    for (let label of ['Tableau de bord', 'Repos', 'Findings', 'Runners', 'Réglages']) {
      assert.ok(html.includes(`${label}</a>`), `the navigation has ${label}`)
    }
    assert.match(html, /Kentō 1\.2\.3 · par Sakuga/)
    // The assets carry the commit, so that a new release is not read from a stale cache.
    assert.match(html, /\/assets\/kento\.css\?v=abc1234/)
  })

  it('marks the screen on display as the current page, in the sidebar and the tab bar', async () => {
    let html = await (await get(pageRoutes.runners.href())).text()

    let current = [...html.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((match) => match[1])
    assert.deepEqual(current, ['/runners', '/runners'])
  })

  it('sends the security headers, and no cache', async () => {
    let response = await get(pageRoutes.settings.href())

    let csp = response.headers.get('Content-Security-Policy') ?? ''
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.doesNotMatch(csp, /unsafe-inline/)
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  })

  it('renders the theme of the cookie, and checks it in the switch', async () => {
    let html = await (await get(pageRoutes.home.href(), { Cookie: 'other=1; kento_theme=sumi' })).text()

    assert.match(html, /data-theme="sumi"/)
    assert.match(html, /<input type="radio" name="theme" value="sumi" checked/)
    assert.doesNotMatch(html, /value="paper" checked/)
  })
})

describe('POST /preferences/theme', () => {
  function post(body: Record<string, string>, headers: HeadersInit = {}) {
    return router().fetch(
      new Request('http://localhost/preferences/theme', { method: 'POST', body: new URLSearchParams(body), headers }),
    )
  }

  it('sets the cookie of the theme and goes back to the page', async () => {
    let response = await post({ theme: 'paper', returnTo: '/repos' })

    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/repos')
    assert.equal(response.headers.get('Set-Cookie'), 'kento_theme=paper; Path=/; Max-Age=31536000; SameSite=Lax')
  })

  it('ignores a theme it does not know', async () => {
    let response = await post({ theme: 'neon', returnTo: '/' })

    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Set-Cookie'), null)
  })

  it('refuses a form that another site sent, and sets no cookie', async () => {
    let attempts: Record<string, string>[] = [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }]
    for (let headers of attempts) {
      let response = await post({ theme: 'sumi', returnTo: '/' }, headers)
      assert.equal(response.status, 403, JSON.stringify(headers))
      assert.equal(response.headers.get('Set-Cookie'), null)
    }
    let sameSite = await post({ theme: 'sumi', returnTo: '/' }, { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost' })
    assert.equal(sameSite.status, 303)
  })

  it('sets a Secure cookie behind the TLS proxy, as theme.js does over HTTPS', async () => {
    let response = await post({ theme: 'sumi', returnTo: '/' }, { 'X-Forwarded-Proto': 'https' })
    assert.match(response.headers.get('Set-Cookie') ?? '', /; Secure$/)
  })

  it('never goes back to another site', async () => {
    let response = await post({ theme: 'sumi', returnTo: '//evil.example/x' })

    assert.equal(response.headers.get('Location'), '/')
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
  it('serves the stylesheet, the script and the fonts', async () => {
    for (let path of [
      '/assets/kento.css',
      '/assets/theme.js',
      '/assets/favicon.svg',
      '/assets/fonts/archivo-latin-wght-normal.woff2',
    ]) {
      let response = await get(path)
      assert.equal(response.status, 200, path)
    }
  })

  it('serves nothing outside of /assets/', async () => {
    let response = await get('/fonts/LICENSE-Archivo.txt')
    assert.equal(response.status, 404)
  })
})
