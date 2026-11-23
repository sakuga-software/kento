// KNT-170. Builds the browser modules of production into build/client/ (app/client-build.ts):
//
//   node --import remix/node-tsx scripts/build-client.ts   (pnpm build:client)
//
// The entries are boot.ts, the runtime, and every module of an `app/**/public/` folder that declares
// a `clientEntry`. esbuild bundles them with code splitting: one file per entry, the code they share
// in chunks, so that the runtime and the components use one copy of remix/component. Each file is
// minified, named by the hash of its content, and written again compressed with brotli (quality 11)
// and gzip (level 9). manifest.json maps each source module to its file and its chunks.
// KNT-202. It also writes the same two copies of each text file of public/assets/ of 1 KB or more
// (the stylesheet, the scripts of the screens, the large icons) under build/client/public/, at the
// path of the file; manifest.json keeps the hash of each plain file.
// The image runs it (Dockerfile), and so does the e2e before it starts the server.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

import { build, type Metafile } from 'esbuild'
import { detectMimeType, isCompressibleMimeType } from 'remix/mime'

import { ALLOWED_FILES, ALLOWED_PACKAGES, BROWSER_TARGET, CLIENT_DIR, COMPRESS_THRESHOLD, DENIED_FILES, PUBLIC_DIR, ROOT_DIR, sha256, type ClientManifest } from '../app/client-build.ts'

/** The module of every page, and the runtime that it loads. */
const ALWAYS = ['app/ui/public/boot.ts', 'app/ui/public/runtime.ts']

/** Every file under `dir` (relative to `root`), as a path with `/`. */
function filesUnder(dir: string, root = ROOT_DIR): string[] {
  return readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
}

/** Writes the brotli (quality 11) and gzip (level 9) copies of `body` beside `file`. */
function writeCopies(file: string, body: Buffer) {
  writeFileSync(`${file}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength } }))
  writeFileSync(`${file}.gz`, gzipSync(body, { level: 9 }))
}

/**
 * KNT-202. Writes the compressed copies of the text files of `publicDir`/assets/ under
 * `outDir`/public/, and returns the hash of each plain file, by its path from `publicDir`. A file
 * that does not compress (a font, an image other than SVG) or is under 1 KB gets none.
 */
export function compressPublicFiles(outDir: string, publicDir = PUBLIC_DIR): Record<string, string> {
  let hashes: Record<string, string> = {}
  for (let file of filesUnder('assets', publicDir).sort()) {
    if (!isCompressibleMimeType(detectMimeType(file) ?? '')) continue
    let body = readFileSync(path.join(publicDir, file))
    if (body.byteLength < COMPRESS_THRESHOLD) continue
    let copy = path.join(outDir, 'public', file)
    mkdirSync(path.dirname(copy), { recursive: true })
    writeCopies(copy, body)
    hashes[file] = sha256(body)
  }
  return hashes
}

/** The modules of `app/**\/public/` that declare a component that hydrates. */
export function clientEntryModules(): string[] {
  return filesUnder('app')
    .filter((file) => /\/public\/[^/]+\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => /\bclientEntry\(/.test(readFileSync(path.join(ROOT_DIR, file), 'utf8')))
    .sort()
}

/** The `dependencies` of a package that apps/web installs. */
function dependenciesOf(name: string): string[] {
  for (let dir = ROOT_DIR; ; dir = path.dirname(dir)) {
    let file = path.join(dir, 'node_modules', name, 'package.json')
    if (existsSync(file)) return Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {})
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed`)
  }
}

/**
 * The packages that a bundle can hold: `ALLOWED_PACKAGES` and their own dependencies (the
 * `@remix-run/*` packages of remix, `@kurkle/color` of chart.js). `assets.test.ts` pins the
 * dependencies of chart.js.
 */
const BUNDLED_PACKAGES = new Set(ALLOWED_PACKAGES.flatMap((name) => [name, ...dependenciesOf(name)]))

/**
 * The inputs of a build that the browser may not get: a file of the app outside `ALLOWED_FILES` (or
 * a test), or a package outside `BUNDLED_PACKAGES`. esbuild bundles whatever a module imports; this
 * keeps the rule of the asset server.
 */
export function forbiddenInputs(inputs: string[]): string[] {
  return inputs.filter((input) => {
    let packageName = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g)?.at(-1)?.replace(/^\/?node_modules\//, '').replace(/\/$/, '')
    if (packageName) return !BUNDLED_PACKAGES.has(packageName)
    if (DENIED_FILES.some((pattern) => path.matchesGlob(input, pattern))) return true
    return !ALLOWED_FILES.some((pattern) => path.matchesGlob(input, pattern))
  })
}

/** The chunks that `file` imports statically, directly or through another chunk. */
function chunksOf(outputs: Metafile['outputs'], file: string, seen = new Set<string>()): Set<string> {
  for (let { path: imported, kind } of outputs[file]?.imports ?? []) {
    if (kind !== 'import-statement' || seen.has(imported)) continue
    seen.add(imported)
    chunksOf(outputs, imported, seen)
  }
  return seen
}

/**
 * Builds the bundles into `outDir` (emptied first), with the compressed copies of the files of
 * `publicDir`, and returns the manifest that it writes.
 */
export async function buildClient(outDir = CLIENT_DIR, publicDir = PUBLIC_DIR): Promise<ClientManifest> {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  let entryPoints = [...ALWAYS, ...clientEntryModules()]
  let result = await build({
    absWorkingDir: ROOT_DIR,
    entryPoints,
    outdir: outDir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    legalComments: 'none',
    target: Object.entries(BROWSER_TARGET).map(([browser, version]) => `${browser}${version}`),
    jsx: 'automatic',
    jsxImportSource: 'remix/component',
    define: { 'process.env.NODE_ENV': '"production"' },
    entryNames: '[name].@[hash]',
    chunkNames: 'chunk.@[hash]',
    metafile: true,
    logLevel: 'warning',
  })
  let forbidden = forbiddenInputs(Object.keys(result.metafile.inputs))
  if (forbidden.length > 0) {
    rmSync(outDir, { recursive: true, force: true })
    throw new Error(`A browser module imports a file that the browser may not get: ${forbidden.join(', ')}`)
  }
  let outputs = result.metafile.outputs
  let manifest: ClientManifest = { entries: {}, files: [], public: compressPublicFiles(outDir, publicDir) }
  for (let [file, output] of Object.entries(outputs)) {
    let absolute = path.join(ROOT_DIR, file)
    writeCopies(absolute, readFileSync(absolute))
    manifest.files.push(path.basename(file))
    if (output.entryPoint) {
      manifest.entries[output.entryPoint] = { file: path.basename(file), imports: [...chunksOf(outputs, file)].map((chunk) => path.basename(chunk)).sort() }
    }
  }
  manifest.files.sort()
  for (let entry of entryPoints) {
    if (!manifest.entries[entry]) throw new Error(`esbuild wrote no bundle for ${entry}`)
  }
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let manifest = await buildClient()
  let sizes = manifest.files.map((file) => {
    let plain = readFileSync(path.join(CLIENT_DIR, file)).byteLength
    let brotli = readFileSync(path.join(CLIENT_DIR, `${file}.br`)).byteLength
    return { file, plain, brotli }
  })
  for (let { file, plain, brotli } of sizes) console.log(`${file.padEnd(32)} ${String(plain).padStart(7)} B  br ${String(brotli).padStart(6)} B`)
  let total = sizes.reduce((sum, size) => ({ plain: sum.plain + size.plain, brotli: sum.brotli + size.brotli }), { plain: 0, brotli: 0 })
  console.log(`${manifest.files.length} files, ${total.plain} B, br ${total.brotli} B: ${path.relative(process.cwd(), CLIENT_DIR) || '.'}`)
  let copies = Object.keys(manifest.public).map((file) => ({
    file,
    plain: readFileSync(path.join(PUBLIC_DIR, file)).byteLength,
    brotli: readFileSync(path.join(CLIENT_DIR, 'public', `${file}.br`)).byteLength,
  }))
  for (let { file, plain, brotli } of copies) console.log(`${file.padEnd(40)} ${String(plain).padStart(7)} B  br ${String(brotli).padStart(6)} B`)
  console.log(`${copies.length} files of public/ compressed`)
}
