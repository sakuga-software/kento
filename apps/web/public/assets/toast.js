// KNT-184. The toasts of a page (app/ui/toast.tsx). At the load, the parameters of the message leave
// the URL: a reload, or a return to this page, does not show it again. Its close link removes it
// without a load. The motion and the time on screen are in kento.css (.toast).
// Its names stay in a block: the scripts of a page share one global scope.
{
  const shown = document.querySelector('[data-toast]')
  if (shown) {
    const url = new URL(location.href)
    for (const name of shown.dataset.toast.split(' ').filter(Boolean)) url.searchParams.delete(name)
    if (url.href !== location.href) history.replaceState(history.state, '', url)
  }

  // A toast that a script put in the page later (repo-toggle.js) closes the same way.
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const close = event.target instanceof Element ? event.target.closest('[data-toast-close]') : null
    const toast = close?.closest('[data-toast]')
    if (!toast) return
    event.preventDefault()
    toast.remove()
  })
}
