// KNT-163. The runtime of the components in the browser: each `clientEntry` of the page hydrates in
// place, and the rest of the page stays the HTML of the server. boot.ts loads this module only on a
// page that has a component to hydrate.
import { run } from 'remix/component'

// The runtime also takes over the links and the forms (client navigation), and a page that it
// brings in that way keeps its scripts inert. The scripts of public/assets/ (theme.js, findings.js…)
// run once per document, so every navigation stays a document load: this listener runs before the
// one of the runtime, which then never sees a navigation. Remove it once those scripts are
// components.
window.navigation?.addEventListener('navigate', (event) => event.stopImmediatePropagation())

// The page has one import map, from the server: no frame brings new mappings later, so a plain
// `import()` is enough (no remix/multiple-import-maps-polyfill).
let app = run({
  async loadModule(moduleUrl, exportName) {
    let module = await import(moduleUrl)
    let component = module[exportName]
    if (typeof component !== 'function') throw new Error(`Unknown component: ${moduleUrl}#${exportName}`)
    return component
  },
})

app.addEventListener('error', (event) => {
  console.error('Component error:', event.error)
})

await app.ready()
// The e2e tests wait for it before they use a component.
document.documentElement.dataset.hydrated = ''
