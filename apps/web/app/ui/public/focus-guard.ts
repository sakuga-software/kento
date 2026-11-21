// KNT-163. The guard of the row menu against a late focus (see `RowMenu` in ./row-menu.tsx).

export interface FocusGuard {
  /** True once: the next `focus()` of the button is dropped. */
  take(): boolean
}

/**
 * Listens on `target` (the document) in the capture phase, until `signal` aborts. A `click` that
 * `closesMenu` arms the guard; the next `pointerdown` or `keydown` (a new action of the person)
 * disarms it, so that a later Escape or choice gives the focus back as usual. The disarm is a
 * safety net: the menu takes the guard on every click outside that closes it, and no path is known
 * where it stays armed; a test keeps it.
 */
export function focusGuard(target: EventTarget, closesMenu: (event: Event) => boolean, signal: AbortSignal): FocusGuard {
  let armed = false
  let options = { capture: true, signal }
  target.addEventListener('click', (event) => (armed = closesMenu(event)), options)
  let disarm = () => (armed = false)
  target.addEventListener('pointerdown', disarm, options)
  target.addEventListener('keydown', disarm, options)
  return {
    take() {
      let was = armed
      armed = false
      return was
    },
  }
}
