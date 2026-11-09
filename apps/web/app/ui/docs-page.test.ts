import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { fakeAuth } from '../auth/test-helpers.ts'
import { DOCS_PATH } from '../commands/refutation.ts'
import { spyStore, webhookDeps } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'

const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

function router(auth: ReturnType<typeof fakeAuth>['deps'] | null) {
  return createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: webhookDeps(spyStore().apply),
    auth,
  })
}

describe('the page of the commands (REV-96)', () => {
  it('opens without a sign-in, at the address of the hint, and describes review, force, resolve and reject', async () => {
    assert.equal(DOCS_PATH, '/docs/commandes')
    for (let auth of [fakeAuth().deps, null]) {
      let response = await router(auth).fetch(new Request(`https://review.sakuga.dev${DOCS_PATH}`, { headers: BROWSER }))
      assert.equal(response.status, 200)
      assert.match(response.headers.get('Content-Type') ?? '', /text\/html/)
      assert.match(response.headers.get('Content-Security-Policy') ?? '', /default-src 'self'/)
      let html = await response.text()
      assert.match(html, /<title>Les commandes · Kentō<\/title>/)
      assert.match(html, /<h1>Les commandes de Kentō<\/h1>/)
      for (let id of ['review', 'force', 'resolve', 'reject']) assert.match(html, new RegExp(`<section id="${id}"[^>]*class="docs-command"`))
      assert.match(html, /@kento-review reject &lt;cause&gt;|@kento-review reject <cause>/)
      assert.match(html, /@kento-review reject #3cf454 &lt;cause&gt;|@kento-review reject #3cf454 <cause>/)
      // No redirect to the sign-in, no cookie of a session.
      assert.equal(response.headers.get('Set-Cookie'), null)
    }
  })
})
