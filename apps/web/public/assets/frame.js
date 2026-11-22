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

  // KNT-178. The size of the pages of the findings that fits this window, once findings.js measured it
  // in this session. A link to the list without `per` gets it, at the load and at the click (a link
  // that a component draws later), so that the list opens at that size with no second load. The URL
  // stays the only state of the list: the server reads `per` from it, never from the storage.
  const PER_KEY = 'kento:findings-per'
  // `per` goes before `page` and before the parameters that the server writes after it
  // (findingListQuery of app/ui/findings.tsx): on the list, the table gives them (`data-after`);
  // a link of another screen has at most `view`.
  const withPer = (url, per, after = ['view'], page = null) => {
    const next = new URL(url.href)
    const params = new URLSearchParams()
    const kept = page ?? Number(url.searchParams.get('page') ?? 1)
    let placed = false
    const place = () => {
      params.set('per', String(per))
      if (kept > 1) params.set('page', String(kept))
      placed = true
    }
    for (const [name, value] of url.searchParams) {
      if (name === 'page') continue
      if (!placed && after.includes(name)) place()
      params.append(name, value)
    }
    if (!placed) place()
    next.search = params.toString()
    return next
  }
  const stored = () => {
    try {
      const value = sessionStorage.getItem(PER_KEY)
      return value && /^(?:[1-9][0-9]?|100)$/.test(value) && Number(value) >= 10 ? Number(value) : null
    } catch {
      return null
    }
  }
  const keep = (per) => {
    try {
      // 25 is the size of the server: a link without `per` already gives it.
      if (per === 25) sessionStorage.removeItem(PER_KEY)
      else sessionStorage.setItem(PER_KEY, String(per))
    } catch {
      // No storage (a private window, blocked site data): each visit measures again.
    }
  }
  window.kentoFindingsPer = { keep, withPer }
  const sized = (link) => {
    const per = stored()
    if (!per || !(link instanceof HTMLAnchorElement)) return
    const url = new URL(link.href, location.href)
    if (url.origin !== location.origin || url.pathname !== '/findings' || url.searchParams.has('per')) return
    const next = withPer(url, per)
    // A path, as the server writes the links.
    link.setAttribute('href', `${next.pathname}${next.search}${next.hash}`)
  }
  for (const link of document.querySelectorAll('a[href^="/findings"]')) sized(link)
  for (const type of ['click', 'auxclick']) {
    document.addEventListener(type, (event) => sized(event.target instanceof Element ? event.target.closest('a') : null), true)
  }
}
