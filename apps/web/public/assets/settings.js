// The Settings screen (REV-29). "Add a provider" is folded: a link to #new-provider
// (the home screen has one) opens it. The table of contents marks the section on screen.
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
    // The technical details of an error stay folded: they are not the section that the link opens.
    const details = target?.querySelector('details:not(.tech-details)') ?? target?.closest('details')
    if (!details || details.open) return
    details.open = true
    target.scrollIntoView()
  }
  openTarget()
  window.addEventListener('hashchange', openTarget)

  const links = new Map()
  for (const link of document.querySelectorAll('.settings-nav a[href^="#"]')) {
    const section = document.getElementById(link.getAttribute('href').slice(1))
    if (section) links.set(section, link)
  }
  if (links.size > 0 && 'IntersectionObserver' in window) {
    const visible = new Set()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target)
        // The first section of the page that is on screen.
        const current = [...links.keys()].find((section) => visible.has(section))
        for (const [section, link] of links) {
          if (section === current) link.setAttribute('aria-current', 'location')
          else link.removeAttribute('aria-current')
        }
      },
      // The top 80 px: the sticky bar of a phone covers them, and the end of the card above sits there.
      { rootMargin: '-80px 0px -60% 0px' },
    )
    for (const section of links.keys()) observer.observe(section)
  }
}
