// The Runners screen: "Copy the command" copies the docker run of a new token. Without
// JavaScript, the button stays hidden and the command is selectable in its field.
// Its names stay in a block: the scripts of a page share one global scope.
{
  for (const button of document.querySelectorAll('button[data-copy]')) {
    const field = document.getElementById(button.dataset.copy)
    const status = button.parentElement?.querySelector('.copy-status')
    if (!(field instanceof HTMLTextAreaElement) || !navigator.clipboard) continue
    button.hidden = false
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(field.value)
        if (status) status.textContent = 'Command copied.'
      } catch {
        field.select()
        if (status) status.textContent = 'The browser refused the copy. The command is selected: copy it with the keyboard.'
      }
    })
  }
}
