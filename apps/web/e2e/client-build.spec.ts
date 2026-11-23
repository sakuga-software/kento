import { expect, test } from '@playwright/test'

import { hydrated, signIn, watchConsole } from './helpers.ts'

// KNT-170. The server of the tests runs in production, on the bundles of scripts/build-client.ts
// (playwright.config.ts builds them first): a page with components loads a few compressed files
// from /assets/js/, all of them asked for at once, and the asset server compiles nothing.

test('a page with components loads its bundles, compressed and preloaded, and hydrates', async ({ page }) => {
  let errors = watchConsole(page)
  await signIn(page, 'octocat')
  await page.goto('/repos')
  await page.getByRole('button', { name: 'Read GitHub again' }).click()
  await expect(page.getByText('List up to date.')).toBeVisible()

  let modules: { url: string; encoding: string | undefined; cache: string | undefined }[] = []
  page.on('response', async (response) => {
    let url = new URL(response.url())
    if (url.pathname.startsWith('/assets/') && response.request().resourceType() === 'script') {
      let headers = await response.allHeaders()
      modules.push({ url: url.pathname, encoding: headers['content-encoding'], cache: headers['cache-control'] })
    }
  })
  await page.goto('/repos')
  await hydrated(page)

  // The module of the page and its preloads: bundles of /assets/js/, no import map.
  let boot = await page.locator('script[type="module"][data-runtime]').getAttribute('src')
  expect(boot).toMatch(/^\/assets\/js\/boot\.@[A-Z0-9]+\.js$/)
  expect(await page.locator('script[type="module"][data-runtime]').getAttribute('data-runtime')).toMatch(/^\/assets\/js\/runtime\.@[A-Z0-9]+\.js$/)
  // The HTML of the server (the runtime takes its preload links out once it has hydrated).
  let html = await (await page.request.get('/repos')).text()
  expect(html).not.toContain('type="importmap"')
  let preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => match[1]!)
  expect(preloads.length).toBeGreaterThan(0)
  expect(new Set(preloads).size).toBe(preloads.length)
  for (let href of preloads) expect(href).toMatch(/^\/assets\/js\/[a-z-]+\.@[A-Z0-9]+\.js$/)

  // Every module of the page is a bundle, compressed (Chromium accepts brotli), kept a year.
  let bundles = modules.filter((module) => module.url.startsWith('/assets/js/'))
  expect(bundles.length).toBeGreaterThan(0)
  // Each preload is a bundle that the page loads: no link is wasted.
  for (let href of preloads) expect(bundles.map((module) => module.url), href).toContain(href)
  expect(modules.filter((module) => !module.url.startsWith('/assets/js/') && !/^\/assets\/[a-z-]+\.js$/.test(module.url))).toEqual([])
  for (let module of bundles) {
    expect(module.encoding).toBe('br')
    expect(module.cache).toBe('public, max-age=31536000, immutable')
  }

  // The asset server is off: a module of the source answers 404, and so does a file the build did not write.
  for (let path of ['/assets/app/ui/public/runtime.ts', '/assets/js/manifest.json', '/assets/js/..%2Fmanifest.json']) {
    expect((await page.request.get(path)).status(), path).toBe(404)
  }
  expect(errors).toEqual([])
})

// KNT-202. The stylesheet, the scripts of the screens and the HTML reach the browser compressed: the
// copies of the build for the files of public/assets/, brotli on each request for the pages.
test('the stylesheet, the scripts of the screens and the page come compressed', async ({ page }) => {
  let errors = watchConsole(page)
  let files: { url: string; type: string; encoding: string | undefined; vary: string | undefined }[] = []
  page.on('response', async (response) => {
    let url = new URL(response.url())
    let headers = await response.allHeaders()
    files.push({ url: url.pathname, type: response.request().resourceType(), encoding: headers['content-encoding'], vary: headers['vary'] })
  })
  await signIn(page, 'octocat')
  await page.goto('/repos')
  await hydrated(page)

  let document = files.findLast((file) => file.type === 'document' && file.url === '/repos')
  expect(document?.encoding).toBe('br')
  expect(document?.vary?.toLowerCase()).toContain('accept-encoding')
  let css = files.find((file) => file.url === '/assets/kento.css')
  expect(css?.encoding).toBe('br')
  expect(css?.vary?.toLowerCase()).toContain('accept-encoding')
  let scripts = files.filter((file) => /^\/assets\/[a-z-]+\.js$/.test(file.url))
  expect(scripts.length).toBeGreaterThan(0)
  // theme.js is under 1 KB: it has no copy and comes plain.
  for (let script of scripts) expect(script.encoding, script.url).toBe(script.url === '/assets/theme.js' ? undefined : 'br')

  // A client that accepts gzip only, then none.
  let gzip = await page.request.get('/assets/kento.css', { headers: { 'Accept-Encoding': 'gzip' } })
  expect(gzip.headers()['content-encoding']).toBe('gzip')
  let plain = await page.request.get('/assets/kento.css', { headers: { 'Accept-Encoding': 'identity' } })
  expect(plain.headers()['content-encoding']).toBeUndefined()
  expect((await plain.body()).byteLength).toBeGreaterThan(100_000)
  expect(errors).toEqual([])
})
