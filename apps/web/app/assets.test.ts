// KNT-163. What the browser can download from the asset server, and the policy that lets the page
// run it: modules from 'self', and one inline script, the import map, with the nonce of the request.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { assets, BOOT, RUNTIME } from './assets.ts'
import { fakeAuth } from './auth/test-helpers.ts'
import { spyStore, webhookDeps } from './github/test-helpers.ts'
import { createAppRouter } from './router.ts'

const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

function router() {
  return createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: webhookDeps(spyStore().apply),
    auth: fakeAuth().deps,
  })
}

async function fetch(path: string) {
  return router().fetch(new Request(`https://review.sakuga.dev${path}`, { headers: BROWSER }))
}

describe('the browser modules (KNT-163)', () => {
  it('serves the modules of app/**/public, the controls, the icons, the routes and the packages of the runtime', async () => {
    for (let file of [BOOT, RUNTIME, 'app/ui/public/row-menu.tsx', 'app/ui/public/confirm.tsx', 'app/ui/controls.tsx', 'app/ui/lucide.tsx', 'app/routes.ts']) {
      let details = await assets.getAssetDetails(file)
      assert.equal(details.status, 'reachable', file)
    }
    let response = await fetch('/assets/app/ui/public/boot.ts')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type') ?? '', /javascript/)
  })

  it('never serves another file of the server: its code, its secrets, its tests', async () => {
    for (let file of ['app/config.ts', 'app/auth/github.ts', 'app/ui/repos.tsx', 'app/ui/public/row-menu.test.ts', 'server.ts', 'package.json']) {
      let details = await assets.getAssetDetails(file)
      assert.notEqual(details.status, 'reachable', file)
    }
    for (let path of ['/assets/app/config.ts', '/assets/app/auth/github.ts', '/assets/server.ts', '/assets/npm/postgres/package.json']) {
      let response = await fetch(path)
      assert.equal(response.status, 404, path)
    }
  })

  it('loads boot.ts on every page, and the import map only on a page that has a component to hydrate', async () => {
    let login = await (await fetch('/login')).text()
    assert.match(login, /<script type="module" src="\/assets\/app\/ui\/public\/boot\.ts" data-runtime="\/assets\/app\/ui\/public\/runtime\.ts"><\/script>/)
    // The sign-in page hydrates nothing: no import map, no data, no runtime.
    assert.doesNotMatch(login, /importmap|rmx-data|rmx:h/)
  })
})

describe('the content security policy of the screens (KNT-163)', () => {
  it('allows the scripts of the app and one inline script with the nonce of the response, a new one each time', async () => {
    let first = await fetch('/login')
    let second = await fetch('/login')
    let policy = (response: Response) => response.headers.get('Content-Security-Policy') ?? ''
    let nonce = (response: Response) => policy(response).match(/script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/)?.[1]
    assert.ok(nonce(first), policy(first))
    assert.ok(nonce(second))
    assert.notEqual(nonce(first), nonce(second))
    // 128 bits, in base64.
    assert.equal(Buffer.from(nonce(first)!, 'base64').length, 16)
    for (let response of [first, second]) {
      assert.match(policy(response), /style-src 'self'(;|$)/)
      assert.doesNotMatch(policy(response), /unsafe-inline|unsafe-eval|strict-dynamic/)
      // A nonce must never be served from a shared cache.
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    }
  })

  it('also sends the policy on a redirect of the screens', async () => {
    let response = await fetch('/')
    assert.equal(response.status, 303)
    assert.match(response.headers.get('Content-Security-Policy') ?? '', /script-src 'self' 'nonce-/)
  })
})
