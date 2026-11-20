// KNT-163. The browser modules of the screens: the components that hydrate (`clientEntry`), the
// runtime that hydrates them, and the boot module that loads it. The asset server of Remix compiles
// each TypeScript file when the browser asks for it: there is still no build step.
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAssetServer } from 'remix/assets'
import type { Middleware } from 'remix/router'

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
const fromRemix = createRequire(require.resolve('remix/package.json'))
const MOUNTS = {
  app: 'app',
  npm: 'node_modules',
  c: distOf('@remix-run/component', fromRemix),
  rp: distOf('@remix-run/route-pattern', fromRemix),
  fr: distOf('@remix-run/fetch-router', fromRemix),
  ui: distOf('@remix-run/ui'),
}

/**
 * What the browser can download. This is a security boundary: anybody can ask for these files.
 * - `app/**\/public/**`: the browser modules, each one next to the screen that uses it.
 * - `routes.ts`, `controls.tsx` and `lucide.tsx`: the URLs of the screens, the controls and the
 *   icons, which a component that hydrates also makes. They import only `remix/routes` and
 *   `remix/component`.
 * - The packages `remix` (and its `@remix-run/component`, the runtime) and `@remix-run/ui`.
 * A browser module that imports any other file of the server gets an error, never the file.
 */
export const ALLOWED_FILES = ['app/**/public/**', 'app/routes.ts', 'app/ui/controls.tsx', 'app/ui/lucide.tsx']

export const assets = createAssetServer({
  basePath: '/assets',
  rootDir: ROOT_DIR,
  mounts: MOUNTS,
  allowFiles: ALLOWED_FILES,
  allowPackages: ['remix', '@remix-run/ui'],
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

let boot: BootScript | null = null

/** The URLs of boot.ts and of the runtime, for `<Document>`. Null before the first request, and in a test of one component. */
export function bootScript(): BootScript | null {
  return boot
}

/** Serves the browser modules, and reads the URLs of boot.ts and of the runtime (they change with their content). */
export function clientAssets(): Middleware {
  return async (context, next) => {
    if (context.url.pathname.startsWith('/assets/')) return (await assets.fetch(context.request)) ?? next()
    if (context.request.method === 'GET' || context.request.method === 'HEAD') {
      boot = { href: await assets.getHref(BOOT), runtime: await assets.getHref(RUNTIME) }
    }
    return next()
  }
}
