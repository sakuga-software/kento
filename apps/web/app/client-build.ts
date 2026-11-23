// KNT-170. The browser modules of production, built ahead of time (scripts/build-client.ts): the
// runtime and every component that hydrates, bundled by esbuild into a few minified files whose name
// carries the hash of their content, each one also compressed with brotli and gzip. The service
// serves them under /assets/js/ with a cache of a year. Development and the unit tests keep the asset
// server of Remix (app/assets.ts), which compiles each module when the browser asks for it.
//
// KNT-202. The same build also compresses the text files of public/assets/ (the stylesheet, the
// scripts of the screens, the large icons) with brotli and gzip. The service serves these copies in
// place of the plain file when the browser accepts one of them.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openLazyFile } from 'remix/fs'
import { AcceptEncoding } from 'remix/headers'
import { detectMimeType } from 'remix/mime'
import { createFileResponse } from 'remix/response/file'

import { errorMessage, log } from './log.ts'

/** The folder of `apps/web`. */
export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Where scripts/build-client.ts writes the bundles; the image copies it. */
export const CLIENT_DIR = path.join(ROOT_DIR, 'build', 'client')

/** The folder of the stylesheet, the fonts and the scripts of the screens, served under /assets/. */
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public')

/** The folder of a build that holds the compressed copies of the files of PUBLIC_DIR, at the same paths. */
const PUBLIC_COPIES = 'public'

/** KNT-202. A file of public/ smaller than this gets no compressed copy (the threshold of `compression()`). */
export const COMPRESS_THRESHOLD = 1024

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
 * - KNT-188: `chart.js`, for the charts of the Costs screen.
 * An entry of `allowPackages` allows the folder of the package and of each package in its
 * `dependencies`, at any depth (`createPackageRootPaths` of `@remix-run/assets`): with `chart.js`,
 * also `@kurkle/color`. A bump that adds a dependency widens what the browser can read:
 * `assets.test.ts` pins the dependencies of chart.js (Fable P2-3).
 * A browser module that imports any other file of the server gets an error, never the file.
 */
export const ALLOWED_FILES = ['app/**/public/**', 'app/routes.ts', 'app/ui/controls.tsx', 'app/ui/lucide.tsx']
export const ALLOWED_PACKAGES = ['remix', '@remix-run/ui', 'chart.js']
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
  /**
   * KNT-202. The files of public/ that have a .br and a .gz copy under `public/` of the build, by
   * their path from public/ (`assets/kento.css`): the SHA-256 of the plain file, in hex.
   */
  public: Record<string, string>
}

/** The compressed copies that the build writes beside each file. */
const SUFFIXES = { br: '.br', gzip: '.gz' } as const

/** The encodings of the copies, in the order of preference at equal weight. */
type Encoding = keyof typeof SUFFIXES

/** A build read from its folder. */
export interface ClientBuild {
  dir: string
  manifest: ClientManifest
  files: Set<string>
  /** KNT-202. The files of public/ whose copies match the plain file: the service serves these copies. */
  publicFiles: Set<string>
  /** KNT-202. The files of public/ that changed since the build (or are gone): served plain only. */
  stale: string[]
}

/**
 * The files that a build lists but its folder lacks: each bundle comes with its .br and .gz, and each
 * file of public/ that it lists with its .br and .gz under `public/`.
 */
export function missingFiles(dir: string, manifest: ClientManifest): string[] {
  let copies = Object.keys(manifest.public).flatMap((file) => [SUFFIXES.br, SUFFIXES.gzip].map((suffix) => `${PUBLIC_COPIES}/${file}${suffix}`))
  let bundles = manifest.files.flatMap((file) => ['', SUFFIXES.br, SUFFIXES.gzip].map((suffix) => file + suffix))
  return [...bundles, ...copies].filter((file) => !existsSync(path.join(dir, file)))
}

/** The SHA-256 of a content, in hex: what the manifest keeps of a file of public/. */
export function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

/** The encoding that the browser prefers among the copies: at equal weight, brotli. Null: the plain file. */
export function preferredEncoding(request: Request): Encoding | null {
  return AcceptEncoding.from(request.headers.get('Accept-Encoding')).getPreferred(['br', 'gzip'] as const)
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
  let copies = (manifest as { public?: unknown }).public
  if (!copies || typeof copies !== 'object' || Array.isArray(copies)) return 'no public files'
  // KNT-202. A path under assets/ with no `.` or `..` segment, and the hash of its plain file.
  for (let [file, hash] of Object.entries(copies)) {
    let segments = file.split('/')
    if (segments[0] !== 'assets' || segments.length < 2 || segments.some((segment) => !/^[\w.@-]+$/.test(segment) || /^\.+$/.test(segment))) return `a wrong public file: ${file}`
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return `a wrong hash: ${file}`
  }
  return null
}

/**
 * The build of `dir`, or null when it has no manifest (not built). A build that cannot serve is
 * refused, with the reason: a manifest that does not read (Kentō #9505b4, a truncated copy), or a
 * folder that lacks one of its files (Kentō #18d066), so that no request ends in a failed read.
 */
export function readClientBuild(dir = CLIENT_DIR, publicDir = PUBLIC_DIR): ClientBuild | { missing: string[] } | { invalid: string } | null {
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
  // KNT-202. A copy is served only while the plain file has the content it was made from: a file of
  // public/ changed after the build (or a build of another release) keeps its plain file.
  let publicFiles = new Set<string>()
  let stale: string[] = []
  for (let [file, hash] of Object.entries(manifest.public)) {
    let plain = path.join(publicDir, file)
    if (existsSync(plain) && sha256(readFileSync(plain)) === hash) publicFiles.add(file)
    else stale.push(file)
  }
  return { dir, manifest, files: new Set(manifest.files), publicFiles, stale }
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
  let encoding = preferredEncoding(request)
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

/**
 * KNT-202. The answer to a GET or a HEAD of a file of public/ that has compressed copies: the copy
 * that the browser accepts, with the conditional requests of a file (`If-None-Match`,
 * `If-Modified-Since`). Null when the plain file answers (`staticFiles()`): the browser accepts
 * neither copy, the request asks for a range (a range is of the plain file, as before), or the file
 * has no fresh copy. The caller adds `Vary: Accept-Encoding` to either answer.
 *
 * The ETag of a copy names its encoding (`"br-<size>-<mtime>"`): the plain file, the brotli copy and
 * the gzip copy never share one, so a browser that changes its `Accept-Encoding` never gets a 304
 * for a copy it does not hold.
 */
export async function servePublicCopy(build: ClientBuild, request: Request, file: string, cacheControl: string): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  if (!build.publicFiles.has(file) || request.headers.has('Range')) return null
  let encoding = preferredEncoding(request)
  if (!encoding) return null
  let copy = path.join(build.dir, PUBLIC_COPIES, file + SUFFIXES[encoding])
  let response: Response
  try {
    response = await createFileResponse(openLazyFile(copy, { name: file, type: detectMimeType(file) ?? '' }), request, {
      cacheControl,
      acceptRanges: false,
      etag: 'strong',
      digest: (lazy) => `${encoding}-${lazy.size}-${Math.floor(lazy.lastModified)}`,
    })
  } catch (error) {
    // The folder was checked at startup: a copy gone since is a fault of the deploy. The plain file answers.
    log('error', 'assets.public_copy_unreadable', { file, encoding, error: errorMessage(error) })
    return null
  }
  if (response.status !== 200) return response
  let headers = new Headers(response.headers)
  headers.set('Content-Encoding', encoding)
  return new Response(response.body, { status: response.status, headers })
}
