// KNT-147. "Enable" and "Disable" of a row of the Repos screen, in place: the script posts the form
// with fetch, and puts the new row where the old one is, with the notice and the counts of the
// screen that the redirect gives. Nothing moves: the row keeps its place until the next load (the
// enabled repos come first then), the page keeps its scroll, and the focus goes back to the row.
// An error shows in the row. Without JavaScript, the form posts as before, and the redirect goes to
// the row (`#repo-<id>`).
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

  const parse = async (response) => new DOMParser().parseFromString(await response.text(), 'text/html')

  // The screen of the name of a repository: its row, when the change took it out of the list on
  // screen (the filter "Not enabled", or another page).
  const rowByName = async (row) => {
    const name = row.querySelector('.repo-name')?.getAttribute('title')
    if (!name) return null
    const response = await fetch(`${location.pathname}?${new URLSearchParams({ q: name })}`, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    })
    return response.ok ? (await parse(response)).getElementById(row.id) : null
  }

  // The notice, the line of the counts and the counts of the filters of the new screen, in place of
  // the old ones. The role of the notice (status or alert) has a screen reader read it.
  const updateFrame = (next) => {
    const summary = content.querySelector('.repos-summary')
    const nextSummary = next.querySelector('.repos-summary')
    if (!summary || !nextSummary) return
    for (const banner of content.querySelectorAll(':scope > .banner')) banner.remove()
    for (const banner of next.querySelectorAll(':scope > .banner')) summary.before(document.importNode(banner, true))
    summary.replaceWith(document.importNode(nextSummary, true))
    const filters = content.querySelector('.list-controls .segmented-links')
    const nextFilters = next.querySelector('.list-controls .segmented-links')
    if (filters && nextFilters) filters.replaceWith(document.importNode(nextFilters, true))
  }

  // The new row in place of the old one, marked as `:target` marks it after a redirect. The focus
  // goes to its next action: "…" after "Enable", "Enable" after "Disable".
  const replaceRow = (row, nextRow) => {
    const fresh = document.importNode(nextRow, true)
    fresh.classList.add('row-changed')
    // confirm.js shows "Cancel" once, at load: the new confirmation needs it too.
    for (const button of fresh.querySelectorAll('[data-confirm-cancel]')) button.hidden = false
    row.replaceWith(fresh)
    // row-menu.js gave the table the room of the open menu of the old row: it is gone now.
    const wrap = fresh.closest('.table-wrap')
    if (wrap) wrap.style.paddingBottom = ''
    const target = fresh.querySelector('.row-action > button') ?? fresh.querySelector('.row-menu > summary')
    target?.focus({ preventScroll: true })
  }

  // On the document: the buttons of the rows submit the form "repo-actions" from anywhere in the page.
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
        let response
        try {
          response = await fetch(button.formAction, {
            method: 'POST',
            body: new URLSearchParams(new FormData(form)),
            credentials: 'same-origin',
            headers: { Accept: 'text/html' },
          })
        } catch {
          return showError(row, 'network')
        }
        // The server answers a change with a redirect to the screen; a sign-in page means the
        // session is over.
        // fetch drops the `#repo-<id>` of the redirect: it comes back here, for a fallback below.
        const landed = new URL(response.url, location.href)
        landed.hash = row.id
        // Only the redirect of a saved change says that it is saved: back to this screen, with
        // `done=enabled|disabled` and the id of this repo. Anything else is a refusal (Kentō
        // #7cf7a5, #807f15), or the end of the session when it lands on another page.
        const saved =
          response.redirected &&
          landed.pathname === location.pathname &&
          /^(enabled|disabled)$/.test(landed.searchParams.get('done') ?? '') &&
          landed.searchParams.get('repo') === row.id.replace(/^repo-/, '')
        const elsewhere = response.ok && response.redirected && landed.pathname !== location.pathname
        if (!saved) return showError(row, elsewhere ? 'session' : 'refused')
        // From here the change is saved. When its screen does not come, or its row cannot be read
        // or shown, the browser goes to the screen of the redirect, as without JavaScript: never a
        // message that says the change failed (Kentō #2e027b, #e074d4).
        try {
          if (!response.ok) throw new Error(`screen ${response.status}`)
          const next = (await parse(response)).getElementById('content')
          const nextRow = next?.querySelector(`#${CSS.escape(row.id)}`) ?? (await rowByName(row))
          if (!next || !nextRow) throw new Error('no row')
          // The notice above the list can grow or shrink the page: the row stays where it is on the
          // screen (the browser does it by itself, except at the top of the page).
          const top = row.getBoundingClientRect().top
          updateFrame(next)
          replaceRow(row, nextRow)
          const moved = document.getElementById(row.id).getBoundingClientRect().top - top
          if (Math.abs(moved) >= 1) window.scrollBy(0, moved)
        } catch {
          location.assign(landed.href)
        }
      } finally {
        // The old row, when it is still on screen (an error): it can be tried again.
        row.removeAttribute('aria-busy')
        button.removeAttribute('aria-disabled')
      }
    })
  }
}
