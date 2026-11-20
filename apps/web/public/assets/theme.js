// The theme switch of the screen of a user (KNT-142): Paper, Sumi or Device applies at once, with
// no reload and no save button.
// The choice lives in a cookie of this browser, so the server renders the next page in it. Without
// JavaScript, the "Apply" button of the form posts the same choice.
// Its names stay in a block: the scripts of a page share one global scope.
{
  document.documentElement.classList.add('js')

  const THEMES = ['paper', 'sumi', 'system']

  document.addEventListener('change', (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.name !== 'theme' || !THEMES.includes(input.value)) return
    if (!input.closest('form[data-theme-switch]')) return
    document.documentElement.dataset.theme = input.value
    const secure = location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `kento_theme=${input.value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
  })
}
