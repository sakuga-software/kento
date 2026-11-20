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
  const currentLabel = nav?.querySelector('[data-settings-nav-current]')
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

  // Under 900 px, "Section …" opens the list over the page; a link folds it again.
  const setOpen = (open) => {
    if (!nav || !toggle) return
    nav.classList.toggle('settings-nav-open', open)
    toggle.setAttribute('aria-expanded', String(open))
  }
  toggle?.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'))
  nav?.querySelector('.settings-nav-list')?.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) setOpen(false)
  })
  // The list opens over the page: Escape or a click outside folds it, as the menu of the frame.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || toggle?.getAttribute('aria-expanded') !== 'true') return
    setOpen(false)
    toggle.focus()
  })
  document.addEventListener('click', (event) => {
    if (nav && !event.composedPath().includes(nav)) setOpen(false)
  })

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
  const update = () => {
    const section = pick(sections) ?? sections[0]
    mark(sections, section, 'location')
    for (const other of sections) mark(other.parts, other === section ? pick(other.parts) : null, 'true')
    if (currentLabel && section) currentLabel.textContent = section.link.textContent
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
