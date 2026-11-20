// KNT-143. public/assets/heroui.css is built from styles/heroui.css and committed: the service has
// no build step. This test builds it again and fails when the committed file is stale.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const WEB = fileURLToPath(new URL('../../', import.meta.url))
const COMMITTED = readFileSync(join(WEB, 'public/assets/heroui.css'), 'utf8')

function cli(): string {
  let pkg = createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json')
  let bin = (JSON.parse(readFileSync(pkg, 'utf8')) as { bin: Record<string, string> }).bin.tailwindcss!
  return join(dirname(pkg), bin)
}

describe('public/assets/heroui.css', () => {
  it('is the build of styles/heroui.css (run `pnpm -F @sakuga-review/web css:build`)', () => {
    let dir = mkdtempSync(join(tmpdir(), 'kento-heroui-'))
    try {
      let out = join(dir, 'heroui.css')
      execFileSync(process.execPath, [cli(), '--input', 'styles/heroui.css', '--output', out, '--minify'], { cwd: WEB, stdio: 'pipe' })
      assert.ok(readFileSync(out, 'utf8') === COMMITTED, 'public/assets/heroui.css is stale: run pnpm -F @sakuga-review/web css:build')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('has no preflight and no utility class: only the controls of HeroUI, in cascade layers', () => {
    // The preflight of Tailwind would reset every element of the app.
    assert.doesNotMatch(COMMITTED, /\*,:after,:before,::backdrop\{box-sizing:border-box;border:0 solid/)
    assert.doesNotMatch(COMMITTED, /\bhtml,:host\{/)
    // `source(none)`: the classes of the screens make no utility.
    assert.doesNotMatch(COMMITTED, /\.flex\{|\.hidden\{|\.w-full\{/)
    assert.match(COMMITTED, /^\/\*! tailwindcss v4\.3\.5 \| MIT License/)
    assert.match(COMMITTED, /\/\*! HeroUI styles 3\.2\.7 \(Apache-2\.0/)
    for (let block of ['.button', '.button--primary', '.input', '.textarea', '.select__trigger', '.checkbox__control', '.radio__control', '.label', '.description']) {
      assert.ok(COMMITTED.includes(`${block}{`) || COMMITTED.includes(`${block},`) || COMMITTED.includes(`${block}:`), block)
    }
  })

  it('takes its colours from the tokens of kento.css, not from a palette of its own', () => {
    assert.match(COMMITTED, /--accent:var\(--action\)/)
    assert.match(COMMITTED, /--danger:var\(--shu\)/)
    assert.match(COMMITTED, /--field-background:var\(--paper-raised\)/)
    assert.doesNotMatch(COMMITTED, /oklch\(/)
  })
})
