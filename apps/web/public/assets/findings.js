// REV-18. The selection of the Findings screen: « Sélectionner tous les findings de la page » in the
// header of the table, and the count of the findings checked. Without JavaScript, each row is
// checked by hand and the actions work the same.
// REV-91: « Désélectionner » empties the selection (kento.css hides the bar with none); a filter
// applies on change, with no « Filtrer » button.
// Its names stay in a block: the scripts of a page share one global scope (frame.js has a `bar` too).
{
  const all = document.querySelector('[data-select-all]')
  const boxes = [...document.querySelectorAll('input[type="checkbox"][name="ids"]')]
  const count = document.querySelector('[data-selected]')
  const none = document.querySelector('[data-select-none]')

  const update = () => {
    const n = boxes.filter((box) => box.checked).length
    if (count) count.textContent = n === 0 ? 'Cochez des findings pour les marquer.' : n === 1 ? '1 finding coché' : `${n} findings cochés`
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

  const filters = document.querySelector('form.findings-filters')
  filters?.addEventListener('change', (event) => {
    if (event.target instanceof HTMLSelectElement) filters.requestSubmit()
  })
}
