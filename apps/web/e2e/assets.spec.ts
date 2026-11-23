import { expect, test } from '@playwright/test'

import { hydrated, signIn, watchConsole } from './helpers.ts'

// KNT-202. The server of the tests runs in production: the asset server of Remix serves the browser
// modules one by one, with the hash of their content in the URL. The page preloads every module of
// its components, and the modules, the stylesheet, the scripts and the page come compressed.

const IMMUTABLE = 'public, max-age=31536000, immutable'

test('a page with components preloads its modules, gets them compressed and cached a year, and hydrates', async ({ browser, page: first }) => {
  await signIn(first, 'octocat')
  await first.goto('/repos')
  await first.getByRole('button', { name: 'Read GitHub again' }).click()
  await expect(first.getByText('List up to date.')).toBeVisible()
  // A new context: the same session, and an empty cache, so that the page asks for every module.
  let context = await browser.newContext({ baseURL: test.info().project.use.baseURL, storageState: await first.context().storageState() })
  let page = await context.newPage()
  let errors = watchConsole(page)

  let files: { url: string; type: string; encoding: string | undefined; cache: string | undefined; vary: string | undefined }[] = []
  page.on('response', (response) => {
    let url = new URL(response.url())
    let headers = response.headers()
    files.push({ url: url.pathname, type: response.request().resourceType(), encoding: headers['content-encoding'], cache: headers['cache-control'], vary: headers['vary'] })
  })
  await page.goto('/repos')
  await hydrated(page)

  // The HTML of the server: the import map first, then one preload link a module, no duplicate.
  let html = await (await page.request.get('/repos')).text()
  let preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => match[1]!)
  expect(preloads.length).toBeGreaterThan(10)
  expect(new Set(preloads).size).toBe(preloads.length)
  expect(html.indexOf('type="importmap"')).toBeGreaterThan(0)
  expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('rel="modulepreload"'))
  let runtime = await page.locator('script[type="module"][data-runtime]').getAttribute('data-runtime')
  expect(runtime).toMatch(/^\/assets\/app\/ui\/public\/runtime\.@[\w-]+\.ts$/)
  expect(preloads).toContain(runtime)
  expect(preloads.some((href) => href.startsWith('/assets/app/ui/public/row-menu.@'))).toBe(true)

  // Each module of the asset server: fingerprinted, compressed with brotli, kept a year.
  let modules = files.filter((file) => file.url.startsWith('/assets/') && /\.@[\w-]+\.[a-z]+$/.test(file.url))
  expect(modules.length).toBeGreaterThan(10)
  for (let href of preloads) expect(modules.map((module) => module.url), href).toContain(href)
  for (let module of modules) {
    expect(module.encoding, module.url).toBe('br')
    expect(module.cache, module.url).toBe(IMMUTABLE)
    expect(module.vary?.toLowerCase(), module.url).toContain('accept-encoding')
  }

  // The page, the stylesheet and the scripts of public/assets/; theme.js is under 1 KB and stays plain.
  let document = files.findLast((file) => file.type === 'document' && file.url === '/repos')
  expect(document?.encoding).toBe('br')
  let css = files.find((file) => file.url === '/assets/kento.css')
  expect(css?.encoding).toBe('br')
  expect(css?.cache).toBe(IMMUTABLE)
  let scripts = files.filter((file) => /^\/assets\/[a-z-]+\.js$/.test(file.url))
  expect(scripts.length).toBeGreaterThan(0)
  for (let script of scripts) expect(script.encoding, script.url).toBe(script.url === '/assets/theme.js' ? undefined : 'br')

  // A client that accepts gzip only, then none.
  let gzip = await page.request.get('/assets/kento.css', { headers: { 'Accept-Encoding': 'gzip' } })
  expect(gzip.headers()['content-encoding']).toBe('gzip')
  let plain = await page.request.get('/assets/kento.css', { headers: { 'Accept-Encoding': 'identity' } })
  expect(plain.headers()['content-encoding']).toBeUndefined()
  expect((await plain.body()).byteLength).toBeGreaterThan(100_000)
  expect(errors).toEqual([])
  await context.close()
})
