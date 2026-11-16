import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const SOURCE = readFileSync(new URL('../../public/assets/repos.js', import.meta.url), 'utf8')

/** Runs public/assets/repos.js against a fake page, and gives its timer to the test. */
function load(answer: () => string) {
  let state = { visible: 'hidden', fetches: 0, replaced: null as string | null, cleared: false }
  let tick: (() => Promise<void>) | null = null
  runInNewContext(SOURCE, {
    URL,
    location: { href: 'https://review.test/repos?notice=enabled', replace: (href: string) => (state.replaced = href) },
    document: {
      querySelector: (selector: string) => (selector === '[data-recheck]' ? {} : null),
      get visibilityState() {
        return state.visible
      },
    },
    DOMParser: class {
      parseFromString(html: string) {
        return { querySelector: (selector: string) => (selector === '[data-recheck]' && html.includes('data-recheck') ? {} : null) }
      }
    },
    fetch: async () => {
      state.fetches++
      return { ok: true, redirected: false, text: async () => answer() }
    },
    setInterval: (fn: () => Promise<void>) => ((tick = fn), 1),
    clearInterval: () => (state.cleared = true),
  })
  return { state, tick: () => tick!() }
}

describe('the script of the Repos screen (REV-26)', () => {
  it('uses no try while the tab is hidden, and shows the list when the check ends', async () => {
    let checking = true
    let page = load(() => (checking ? '<span data-recheck="">' : '<table>'))
    for (let i = 0; i < 30; i++) await page.tick()
    assert.equal(page.state.fetches, 0)
    assert.equal(page.state.cleared, false)

    page.state.visible = 'visible'
    await page.tick()
    assert.equal(page.state.fetches, 1)
    assert.equal(page.state.replaced, null)
    checking = false
    await page.tick()
    assert.equal(page.state.replaced, 'https://review.test/repos')
    assert.equal(page.state.cleared, true)
  })

  it('stops after 20 reads on screen, and leaves the link "Reload"', async () => {
    let page = load(() => '<span data-recheck="">')
    page.state.visible = 'visible'
    for (let i = 0; i < 25; i++) await page.tick()
    assert.equal(page.state.fetches, 20)
    assert.equal(page.state.cleared, true)
    assert.equal(page.state.replaced, null)
  })
})
