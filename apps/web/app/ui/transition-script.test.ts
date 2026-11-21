// KNT-172. public/assets/transition.js against a fake page: which presses during a page transition
// go to the element under them. The e2e (e2e/frame.spec.ts) plays it in a browser.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const SOURCE = readFileSync(new URL('../../public/assets/transition.js', import.meta.url), 'utf8')

class FakeElement {
  clicks = 0
  focused = false
  constructor(
    readonly tag: string,
    readonly field: FakeElement | null = null,
  ) {}
  closest() {
    return this.field
  }
  click() {
    this.clicks++
  }
  focus() {
    this.focused = true
  }
}

interface FakeEvent {
  target: unknown
  clientX?: number
  clientY?: number
  timeStamp: number
  isPrimary?: boolean
  stopped?: boolean
  stopImmediatePropagation?: () => void
}

class FakeTransition {
  skipped = 0
  done!: () => void
  finished = new Promise<void>((resolve) => (this.done = resolve))
  skipTransition() {
    this.skipped++
  }
}

/** Runs the script on a fake page, with `transition` as document.activeViewTransition. */
function load({ transition = null as FakeTransition | null, under = null as FakeElement | null } = {}) {
  let listeners = new Map<string, ((event: FakeEvent) => void)[]>()
  let html = new FakeElement('html')
  let body = new FakeElement('body')
  let points: [number, number][] = []
  let document = {
    documentElement: html,
    body,
    activeViewTransition: transition,
    elementFromPoint: (x: number, y: number) => (points.push([x, y]), under),
  }
  runInNewContext(SOURCE, {
    HTMLElement: FakeElement,
    document,
    window: { addEventListener: (type: string, listener: (event: FakeEvent) => void) => listeners.set(type, [...(listeners.get(type) ?? []), listener]) },
  })
  let fire = (type: string, event: FakeEvent) => {
    event.stopImmediatePropagation = () => (event.stopped = true)
    for (let listener of listeners.get(type) ?? []) listener(event)
    return event
  }
  /** A press then its click, at (10, 20). */
  let tap = (target: unknown = html, { at = 1000, after = 80 } = {}) => {
    fire('pointerdown', { target, clientX: 10, clientY: 20, timeStamp: at, isPrimary: true })
    return fire('click', { target, timeStamp: at + after })
  }
  return { document, html, fire, tap, points }
}

describe('a tap during the page transition (KNT-172)', () => {
  it('ends the transition, stops the click on <html>, and clicks the element under the press once the page is back', async () => {
    let transition = new FakeTransition()
    let link = new FakeElement('a')
    let page = load({ transition, under: link })
    let click = page.tap()
    assert.equal(transition.skipped, 1)
    assert.equal(click.stopped, true)
    assert.equal(link.clicks, 0, 'not before the transition ends: the browser would still send it to <html>')
    page.document.activeViewTransition = null
    transition.done()
    await transition.finished
    await Promise.resolve()
    assert.deepEqual(page.points, [[10, 20]])
    assert.equal(link.clicks, 1)
    assert.equal(link.focused, false)
  })

  it('gives the focus to a field, as a real click does', async () => {
    let transition = new FakeTransition()
    let input = new FakeElement('input')
    input.closest = () => input
    let page = load({ transition, under: input })
    page.tap()
    transition.done()
    await transition.finished
    await Promise.resolve()
    assert.equal(input.focused, true)
    assert.equal(input.clicks, 1)
  })

  it('leaves a press alone with no transition, on an element, or not primary', async () => {
    let link = new FakeElement('a')
    let none = load({ under: link })
    assert.equal(none.tap().stopped, undefined)

    let transition = new FakeTransition()
    let page = load({ transition, under: link })
    assert.equal(page.tap(link).stopped, undefined, 'the press reached an element: nothing to do')
    page.fire('pointerdown', { target: page.html, clientX: 1, clientY: 1, timeStamp: 1, isPrimary: false })
    assert.equal(page.fire('click', { target: page.html, timeStamp: 2 }).stopped, undefined, 'a second finger')
    assert.equal(transition.skipped, 0)
    transition.done()
    await transition.finished
    await Promise.resolve()
    assert.equal(link.clicks, 0)
  })

  it('forgets a press with no click: a scroll, or a click too late, or one after another press', async () => {
    let transition = new FakeTransition()
    let link = new FakeElement('a')
    let page = load({ transition, under: link })
    assert.equal(page.tap(page.html, { after: 1500 }).stopped, undefined, 'a click 1.5 s later is not that tap')
    page.fire('pointerdown', { target: page.html, clientX: 1, clientY: 1, timeStamp: 3000, isPrimary: true })
    page.fire('pointerdown', { target: link, clientX: 1, clientY: 1, timeStamp: 3100, isPrimary: true })
    assert.equal(page.fire('click', { target: page.html, timeStamp: 3200 }).stopped, undefined)
    transition.done()
    await transition.finished
    await Promise.resolve()
    assert.equal(link.clicks, 0)
  })

  it('replays nothing on a page that the browser left before the transition ended (Kentō #36cca6)', async () => {
    let transition = new FakeTransition()
    let link = new FakeElement('a')
    let page = load({ transition, under: link })
    assert.equal(page.tap().stopped, true)
    page.fire('pagehide', { target: null, timeStamp: 1100 })
    transition.done()
    await transition.finished
    await Promise.resolve()
    assert.equal(link.clicks, 0)
    // Back from the cache of the browser, the page handles the next tap again.
    let next = new FakeTransition()
    page.document.activeViewTransition = next
    page.fire('pageshow', { target: null, timeStamp: 5000 })
    page.tap(page.html, { at: 6000 })
    next.done()
    await next.finished
    await Promise.resolve()
    assert.equal(link.clicks, 1)
  })

  it('clicks nothing when the press was over no element of the page', async () => {
    let transition = new FakeTransition()
    let page = load({ transition, under: null })
    page.tap()
    transition.done()
    await transition.finished
    await Promise.resolve()
    assert.deepEqual(page.points, [[10, 20]])
  })
})
