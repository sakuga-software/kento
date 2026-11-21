// KNT-163. What the browser can download from the asset server, and the policy that lets the page
// run it: modules from 'self', and one inline script, the import map, with the nonce of the request.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAssetServer } from 'remix/assets'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { assetError, assets, BOOT, chartsAvailable, resolveBootScript, resolveCharts, RUNTIME } from './assets.ts'
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

/** Runs `body` with the lines that the service writes on stderr (warn, error), and returns them. */
async function stderrOf(body: () => Promise<void>): Promise<{ level: string; event: string; code: string | null }[]> {
  let lines: string[] = []
  let write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write
  try {
    await body()
  } finally {
    process.stderr.write = write
  }
  return lines.map((line) => JSON.parse(line) as { level: string; event: string; code: string | null })
}

describe('a module that the asset server cannot serve (Fable re-check N-1)', () => {
  it('answers 500 with an error in the log when an allowed module does not compile, and 404 with a warning for a path that nobody may read', async () => {
    let root = mkdtempSync(path.join(tmpdir(), 'kento-assets-'))
    try {
      mkdirSync(path.join(root, 'app', 'public'), { recursive: true })
      writeFileSync(path.join(root, 'app', 'public', 'broken.ts'), 'export let x = {\n')
      writeFileSync(path.join(root, 'app', 'public', 'outside.ts'), "import { y } from '../../server.ts'\nexport let x = y\n")
      writeFileSync(path.join(root, 'server.ts'), 'export let y = 1\n')
      writeFileSync(path.join(root, 'app', 'secret.ts'), 'export let z = 1\n')
      let server = createAssetServer({ basePath: '/assets', rootDir: root, mounts: { app: 'app' }, allowFiles: ['app/**/public/**'], watch: false, onError: assetError })
      try {
        let responses: Record<string, number> = {}
        let lines = await stderrOf(async () => {
          for (let file of ['public/broken.ts', 'public/outside.ts', 'secret.ts', 'public/missing.ts']) {
            let response = await server.fetch(new Request(`https://review.sakuga.dev/assets/app/${file}`))
            responses[file] = response?.status ?? 404
          }
        })
        assert.deepEqual(responses, { 'public/broken.ts': 500, 'public/outside.ts': 500, 'secret.ts': 404, 'public/missing.ts': 404 })
        assert.deepEqual(
          lines.map((line) => `${line.level} ${line.event}`),
          ['error assets.compile_failed', 'error assets.compile_failed', ...lines.slice(2).map(() => 'warn assets.not_served')],
        )
      } finally {
        await server.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

/** The URL of a file of the pnpm store, as the asset server serves it (no hash outside production). */
function storeUrl(file: string): string {
  let real = realpathSync(file)
  let inStore = real.slice(real.indexOf('/.pnpm/') + '/.pnpm/'.length)
  return `/assets/__@remix/virtual-store/${inStore.split('/').map(encodeURIComponent).join('/')}`
}

/** The ES module of chart.js, and its package folder. */
const CHART_ENTRY = fileURLToPath(import.meta.resolve('chart.js'))
const CHART_DIR = path.dirname(path.dirname(CHART_ENTRY))

describe('the charts of the Costs screen and the asset server (KNT-188)', () => {
  it('answers 404 and logs a warning for a file of chart.js that is no browser module (Fable P2-1)', async () => {
    let statuses: Record<string, number> = {}
    let lines = await stderrOf(async () => {
      for (let file of ['dist/chart.umd.min.js', 'dist/chart.umd.js', 'dist/types.d.ts', 'dist/chart.cjs']) {
        let response = await fetch(storeUrl(path.join(CHART_DIR, file)))
        statuses[file] = response.status
      }
      // Repeated slashes reach the same files (Fable re-check).
      let umd = storeUrl(path.join(CHART_DIR, 'dist/chart.umd.min.js'))
      let types = storeUrl(path.join(CHART_DIR, 'dist/types.d.ts'))
      for (let url of [
        umd.replace('/assets/', '/assets//'),
        umd.replace('/assets/', '/assets///'),
        umd.replace('__@remix/virtual-store', '__@remix//virtual-store'),
        types.replace('/assets/', '/assets//'),
      ]) {
        statuses[url] = (await fetch(url)).status
      }
    })
    assert.deepEqual(
      Object.values(statuses).filter((status) => status !== 404),
      [],
      JSON.stringify(statuses),
    )
    assert.equal(Object.keys(statuses).length, 8)
    assert.deepEqual(
      lines.filter((line) => line.level === 'error'),
      [],
      'a file that no page imports is not a broken release',
    )
  })

  it('pins what chart.js opens to the browser: one dependency, its modules, nothing else of the store (Fable P2-3)', async () => {
    // `allowPackages` also allows the dependencies of a package, at any depth: a bump that adds one
    // widens the boundary, and fails here.
    let manifest = JSON.parse(readFileSync(path.join(CHART_DIR, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@kurkle/color'])
    assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), [])
    // Its ES module, beside the CommonJS entry that `require` finds.
    let color = path.join(path.dirname(createRequire(CHART_ENTRY).resolve('@kurkle/color')), 'color.esm.js')
    let expected: [string, number][] = [
      [storeUrl(CHART_ENTRY), 200],
      [storeUrl(color), 200],
      [storeUrl(path.join(CHART_DIR, 'package.json')), 404],
      // Another package of the store, of the server.
      [storeUrl(createRequire(import.meta.url).resolve('postgres')), 404],
      [`${path.posix.dirname(storeUrl(CHART_ENTRY))}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/package.json`, 404],
    ]
    await stderrOf(async () => {
      for (let [url, status] of expected) assert.equal((await fetch(url)).status, status, url)
    })
  })

  it('says at startup when the asset server cannot serve the charts, and the screen then renders its tables only (Fable P2-2)', async () => {
    // The allow list of main before KNT-188: chart.js is not in it.
    let root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
    let without = createAssetServer({ basePath: '/assets', rootDir: root, mounts: { app: 'app' }, allowFiles: ['app/**/public/**', 'app/routes.ts'], allowPackages: ['remix', '@remix-run/ui'], watch: false, onError: assetError })
    let withCharts = createAssetServer({ basePath: '/assets', rootDir: root, mounts: { app: 'app' }, allowFiles: ['app/**/public/**', 'app/routes.ts'], allowPackages: ['remix', '@remix-run/ui', 'chart.js'], watch: false, onError: assetError })
    try {
      let answers: boolean[] = []
      let lines = await stderrOf(async () => {
        answers.push(await resolveCharts(without))
        answers.push(await resolveCharts(withCharts))
      })
      assert.deepEqual(answers, [false, true])
      assert.deepEqual(
        lines.map((line) => `${line.level} ${line.event}`),
        ['error startup.assets_unavailable'],
      )
    } finally {
      await without.close()
      await withCharts.close()
    }
    assert.equal(chartsAvailable(), true, 'the asset server of the service serves them')
  })
})
