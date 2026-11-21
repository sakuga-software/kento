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

  // A server that does not answer: the row gets its message, and can be tried again.
  const TIMEOUT_MS = 15_000

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

  const read = (url) => fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const parse = async (response) => new DOMParser().parseFromString(await response.text(), 'text/html')
  const copy = (node) => [...node.childNodes].map((child) => document.importNode(child, true))

  // The screen of the name of a repository: its row, when the change took it out of the list on
  // screen (the filter "Not enabled", or another page).
  const rowByName = async (row) => {
    // The title of the name is "owner/name (private)" (KNT-180): a name on GitHub has no space and
    // no parenthesis, so the full name is what comes before " (".
    const name = row.querySelector('.repo-name')?.getAttribute('title')?.replace(/ \(.*\)$/, '')
    if (!name) return null
    const response = await read(`${location.pathname}?${new URLSearchParams({ q: name })}`)
    return response.ok ? (await parse(response)).getElementById(row.id) : null
  }

  // The line of the counts and the counts of the filters of the new screen, in place of the old ones.
  // The nodes stay: only their content changes, so `aria-live` on the line keeps working. With
  // `notice`, the notice too, in the slot `role="status"` that the server always renders: a screen
  // reader reads the change of its content.
  const updateFrame = (next, { notice }) => {
    const summary = content.querySelector('.repos-summary')
    const nextSummary = next.querySelector('.repos-summary')
    if (summary && nextSummary) summary.replaceChildren(...copy(nextSummary))
    const filters = content.querySelector('.list-controls .segmented-links')
    const nextFilters = next.querySelector('.list-controls .segmented-links')
    if (filters && nextFilters) filters.replaceChildren(...copy(nextFilters))
    if (!notice) return
    for (const banner of content.querySelectorAll(':scope > .banner-alert')) banner.remove()
    const slot = content.querySelector('.notice-slot')
    const nextSlot = next.querySelector('.notice-slot')
    if (slot && nextSlot) slot.replaceChildren(...copy(nextSlot))
  }

  // The row left the list on screen (another filter, another page): the list of the server is not
  // the one on screen any more. The pager and its range come from the server, and a line says so,
  // with a link that reads the page again. Without it, "Next" would skip the rows that moved up.
  // The pager of the server is copied only when it is on the page on screen: a list that got shorter
  // can send the server to an earlier page, and its range and current page would then not match the
  // table. Then the pager goes, and the line offers the reload (Kentō #fcb2e3).
  const currentPage = (root) => root.querySelector('.pager [aria-current="page"]')?.textContent.replace(/\D/g, '') ?? '1'
  const listChanged = (next) => {
    const wrap = content.querySelector('.table-wrap')
    if (!wrap) return
    const pager = content.querySelector('.pager')
    let nextPager = next.querySelector('.pager')
    if (nextPager && currentPage(next) !== currentPage(content)) nextPager = null
    if (pager && nextPager) pager.replaceWith(document.importNode(nextPager, true))
    else if (pager) pager.remove()
    else if (nextPager) wrap.after(document.importNode(nextPager, true))
    if (content.querySelector('.list-changed')) return
    const line = document.createElement('p')
    line.className = 'list-changed hint'
    const reload = document.createElement('a')
    reload.href = location.href.split('#')[0]
    reload.textContent = 'Reload'
    line.append('The list changed. ', reload)
    wrap.after(line)
  }

  // The new row in place of the old one, marked as `:target` marks it after a redirect: the last
  // changed row only. The focus goes to its next action: "…" after "Enable", "Enable" after "Disable".
  const replaceRow = (row, nextRow) => {
    const fresh = document.importNode(nextRow, true)
    for (const marked of content.querySelectorAll('tr.row-changed')) marked.classList.remove('row-changed')
    fresh.classList.add('row-changed')
    // KNT-163: the components of the old row go first, with their listeners (app/ui/public/runtime.ts).
    document.dispatchEvent(new CustomEvent('kento:dispose', { detail: { root: row } }))
    row.replaceWith(fresh)
    const target = fresh.querySelector('.row-action > button') ?? fresh.querySelector('.row-menu > summary')
    target?.focus({ preventScroll: true })
    // KNT-163: the menu "…" of the new row hydrates too (app/ui/public/runtime.ts), with its props from
    // the page that the server sent.
    document.dispatchEvent(new CustomEvent('kento:hydrate', { detail: { root: fresh, source: nextRow.ownerDocument } }))
  }

  // Two rows changed at the same time: their answers can come back in any order, and the counts of
  // the first one to come back can be the older ones. When the last one is done, the counts are read
  // again from the screen as it is now.
  let pending = 0
  let overlapped = false
  const settle = async () => {
    pending -= 1
    if (pending > 0 || !overlapped) return
    overlapped = false
    try {
      const response = await read(location.href.split('#')[0])
      const next = response.ok ? (await parse(response)).getElementById('content') : null
      if (next && pending === 0) updateFrame(next, { notice: false })
    } catch {
      // The counts stay as they are; the next load reads them again.
    }
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
      pending += 1
      if (pending > 1) overlapped = true
      try {
        let response
        try {
          response = await fetch(button.formAction, {
            method: 'POST',
            body: new URLSearchParams(new FormData(form)),
            credentials: 'same-origin',
            headers: { Accept: 'text/html' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch {
          return showError(row, 'network')
        }
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
          if (!next) throw new Error('no screen')
          let nextRow = next.querySelector(`#${CSS.escape(row.id)}`)
          const left = !nextRow
          if (left) nextRow = await rowByName(row)
          if (!nextRow) throw new Error('no row')
          // The notice above the list can grow or shrink the page: the row stays where it is on the
          // screen (the browser does it by itself, except at the top of the page).
          const top = row.getBoundingClientRect().top
          updateFrame(next, { notice: true })
          if (left) listChanged(next)
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
        settle()
      }
    })
  }
}
