// KNT-144. A thin bar at the top of the window while the next page loads, in the spirit of
// nprogress: a click on a link to another page of Kentō, or the submit of a form. Every screen is a
// whole page from the server, so the bar lives until the browser shows the next page. It shows after
// 120 ms only, so a fast page shows none, with or without motion. The motion is in kento.css
// (.nav-progress), and it stops under prefers-reduced-motion.
// Its names stay in a block: the scripts of a page share one global scope.
{
  const DELAY = 120
  let bar = null
  let pending = 0
  let watchdog = 0

  const stop = () => {
    clearTimeout(pending)
    clearTimeout(watchdog)
    pending = 0
    bar?.remove()
    bar = null
  }

  const show = () => {
    pending = 0
    bar = document.createElement('div')
    bar.className = 'nav-progress'
    bar.setAttribute('aria-hidden', 'true')
    document.body.append(bar)
  }

  // A second click or submit while the page loads keeps the bar where it is.
  const start = () => {
    if (!bar && !pending) pending = setTimeout(show, DELAY)
    // A navigation that never ends (a download, a server that does not answer) leaves no bar.
    clearTimeout(watchdog)
    watchdog = setTimeout(stop, 30000)
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

  // Escape stops the loading of the page in the browsers: the bar goes too. An Escape that another
  // script used for itself (confirm.js closes a confirmation, row-menu.js a menu) leaves it; as for a
  // click, decide once every handler ran, whatever the order of the scripts.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    setTimeout(() => {
      if (!event.defaultPrevented && (bar || pending)) stop()
    })
  })

  // Back to this page from the cache of the browser: the bar of the click that left it goes away.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) stop()
  })
}
