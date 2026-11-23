// KNT-202. The stylesheet and the scripts of public/assets/ go out as the copy that the browser
// accepts (brotli, gzip, or the plain file), made by the build; the HTML pages are compressed on each
// request; a range and the fonts are answered as before. The stream of the live card stays plain:
// app/ui/dashboard-live.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { compressPublicFiles } from '../scripts/build-client.ts'
import { fakeAuth } from './auth/test-helpers.ts'
import { PUBLIC_DIR, readClientBuild, type ClientBuild } from './client-build.ts'
import { disabledWebhook } from './github/test-helpers.ts'
import { createAppRouter } from './router.ts'

const CSS = readFileSync(path.join(PUBLIC_DIR, 'assets/kento.css'))
const FONT = 'assets/fonts/archivo-latin-wght-normal.woff2'
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

let dir = ''
let build: ClientBuild

before(() => {
  // The build of the copies of the real public/, as scripts/build-client.ts writes it, without the bundles.
  dir = mkdtempSync(path.join(tmpdir(), 'kento-public-'))
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ entries: {}, files: [], public: compressPublicFiles(dir) }))
  build = readClientBuild(dir) as ClientBuild
})

after(() => rmSync(dir, { recursive: true, force: true }))

function router(clientBuild: ClientBuild | null = build) {
  return createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: fakeAuth().deps,
    clientBuild,
  })
}

function get(path: string, headers: Record<string, string> = {}, clientBuild?: ClientBuild | null) {
  return router(clientBuild).fetch(new Request(`http://localhost${path}`, { headers }))
}

/** The body of an answer, decoded as its Content-Encoding says. */
async function decoded(response: Response): Promise<Buffer> {
  let body = Buffer.from(await response.arrayBuffer())
  let encoding = response.headers.get('Content-Encoding')
  if (encoding === 'br') return brotliDecompressSync(body)
  if (encoding === 'gzip') return gunzipSync(body)
  assert.equal(encoding, null)
  return body
}

/** The names of the `Vary` header, in lower case. */
function varyOf(response: Response): string[] {
  return (response.headers.get('Vary') ?? '').split(',').map((name) => name.trim().toLowerCase())
}

describe('the compressed copies of public/assets/ (KNT-202)', () => {
  it('serves the brotli copy of kento.css to a browser that accepts brotli, and gzip to one that accepts gzip only', async () => {
    let cases: [string, string, number][] = [
      ['gzip, deflate, br, zstd', 'br', 30_000],
      ['br;q=1, gzip;q=0.5', 'br', 30_000],
      ['gzip, deflate', 'gzip', 32_000],
      ['br;q=0.1, gzip', 'gzip', 32_000],
    ]
    for (let [accept, encoding, under] of cases) {
      let response = await get('/assets/kento.css?v=1.2.3', { 'Accept-Encoding': accept })
      assert.equal(response.status, 200, accept)
      assert.equal(response.headers.get('Content-Encoding'), encoding, accept)
      assert.equal(response.headers.get('Content-Type'), 'text/css; charset=utf-8')
      assert.ok(varyOf(response).includes('accept-encoding'), accept)
      assert.equal(response.headers.get('Cache-Control'), 'no-cache')
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
      assert.equal(response.headers.get('Accept-Ranges'), null)
      let length = Number(response.headers.get('Content-Length'))
      assert.ok(length > 0 && length < under, `${accept}: ${length} B`)
      let body = await decoded(response)
      assert.deepEqual(body, CSS, accept)
    }
  })

  it('serves the plain file, with Vary, to a browser that accepts neither', async () => {
    for (let headers of [{}, { 'Accept-Encoding': 'identity' }, { 'Accept-Encoding': 'br;q=0, gzip;q=0' }, { 'Accept-Encoding': 'deflate' }] as Record<string, string>[]) {
      let response = await get('/assets/kento.css', headers)
      assert.equal(response.status, 200, JSON.stringify(headers))
      assert.equal(response.headers.get('Content-Encoding'), null)
      assert.equal(response.headers.get('Content-Length'), String(CSS.byteLength))
      assert.ok(varyOf(response).includes('accept-encoding'), JSON.stringify(headers))
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), CSS)
    }
    // The path that staticFiles() serves, with repeated slashes: the same copy.
    let slashes = await get('//assets/kento.css', { 'Accept-Encoding': 'br' })
    assert.equal(slashes.headers.get('Content-Encoding'), 'br')
    assert.deepEqual(await decoded(slashes), CSS)
    // The scripts of the screens too.
    let script = await get('/assets/settings.js', { 'Accept-Encoding': 'br' })
    assert.equal(script.headers.get('Content-Encoding'), 'br')
    assert.match(script.headers.get('Content-Type') ?? '', /^text\/javascript/)
    assert.deepEqual(await decoded(script), readFileSync(path.join(PUBLIC_DIR, 'assets/settings.js')))
  })

  it('gives each copy its own ETag, and answers 304 only for the copy that the browser holds', async () => {
    let tags = new Map<string, string>()
    for (let accept of ['br', 'gzip', 'identity']) {
      let response = await get('/assets/kento.css', { 'Accept-Encoding': accept })
      tags.set(accept, response.headers.get('ETag')!)
      assert.ok(tags.get(accept), accept)
    }
    assert.equal(new Set(tags.values()).size, 3, [...tags.values()].join(' '))

    let again = await get('/assets/kento.css', { 'Accept-Encoding': 'br', 'If-None-Match': tags.get('br')! })
    assert.equal(again.status, 304)
    assert.equal(again.headers.get('ETag'), tags.get('br'))
    assert.ok(varyOf(again).includes('accept-encoding'))
    assert.equal(await again.text(), '')
    // The browser holds the brotli copy and now accepts gzip only: the gzip copy, whole.
    let other = await get('/assets/kento.css', { 'Accept-Encoding': 'gzip', 'If-None-Match': tags.get('br')! })
    assert.equal(other.status, 200)
    assert.equal(other.headers.get('Content-Encoding'), 'gzip')
    // And the plain file keeps its own conditional request.
    let plain = await get('/assets/kento.css', { 'If-None-Match': tags.get('identity')! })
    assert.equal(plain.status, 304)
  })

  it('answers a HEAD with the headers of the copy and no body', async () => {
    let response = await router().fetch(new Request('http://localhost/assets/kento.css', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Encoding'), 'br')
    assert.equal(response.headers.get('Content-Length'), String(readFileSync(path.join(dir, 'public/assets/kento.css.br')).byteLength))
    assert.equal(await response.text(), '')
  })

  it('answers a range as before: kento.css whole and plain, a font in part', async () => {
    let css = await get('/assets/kento.css', { 'Accept-Encoding': 'br', Range: 'bytes=0-99' })
    assert.equal(css.status, 200)
    assert.equal(css.headers.get('Content-Encoding'), null)
    assert.deepEqual(Buffer.from(await css.arrayBuffer()), CSS)

    let font = await get(`/${FONT}`, { 'Accept-Encoding': 'br', Range: 'bytes=0-99' })
    assert.equal(font.status, 206)
    assert.equal(font.headers.get('Content-Encoding'), null)
    assert.equal(font.headers.get('Accept-Ranges'), 'bytes')
    assert.match(font.headers.get('Content-Range') ?? '', /^bytes 0-99\/\d+$/)
    assert.equal((await font.arrayBuffer()).byteLength, 100)
    // A font and a small icon have no copy: as before, with no Vary.
    for (let file of [FONT, 'assets/favicon.svg']) {
      let whole = await get(`/${file}`, { 'Accept-Encoding': 'br' })
      assert.equal(whole.status, 200, file)
      assert.equal(whole.headers.get('Content-Encoding'), null, file)
      assert.deepEqual(Buffer.from(await whole.arrayBuffer()), readFileSync(path.join(PUBLIC_DIR, file)), file)
    }
    assert.ok(!build.publicFiles.has(FONT) && !build.publicFiles.has('assets/favicon.svg'))
  })

  it('serves the plain file of a file changed since the build, and every file plain without a build', async () => {
    let stale: ClientBuild = { ...build, publicFiles: new Set([...build.publicFiles].filter((file) => file !== 'assets/kento.css')), stale: ['assets/kento.css'] }
    for (let clientBuild of [stale, null]) {
      let response = await get('/assets/kento.css', { 'Accept-Encoding': 'br' }, clientBuild)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('Content-Encoding'), null)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), CSS)
    }
  })
})

describe('the compression of the HTML pages (KNT-202)', () => {
  it('compresses a page with brotli or gzip, as the browser accepts, and says Vary', async () => {
    for (let [accept, encoding] of [['gzip, deflate, br, zstd', 'br'], ['gzip, deflate', 'gzip']]) {
      let response = await get('/docs/commands', { Accept: BROWSER, 'Accept-Encoding': accept! })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('Content-Type') ?? '', /^text\/html/)
      assert.equal(response.headers.get('Content-Encoding'), encoding, accept)
      assert.ok(varyOf(response).includes('accept-encoding'), accept)
      let body = Buffer.from(await response.arrayBuffer())
      let html = (encoding === 'br' ? brotliDecompressSync(body) : gunzipSync(body)).toString('utf8')
      assert.match(html, /^<!DOCTYPE html>/i)
      assert.match(html, /<\/html>/)
      assert.ok(body.byteLength * 2 < Buffer.byteLength(html), `${encoding}: ${body.byteLength} B for ${Buffer.byteLength(html)} B`)
    }
    // The page of a 404 too.
    let missing = await get('/no-such-page', { Accept: BROWSER, 'Accept-Encoding': 'br' })
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('Content-Encoding'), 'br')
  })

  it('sends a page plain, with Vary, to a client that accepts no compression', async () => {
    let response = await get('/docs/commands', { Accept: BROWSER })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Encoding'), null)
    assert.ok(varyOf(response).includes('accept-encoding'))
    assert.match(await response.text(), /^<!DOCTYPE html>/i)
  })

  it('leaves the JSON of the machines as it was', async () => {
    let response = await get('/healthz', { 'Accept-Encoding': 'br' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Encoding'), null)
    assert.ok(!varyOf(response).includes('accept-encoding'))
  })
})
