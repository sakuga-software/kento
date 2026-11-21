// KNT-163. What the browser can download from the asset server, and the policy that lets the page
// run it: modules from 'self', and one inline script, the import map, with the nonce of the request.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { assets, BOOT, resolveBootScript, RUNTIME } from './assets.ts'
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
    // As every file of the app (Fable critique P3-1).
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  })

  it('never serves another file of the server: its code, its secrets, its tests', async () => {
    // A test in a public/ folder is a file that exists (`denyFiles`); postgres is a package of the
    // server, not of the browser (`allowPackages`, and no mount of node_modules).
    assert.ok(existsSync(new URL('./ui/public/row-menu.test.ts', import.meta.url)))
    let postgres = createRequire(import.meta.url).resolve('postgres')
    for (let file of ['app/config.ts', 'app/auth/github.ts', 'app/ui/repos.tsx', 'app/ui/public/row-menu.test.ts', 'server.ts', 'package.json', postgres]) {
      let details = await assets.getAssetDetails(file)
      assert.notEqual(details.status, 'reachable', file)
    }
    assert.equal((await assets.getAssetDetails('app/ui/public/row-menu.test.ts')).status, 'denied')
    assert.equal((await fetch('/assets/app/ui/public/row-menu.test.ts')).status, 404)
    assert.equal((await fetch('/assets/npm/remix/dist/index.js')).status, 404)
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

  it('loads boot.ts on the 404 page too, even as the first request of a new server (Kentō #6783ea)', async () => {
    let response = await fetch('/no-such-screen')
    assert.equal(response.status, 404)
    assert.match(await response.text(), /<script type="module" src="\/assets\/app\/ui\/public\/boot\.ts" data-runtime="[^"]+"><\/script>/)
  })
})

describe('the URLs of boot.ts (KNT-163)', () => {
  it('are null, with an error in the log, when the asset server cannot read them: the service still starts (Kentō #5d5d55)', async () => {
    let lines: string[] = []
    let write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write
    try {
      let boot = await resolveBootScript({
        getHref: async () => {
          throw new Error('File not found: app/ui/public/boot.ts')
        },
      })
      assert.equal(boot, null)
    } finally {
      process.stderr.write = write
    }
    assert.equal(lines.length, 1)
    let line = JSON.parse(lines[0]!) as { level: string; event: string; error: string }
    assert.equal(line.level, 'error')
    assert.equal(line.event, 'startup.assets_unavailable')
    assert.match(line.error, /boot\.ts/)
    assert.deepEqual(await resolveBootScript(assets), { href: '/assets/app/ui/public/boot.ts', runtime: '/assets/app/ui/public/runtime.ts' })
  })
})

/** The policy of every screen, word for word; `{nonce}` stands for the nonce of the response. */
const EXPECTED_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'nonce-{nonce}'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

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
      // The whole policy, word for word: a source more (`https:`, `data:`, `blob:`) or a directive less
      // (`base-uri 'none'`, `object-src 'none'`) fails here (Fable critique P2-1).
      assert.equal(policy(response), EXPECTED_POLICY.replace('{nonce}', nonce(response)!))
      // A nonce must never be served from a shared cache.
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    }
  })

  it('also sends the policy on a redirect of the screens', async () => {
    let response = await fetch('/')
    assert.equal(response.status, 303)
    let policy = response.headers.get('Content-Security-Policy') ?? ''
    let nonce = policy.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1]
    assert.ok(nonce, policy)
    assert.equal(policy, EXPECTED_POLICY.replace('{nonce}', nonce))
  })
})
