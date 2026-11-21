// KNT-172. public/assets/transition.js against a fake page: which presses during a page transition
// go to the element under them. The e2e (e2e/frame.spec.ts) plays it in a browser.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const SOURCE = readFileSync(new URL('../../public/assets/transition.js', import.meta.url), 'utf8')

class FakeMouseEvent {
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown>,
  ) {}
}

/** An element; an SVG icon is one, and is not an HTMLElement. */
class FakeElement {
  events: FakeMouseEvent[] = []
  field: FakeHTMLElement | null = null
  constructor(readonly tag: string) {}
  closest() {
    return this.field
  }
  dispatchEvent(event: FakeMouseEvent) {
    this.events.push(event)
    return true
  }
  get clicks() {
    return this.events.filter((event) => event.type === 'click').length
  }
}

class FakeHTMLElement extends FakeElement {
  focused = false
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
  button?: number
  detail?: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  stopped?: boolean
  stopImmediatePropagation?: () => void
}

class FakeTransition {
  skipped = 0
  done!: () => void
  fail!: (error: Error) => void
  finished = new Promise<void>((resolve, reject) => ((this.done = resolve), (this.fail = reject)))
  skipTransition() {
    this.skipped++
  }
}

/** Runs the script on a fake page, with `transition` as document.activeViewTransition. */
function load({ transition = null as FakeTransition | null, under = null as FakeElement | null } = {}) {
  let listeners = new Map<string, ((event: FakeEvent) => void)[]>()
  let html = new FakeHTMLElement('html')
  let body = new FakeHTMLElement('body')
  let points: [number, number][] = []
  let document = {
    documentElement: html,
    body,
    activeViewTransition: transition,
    elementFromPoint: (x: number, y: number) => (points.push([x, y]), under),
  }
  let window = { addEventListener: (type: string, listener: (event: FakeEvent) => void) => listeners.set(type, [...(listeners.get(type) ?? []), listener]) }
  let context = { Element: FakeElement, HTMLElement: FakeHTMLElement, MouseEvent: FakeMouseEvent, document, window, scrollX: 0, scrollY: 0 }
  runInNewContext(SOURCE, context)
  let fire = (type: string, event: FakeEvent) => {
    event.stopImmediatePropagation = () => (event.stopped = true)
    for (let listener of listeners.get(type) ?? []) listener(event)
    return event
  }
  /** A press of the main button then its click, at (10, 20). */
  let tap = (target: unknown = html, { at = 1000, after = 80, keys = {} as Partial<FakeEvent>, detail = 1 } = {}) => {
    fire('pointerdown', { target, clientX: 10, clientY: 20, timeStamp: at, isPrimary: true, button: 0, ...keys })
    return fire('click', { target, timeStamp: at + after, detail, ...keys })
  }
  /** Ends the transition, and lets the replay run. */
  let finish = async (end: FakeTransition | null = transition) => {
    document.activeViewTransition = null
    end?.done()
    await end?.finished
    await Promise.resolve()
  }
  /** Scrolls the fake window. */
  let scroll = (y: number) => (context.scrollY = y)
  return { document, html, window, fire, tap, finish, points, scroll }
}

describe('a tap during the page transition (KNT-172)', () => {
  it('ends the transition, stops the click on <html>, and clicks the element under the press once the page is back', async () => {
    let transition = new FakeTransition()
    let link = new FakeHTMLElement('a')
    let page = load({ transition, under: link })
    let click = page.tap()
    assert.equal(transition.skipped, 1)
    assert.equal(click.stopped, true)
    assert.equal(link.clicks, 0, 'not before the transition ends: the browser would still send it to <html>')
    await page.finish()
    assert.deepEqual(page.points, [[10, 20]])
    assert.equal(link.clicks, 1)
    let init = link.events[0]!.init
    assert.equal(init.bubbles, true)
    assert.equal(init.cancelable, true)
    assert.equal(init.view, page.window)
    assert.equal(init.button, 0)
    assert.equal(init.detail, 1)
    assert.equal(init.clientX, 10)
    assert.equal(init.clientY, 20)
    assert.equal(link.focused, false)
  })

  it('keeps the keys of the press: Ctrl or Cmd opens the link in a new tab', async () => {
    let transition = new FakeTransition()
    let link = new FakeHTMLElement('a')
    let page = load({ transition, under: link })
    page.tap(page.html, { keys: { ctrlKey: true, metaKey: true, shiftKey: false, altKey: true } })
    await page.finish()
    let init = link.events[0]!.init
    assert.deepEqual([init.ctrlKey, init.metaKey, init.shiftKey, init.altKey], [true, true, false, true])
  })

  it('clicks an SVG icon too, which is no HTMLElement: the click reaches its link', async () => {
    let transition = new FakeTransition()
    let path = new FakeElement('path')
    let page = load({ transition, under: path })
    page.tap()
    await page.finish()
    assert.equal(path.clicks, 1)
  })

  it('gives the focus to a field, as a real click does', async () => {
    let transition = new FakeTransition()
    let input = new FakeHTMLElement('input')
    input.field = input
    let page = load({ transition, under: input })
    page.tap()
    await page.finish()
    assert.equal(input.focused, true)
    assert.equal(input.clicks, 1)
  })

  it('ends the transition on a middle or right press, and replays nothing', async () => {
    let transition = new FakeTransition()
    let link = new FakeHTMLElement('a')
    let page = load({ transition, under: link })
    page.fire('pointerdown', { target: page.html, clientX: 10, clientY: 20, timeStamp: 1000, isPrimary: true, button: 1 })
    assert.equal(transition.skipped, 1)
    assert.equal(page.fire('click', { target: page.html, timeStamp: 1080, detail: 1 }).stopped, undefined)
    await page.finish()
    assert.equal(link.clicks, 0)
  })

  it('replays no hurried second click: it was aimed at the page before', async () => {
    let transition = new FakeTransition()
    let link = new FakeHTMLElement('a')
    let page = load({ transition, under: link })
    assert.equal(page.tap(page.html, { detail: 2 }).stopped, true)
    await page.finish()
    assert.equal(link.clicks, 0)
  })

  it('leaves a press alone with no transition, on an element, or not primary', async () => {
    let link = new FakeHTMLElement('a')
    let none = load({ under: link })
    assert.equal(none.tap().stopped, undefined)

    let transition = new FakeTransition()
    let page = load({ transition, under: link })
    assert.equal(page.tap(link).stopped, undefined, 'the press reached an element: nothing to do')
    page.fire('pointerdown', { target: page.html, clientX: 1, clientY: 1, timeStamp: 1, isPrimary: false, button: 0 })
    assert.equal(page.fire('click', { target: page.html, timeStamp: 2, detail: 1 }).stopped, undefined, 'a second finger')
    assert.equal(transition.skipped, 0)
    await page.finish()
    assert.equal(link.clicks, 0)
  })

  it('replays nothing when the real click reached the element (a touch after the end of the transition)', async () => {
    let transition = new FakeTransition()
    let link = new FakeHTMLElement('a')
    let page = load({ transition, under: link })
    page.fire('pointerdown', { target: page.html, clientX: 10, clientY: 20, timeStamp: 1000, isPrimary: true, button: 0 })
    assert.equal(page.fire('click', { target: link, timeStamp: 1080, detail: 1 }).stopped, undefined)
    await page.finish()
    assert.equal(link.clicks, 0, 'the browser gave the click: a replay would activate the link twice')
  })

  it('forgets a press with no click: a scroll, or a click too late, or one after another press', async () => {
    let transition = new FakeTransition()
    let link = new FakeHTMLElement('a')
    let page = load({ transition, under: link })
    assert.equal(page.tap(page.html, { after: 1500 }).stopped, undefined, 'a click 1.5 s later is not that tap')
    page.fire('pointerdown', { target: page.html, clientX: 1, clientY: 1, timeStamp: 3000, isPrimary: true, button: 0 })
    page.fire('pointerdown', { target: link, clientX: 1, clientY: 1, timeStamp: 3100, isPrimary: true, button: 0 })
    assert.equal(page.fire('click', { target: page.html, timeStamp: 3200, detail: 1 }).stopped, undefined)
    await page.finish()
    assert.equal(link.clicks, 0)
  })

  it('replays nothing on a page that the browser left before the transition ended (Kentō #36cca6)', async () => {
    let transition = new FakeTransition()
    let link = new FakeHTMLElement('a')
    let page = load({ transition, under: link })
    assert.equal(page.tap().stopped, true)
    page.fire('pagehide', { target: null, timeStamp: 1100 })
    await page.finish()
    assert.equal(link.clicks, 0)
    // Back from the cache of the browser, the page handles the next tap again.
    let next = new FakeTransition()
    page.document.activeViewTransition = next
    page.fire('pageshow', { target: null, timeStamp: 5000 })
    page.tap(page.html, { at: 6000 })
    await page.finish(next)
    assert.equal(link.clicks, 1)
  })

  it('replays nothing when the page scrolled between the press and the end of the transition (Kentō #160162)', async () => {
    let transition = new FakeTransition()
    let link = new FakeHTMLElement('a')
    let page = load({ transition, under: link })
    assert.equal(page.tap().stopped, true)
    page.scroll(120)
    await page.finish()
    assert.equal(link.clicks, 0)
  })

  it('replays the click when `finished` rejects, with no unhandled rejection (Kentō #2d9c39)', async () => {
    let unhandled: unknown[] = []
    let track = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', track)
    try {
      let transition = new FakeTransition()
      let link = new FakeHTMLElement('a')
      let page = load({ transition, under: link })
      page.tap()
      page.document.activeViewTransition = null
      transition.fail(new Error('the update callback threw'))
      await transition.finished.catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(link.clicks, 1)
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', track)
    }
  })

  it('clicks nothing when the press was over no element of the page', async () => {
    let transition = new FakeTransition()
    let page = load({ transition, under: null })
    page.tap()
    await page.finish()
    assert.deepEqual(page.points, [[10, 20]])
  })
})
