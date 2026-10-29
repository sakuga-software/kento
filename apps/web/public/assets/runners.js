// The Runners screen: « Copier la commande » copies the docker run of a new token. Without
// JavaScript, the button stays hidden and the command is selectable in its field.
for (const button of document.querySelectorAll('button[data-copy]')) {
  const field = document.getElementById(button.dataset.copy)
  const status = button.parentElement?.querySelector('.copy-status')
  if (!(field instanceof HTMLTextAreaElement) || !navigator.clipboard) continue
  button.hidden = false
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(field.value)
      if (status) status.textContent = 'Commande copiée.'
    } catch {
      field.select()
      if (status) status.textContent = 'Copie refusée par le navigateur : la commande est sélectionnée, copiez-la au clavier.'
    }
  })
}
