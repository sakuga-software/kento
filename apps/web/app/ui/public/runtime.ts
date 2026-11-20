// KNT-163. The runtime of the components in the browser: each `clientEntry` of the page hydrates in
// place, and the rest of the page stays the HTML of the server. boot.ts loads this module only on a
// page that has a component to hydrate.
import { createElement, createRangeRoot, run } from 'remix/component'

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

/** The components of the page that the server sent, from its `<script id="rmx-data">`. */
interface HydrationData {
  h?: Record<string, { exportName: string; moduleUrl: string; props: Record<string, unknown> }>
}

/**
 * Hydrates the components in `root`, HTML of the server that a script put in the page after the
 * load (repo-toggle.js swaps a row): `run()` reads the page once. The props come from the page that
 * `source` parsed. Only plain props: a prop with an element (`$rmx`) needs the reviver of the
 * runtime, which it does not export; such a component stays its HTML without JavaScript.
 */
async function hydrateIn(root: Element, source: Document) {
  let data: HydrationData
  try {
    data = JSON.parse(source.getElementById('rmx-data')?.textContent ?? '{}') as HydrationData
  } catch {
    return
  }
  let walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  let ranges: { start: Comment; end: Comment; id: string }[] = []
  while (walker.nextNode()) {
    let start = walker.currentNode as Comment
    let id = start.data.trim().match(/^rmx:h:(\w+)$/)?.[1]
    if (!id) continue
    let end = start.nextSibling
    while (end && !(end instanceof Comment && end.data.trim() === '/rmx:h')) end = end.nextSibling
    if (end instanceof Comment) ranges.push({ start, end, id })
  }
  for (let { start, end, id } of ranges) {
    let entry = data.h?.[id]
    if (!entry || JSON.stringify(entry.props).includes('"$rmx')) continue
    let module = (await import(entry.moduleUrl)) as Record<string, unknown>
    let component = module[entry.exportName]
    if (typeof component !== 'function') continue
    createRangeRoot([start, end]).render(createElement(component as Parameters<typeof createElement>[0], entry.props))
  }
}

document.addEventListener('kento:hydrate', (event) => {
  let { root, source } = (event as CustomEvent<{ root: Element; source: Document }>).detail
  hydrateIn(root, source).catch((error) => console.error('Component error:', error))
})

await app.ready()
// The e2e tests wait for it before they use a component.
document.documentElement.dataset.hydrated = ''
