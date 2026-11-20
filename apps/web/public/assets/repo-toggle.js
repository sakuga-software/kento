// KNT-147. "Enable" and "Disable" of a row of the Repos screen, in place: the script posts the form
// with fetch, reads the screen that the redirect gives, and puts it in place of the one on screen.
// The page does not scroll, and the focus goes back to the row. An error shows in the row. Without
// JavaScript, the form posts as before, and the redirect goes to the row (`#repo-<id>`).
// Its names stay in a block: the scripts of a page share one global scope.
{
  const content = document.getElementById('content')

  const MESSAGES = {
    session: 'Your session ended: reload the page and sign in again.',
    refused: 'Kentō did not save this change. Reload the page, then try again.',
    network: 'Kentō could not be reached. Check the connection, then try again.',
  }

  // The message of a row: one at a time, in its action cell, read at once by a screen reader.
  const showError = (row, kind) => {
    const cell = row.querySelector('.row-action') ?? row
    cell.querySelector('.row-error')?.remove()
    const message = document.createElement('p')
    message.className = 'row-error'
    message.setAttribute('role', 'alert')
    message.textContent = MESSAGES[kind]
    cell.append(message)
  }

  // The new screen in place of the old one, at the same scroll position. What the person opened
  // ("How the switch works") stays open.
  const swap = (next, rowId) => {
    const x = window.scrollX
    const y = window.scrollY
    const howtoOpen = content.querySelector('details.repos-howto')?.open ?? false
    content.replaceChildren(...[...next.childNodes].map((node) => document.importNode(node, true)))
    const howto = content.querySelector('details.repos-howto')
    if (howto) howto.open = howtoOpen
    // confirm.js shows "Cancel" once, at load: the new confirmations need it too.
    for (const button of content.querySelectorAll('[data-confirm-cancel]')) button.hidden = false
    window.scrollTo(x, y)

    // The enabled repos come first: a row can move. One that left the screen is brought back into
    // view, marked, as the redirect without JavaScript does with `#repo-<id>`. One still on screen
    // does not move the page.
    const row = document.getElementById(rowId)
    if (row) {
      row.classList.add('row-changed')
      const box = row.getBoundingClientRect()
      if (box.top < 0 || box.bottom > window.innerHeight) {
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        row.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
      }
    }

    // The focus goes to the next action of the row: "…" after "Enable", "Enable" after "Disable".
    // A row that left the list (the filter "Not enabled" after "Enable") gives it to the notice.
    const target =
      row?.querySelector('.row-action > button') ?? row?.querySelector('.row-menu > summary') ?? content.querySelector('.banner')
    if (!target) return
    if (!target.matches('a, button, summary')) target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
  }

  // On the document: a change puts a new form "repo-actions" in place of the old one.
  if (content && window.fetch && window.DOMParser) {
    document.addEventListener('submit', async (event) => {
      const form = event.target
      if (!(form instanceof HTMLFormElement) || form.id !== 'repo-actions') return
      const button = event.submitter
      const row = button?.closest('tr[id^="repo-"]')
      if (!row || !button.formAction) return
      event.preventDefault()
      // A second click while the first one is on its way does nothing.
      if (row.getAttribute('aria-busy') === 'true') return
      row.setAttribute('aria-busy', 'true')
      button.setAttribute('aria-disabled', 'true')
      row.querySelector('.row-error')?.remove()
      try {
        const response = await fetch(button.formAction, {
          method: 'POST',
          body: new URLSearchParams(new FormData(form)),
          credentials: 'same-origin',
          headers: { Accept: 'text/html' },
        })
        // The server answers a change with a redirect to the screen; a sign-in page means the
        // session is over.
        const landed = new URL(response.url, location.href)
        if (response.ok && landed.pathname !== location.pathname) return showError(row, 'session')
        if (!response.ok) return showError(row, 'refused')
        const next = new DOMParser().parseFromString(await response.text(), 'text/html').getElementById('content')
        if (!next) return showError(row, 'refused')
        swap(next, row.id)
      } catch {
        showError(row, 'network')
      } finally {
        // The row of the old screen, when it is still there (an error): it can be tried again.
        row.removeAttribute('aria-busy')
        button.removeAttribute('aria-disabled')
      }
    })
  }
}
