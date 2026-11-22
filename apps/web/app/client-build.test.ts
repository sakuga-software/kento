// KNT-170. The bundles of the browser modules: scripts/build-client.ts builds them, and the service
// serves them compressed under /assets/js/, a file of the build and nothing else.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { buildClient, clientEntryModules, forbiddenInputs } from '../scripts/build-client.ts'
import { BOOT, CHART, createClientEntries, loadClientBuild, resolveBootScript, resolveCharts, RUNTIME } from './assets.ts'
import { bundleOf, readClientBuild, ROOT_DIR, serveClientFile, sourceOf, type ClientBuild } from './client-build.ts'

/** Runs `body` with the lines that the service writes on stderr, and returns them. */
async function stderrOf(body: () => Promise<void> | void): Promise<string[]> {
  let lines: string[] = []
  let write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write
  try {
    await body()
  } finally {
    process.stderr.write = write
  }
  return lines
}

/** A build of two files in a folder of its own: a.js (with its .br and .gz) and a chunk. */
function fakeBuild(): ClientBuild & { cleanup: () => void } {
  let dir = mkdtempSync(path.join(tmpdir(), 'kento-client-'))
  writeFileSync(path.join(dir, 'a.@AAA.js'), 'plain')
  writeFileSync(path.join(dir, 'a.@AAA.js.br'), 'brotli')
  writeFileSync(path.join(dir, 'a.@AAA.js.gz'), 'gzip')
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    entries: {
      'app/ui/public/a.tsx': { file: 'a.@AAA.js', imports: ['chunk.@C.js'] },
      [RUNTIME]: { file: 'runtime.@R.js', imports: ['chunk.@C.js', 'chunk.@D.js'] },
      [BOOT]: { file: 'boot.@B.js', imports: [] },
    },
    files: ['a.@AAA.js', 'boot.@B.js', 'chunk.@C.js', 'chunk.@D.js', 'runtime.@R.js'],
  }))
  for (let file of ['boot.@B.js', 'chunk.@C.js', 'chunk.@D.js', 'runtime.@R.js']) {
    for (let suffix of ['', '.br', '.gz']) writeFileSync(path.join(dir, file + suffix), file)
  }
  return { ...(readClientBuild(dir) as ClientBuild), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Request(`https://review.sakuga.dev${path}`, { method, headers })
}

describe('the bundles of the browser modules (KNT-170)', () => {
  it('names an entry by its source, from the URL of a clientEntry or a path', () => {
    let url = pathToFileURL(path.join(ROOT_DIR, 'app/ui/public/row-menu.tsx')).href
    assert.equal(sourceOf(`${url}#RowMenu`), 'app/ui/public/row-menu.tsx')
    assert.equal(sourceOf(url), 'app/ui/public/row-menu.tsx')
    assert.equal(sourceOf('app/ui/public/boot.ts'), 'app/ui/public/boot.ts')
  })

  it('gives the URL of a bundle and of its chunks, and refuses an entry that the build does not know', () => {
    let build = fakeBuild()
    try {
      assert.deepEqual(bundleOf(build, 'app/ui/public/a.tsx#A'), { href: '/assets/js/a.@AAA.js', preloads: ['/assets/js/chunk.@C.js'] })
      assert.throws(() => bundleOf(build, 'app/ui/public/missing.tsx'), /No bundle for app\/ui\/public\/missing\.tsx/)
      for (let key of ['constructor', '__proto__', 'toString']) assert.throws(() => bundleOf(build, key), /No bundle for/, key)
    } finally {
      build.cleanup()
    }
  })

  it('preloads the runtime and every chunk of the page once, with no import map; boot.ts and the runtime come from the build', async () => {
    let build = fakeBuild()
    try {
      let entry = await createClientEntries(build).getScriptEntry(`${pathToFileURL(path.join(ROOT_DIR, 'app/ui/public/a.tsx')).href}#A`)
      assert.equal(entry.href, '/assets/js/a.@AAA.js')
      assert.deepEqual(entry.preloads, ['/assets/js/runtime.@R.js', '/assets/js/chunk.@C.js', '/assets/js/chunk.@D.js'])
      assert.deepEqual(entry.importMap, { imports: {} })
      let boot = await resolveBootScript({ getHref: async () => assert.fail('the asset server is not asked') }, build)
      assert.deepEqual(boot, { href: '/assets/js/boot.@B.js', runtime: '/assets/js/runtime.@R.js' })
    } finally {
      build.cleanup()
    }
  })

  it('renders the charts with the bundles only when the build holds the chart component (KNT-188)', async () => {
    let build = fakeBuild()
    let server = { getHref: async () => assert.fail('the asset server is not asked'), getImportMap: async () => assert.fail('the asset server is not asked') }
    let withCharts: ClientBuild = { ...build, manifest: { ...build.manifest, entries: { ...build.manifest.entries, [CHART]: { file: 'a.@AAA.js', imports: [] } } } }
    try {
      let answers: boolean[] = []
      let lines = await stderrOf(async () => {
        answers.push(await resolveCharts(server, build))
        answers.push(await resolveCharts(server, withCharts))
      })
      assert.deepEqual(answers, [false, true])
      assert.equal(lines.length, 1)
      assert.match(lines[0]!, /startup\.assets_unavailable/)
    } finally {
      build.cleanup()
    }
  })

  it('serves brotli, gzip or the plain file as the browser accepts, with a cache of a year', async () => {
    let build = fakeBuild()
    try {
      let cases: [Record<string, string>, string, string | null][] = [
        [{ 'Accept-Encoding': 'gzip, deflate, br, zstd' }, 'brotli', 'br'],
        [{ 'Accept-Encoding': 'gzip, deflate' }, 'gzip', 'gzip'],
        [{ 'Accept-Encoding': 'br;q=0.5, gzip;q=1' }, 'gzip', 'gzip'],
        [{ 'Accept-Encoding': 'br;q=0, gzip;q=0' }, 'plain', null],
        [{ 'Accept-Encoding': 'identity' }, 'plain', null],
        [{}, 'plain', null],
      ]
      for (let [headers, body, encoding] of cases) {
        let response = (await serveClientFile(build, get('/assets/js/a.@AAA.js', headers), '/assets/js/a.@AAA.js'))!
        assert.equal(response.status, 200)
        assert.equal(await response.text(), body, JSON.stringify(headers))
        assert.equal(response.headers.get('Content-Encoding'), encoding)
        assert.equal(response.headers.get('Content-Length'), String(body.length))
        assert.equal(response.headers.get('Content-Type'), 'text/javascript; charset=utf-8')
        assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
        assert.equal(response.headers.get('Vary'), 'Accept-Encoding')
        assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
      }
      let head = (await serveClientFile(build, get('/assets/js/a.@AAA.js', { 'Accept-Encoding': 'br' }, 'HEAD'), '/assets/js/a.@AAA.js'))!
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('Content-Length'), '6')
      assert.equal(await head.text(), '')
      for (let name of ['a.@AAA.js', 'unknown.js']) {
        let post = (await serveClientFile(build, get(`/assets/js/${name}`, {}, 'POST'), `/assets/js/${name}`))!
        assert.equal(post.status, 405, name)
      }
    } finally {
      build.cleanup()
    }
  })

  it('answers 404 for any file that the manifest does not list, and null outside /assets/js/', async () => {
    let build = fakeBuild()
    try {
      for (let name of ['manifest.json', 'a.@AAA.js.br', 'a.@OLD.js', '../manifest.json', '..%2Fmanifest.json', 'sub/a.@AAA.js', '']) {
        let response = (await serveClientFile(build, get(`/assets/js/${name}`), `/assets/js/${name}`))!
        assert.equal(response.status, 404, name)
      }
      assert.equal(await serveClientFile(build, get('/assets/kento.css'), '/assets/kento.css'), null)
      // Kentō #048c24: a file of the manifest gone from the folder since startup: 404 and an error.
      rmSync(path.join(build.dir, 'a.@AAA.js.br'))
      let gone: Response | null = null
      let lines = await stderrOf(async () => {
        gone = await serveClientFile(build, get('/assets/js/a.@AAA.js', { 'Accept-Encoding': 'br' }), '/assets/js/a.@AAA.js')
      })
      assert.equal(gone!.status, 404)
      let line = JSON.parse(lines[0]!)
      assert.deepEqual([line.level, line.event, line.file], ['error', 'assets.client_file_unreadable', 'a.@AAA.js'])
    } finally {
      build.cleanup()
    }
  })

  it('reads no build outside production, and logs an error in production when there is none', async () => {
    let empty = mkdtempSync(path.join(tmpdir(), 'kento-client-'))
    try {
      assert.equal(readClientBuild(empty), null)
      assert.deepEqual(await stderrOf(() => assert.equal(loadClientBuild(false, empty), null)), [])
      let lines = await stderrOf(() => assert.equal(loadClientBuild(true, empty), null))
      assert.equal(lines.length, 1)
      let line = JSON.parse(lines[0]!)
      assert.deepEqual([line.level, line.event, line.dir], ['error', 'startup.client_build_missing', empty])
      // Kentō #18d066: a build that lacks a file it lists is refused, with the files it lacks.
      let partial = fakeBuild()
      try {
        rmSync(path.join(partial.dir, 'chunk.@C.js.gz'))
        rmSync(path.join(partial.dir, 'runtime.@R.js'))
        assert.deepEqual(readClientBuild(partial.dir), { missing: ['chunk.@C.js.gz', 'runtime.@R.js'] })
        let refused = await stderrOf(() => assert.equal(loadClientBuild(true, partial.dir), null))
        let logged = JSON.parse(refused[0]!)
        assert.deepEqual([logged.event, logged.missing], ['startup.client_build_incomplete', ['chunk.@C.js.gz', 'runtime.@R.js']])
        // Kentō #9505b4: a manifest that does not read (a truncated copy) is refused, logged.
        writeFileSync(path.join(partial.dir, 'manifest.json'), '{"entries": {')
        assert.ok('invalid' in (readClientBuild(partial.dir) as object))
        let broken = await stderrOf(() => assert.equal(loadClientBuild(true, partial.dir), null))
        assert.equal(JSON.parse(broken[0]!).event, 'startup.client_build_invalid')
        // Kentō #1295f7: parsed, but of the wrong shape.
        let shapes: [unknown, string][] = [
          [{ entries: {} }, 'no files'],
          [{ entries: [], files: [] }, 'no entries'],
          [{ entries: { 'app/a.ts': { file: 'a.js' } }, files: ['a.js'] }, 'a wrong entry: app/a.ts'],
          [{ entries: { 'app/a.ts': { file: 'a.js', imports: ['c.js'] } }, files: ['a.js'] }, 'a wrong entry: app/a.ts'],
          [{ entries: { 'app/a.ts': { file: 'b.js', imports: [] } }, files: ['a.js'] }, 'a wrong entry: app/a.ts'],
          [{ entries: {}, files: ['../secret.js'] }, 'a wrong file name: ../secret.js'],
          [{ entries: {}, files: ['sub/a.js'] }, 'a wrong file name: sub/a.js'],
          [{ entries: {}, files: ['manifest.json'] }, 'a wrong file name: manifest.json'],
          [{ entries: {}, files: ['..js'] }, 'a wrong file name: ..js'],
        ]
        for (let [manifest, problem] of shapes) {
          writeFileSync(path.join(partial.dir, 'manifest.json'), JSON.stringify(manifest))
          assert.deepEqual(readClientBuild(partial.dir), { invalid: problem }, JSON.stringify(manifest))
        }
        let whole = fakeBuild()
        try {
          assert.equal(loadClientBuild(true, whole.dir)?.files.size, 5)
        } finally {
          whole.cleanup()
        }
      } finally {
        partial.cleanup()
      }
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('keeps the rule of the asset server: a bundle holds only the browser modules, the routes, the controls, the icons, the runtime packages and Chart.js', () => {
    let allowed = [
      'app/ui/public/row-menu.tsx',
      'app/routes.ts',
      'app/ui/controls.tsx',
      'app/ui/lucide.tsx',
      '../../node_modules/.pnpm/remix@3.2.0/node_modules/remix/dist/component.js',
      '../../node_modules/.pnpm/remix@3.2.0/node_modules/@remix-run/component/dist/lib/vdom.js',
      '../../node_modules/.pnpm/@remix-run+ui@0.13.1/node_modules/@remix-run/ui/dist/menu.js',
      '../../node_modules/.pnpm/chart.js@4.6.1/node_modules/chart.js/dist/chart.js',
      '../../node_modules/.pnpm/@kurkle+color@0.3.4/node_modules/@kurkle/color/dist/color.esm.js',
    ]
    let refused = [
      'app/db/schema.ts',
      'app/auth/store.ts',
      'app/ui/public/row-menu.test.ts',
      'server.ts',
      '../../node_modules/.pnpm/postgres@4.1.1/node_modules/postgres/src/index.js',
      '../../node_modules/.pnpm/better-auth@1.7.26/node_modules/better-auth/dist/index.js',
    ]
    assert.deepEqual(forbiddenInputs([...allowed, ...refused]), refused)
  })

  it('builds boot.ts, the runtime and every component that hydrates, minified, with their brotli and gzip copies', async () => {
    let dir = mkdtempSync(path.join(tmpdir(), 'kento-client-'))
    try {
      let manifest = await buildClient(dir)
      let modules = clientEntryModules()
      assert.ok(modules.includes('app/ui/public/row-menu.tsx') && modules.includes('app/ui/public/confirm.tsx') && modules.includes('app/ui/public/chart.tsx'), modules.join(', '))
      assert.ok(!modules.some((module) => module.includes('.test.')))
      assert.deepEqual(Object.keys(manifest.entries).sort(), [BOOT, RUNTIME, ...modules].sort())
      for (let file of manifest.files) {
        assert.match(file, /^[a-z-]+\.@[A-Z0-9]+\.js$/)
        let plain = readFileSync(path.join(dir, file))
        assert.deepEqual(brotliDecompressSync(readFileSync(path.join(dir, `${file}.br`))), plain, file)
        assert.deepEqual(gunzipSync(readFileSync(path.join(dir, `${file}.gz`))), plain, file)
        let text = plain.toString('utf8')
        // Bundled: no import of a bare package or of the asset server, no source map, no test.
        assert.ok(!/from\s*["'](?:remix\/|@remix-run\/|chart\.js|@kurkle\/)/.test(text) && !text.includes('/assets/app/') && !text.includes('sourceMappingURL'), file)
      }
      // One copy of the runtime of remix/component: the components share the chunks of the runtime.
      let runtime = manifest.entries[RUNTIME]!
      for (let module of modules) {
        for (let chunk of runtime.imports) assert.ok(manifest.entries[module]!.imports.includes(chunk), `${module} imports ${chunk}`)
      }
      // Built twice from the same source: the same names (the cache of the browsers holds).
      let again = await buildClient(dir)
      assert.deepEqual(again, manifest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
