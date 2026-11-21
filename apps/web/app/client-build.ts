// KNT-170. The browser modules of production, built ahead of time (scripts/build-client.ts): the
// runtime and every component that hydrates, bundled by esbuild into a few minified files whose name
// carries the hash of their content, each one also compressed with brotli and gzip. The service
// serves them under /assets/js/ with a cache of a year. Development and the unit tests keep the asset
// server of Remix (app/assets.ts), which compiles each module when the browser asks for it.
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AcceptEncoding } from 'remix/headers'

import { errorMessage, log } from './log.ts'

/** The folder of `apps/web`. */
export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Where scripts/build-client.ts writes the bundles; the image copies it. */
export const CLIENT_DIR = path.join(ROOT_DIR, 'build', 'client')

/** The URL of the folder of the bundles. */
export const CLIENT_BASE = '/assets/js/'

/** The browsers that the modules support: the popover API (Baseline 2024) is the newest part used. */
export const BROWSER_TARGET = { chrome: '114', firefox: '125', safari: '17' } as const

/**
 * What the browser can download. This is a security boundary: anybody can ask for these files. The
 * asset server of development refuses any other file (app/assets.ts), and the build stops on one
 * (scripts/build-client.ts), so that no file of the server ends in a bundle.
 * - `app/**\/public/**`: the browser modules, each one next to the screen that uses it.
 * - `routes.ts`, `controls.tsx` and `lucide.tsx`: the URLs of the screens, the controls and the
 *   icons, which a component that hydrates also makes. They import only `remix/routes` and
 *   `remix/component`.
 * - The packages `remix` (and its `@remix-run/component`, the runtime) and `@remix-run/ui`.
 */
export const ALLOWED_FILES = ['app/**/public/**', 'app/routes.ts', 'app/ui/controls.tsx', 'app/ui/lucide.tsx']
export const ALLOWED_PACKAGES = ['remix', '@remix-run/ui']
export const DENIED_FILES = ['app/**/*.test.*']

/** What scripts/build-client.ts writes in `manifest.json`. */
export interface ClientManifest {
  /**
   * By the path of a source module, from `apps/web` (`app/ui/public/row-menu.tsx`): the name of its
   * bundle, and the chunks that the bundle imports, directly or not.
   */
  entries: Record<string, { file: string; imports: string[] }>
  /** Every file of the folder that the service may serve (bundles and chunks, without .br or .gz). */
  files: string[]
}

/** The compressed copies that the build writes beside each file. */
const SUFFIXES = { br: '.br', gzip: '.gz' } as const

/** A build read from its folder. */
export interface ClientBuild {
  dir: string
  manifest: ClientManifest
  files: Set<string>
}

/** The files that a build lists but its folder lacks: each bundle comes with its .br and .gz. */
export function missingFiles(dir: string, manifest: ClientManifest): string[] {
  return manifest.files.flatMap((file) => ['', SUFFIXES.br, SUFFIXES.gzip].map((suffix) => file + suffix)).filter((file) => !existsSync(path.join(dir, file)))
}

/** What is wrong with the shape of a manifest (Kentō #1295f7), or null. */
function manifestProblem(manifest: unknown): string | null {
  let { entries, files } = (manifest ?? {}) as Partial<ClientManifest>
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return 'no entries'
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) return 'no files'
  // Kentō #cb6ad2: a plain name of a script of the folder, never a path, never the manifest.
  let wrong = files.find((file) => !/^[\w.@-]+\.js$/.test(file) || file.startsWith('.'))
  if (wrong !== undefined) return `a wrong file name: ${wrong}`
  for (let [source, entry] of Object.entries(entries)) {
    let { file, imports } = (entry ?? {}) as Partial<ClientManifest['entries'][string]>
    let listed = (name: unknown) => typeof name === 'string' && files.includes(name)
    if (!listed(file) || !Array.isArray(imports) || !imports.every(listed)) return `a wrong entry: ${source}`
  }
  return null
}

/**
 * The build of `dir`, or null when it has no manifest (not built). A build that cannot serve is
 * refused, with the reason: a manifest that does not read (Kentō #9505b4, a truncated copy), or a
 * folder that lacks one of its files (Kentō #18d066), so that no request ends in a failed read.
 */
export function readClientBuild(dir = CLIENT_DIR): ClientBuild | { missing: string[] } | { invalid: string } | null {
  let file = path.join(dir, 'manifest.json')
  if (!existsSync(file)) return null
  let manifest: ClientManifest
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as ClientManifest
    let problem = manifestProblem(manifest)
    if (problem) throw new Error(problem)
  } catch (error) {
    return { invalid: errorMessage(error) }
  }
  let missing = missingFiles(dir, manifest)
  if (missing.length > 0) return { missing }
  return { dir, manifest, files: new Set(manifest.files) }
}

/**
 * The source path of an entry, from `apps/web`: `clientEntry(import.meta.url, …)` gives
 * `file:///…/app/ui/public/row-menu.tsx#RowMenu`; boot.ts and the runtime are named by their path.
 */
export function sourceOf(entryId: string): string {
  let location = entryId.split('#')[0]!
  let file = location.startsWith('file:') ? fileURLToPath(location) : path.resolve(ROOT_DIR, location)
  return path.relative(ROOT_DIR, file).split(path.sep).join('/')
}

/** The URL of the bundle of an entry, and the URLs of the chunks that it imports. */
export function bundleOf(build: ClientBuild, entryId: string): { href: string; preloads: string[] } {
  let source = sourceOf(entryId)
  // Kentō #d8ff35: its own key only, never a property of Object (`constructor`, `__proto__`).
  let entry = Object.hasOwn(build.manifest.entries, source) ? build.manifest.entries[source] : undefined
  if (!entry) throw new Error(`No bundle for ${source}: run scripts/build-client.ts again`)
  return { href: CLIENT_BASE + entry.file, preloads: entry.imports.map((file) => CLIENT_BASE + file) }
}


/**
 * The answer to a request under /assets/js/: the bundle, compressed as the browser accepts it.
 * Only a file that the manifest lists: any other name (a path, `manifest.json`, a missing hash)
 * answers 404. Null for a path outside /assets/js/.
 */
export async function serveClientFile(build: ClientBuild, request: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith(CLIENT_BASE)) return null
  let name = pathname.slice(CLIENT_BASE.length)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  if (!build.files.has(name)) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  // The weights of the browser decide; at equal weight, brotli. None of the two: the plain file.
  let encoding = AcceptEncoding.from(request.headers.get('Accept-Encoding')).getPreferred(['br', 'gzip'] as const)
  let file = path.join(build.dir, name + (encoding ? SUFFIXES[encoding] : ''))
  let body: Uint8Array<ArrayBuffer>
  try {
    body = new Uint8Array(await readFile(file))
  } catch (error) {
    // Kentō #048c24: the folder was checked at startup; a file gone since is a fault of the
    // deploy, logged, and the browser gets a plain 404 rather than a 500.
    log('error', 'assets.client_file_unreadable', { file: name, error: errorMessage(error) })
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  let headers = new Headers({
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': String(body.byteLength),
    // The name carries the hash of the content: a new content is a new URL.
    'Cache-Control': 'public, max-age=31536000, immutable',
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
  })
  if (encoding) headers.set('Content-Encoding', encoding)
  return new Response(request.method === 'HEAD' ? null : body, { headers })
}
