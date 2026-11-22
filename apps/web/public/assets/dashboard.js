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
      // Never longer than "Updated 59 min ago": kento.css keeps that width for the stamp.
      stamp.textContent =
        seconds < 60 ? `Updated ${seconds} s ago` : seconds < 3600 ? `Updated ${Math.floor(seconds / 60)} min ago` : `Updated ${Math.floor(seconds / 3600)} h ago`
    }

    const refresh = async () => {
      // A person who is reading a form of the dashboard keeps their focus: no read under them.
      if (busy || document.visibilityState !== 'visible' || live.contains(document.activeElement)) return
      busy = true
      try {
        const response = await fetch(url.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' })
        if (!response.ok || response.redirected) return
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html')
        const next = doc.getElementById('dashboard-live')
        if (next) {
          // KNT-191. A block with a component (the chart of the precision) carries `data-keep`, a key
          // of its numbers: with the same key the block stays, with its chart; else the old one is
          // disposed and the runtime hydrates the new one (app/ui/public/runtime.ts).
          const kept = new Map([...live.querySelectorAll('[data-keep][id]')].map((block) => [block.id, block]))
          // KNT-189. The section of the queue holds the live card (app/ui/public/live-queue.tsx): it
          // stays, so that its stream goes on. Its card takes the one just read, unless the stream is live.
          const keptQueue = live.querySelector('[data-live-queue]')
          live.replaceChildren(...next.childNodes)
          for (const fresh of live.querySelectorAll('[data-keep][id]')) {
            const old = kept.get(fresh.id)
            kept.delete(fresh.id)
            if (old && old.dataset.keep === fresh.dataset.keep) {
              fresh.replaceWith(old)
              continue
            }
            if (old) document.dispatchEvent(new CustomEvent('kento:dispose', { detail: { root: old } }))
            document.dispatchEvent(new CustomEvent('kento:hydrate', { detail: { root: fresh, source: doc } }))
          }
          for (const gone of kept.values()) document.dispatchEvent(new CustomEvent('kento:dispose', { detail: { root: gone } }))
          const freshQueue = keptQueue && live.querySelector('[data-live-queue]')
          if (freshQueue) {
            const card = freshQueue.querySelector('#dash-queue-card')
            if (keptQueue.dataset.liveState !== 'live' && card) keptQueue.querySelector('#dash-queue-card')?.replaceWith(card)
            freshQueue.replaceWith(keptQueue)
          }
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
