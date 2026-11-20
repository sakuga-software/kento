// KNT-144. public/assets/progress.js against a fake page: which clicks and submits show the bar.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const SOURCE = readFileSync(new URL('../../public/assets/progress.js', import.meta.url), 'utf8')

class FakeElement {
  attributes = new Map<string, string>()
  constructor(attributes: Record<string, string> = {}) {
    for (let [name, value] of Object.entries(attributes)) this.attributes.set(name, value)
  }
  hasAttribute(name: string) {
    return this.attributes.has(name)
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
}

class FakeLink extends FakeElement {
  get href() {
    return new URL(this.getAttribute('href') ?? '', 'https://review.test/repos?page=2').href
  }
  get target() {
    return this.getAttribute('target') ?? ''
  }
  closest(selector: string) {
    return selector === 'a[href]' && this.hasAttribute('href') ? this : null
  }
}

class FakeForm extends FakeElement {
  get target() {
    return this.getAttribute('target') ?? ''
  }
  get method() {
    return this.getAttribute('method') ?? 'get'
  }
}

interface FakeEvent {
  target: unknown
  defaultPrevented: boolean
  button?: number
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  submitter?: FakeElement | null
  persisted?: boolean
}

/** Runs the script on a fake page. `bars()` counts the bars in the body; `run()` fires the timers. */
function load() {
  let listeners = new Map<string, ((event: FakeEvent) => void)[]>()
  let on = (type: string, listener: (event: FakeEvent) => void) => listeners.set(type, [...(listeners.get(type) ?? []), listener])
  let body: FakeElement[] = []
  let timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  runInNewContext(SOURCE, {
    URL,
    Element: FakeElement,
    HTMLFormElement: FakeForm,
    location: { href: 'https://review.test/repos?page=2', origin: 'https://review.test', pathname: '/repos', search: '?page=2' },
    window: { addEventListener: on },
    document: {
      addEventListener: on,
      createElement: () => {
        let element = new FakeElement() as FakeElement & { className: string; remove: () => void }
        element.remove = () => body.splice(body.indexOf(element), 1)
        return element
      },
      body: { append: (element: FakeElement) => body.push(element) },
    },
    setTimeout: (fn: () => void, ms = 0) => (timers.set(next, { fn, ms }), next++),
    clearTimeout: (id: number) => timers.delete(id),
  })
  let fire = (type: string, event: FakeEvent) => {
    for (let listener of listeners.get(type) ?? []) listener(event)
  }
  /** Runs the timers of at most `upTo` ms, as the browser would once the handlers of the event ran. */
  let run = (upTo = 0) => {
    for (let [id, timer] of timers) {
      if (timer.ms > upTo) continue
      timers.delete(id)
      timer.fn()
    }
  }
  let click = (attributes: Record<string, string>, event: Partial<FakeEvent> = {}) => {
    fire('click', { target: new FakeLink(attributes), defaultPrevented: false, button: 0, ...event })
    run()
  }
  let submit = (attributes: Record<string, string>, event: Partial<FakeEvent> = {}) => {
    fire('submit', { target: new FakeForm(attributes), defaultPrevented: false, submitter: null, ...event })
    run()
  }
  return { bars: () => body.filter((element) => (element as unknown as { className: string }).className === 'nav-progress').length, click, submit, fire, run }
}

describe('the bar of a navigation (KNT-144)', () => {
  it('shows one bar for a click on a link to another page of Kentō', () => {
    let page = load()
    page.click({ href: '/findings' })
    assert.equal(page.bars(), 1)
    page.click({ href: '/runners' })
    assert.equal(page.bars(), 1, 'a second click replaces the bar')
  })

  it('shows none for a link that this window does not follow to another page', () => {
    let page = load()
    page.click({ href: 'https://github.com/sakuga-software' })
    page.click({ href: '/findings', target: '_blank' })
    page.click({ href: '/findings', download: '' })
    page.click({ href: '#runners' })
    page.click({ href: '/repos?page=2#top' })
    page.click({ href: '/findings' }, { metaKey: true })
    page.click({ href: '/findings' }, { ctrlKey: true })
    page.click({ href: '/findings' }, { shiftKey: true })
    page.click({ href: '/findings' }, { button: 1 })
    page.click({})
    assert.equal(page.bars(), 0)
  })

  it('shows one for a link to the same path with another query', () => {
    let page = load()
    page.click({ href: '/repos?page=3' })
    assert.equal(page.bars(), 1)
  })

  it('shows none when another script cancels the click or the submit', () => {
    let page = load()
    page.click({ href: '/findings' }, { defaultPrevented: true })
    page.submit({ method: 'post' }, { defaultPrevented: true })
    assert.equal(page.bars(), 0)
  })

  it('shows one for the submit of a form, and none for a form of a dialog or of another window', () => {
    let page = load()
    page.submit({ method: 'dialog' })
    page.submit({ method: 'post', target: '_blank' })
    page.submit({ method: 'post' }, { submitter: new FakeElement({ formtarget: '_blank' }) })
    assert.equal(page.bars(), 0)
    page.submit({ method: 'post' })
    assert.equal(page.bars(), 1)
  })

  it('takes the bar away after 30 s, and when the page comes back from the cache of the browser', () => {
    let page = load()
    page.click({ href: '/findings' })
    page.run(29_999)
    assert.equal(page.bars(), 1)
    page.run(30_000)
    assert.equal(page.bars(), 0)

    page.click({ href: '/findings' })
    page.fire('pageshow', { target: null, defaultPrevented: false, persisted: false })
    assert.equal(page.bars(), 1, 'a first load keeps it')
    page.fire('pageshow', { target: null, defaultPrevented: false, persisted: true })
    assert.equal(page.bars(), 0)
  })
})
