// KNT-172. A tap during the page transition (KNT-145, kento.css) reaches its target. While a view
// transition runs, the browser draws the two pages in pseudo-elements over the page, and every press
// lands on <html>: `pointer-events: none` on them does not change that (measured in Chromium 156 and
// 158). So a press on <html> during a transition ends the transition at once. A touch then gets its
// real click on the element; a mouse click still goes to <html> (its press was there), so it is
// stopped, and a click with the same keys goes to the element under the press, once the page is back.
// Its names stay in a block: the scripts of a page share one global scope.
{
  // A press waits for its click this long, at most: a press that starts a scroll has no click.
  const WINDOW = 1000
  let revealed = null
  let pending = null

  // The transition of this page, for a browser without document.activeViewTransition. This script is
  // deferred: it may run after `pagereveal`, and then only activeViewTransition knows.
  window.addEventListener('pagereveal', (event) => {
    revealed = event.viewTransition ?? null
    revealed?.finished.finally(() => (revealed = null))
  })

  const running = () => document.activeViewTransition ?? revealed

  // Kentō #36cca6: a page that the browser leaves replays nothing. The replay comes when the click
  // comes (at the release of a mouse button, up to WINDOW after the press), on the page that the
  // transition was showing.
  let leaving = false
  window.addEventListener('pagehide', () => {
    leaving = true
    pending = null
  })
  window.addEventListener('pageshow', () => (leaving = false))

  window.addEventListener(
    'pointerdown',
    (event) => {
      pending = null
      const transition = running()
      if (!transition || event.target !== document.documentElement || !event.isPrimary) return
      transition.skipTransition()
      // Only the main button is replayed: a middle or a right press only ends the transition.
      if (event.button !== 0) return
      const { clientX, clientY, ctrlKey, metaKey, shiftKey, altKey } = event
      pending = { at: event.timeStamp, scroll: [scrollX, scrollY], transition, init: { clientX, clientY, ctrlKey, metaKey, shiftKey, altKey } }
    },
    true,
  )

  window.addEventListener(
    'click',
    (event) => {
      const press = pending
      pending = null
      if (!press || event.target !== document.documentElement || event.timeStamp - press.at > WINDOW) return
      // The click on <html> stops here: the one on the element replaces it.
      event.stopImmediatePropagation()
      // A hurried second click was aimed at the page before: it is not replayed.
      if (event.detail > 1) return
      press.transition.finished.finally(() => {
        // Kentō #160162: a page that scrolled since the press has another element under the point.
        if (leaving || scrollX !== press.scroll[0] || scrollY !== press.scroll[1]) return
        const { clientX, clientY } = press.init
        // Any element: an SVG icon of a link too (the logo, the icons of the repositories).
        const target = document.elementFromPoint(clientX, clientY)
        if (!(target instanceof Element) || target === document.documentElement || target === document.body) return
        // A field takes the focus, as from a real click; a click event alone does not give it.
        const field = target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        if (field instanceof HTMLElement) field.focus()
        // With the keys of the press: Ctrl or Cmd opens a link in a new tab, as it would have.
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, button: 0, ...press.init }))
      })
    },
    true,
  )
}
