// The confirmation of a destructive action (app/ui/confirm.tsx, REV-33): « Annuler » and Échap
// close it, and the focus goes back to its trigger. Without JavaScript, « Annuler » stays hidden
// and the trigger closes the confirmation.
for (const button of document.querySelectorAll('[data-confirm-cancel]')) button.hidden = false

function close(details) {
  details.open = false
  details.querySelector(':scope > summary')?.focus()
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-confirm-cancel]') : null
  const details = button?.closest('details[data-confirm]')
  if (details) close(details)
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !(event.target instanceof Element)) return
  const details = event.target.closest('details[data-confirm][open]')
  if (!details) return
  event.preventDefault()
  close(details)
})
