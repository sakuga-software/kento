// KNT-202. compressed() compresses the HTML pages, the files of public/assets/ and the browser
// modules on each request, as the browser accepts. A font, a byte range of it and the JSON of the
// machines go out as before. The stream of the live card stays plain: app/ui/dashboard-live.test.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { bootScript } from './assets.ts'
import { fakeAuth } from './auth/test-helpers.ts'
import { disabledWebhook } from './github/test-helpers.ts'
import { createAppRouter } from './router.ts'

const PUBLIC = (file: string) => readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url)))
const CSS = PUBLIC('assets/kento.css')
const FONT = 'assets/fonts/archivo-latin-wght-normal.woff2'
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

function router() {
  return createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: fakeAuth().deps,
  })
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return router().fetch(new Request(`http://localhost${path}`, { headers, method }))
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

describe('the compression of the files of public/assets/ (KNT-202)', () => {
  it('sends kento.css with brotli to a browser that accepts brotli, and with gzip to one that accepts gzip only', async () => {
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
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
      assert.equal(response.headers.get('Content-Length'), null)
      let body = Buffer.from(await response.arrayBuffer())
      assert.ok(body.byteLength < under, `${accept}: ${body.byteLength} B`)
      assert.deepEqual(encoding === 'br' ? brotliDecompressSync(body) : gunzipSync(body), CSS, accept)
    }
  })

  it('sends the plain file, with Vary, to a browser that accepts neither', async () => {
    // `deflate` and `zstd` alone: compression() of remix 3.2.0 answers them 406, compressed() does not.
    for (let headers of [{}, { 'Accept-Encoding': 'identity' }, { 'Accept-Encoding': 'deflate' }, { 'Accept-Encoding': 'zstd' }] as Record<string, string>[]) {
      let response = await get('/assets/kento.css', headers)
      assert.equal(response.status, 200, JSON.stringify(headers))
      assert.equal(response.headers.get('Content-Encoding'), null)
      assert.equal(response.headers.get('Content-Length'), String(CSS.byteLength))
      assert.ok(varyOf(response).includes('accept-encoding'), JSON.stringify(headers))
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), CSS)
    }
  })

  it('compresses the scripts of the screens, and leaves a script under 1 KB plain', async () => {
    let script = await get('/assets/settings.js', { 'Accept-Encoding': 'br' })
    assert.equal(script.headers.get('Content-Encoding'), 'br')
    assert.match(script.headers.get('Content-Type') ?? '', /^text\/javascript/)
    assert.deepEqual(await decoded(script), PUBLIC('assets/settings.js'))
    let theme = await get('/assets/theme.js', { 'Accept-Encoding': 'br' })
    assert.ok(PUBLIC('assets/theme.js').byteLength < 1024)
    assert.equal(theme.headers.get('Content-Encoding'), null)
  })

  it('answers 304 to the ETag of the compressed copy, and the plain file to its own', async () => {
    let first = await get('/assets/kento.css', { 'Accept-Encoding': 'br' })
    let tag = first.headers.get('ETag')
    assert.match(tag ?? '', /^W\//)
    let again = await get('/assets/kento.css', { 'Accept-Encoding': 'br', 'If-None-Match': tag! })
    assert.equal(again.status, 304)
    assert.equal(await again.text(), '')
    let plain = await get('/assets/kento.css')
    let plainAgain = await get('/assets/kento.css', { 'If-None-Match': plain.headers.get('ETag')! })
    assert.equal(plainAgain.status, 304)
  })

  it('answers a HEAD with the headers of the compressed answer and no body', async () => {
    let response = await get('/assets/kento.css', { 'Accept-Encoding': 'br' }, 'HEAD')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Encoding'), 'br')
    assert.equal(response.headers.get('Content-Length'), null)
    assert.equal(await response.text(), '')
  })

  it('answers a range of kento.css with the whole file, and a range of a font in part, plain', async () => {
    let css = await get('/assets/kento.css', { 'Accept-Encoding': 'br', Range: 'bytes=0-99' })
    assert.equal(css.status, 200)
    assert.deepEqual(await decoded(css), CSS)

    let font = await get(`/${FONT}`, { 'Accept-Encoding': 'br', Range: 'bytes=0-99' })
    assert.equal(font.status, 206)
    assert.equal(font.headers.get('Content-Encoding'), null)
    assert.equal(font.headers.get('Accept-Ranges'), 'bytes')
    assert.match(font.headers.get('Content-Range') ?? '', /^bytes 0-99\/\d+$/)
    assert.equal((await font.arrayBuffer()).byteLength, 100)
    let whole = await get(`/${FONT}`, { 'Accept-Encoding': 'br' })
    assert.equal(whole.headers.get('Content-Encoding'), null)
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), PUBLIC(FONT))
  })
})

describe('the compression of the browser modules (KNT-202)', () => {
  it('sends a module of the asset server with brotli, and its source when decoded', async () => {
    let boot = bootScript()
    assert.ok(boot)
    let plain = await get(boot.runtime)
    let response = await get(boot.runtime, { 'Accept-Encoding': 'gzip, deflate, br, zstd' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Encoding'), 'br')
    assert.match(response.headers.get('Content-Type') ?? '', /javascript/)
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.ok(varyOf(response).includes('accept-encoding'))
    assert.deepEqual(await decoded(response), Buffer.from(await plain.arrayBuffer()))
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
