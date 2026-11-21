// KNT-163. The browser modules of the screens: the components that hydrate (`clientEntry`), the
// runtime that hydrates them, and the boot module that loads it. In development and in the unit
// tests, the asset server of Remix compiles each TypeScript file when the browser asks for it. In
// production (KNT-170), the service serves the bundles that scripts/build-client.ts built ahead of
// time (app/client-build.ts): a few files, compressed, instead of some 70 modules.
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAssetServer, type ScriptEntry } from 'remix/assets'
import type { Middleware } from 'remix/router'

import { ALLOWED_FILES, ALLOWED_PACKAGES, BROWSER_TARGET, bundleOf, CLIENT_DIR, DENIED_FILES, readClientBuild, serveClientFile, type ClientBuild } from './client-build.ts'
import { errorMessage, log } from './log.ts'

const isDevelopment = process.env.NODE_ENV === 'development'
const isProduction = process.env.NODE_ENV === 'production'

/** The folder of `apps/web`. */
const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))

const require = createRequire(import.meta.url)
/** The `dist` folder of a package, for a short mount: `@remix-run/component` comes with `remix`. */
function distOf(name: string, from = require): string {
  return path.relative(ROOT_DIR, path.join(path.dirname(from.resolve(`${name}/package.json`)), 'dist'))
}

/**
 * The public folders under `/assets/`, beside the files of `public/assets/` that `staticFiles()`
 * serves. The packages that the browser loads get a short name (the runtime, the URLs of
 * `routes.ts`, the primitives): each of their modules is a line
 * of the import map of a page, twice (its URL and the URL with its hash), and the Findings screen
 * keeps a budget of 80 KB of HTML.
 */
/** What the asset server says about a path that anybody can ask for: none of them is a fault of the service. */
const NOT_SERVED = new Set(['FILE_NOT_FOUND', 'FILE_NOT_ALLOWED', 'FILE_NOT_SUPPORTED', 'FILE_OUTSIDE_MOUNTS', 'URL_NOT_SUPPORTED', 'URL_NOT_ALLOWED', 'URL_OUTSIDE_MOUNTS'])

/**
 * The answer to a module that the asset server cannot serve. A path that does not exist, is not
 * allowed or is outside the mounts: 404, a warning (anybody can ask for any path). Any other
 * failure (a module that does not compile, an import outside the mounts): 500, an error, so that a
 * broken release shows in the logs.
 */
export function assetError(error: unknown): Response {
  let code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null
  if (code && NOT_SERVED.has(code)) {
    log('warn', 'assets.not_served', { code, error: errorMessage(error) })
    return new Response('Not Found', { status: 404 })
  }
  log('error', 'assets.compile_failed', { code, error: errorMessage(error) })
  return new Response('Internal Server Error', { status: 500 })
}

const fromRemix = createRequire(require.resolve('remix/package.json'))
/**
 * Only the packages that the browser loads: no mount of `node_modules`, so that a request cannot
 * make the server compile another file of a package (Fable critique P3-7). A new package that a
 * component imports needs its mount here, else its module answers 404.
 */
const MOUNTS = {
  app: 'app',
  c: distOf('@remix-run/component', fromRemix),
  rp: distOf('@remix-run/route-pattern', fromRemix),
  fr: distOf('@remix-run/fetch-router', fromRemix),
  ui: distOf('@remix-run/ui'),
}

export { ALLOWED_FILES }

export const assets = createAssetServer({
  basePath: '/assets',
  rootDir: ROOT_DIR,
  mounts: MOUNTS,
  allowFiles: ALLOWED_FILES,
  allowPackages: ALLOWED_PACKAGES,
  denyFiles: DENIED_FILES,
  // Production: minified, and each URL carries the hash of its content (cached for a year).
  // Elsewhere: stable URLs, checked again on each load.
  minify: !isDevelopment,
  fingerprint: isProduction,
  watch: isDevelopment,
  sourceMaps: isDevelopment ? 'external' : undefined,
  // The popover API (Baseline 2024) is the newest part of the platform that the components use.
  target: BROWSER_TARGET,
  scripts: { define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') } },
  onError: assetError,
})

/**
 * The bundles of production, read once at startup. Missing in production (an image built without
 * scripts/build-client.ts): an error in the logs, and the asset server serves the modules one by one,
 * as in development, so that the screens still work.
 */
export function loadClientBuild(production = isProduction, dir = CLIENT_DIR): ClientBuild | null {
  if (!production) return null
  let build = readClientBuild(dir)
  if (!build) {
    log('error', 'startup.client_build_missing', { dir })
    return null
  }
  if ('missing' in build) {
    log('error', 'startup.client_build_incomplete', { dir, missing: build.missing })
    return null
  }
  return build
}

const CLIENT_BUILD = loadClientBuild()

/** The module of every page (see its comment). */
export const BOOT = 'app/ui/public/boot.ts'
/** The runtime, that boot.ts loads on a page with a component to hydrate. */
export const RUNTIME = 'app/ui/public/runtime.ts'

/**
 * What `render({ assets })` reads for each component that hydrates.
 * - With the bundles (production): the URL of its bundle, and a module preload for the runtime and
 *   for every chunk that they import, a handful of links, so that the browser asks for all of them
 *   at once. No import map: a bundle imports its chunks by their URL.
 * - With the asset server: its URL, and an import map that also resolves the runtime (boot.ts
 *   imports it only on such a page, so that a page without a component carries no import map). No
 *   module preload: 40 preload links would cost 2 KB of HTML on each page.
 */
export function createClientEntries(build: ClientBuild | null) {
  return {
    async getScriptEntry(entry: string): Promise<ScriptEntry> {
      if (build) {
        let own = bundleOf(build, entry)
        let runtime = bundleOf(build, RUNTIME)
        return { href: own.href, importMap: { imports: {} }, preloads: [...new Set([runtime.href, ...runtime.preloads, ...own.preloads])] }
      }
      return moduleEntry(entry)
    },
  }
}

export const clientEntries = createClientEntries(CLIENT_BUILD)

/** The entry of a component from the asset server. */
async function moduleEntry(entry: string) {
  let { href } = await assets.getScriptEntry(entry)
  return { href, importMap: await assets.getImportMap([entry, RUNTIME]), preloads: [] }
}

/** The URLs of boot.ts and of the runtime that it loads. */
export interface BootScript {
  href: string
  runtime: string
}

/**
 * The URLs of boot.ts and of the runtime. Null when the asset server cannot read them (a file
 * missing from the image): the error is logged, and the pages go without their components, as
 * without JavaScript; the service still starts (Kentō #5d5d55).
 */
export async function resolveBootScript(server: Pick<typeof assets, 'getHref'>, build: ClientBuild | null = null): Promise<BootScript | null> {
  try {
    if (build) return { href: bundleOf(build, BOOT).href, runtime: bundleOf(build, RUNTIME).href }
    return { href: await server.getHref(BOOT), runtime: await server.getHref(RUNTIME) }
  } catch (error) {
    log('error', 'startup.assets_unavailable', { error: errorMessage(error) })
    return null
  }
}

/**
 * Read once, when the module loads: without a hash (development, tests) the URL of a file never
 * changes, and with one (production) the files do not change while the process runs (`watch` is
 * off). Every page, a 404 included, gets the same value, with no request needed first.
 */
const BOOT_SCRIPT = await resolveBootScript(assets, CLIENT_BUILD)

/** The URLs of boot.ts and of the runtime, for `<Document>`. Null: no component hydrates. */
export function bootScript(): BootScript | null {
  return BOOT_SCRIPT
}

/**
 * Serves the browser modules under `/assets/`; anything else goes on. With the bundles, only them
 * (/assets/js/): the asset server then compiles nothing on request.
 */
export function clientAssets(build: ClientBuild | null = CLIENT_BUILD): Middleware {
  return async (context, next) => {
    if (!context.url.pathname.startsWith('/assets/')) return next()
    if (build) return (await serveClientFile(build, context.request, context.url.pathname)) ?? next()
    let response = await assets.fetch(context.request)
    if (!response) return next()
    // As every file of the app: the browser runs a module only as the type that the server says.
    let headers = new Headers(response.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
