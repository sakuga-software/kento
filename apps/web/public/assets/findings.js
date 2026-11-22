// REV-18. The selection of the Findings screen: "Select all the findings of the page" in the
// header of the table, and the count of the findings checked. Without JavaScript, each row is
// checked by hand and the actions work the same.
// REV-91: "Clear the selection" empties the selection (kento.css hides the bar with none); a filter
// applies on change, with no "Filter" button.
// Its names stay in a block: the scripts of a page share one global scope (frame.js has a `bar` too).
{
  const all = document.querySelector('[data-select-all]')
  const boxes = [...document.querySelectorAll('input[type="checkbox"][name="ids"]')]
  const count = document.querySelector('[data-selected]')
  const none = document.querySelector('[data-select-none]')

  const update = () => {
    const n = boxes.filter((box) => box.checked).length
    if (count) count.textContent = n === 0 ? 'Check findings to mark them.' : n === 1 ? '1 finding checked' : `${n} findings checked`
    if (all) {
      all.checked = n > 0 && n === boxes.length
      all.indeterminate = n > 0 && n < boxes.length
    }
  }

  if (all && boxes.length > 0) {
    all.hidden = false
    all.addEventListener('change', () => {
      for (const box of boxes) box.checked = all.checked
      update()
    })
  }
  if (none) {
    none.hidden = false
    none.addEventListener('click', () => {
      for (const box of boxes) box.checked = false
      update()
      all?.focus()
    })
  }
  for (const box of boxes) box.addEventListener('change', update)
  update()

  // KNT-178. A page of as many rows as the window holds: on a load without `per`, the size that fits
  // the height of the window, 10 to 100, and the page that keeps the first row on screen. One replace
  // of the URL: the next load has `per` and changes nothing. Without JavaScript, 25. frame.js keeps the
  // size for the session and puts it in the links to the list, so that only the first visit replaces.
  const table = document.querySelector('table.findings-table[data-offset]')
  const url = new URL(location.href)
  const rows = table ? [...table.tBodies[0].rows] : []
  const sizes = window.kentoFindingsPer
  if (table && sizes && rows.length > 0 && !url.searchParams.has('per')) {
    // The mean from one row to the next: on a phone a row is a card, with its gap; a title on two
    // lines does not count more than its share.
    const top = (row) => row.getBoundingClientRect().top
    const step = rows.length > 1 ? (top(rows.at(-1)) - top(rows[0])) / (rows.length - 1) : rows[0].offsetHeight
    const per = step > 0 ? Math.min(100, Math.max(10, Math.floor(window.innerHeight / step))) : 25
    sizes.keep(per)
    if (per !== 25) {
      const page = Math.floor((Number(table.dataset.offset) || 0) / per) + 1
      // The parameters after `per`, as the server writes them: `data-after` of the table.
      const next = sizes.withPer(url, per, (table.dataset.after ?? '').split(' '), page)
      // The page leaves: nothing that is typed or checked now would reach the next one. No fade for a
      // page that replaces itself.
      document.body.inert = true
      table.closest('.table-wrap')?.setAttribute('aria-busy', 'true')
      window.addEventListener('pageswap', (event) => event.viewTransition?.skipTransition(), { once: true })
      location.replace(next.href)
    }
  }

  const filters = document.querySelector('form.findings-filters')
  filters?.addEventListener('change', (event) => {
    // KNT-165: a select of the filters is a component in the browser; its hidden input sends `change`.
    if (event.target instanceof Element && event.target.matches('select, input[data-select]')) filters.requestSubmit()
  })
}
