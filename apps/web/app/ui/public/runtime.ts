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

/** Something that the runtime can take out of the page, with its listeners. */
interface Disposable {
  dispose(): void
}

/** The roots that `hydrateIn` made, by the comment that starts their range. */
let roots = new WeakMap<Comment, Disposable>()

/** The comments that start the range of a component in `root`, with their id and their end. */
function ranges(root: Element) {
  let walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  let found: { start: Comment; end: Comment; id: string }[] = []
  while (walker.nextNode()) {
    let start = walker.currentNode as Comment
    let id = start.data.trim().match(/^rmx:h:(\w+)$/)?.[1]
    if (!id) continue
    let end = start.nextSibling
    while (end && !(end instanceof Comment && end.data.trim() === '/rmx:h')) end = end.nextSibling
    if (end instanceof Comment) found.push({ start, end, id })
  }
  return found
}

/**
 * Takes the components of `root` out, before a script removes it from the page (repo-toggle.js
 * swaps a row): their listeners on `document` go with them (Fable critique P3-3). A root of
 * `hydrateIn` is in `roots`; one that `run()` hydrated at load is on its start comment, as `$rmx`.
 * `$rmx` is a private field of remix/component 1.2, not an API (Fable re-check N-3): check it at
 * each upgrade of `remix`. If it goes, nothing breaks but the listeners of a swapped row stay, and
 * the e2e "a row swapped 4 times in place leaves no listener behind" fails.
 */
function disposeIn(root: Element) {
  for (let { start } of ranges(root)) {
    let owned = roots.get(start) ?? (start as Comment & { $rmx?: Partial<Disposable> }).$rmx
    if (typeof owned?.dispose === 'function') owned.dispose()
    roots.delete(start)
  }
}

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
  for (let { start, end, id } of ranges(root)) {
    let entry = data.h?.[id]
    if (!entry || JSON.stringify(entry.props).includes('"$rmx')) continue
    let module = (await import(entry.moduleUrl)) as Record<string, unknown>
    let component = module[entry.exportName]
    if (typeof component !== 'function') continue
    let vroot = createRangeRoot([start, end])
    roots.set(start, vroot)
    vroot.render(createElement(component as Parameters<typeof createElement>[0], entry.props))
  }
}

document.addEventListener('kento:dispose', (event) => {
  disposeIn((event as CustomEvent<{ root: Element }>).detail.root)
})

document.addEventListener('kento:hydrate', (event) => {
  let { root, source } = (event as CustomEvent<{ root: Element; source: Document }>).detail
  hydrateIn(root, source).catch((error) => console.error('Component error:', error))
})

await app.ready()
// The e2e tests wait for it before they use a component.
document.documentElement.dataset.hydrated = ''
