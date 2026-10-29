// The Settings screen (REV-29). « Ajouter un provider » is folded: a link to #nouveau-provider
// (the home screen has one) opens it. The table of contents marks the section on screen.
function openTarget() {
  let id
  try {
    id = decodeURIComponent(location.hash.slice(1))
  } catch {
    // A malformed hash (/settings#%E0%A4%A) names no section: the rest of the script still runs.
    return
  }
  const target = id ? document.getElementById(id) : null
  const details = target?.querySelector('details') ?? target?.closest('details')
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
    { rootMargin: '0px 0px -60% 0px' },
  )
  for (const section of links.keys()) observer.observe(section)
}
