// KNT-163. The browser modules of the screens: the components that hydrate (`clientEntry`), the
// runtime that hydrates them, and the boot module that loads it. The asset server of Remix compiles
// each TypeScript file when the browser asks for it: there is still no build step.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAssetServer } from 'remix/assets'
import type { Middleware } from 'remix/router'

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

/** Where the asset server serves the files of the pnpm store: the allowed packages without a short mount. */
const STORE_PATH = '/assets/__@remix/virtual-store/'

/** The path of the request that the asset server is serving: `assetError` reads it (KNT-188). */
const requestPath = new AsyncLocalStorage<string>()

/**
 * The answer to a module that the asset server cannot serve. A path that does not exist, is not
 * allowed or is outside the mounts: 404, a warning (anybody can ask for any path). A file of an
 * allowed package of the pnpm store that is no browser module (KNT-188, Fable P2-1: the UMD and
 * CommonJS builds and the `.d.ts` of chart.js do not compile): 404, a warning too; no page imports
 * it, and `resolveCharts` checks at startup the modules that a page does import. Any other failure
 * (a module of the app that does not compile, an import outside the mounts): 500, an error, so that
 * a broken release shows in the logs.
 */
export function assetError(error: unknown): Response {
  let code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null
  let path = requestPath.getStore()
  let ofPackage = path !== undefined && path.startsWith(STORE_PATH)
  if ((code && NOT_SERVED.has(code)) || ofPackage) {
    log('warn', 'assets.not_served', { code, ...(ofPackage ? { path } : {}), error: errorMessage(error) })
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
  // KNT-188: no mount for chart.js. The asset server serves it from its own mount of the pnpm store
  // (`/assets/__@remix/virtual-store/…`): with a mount of `chart.js/dist`, the import map put the
  // scope of its `@kurkle/color` under the store and its chunk under the mount, and the browser could
  // not resolve it.
}

/**
 * What the browser can download. This is a security boundary: anybody can ask for these files.
 * - `app/**\/public/**`: the browser modules, each one next to the screen that uses it.
 * - `routes.ts`, `controls.tsx` and `lucide.tsx`: the URLs of the screens, the controls and the
 *   icons, which a component that hydrates also makes. They import only `remix/routes` and
 *   `remix/component`.
 * - The packages `remix` (and its `@remix-run/component`, the runtime) and `@remix-run/ui`.
 * - KNT-188: `chart.js`, for the charts of the Costs screen.
 * An entry of `allowPackages` allows the folder of the package and of each package in its
 * `dependencies`, at any depth (`createPackageRootPaths` of `@remix-run/assets`): with `chart.js`,
 * also `@kurkle/color`. A bump that adds a dependency widens what the browser can read:
 * `assets.test.ts` pins the dependencies of chart.js (Fable P2-3).
 * A browser module that imports any other file of the server gets an error, never the file.
 */
export const ALLOWED_FILES = ['app/**/public/**', 'app/routes.ts', 'app/ui/controls.tsx', 'app/ui/lucide.tsx']

export const assets = createAssetServer({
  basePath: '/assets',
  rootDir: ROOT_DIR,
  mounts: MOUNTS,
  allowFiles: ALLOWED_FILES,
  allowPackages: ['remix', '@remix-run/ui', 'chart.js'],
  denyFiles: ['app/**/*.test.*'],
  // Production: minified, and each URL carries the hash of its content (cached for a year).
  // Elsewhere: stable URLs, checked again on each load.
  minify: !isDevelopment,
  fingerprint: isProduction,
  watch: isDevelopment,
  sourceMaps: isDevelopment ? 'external' : undefined,
  // The popover API (Baseline 2024) is the newest part of the platform that the components use.
  target: { chrome: '114', firefox: '125', safari: '17' },
  scripts: { define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') } },
  onError: assetError,
})

/** The module of every page (see its comment). */
export const BOOT = 'app/ui/public/boot.ts'
/** The runtime, that boot.ts loads on a page with a component to hydrate. */
export const RUNTIME = 'app/ui/public/runtime.ts'

/**
 * What `render({ assets })` reads for each component that hydrates: its URL, and an import map
 * that also resolves the runtime (boot.ts imports it only on such a page, so that a page without
 * a component carries no import map). No module preload: with the hash in each URL, the browser
 * keeps the modules a year, and 40 preload links would cost 2 KB of HTML on each page.
 */
export const clientEntries = {
  async getScriptEntry(entry: string) {
    let { href } = await assets.getScriptEntry(entry)
    return { href, importMap: await assets.getImportMap([entry, RUNTIME]), preloads: [] }
  },
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
export async function resolveBootScript(server: Pick<typeof assets, 'getHref'>): Promise<BootScript | null> {
  try {
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
const BOOT_SCRIPT = await resolveBootScript(assets)

/** The URLs of boot.ts and of the runtime, for `<Document>`. Null: no component hydrates. */
export function bootScript(): BootScript | null {
  return BOOT_SCRIPT
}

/** KNT-188. The component of the charts, with Chart.js under it. */
export const CHART = 'app/costs/public/cost-chart.tsx'

/**
 * KNT-188, Fable P2-2. True when the asset server can serve the charts: their module and the import
 * map of their graph (Chart.js). A page renders a chart only then; else it renders its tables
 * alone, as without JavaScript, and the log says why. Without this, a release whose build cannot
 * resolve Chart.js failed the render of the whole page, tables included.
 */
export async function resolveCharts(server: Pick<typeof assets, 'getHref' | 'getImportMap'>): Promise<boolean> {
  try {
    await server.getHref(CHART)
    await server.getImportMap([CHART])
    return true
  } catch (error) {
    log('error', 'startup.assets_unavailable', { module: CHART, error: errorMessage(error) })
    return false
  }
}

const CHARTS = await resolveCharts(assets)

/** Whether the pages can render their charts (see `resolveCharts`). */
export function chartsAvailable(): boolean {
  return CHARTS
}

/** Serves the browser modules under `/assets/`; anything else goes on. */
export function clientAssets(): Middleware {
  return async (context, next) => {
    if (!context.url.pathname.startsWith('/assets/')) return next()
    let response = await requestPath.run(context.url.pathname, () => assets.fetch(context.request))
    if (!response) return next()
    // As every file of the app: the browser runs a module only as the type that the server says.
    let headers = new Headers(response.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
