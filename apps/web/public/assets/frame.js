// The frame of the screens (REV-91). Under 760 px, "Menu" opens and closes the list of the screens;
// Escape or a click outside closes it. A choice of org applies at once. Without JavaScript, the list
// stays open under the bar and "Switch" posts the org.
// Its names stay in a block: the scripts of a page share one global scope.
{
  const bar = document.querySelector('[data-bar]')
  const menu = document.querySelector('[data-bar-menu]')

  const setOpen = (open) => {
    if (!bar || !menu) return
    bar.classList.toggle('bar-open', open)
    menu.setAttribute('aria-expanded', String(open))
  }

  menu?.addEventListener('click', () => setOpen(menu.getAttribute('aria-expanded') !== 'true'))

  document.addEventListener('keydown', (event) => {
    // An open list (a select, a menu) handles its own Escape first, and marks it handled.
    if (event.defaultPrevented) return
    if (event.key !== 'Escape' || menu?.getAttribute('aria-expanded') !== 'true') return
    setOpen(false)
    menu.focus()
  })

  // composedPath() holds the nodes of the click as they were, even one that a handler removed since.
  document.addEventListener('click', (event) => {
    if (bar && !event.composedPath().includes(bar)) setOpen(false)
  })

  // KNT-150. The menu of the org closes on Escape and on a click outside of it.
  const orgMenu = document.querySelector('details.org-menu')
  if (orgMenu) {
    document.addEventListener('click', (event) => {
      if (orgMenu.open && !event.composedPath().includes(orgMenu)) orgMenu.open = false
    })
    orgMenu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !orgMenu.open) return
      orgMenu.open = false
      orgMenu.querySelector('summary')?.focus()
    })
  }
}
