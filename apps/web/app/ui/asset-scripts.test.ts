// The scripts of public/assets are classic scripts: the scripts of a page share one global scope.
// Each keeps its names in a block, and declares no `function`: in sloppy mode a `function` in a
// block also lands on `window`, where it replaces the one of another script (REV-91 found
// row-menu.js replacing the `close` of confirm.js).
import { readdirSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const DIR = new URL('../../public/assets/', import.meta.url)
const SCRIPTS = readdirSync(DIR).filter((name) => name.endsWith('.js'))

/** The code of a script, without the comment lines at its top. */
function codeOf(name: string): string {
  return readFileSync(new URL(name, DIR), 'utf8').replace(/^(?:\/\/.*\n)+/, '')
}

describe('the scripts of public/assets', () => {
  it('are found', () => {
    assert.ok(SCRIPTS.length >= 8, SCRIPTS.join(', '))
  })

  for (let name of SCRIPTS) {
    it(`${name} keeps its names in one block and declares no function`, () => {
      let code = codeOf(name)
      assert.match(code, /^\{\n/, `${name} starts with a block`)
      assert.match(code, /\n\}\n$/, `${name} ends its block`)
      assert.doesNotMatch(code, /^\s*(?:async\s+)?function[\s*]/m, `${name} declares a function`)
    })
  }

  it('leaves no name of its own on the global object, all of them in one page', () => {
    // Every script runs in the same context, as on a page; a DOM that has nothing in it.
    let element: unknown = new Proxy(function () {}, {
      get: (_target, key) => (key === Symbol.iterator ? [][Symbol.iterator] : key === Symbol.toPrimitive ? () => '' : element),
      apply: () => element,
    })
    let global: Record<string, unknown> = {
      document: element,
      window: element,
      location: { href: 'https://review.test/', hash: '', protocol: 'https:' },
      navigator: element,
      URL,
      setInterval: () => 0,
      setTimeout: () => 0,
      clearInterval: () => {},
      getComputedStyle: () => element,
    }
    let before = new Set(Object.keys(global))
    for (let name of SCRIPTS) runInNewContext(readFileSync(new URL(name, DIR), 'utf8'), global, { filename: name })
    assert.deepEqual(Object.keys(global).filter((key) => !before.has(key)), [])
  })
})
