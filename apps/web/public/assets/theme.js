// The theme switch: Papier, Sumi or Appareil applies at once, with no reload and no save button.
// The choice lives in a cookie of this browser, so the server renders the next page in it. Without
// JavaScript, the « Appliquer » button of the form posts the same choice.
document.documentElement.classList.add('js')

const THEMES = ['paper', 'sumi', 'system']

document.addEventListener('change', (event) => {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.name !== 'theme' || !THEMES.includes(input.value)) return
  if (!input.closest('form[data-theme-switch]')) return
  document.documentElement.dataset.theme = input.value
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `kento_theme=${input.value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
  // Every switch on the page shows the same choice (the foot of the frame and the screen of a user).
  for (const other of document.querySelectorAll(`form[data-theme-switch] input[name="theme"][value="${input.value}"]`)) {
    other.checked = true
  }
})
