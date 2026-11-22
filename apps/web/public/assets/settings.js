// The Settings screen (REV-29). "Add a provider" is folded: a link to #new-provider
// (the home screen has one) opens it. The sidebar marks the section and the part on screen.
// Its names stay in a block: the scripts of a page share one global scope.
{
  // REV-115. The anchors of an earlier release, in the check runs and the bookmarks before it.
  const LEGACY_ANCHORS = { plafond: 'cap', defauts: 'defaults', regles: 'org-rules', 'nouveau-provider': 'new-provider' }
  const legacy = location.hash.slice(1)
  if (Object.hasOwn(LEGACY_ANCHORS, legacy)) location.replace(`#${LEGACY_ANCHORS[legacy]}`)

  const openTarget = () => {
    let id
    try {
      id = decodeURIComponent(location.hash.slice(1))
    } catch {
      // A malformed hash (/settings#%E0%A4%A) names no section: the rest of the script still runs.
      return
    }
    const target = id ? document.getElementById(id) : null
    // The fold of the target itself ("Add a provider", "New rule"), or the one around it. KNT-149: not
    // a fold deeper in it, as "Replace the key" in a provider that the sidebar links to. The technical
    // details of an error stay folded.
    const details = target?.querySelector(':scope > details:not(.tech-details)') ?? target?.closest('details')
    if (!details || details.open) return
    details.open = true
    target.scrollIntoView()
  }
  openTarget()
  window.addEventListener('hashchange', openTarget)

  // KNT-149. The sidebar: the sections, and the parts of each section under it. The link of the
  // section on screen gets aria-current="location", the link of its part on screen aria-current="true".
  const nav = document.querySelector('[data-settings-nav]')
  const toggle = nav?.querySelector('[data-settings-nav-toggle]')
  const targetOf = (link) => document.getElementById(link.getAttribute('href').slice(1))
  const sections = []
  for (const item of nav?.querySelectorAll('.settings-nav-list > li') ?? []) {
    const link = item.querySelector(':scope > a')
    const target = link && targetOf(link)
    if (!target) continue
    const parts = []
    for (const sub of item.querySelectorAll(':scope > ul a')) {
      const part = targetOf(sub)
      if (part) parts.push({ link: sub, target: part })
    }
    sections.push({ link, target, parts })
  }

  // Under 900 px, "Sections" at the top of the page opens the list under it; a link folds it again.
  const setOpen = (open) => {
    if (!nav || !toggle) return
    nav.classList.toggle('settings-nav-open', open)
    toggle.setAttribute('aria-expanded', String(open))
  }
  toggle?.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'))
  // KNT-177. A link of the sidebar glides to its section (kento.css, .settings-glide): the class holds
  // for the scroll of this click only, until its end, or 1 s where `scrollend` does not exist.
  const root = document.documentElement
  let glideEnd = 0
  const endGlide = () => {
    clearTimeout(glideEnd)
    root.classList.remove('settings-glide')
  }
  window.addEventListener('scrollend', endGlide)
  nav?.querySelector('.settings-nav-list')?.addEventListener('click', (event) => {
    if (!(event.target instanceof Element && event.target.closest('a'))) return
    setOpen(false)
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    root.classList.add('settings-glide')
    clearTimeout(glideEnd)
    glideEnd = setTimeout(endGlide, 1000)
  })
  // KNT-164. The open list is part of the page, as a disclosure: only a link or Escape folds it.
  // Folding it when the focus leaves it, or on a tap outside, moved the field under it off the
  // screen at the tap, and the tap missed the field.
  document.addEventListener('keydown', (event) => {
    // An open list (a select, a menu) handles its own Escape first, and marks it handled.
    if (event.defaultPrevented) return
    if (event.key !== 'Escape' || toggle?.getAttribute('aria-expanded') !== 'true') return
    setOpen(false)
    toggle.focus()
  })
  // The bar folds the list only from here: if this script does not run, the list stays in the page.
  if (toggle) nav.classList.add('settings-nav-ready')

  // The entry on screen: the last one whose top went above the line, at a quarter of the window.
  // At the bottom of the page, the entry that the URL names, or whose part it names, wins: a short
  // last section never reaches the line.
  const names = (entry, id) => entry.target.id === id || (entry.parts ?? []).some((part) => part.target.id === id)
  const pick = (entries) => {
    const line = Math.max(96, window.innerHeight * 0.25)
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
    const id = location.hash.slice(1)
    const named = atBottom && id ? entries.find((entry) => names(entry, id)) : null
    const box = named ? document.getElementById(id).getBoundingClientRect() : null
    // Only while it is on screen: after a scroll away from it, the line decides again.
    if (box && box.top < window.innerHeight && box.bottom > 0) return named
    let current = null
    for (const entry of entries) if (entry.target.getBoundingClientRect().top <= line) current = entry
    return current
  }
  const mark = (entries, current, value) => {
    for (const entry of entries) {
      if (entry === current) entry.link.setAttribute('aria-current', value)
      else entry.link.removeAttribute('aria-current')
    }
  }
  // A long sidebar scrolls on its own: the marked link stays in it.
  let shown = null
  const keepInView = (link) => {
    if (!nav || nav.scrollHeight <= nav.clientHeight) return
    const box = nav.getBoundingClientRect()
    const row = link.getBoundingClientRect()
    if (row.top < box.top) nav.scrollTop -= box.top - row.top + 8
    else if (row.bottom > box.bottom) nav.scrollTop += row.bottom - box.bottom + 8
  }
  // KNT-168. Under 900 px the list is at the top of the page: the section on screen is never the
  // one under the list. There, the marks show the section that the person chose in the list, or
  // came back from with its link "Sections", while the person is in it; otherwise nothing.
  const phone = () => !!toggle && getComputedStyle(toggle).display !== 'none'
  // The section of the last choice, and whether it came from a link "Sections": the page is then at
  // the bar, away from that section, and the mark stays until the person leaves the bar.
  let chosen = null
  let fromBack = false
  const clearMarks = () => {
    chosen = null
    mark(sections, null, 'location')
    for (const other of sections) mark(other.parts, null, 'true')
  }
  const markChoice = (link) => {
    const section = sections.find((entry) => entry.link === link || entry.parts.some((part) => part.link === link) || entry.target.id === link?.dataset?.settingsBack)
    chosen = section ?? null
    mark(sections, chosen, 'location')
    for (const other of sections) mark(other.parts, other === chosen ? other.parts.find((part) => part.link === link) ?? null : null, 'true')
  }
  nav?.querySelector('.settings-nav-list')?.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null
    if (!link || !phone()) return
    fromBack = false
    markChoice(link)
  })
  // "Sections" at the end of a section: the link leads to the bar; the list opens on that section,
  // and the focus goes to the button, so that Tab goes on into the list.
  document.addEventListener('click', (event) => {
    // A click that opens another tab or window leaves this page as it is.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const back = event.target instanceof Element ? event.target.closest('[data-settings-back]') : null
    if (!back || !phone()) return
    setOpen(true)
    fromBack = true
    markChoice(back)
    requestAnimationFrame(() => toggle.focus({ preventScroll: true }))
  })
  // A window that narrows to a phone drops the marks of the scroll: they named a section that the
  // person did not choose.
  let wasPhone = false
  const update = () => {
    if (phone()) {
      if (!wasPhone) {
        clearMarks()
        // The sidebar scrolls to its marked link again once the window widens.
        shown = null
      } else if (chosen) {
        // The person scrolled out of the chosen section by hand: the mark goes.
        const box = nav.getBoundingClientRect()
        const atBar = box.bottom > 0 && box.top < window.innerHeight
        if (!(fromBack && atBar) && pick(sections) !== chosen) clearMarks()
        if (!atBar) fromBack = false
      }
      wasPhone = true
      return
    }
    wasPhone = false
    const section = pick(sections) ?? sections[0]
    mark(sections, section, 'location')
    for (const other of sections) mark(other.parts, other === section ? pick(other.parts) : null, 'true')
    const deepest = nav?.querySelector('a[aria-current="true"]') ?? section?.link
    if (deepest && deepest !== shown) keepInView(deepest)
    shown = deepest
  }
  if (sections.length > 0) {
    let queued = false
    const schedule = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        update()
      })
    }
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('hashchange', schedule)
    update()
  }
}
