// REV-91. The menu "…" of a row on the Repos screen: one open at a time; Escape and a click
// outside close it. Without JavaScript, its summary opens and closes it.
{
  const menus = () => document.querySelectorAll('details.row-menu[open]')

  // An arrow function in a const: a `function` in a block of a classic script also lands on
  // `window` (sloppy mode), and would replace the `close` of confirm.js.
  const closeMenu = (menu, focus) => {
    menu.open = false
    // A confirmation inside starts closed the next time.
    for (const inner of menu.querySelectorAll('details[open]')) inner.open = false
    if (focus) menu.querySelector(':scope > summary')?.focus()
  }

  // A table that scrolls sideways clips what goes past its bottom: it gets the room of the open
  // menu, its confirmation included, and gives it back once the menu is closed.
  const fit = (wrap) => {
    wrap.style.paddingBottom = ''
    const open = wrap.querySelector('details.row-menu[open] > div')
    if (!open || getComputedStyle(wrap).overflowX === 'visible') return
    const past = open.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom
    if (past > 0) wrap.style.paddingBottom = `${Math.ceil(past) + 8}px`
  }

  // `toggle` does not bubble: listen in the capture phase. It comes for the menu and for its confirmation.
  document.addEventListener(
    'toggle',
    (event) => {
      const details = event.target
      if (!(details instanceof HTMLDetailsElement)) return
      const menu = details.closest('details.row-menu')
      if (!menu) return
      if (details === menu) {
        menu.closest('.row-action')?.classList.toggle('row-action-open', menu.open)
        if (menu.open) for (const other of menus()) if (other !== menu) closeMenu(other, false)
      }
      const wrap = menu.closest('.table-wrap')
      if (wrap) fit(wrap)
    },
    true,
  )

  document.addEventListener('click', (event) => {
    // Both read before any change to the page: the nodes of the click, and "Cancel" in a menu.
    const path = event.composedPath()
    const cancel = event.target instanceof Element ? event.target.closest('.row-menu [data-confirm-cancel]') : null
    const cancelled = cancel?.closest('details.row-menu')
    for (const menu of menus()) if (!path.includes(menu)) closeMenu(menu, false)
    // "Cancel" of the confirmation in a menu: the person gives up the action, the menu closes too.
    // After every listener of this click, confirm.js included, whatever their order: the focus ends
    // on the summary of the menu.
    // A menu that something else closed or took away keeps its state, and the focus stays where it is.
    // confirm.js closes only the confirmation (never this menu): e2e/repos.spec.ts, "a click inside the inner confirmation…".
    if (cancelled) setTimeout(() => cancelled.isConnected && cancelled.open && closeMenu(cancelled, true))
  })

  // Back from the next page (bfcache): the page comes back as it was left, a menu open included.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return
    for (const menu of menus()) closeMenu(menu, false)
    for (const cell of document.querySelectorAll('.row-action-open')) cell.classList.remove('row-action-open')
    for (const wrap of document.querySelectorAll('.table-wrap')) wrap.style.paddingBottom = ''
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !(event.target instanceof Element)) return
    // confirm.js closed an open confirmation with this Escape: the next one closes the menu.
    if (event.defaultPrevented) return
    const menu = event.target.closest('details.row-menu[open]')
    if (!menu) return
    event.preventDefault()
    closeMenu(menu, true)
  })
}
