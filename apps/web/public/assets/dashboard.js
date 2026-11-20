// The dashboard reads itself again every 10 s while it is on screen, and says how old its numbers
// are ("Updated 12 s ago"). Without JavaScript, the link "Refresh" does the same.
// Its names stay in a block: the scripts of a page share one global scope.
{
  const live = document.getElementById('dashboard-live')
  if (live) {
    const every = (Number(live.dataset.refresh) || 10) * 1000
    const url = new URL(location.href)
    // A notice belongs to the answer of a form: the next reads show the dashboard without it.
    url.searchParams.delete('notice')
    if (url.href !== location.href) history.replaceState(null, '', url.href)
    let busy = false

    const age = () => {
      const stamp = document.querySelector('[data-updated]')
      if (!stamp) return
      const seconds = Math.max(0, Math.round((Date.now() - Date.parse(stamp.dataset.updated)) / 1000))
      stamp.textContent = seconds < 60 ? `Updated ${seconds} s ago` : `Updated ${Math.floor(seconds / 60)} min ago`
    }

    const refresh = async () => {
      // A person who is reading a form of the dashboard keeps their focus: no read under them.
      if (busy || document.visibilityState !== 'visible' || live.contains(document.activeElement)) return
      busy = true
      try {
        const response = await fetch(url.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' })
        if (!response.ok || response.redirected) return
        const next = new DOMParser().parseFromString(await response.text(), 'text/html').getElementById('dashboard-live')
        if (next) {
          live.replaceChildren(...next.childNodes)
          stampNow()
          age()
        }
      } catch {
        // The network is gone for a moment: the next tick tries again.
      } finally {
        busy = false
      }
    }

    // The clocks of the server and of the browser differ: the age counts from the moment the page came.
    const stampNow = () => {
      const stamp = document.querySelector('[data-updated]')
      if (stamp) stamp.dataset.updated = new Date().toISOString()
    }
    stampNow()
    age()
    setInterval(age, 1000)
    setInterval(refresh, every)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh()
    })
  }
}
