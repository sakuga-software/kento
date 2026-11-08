// The frame of the screens (REV-91). Under 760 px, « Menu » opens and closes the list of the screens;
// Échap or a click outside closes it. A choice of org applies at once. Without JavaScript, the list
// stays open under the bar and « Changer » posts the org.
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
    if (event.key !== 'Escape' || menu?.getAttribute('aria-expanded') !== 'true') return
    setOpen(false)
    menu.focus()
  })

  // composedPath() holds the nodes of the click as they were, even one that a handler removed since.
  document.addEventListener('click', (event) => {
    if (bar && !event.composedPath().includes(bar)) setOpen(false)
  })

  document.addEventListener('change', (event) => {
    const select = event.target
    if (!(select instanceof HTMLSelectElement) || select.name !== 'orgId') return
    select.closest('form[data-org-switch]')?.requestSubmit()
  })
}
