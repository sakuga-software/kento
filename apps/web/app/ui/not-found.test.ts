import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { ROLE_GRACE_MS, ROLE_TTL_MS } from '../auth/access.ts'
import { SESSION_TTL_MS } from '../auth/better-auth.ts'
import { cookieOf, fakeAuth, OCTOCAT, ORG } from '../auth/test-helpers.ts'
import { spyStore, webhookDeps } from '../github/test-helpers.ts'
import type { RepoConfigStore } from '../repo-config/store.ts'
import { serviceProviders } from '../repo-config/providers.ts'
import { createAppRouter, type AppDependencies } from '../router.ts'
import type { RunnerApiDependencies } from '../runner/controller.ts'
import type { RunnerStore } from '../runner/store.ts'

const COOKIE = '__Host-kento_session'
const UNKNOWN = '00000000-0000-4000-8000-000000000009'
/** What a browser sends when it opens a page. */
const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

/** A runner API that knows no runner: every token is refused. */
const runner: RunnerApiDependencies = {
  store: { findRunner: async () => null } as unknown as RunnerStore,
  registrationToken: null,
  mintInstallationToken: null,
  providerApiKey: null,
}

/** A config store where no repository is in the installation. */
const noRepo: RepoConfigStore = {
  read: async () => null,
  save: async () => ({ kind: 'not_found' }),
}

function setup(overrides: Partial<AppDependencies> = {}) {
  let auth = fakeAuth()
  auth.setRole(ORG, OCTOCAT, 'admin')
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: webhookDeps(spyStore().apply),
    auth: auth.deps,
    runner,
    repoConfig: { store: noRepo, providers: { list: async () => serviceProviders } as never },
    ...overrides,
  })

  function request(path: string, init: { method?: string; cookie?: string | null; headers?: Record<string, string>; form?: Record<string, string>; body?: string } = {}) {
    let headers = new Headers(init.headers)
    if (init.cookie) headers.set('Cookie', init.cookie)
    return router.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: init.method ?? (init.form || init.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.form ? new URLSearchParams(init.form) : init.body,
      }),
    )
  }

  async function signIn() {
    auth.as(OCTOCAT)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookieOf(start, COOKIE) })
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request('/', { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf }
  }

  return { request, signIn, auth }
}

/** Status, type, body and the headers that a machine reads. */
async function shape(response: Response) {
  return {
    status: response.status,
    type: response.headers.get('Content-Type'),
    allow: response.headers.get('Allow'),
    auth: response.headers.get('WWW-Authenticate'),
    body: await response.text(),
  }
}

describe('REV-40: a 404 or a 400 of a screen', () => {
  it('shows an unknown page in the frame, in English, with a link to the dashboard, as a 404', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    let response = await request('/nope', { cookie, headers: BROWSER })
    assert.equal(response.status, 404)
    assert.match(response.headers.get('Content-Type') ?? '', /^text\/html/)
    let html = await response.text()
    assert.match(html, /<html lang="en"/)
    assert.match(html, /<h1 class="page-title">This page does not exist<\/h1>/)
    assert.match(html, /<a href="\/" class="button button-primary">Back to the dashboard<\/a>/)
    assert.match(html, /aria-label="Main navigation"/)
    assert.doesNotMatch(html, /aria-current="page"/)
  })

  it('shows an unknown page to a person who is not signed in, with the sign-in as the way out', async () => {
    let { request } = setup()
    let response = await request('/nope', { headers: BROWSER })
    assert.equal(response.status, 404)
    let html = await response.text()
    assert.match(html, /<h1>This page does not exist<\/h1>/)
    assert.match(html, /href="\/login"/)
  })

  it('shows the 404 of a person not signed in when the session has expired, and leaves the session alone', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn()
    auth.clock.now += SESSION_TTL_MS + 1000
    let response = await request('/nope', { cookie, headers: BROWSER })
    assert.equal(response.status, 404)
    let html = await response.text()
    assert.match(html, /<h1>This page does not exist<\/h1>/)
    assert.doesNotMatch(html, /octocat/)
    assert.equal(cookieOf(response, COOKIE), null, 'an unknown URL does not touch the session')
  })

  it('never signs out a person who left the org on an unknown URL: the screens do', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn()
    auth.setRole(ORG, OCTOCAT, null)
    auth.clock.now += ROLE_TTL_MS + 1000
    let response = await request('/nope', { cookie, headers: BROWSER })
    assert.equal(response.status, 404)
    assert.match(await response.text(), /<h1>This page does not exist<\/h1>/)
    assert.equal(cookieOf(response, COOKIE), null, 'an unknown URL does not touch the session')
    let screen = await request('/', { cookie, headers: BROWSER })
    assert.equal(screen.status, 303)
    assert.match(screen.headers.get('Location') ?? '', /notice=expired/)
  })

  it('answers the 503 of the screens when GitHub has not confirmed the role for over an hour, and keeps the session', async () => {
    let { request, signIn, auth } = setup()
    let { cookie } = await signIn()
    auth.setRole(ORG, OCTOCAT, 'error')
    auth.clock.now += ROLE_GRACE_MS + 1000
    let response = await request('/nope', { cookie, headers: BROWSER })
    assert.equal(response.status, 503)
    assert.match(await response.text(), /GitHub does not answer\./)
    assert.equal(cookieOf(response, COOKIE), null, 'the session is not cleared')
  })

  it('says that a repository left the installation, with a link to Repos', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    for (let path of [`/repos/${UNKNOWN}/config`, '/repos/not-a-uuid/config']) {
      let response = await request(path, { cookie, headers: BROWSER })
      assert.equal(response.status, 404, path)
      let html = await response.text()
      assert.match(html, /This repo is no longer in the installation/, path)
      assert.match(html, /<a href="\/repos" class="button button-primary">See the repos<\/a>/, path)
      assert.match(html, /<a href="\/repos" aria-current="page" class="bar-link">/, path)
    }
  })

  it('answers a form it cannot read with a 400 in the frame, and a link back', async () => {
    let { request, signIn } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request(`/repos/${UNKNOWN}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'enabled' } })
    assert.equal(response.status, 400)
    let html = await response.text()
    assert.match(html, /Kentō could not read this form/)
    assert.match(html, new RegExp(`href="/repos/${UNKNOWN}/config" class="button button-primary">Back to the config of the repo</a>`))
  })
})

describe('REV-40: the routes of machines keep their answers', () => {
  // The answers of main before REV-40, byte for byte. A browser Accept and a session change nothing.
  it('keeps the answers of the webhook', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    for (let headers of [{}, BROWSER]) {
      assert.deepEqual(await shape(await request('/webhooks/github', { cookie, headers, body: '{}' })), {
        status: 400,
        type: 'text/plain; charset=utf-8',
        allow: null,
        auth: null,
        body: 'missing or invalid X-GitHub-Event or X-GitHub-Delivery',
      })
      assert.deepEqual(await shape(await request('/webhooks/github', { cookie, headers })), {
        status: 405,
        type: 'text/plain;charset=UTF-8',
        allow: 'POST',
        auth: null,
        body: 'Method Not Allowed: GET',
      })
      assert.deepEqual(await shape(await request('/webhooks/nope', { cookie, headers })), {
        status: 404,
        type: 'text/plain;charset=UTF-8',
        allow: null,
        auth: null,
        body: 'Not Found: /webhooks/nope',
      })
    }
  })

  it('keeps the answers of the runner API, with it and without it', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    let without = setup({ runner: undefined })
    for (let headers of [{}, BROWSER]) {
      assert.deepEqual(await shape(await request('/api/runner/jobs/claim', { cookie, headers, body: '{}' })), {
        status: 401,
        type: 'application/json',
        allow: null,
        auth: 'Bearer',
        body: '{"error":"unauthorized"}',
      })
      assert.deepEqual(await shape(await request('/api/runner/jobs/claim', { cookie, headers })), {
        status: 405,
        type: 'text/plain;charset=UTF-8',
        allow: 'POST',
        auth: null,
        body: 'Method Not Allowed: GET',
      })
      for (let method of ['GET', 'POST']) {
        assert.deepEqual(await shape(await request('/api/runner/nope', { cookie, headers, method })), {
          status: 404,
          type: 'text/plain;charset=UTF-8',
          allow: null,
          auth: null,
          body: 'Not Found: /api/runner/nope',
        })
      }
      assert.deepEqual(await shape(await without.request('/api/runner/jobs/claim', { headers, body: '{}' })), {
        status: 404,
        type: 'text/plain;charset=UTF-8',
        allow: null,
        auth: null,
        body: 'Not Found: /api/runner/jobs/claim',
      })
    }
  })

  it('keeps the 405 of a page with another method', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    assert.deepEqual(await shape(await request('/repos', { cookie, headers: BROWSER, method: 'DELETE' })), {
      status: 405,
      type: 'text/plain;charset=UTF-8',
      allow: 'GET, HEAD',
      auth: null,
      body: 'Method Not Allowed: DELETE',
    })
  })

  it('keeps the plain 404 for a request that is not a page of a browser', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    // curl, a POST to an unknown path, a missing asset.
    for (let [path, method, headers] of [
      ['/nope', 'GET', {}],
      ['/nope', 'POST', BROWSER],
      ['/assets/nope.css', 'GET', BROWSER],
      ['/healthz/nope', 'GET', BROWSER],
    ] as const) {
      assert.deepEqual(await shape(await request(path, { cookie, headers, method })), {
        status: 404,
        type: 'text/plain;charset=UTF-8',
        allow: null,
        auth: null,
        body: `Not Found: ${path}`,
      })
    }
  })
})
