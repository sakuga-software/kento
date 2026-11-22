// KNT-171. e2e/csp.spec.ts checks the content security policy on every screen: its list
// (e2e/csp-screens.ts) must name every GET route of app/routes.ts, or say why a route renders none.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { NOT_SCREENS, SIGNED_IN_SCREENS, SIGNED_OUT_SCREENS } from '../e2e/csp-screens.ts'
import * as allRoutes from './routes.ts'

/** The pattern of every GET route of the app. */
function getPatterns(): string[] {
  let patterns: string[] = []
  for (let group of Object.values(allRoutes)) {
    for (let route of Object.values(group as Record<string, { method: string; pattern: { source: string } }>)) {
      if (route.method === 'GET') patterns.push(route.pattern.source)
    }
  }
  return patterns.sort()
}

describe('the screens of the check of the content security policy (KNT-171)', () => {
  it('names every GET route of the app, as a screen visited or as a route with no screen', () => {
    let listed = [...SIGNED_IN_SCREENS, ...SIGNED_OUT_SCREENS, ...Object.keys(NOT_SCREENS)].sort()
    assert.deepEqual(listed, getPatterns())
    assert.equal(new Set(listed).size, listed.length, 'each route once')
  })
})
