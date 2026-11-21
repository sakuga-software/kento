// KNT-163 (Fable re-check N-2). The guard of the row menu: armed by a click that closes the menu,
// taken once, and disarmed by the next action of the person.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { focusGuard } from './focus-guard.ts'

describe('the focus guard of the row menu', () => {
  it('drops one focus after a click that closes the menu, and no other', () => {
    let document = new EventTarget()
    let closes = true
    let guard = focusGuard(document, () => closes, new AbortController().signal)
    assert.equal(guard.take(), false)
    document.dispatchEvent(new Event('click'))
    assert.equal(guard.take(), true)
    assert.equal(guard.take(), false, 'once only')
    closes = false
    document.dispatchEvent(new Event('click'))
    assert.equal(guard.take(), false, 'a click that does not close the menu')
  })

  for (let action of ['pointerdown', 'keydown']) {
    it(`is disarmed by the next ${action}, so that a later focus goes through`, () => {
      let document = new EventTarget()
      let guard = focusGuard(document, () => true, new AbortController().signal)
      document.dispatchEvent(new Event('click'))
      document.dispatchEvent(new Event(action))
      assert.equal(guard.take(), false)
    })
  }

  it('stops listening when its component goes', () => {
    let document = new EventTarget()
    let gone = new AbortController()
    let guard = focusGuard(document, () => true, gone.signal)
    gone.abort()
    document.dispatchEvent(new Event('click'))
    assert.equal(guard.take(), false)
  })
})
