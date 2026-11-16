// REV-115. The keys and values of a query that an earlier release wrote in French, on the screens that
// wrote them. A bookmark or a link in a comment on GitHub can still hold them: a GET of such a screen
// gets a permanent redirect to the same URL with the English names.
import type { Middleware } from 'remix/router'

interface LegacyNames {
  /** An old key of a query, and its key now. */
  keys: Readonly<Record<string, string>>
  /** An old value of a key (by the key now), and its value now. */
  values?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

/** The screens with old names, by their path. */
const SCREENS: readonly [path: RegExp, names: LegacyNames][] = [
  [/^\/repos\/[^/]+\/pulls\/[^/]+$/, { keys: { statut: 'status', avant: 'before', suite: 'after', relance: 'rerun' } }],
  [/^\/findings$/, { keys: { vue: 'view' }, values: { type: { 'a-considerer': 'to-consider' } } }],
  [/^\/findings\/[^/]+$/, { keys: { fait: 'done', historique: 'history' } }],
  [/^\/users\/[^/]+$/, { keys: { fait: 'done' } }],
  [/^\/feedback$/, { keys: { auteur: 'author' } }],
]

/** The URL with the names of today, or null when the screen has no old name in the query. */
export function currentUrl(url: URL): string | null {
  let names = SCREENS.find(([path]) => path.test(url.pathname))?.[1]
  if (!names) return null
  let changed = false
  let query = new URLSearchParams()
  for (let [key, value] of url.searchParams) {
    let name = Object.hasOwn(names.keys, key) ? names.keys[key]! : key
    let values = names.values?.[name]
    let current = values && Object.hasOwn(values, value) ? values[value]! : value
    if (name !== key || current !== value) changed = true
    query.append(name, current)
  }
  if (!changed) return null
  return `${url.pathname}?${query}`
}

/** Sends a GET or a HEAD of a screen whose query holds an old name to the URL with the names of today. */
export function legacyQueryRedirect(): Middleware {
  return (context, next) => {
    let { method } = context.request
    if (method !== 'GET' && method !== 'HEAD') return next()
    let location = currentUrl(context.url)
    return location ? new Response(null, { status: 301, headers: { Location: location } }) : next()
  }
}
