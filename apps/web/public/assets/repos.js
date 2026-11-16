// REV-26. While Kentō reads the repositories on GitHub, the Repos screen asks the server again
// every 3 s, and shows the list as soon as the check is over. Without JavaScript, the link
// « Reload » does the same.
// Its names stay in a block: the scripts of a page share one global scope.
{
  const pending = document.querySelector('[data-recheck]')
  if (pending) {
    const url = new URL(location.href)
    // A notice belongs to the answer of a form: the next read shows the screen without it.
    url.searchParams.delete('notice')
    let tries = 0
    const timer = setInterval(async () => {
      // A hidden tab asks nothing, and uses none of the tries.
      if (document.visibilityState !== 'visible') return
      // A check stays under a minute; after 20 reads on screen, the link « Reload » remains.
      if (++tries > 20) return clearInterval(timer)
      try {
        const response = await fetch(url.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' })
        if (!response.ok || response.redirected) return
        const next = new DOMParser().parseFromString(await response.text(), 'text/html')
        if (next.querySelector('[data-recheck]')) return
        clearInterval(timer)
        location.replace(url.href)
      } catch {
        // The network is gone for a moment: the next tick tries again.
      }
    }, 3000)
  }
}
