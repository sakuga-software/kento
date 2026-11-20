// KNT-144. A thin bar at the top of the window while the next page loads, in the spirit of
// nprogress: a click on a link to another page of Kentō, or the submit of a form. Every screen is a
// whole page from the server, so the bar lives until the browser shows the next page. The motion is
// in kento.css (.nav-progress), and it stops under prefers-reduced-motion.
// Its names stay in a block: the scripts of a page share one global scope.
{
  let bar = null
  let timer = 0

  const stop = () => {
    clearTimeout(timer)
    bar?.remove()
    bar = null
  }

  const start = () => {
    stop()
    bar = document.createElement('div')
    bar.className = 'nav-progress'
    bar.setAttribute('aria-hidden', 'true')
    document.body.append(bar)
    // A navigation that never ends (a download, Escape, a server that does not answer) leaves no bar.
    timer = setTimeout(stop, 30000)
  }

  // True for a link that this window follows to another page of Kentō.
  const leads = (link, event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
    if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return false
    const url = new URL(link.href, location.href)
    if (url.origin !== location.origin) return false
    // Only the hash changes: the browser scrolls, it loads nothing.
    return !(url.hash && url.pathname === location.pathname && url.search === location.search)
  }

  // A handler of another script may cancel the event after this one: decide once they all ran.
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link || !leads(link, event)) return
    setTimeout(() => {
      if (!event.defaultPrevented) start()
    })
  })

  document.addEventListener('submit', (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || form.method === 'dialog') return
    const target = event.submitter?.getAttribute('formtarget') ?? form.target
    if (target && target !== '_self') return
    setTimeout(() => {
      if (!event.defaultPrevented) start()
    })
  })

  // Back to this page from the cache of the browser: the bar of the click that left it goes away.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) stop()
  })
}
