// KNT-172. A tap during the page transition (KNT-145, kento.css) reaches its target. While a view
// transition runs, the browser draws the two pages in pseudo-elements over the page, and every press
// lands on <html>: `pointer-events: none` on them does not change that (measured in Chromium 158).
// So a press on <html> during a transition ends the transition at once, and the click that follows
// goes to the element under the press, once the page is back.
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

  // Kentō #36cca6: a page that the browser leaves replays nothing. The replay comes one frame after
  // the press, on the page that the transition was showing: its elements are where the person saw them.
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
      pending = { x: event.clientX, y: event.clientY, at: event.timeStamp, transition }
      transition.skipTransition()
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
      press.transition.finished.finally(() => {
        if (leaving) return
        const target = document.elementFromPoint(press.x, press.y)
        if (!(target instanceof HTMLElement) || target === document.documentElement || target === document.body) return
        // A field takes the focus, as from a real click; click() alone does not give it.
        const field = target.closest('input, textarea, select, [contenteditable="true"]')
        if (field instanceof HTMLElement) field.focus()
        target.click()
      })
    },
    true,
  )
}
