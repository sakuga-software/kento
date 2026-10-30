// REV-18. The selection of the Findings screen: « Sélectionner tous les findings de la page » in the
// header of the table, and the count of the findings checked. Without JavaScript, each row is
// checked by hand and the actions work the same.
const all = document.querySelector('[data-select-all]')
const boxes = [...document.querySelectorAll('input[type="checkbox"][name="ids"]')]
const count = document.querySelector('[data-selected]')

function update() {
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
for (const box of boxes) box.addEventListener('change', update)
update()
