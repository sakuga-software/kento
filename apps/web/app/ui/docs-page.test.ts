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
    assert.equal(DOCS_PATH, '/docs/commands')
    for (let auth of [fakeAuth().deps, null]) {
      let response = await router(auth).fetch(new Request(`https://review.sakuga.dev${DOCS_PATH}`, { headers: BROWSER }))
      assert.equal(response.status, 200)
      assert.match(response.headers.get('Content-Type') ?? '', /text\/html/)
      assert.match(response.headers.get('Content-Security-Policy') ?? '', /default-src 'self'/)
      let html = await response.text()
      assert.match(html, /<title>Commands · Kentō<\/title>/)
      assert.match(html, /<h1>Kentō commands<\/h1>/)
      for (let id of ['review', 'force', 'resolve', 'reject', 'feedback']) assert.match(html, new RegExp(`<section id="${id}"[^>]*class="docs-command"`))
      assert.match(html, /@kento-review reject &lt;cause&gt;|@kento-review reject <cause>/)
      assert.match(html, /@kento-review reject #3cf454 &lt;cause&gt;|@kento-review reject #3cf454 <cause>/)
      // REV-105. The cost of each command, and the same cost for an agent and for a person.
      assert.equal(html.split('<dt>Cost</dt>').length - 1, 5)
      // REV-107. `feedback`: free, and no job.
      assert.match(html, /@kento-review feedback &lt;opinion&gt;|@kento-review feedback <opinion>/)
      assert.match(html, /No model call and no job/)
      assert.match(html, /<code>heavy<\/code> 30 to 50 cents/)
      assert.match(html, /the command costs nothing/)
      assert.match(html, /A command that an agent writes \(Claude Code, Copilot\.\.\.\) has the same effect and the same cost as the command of a person\./)
      // No redirect to the sign-in, no cookie of a session.
      assert.equal(response.headers.get('Set-Cookie'), null)
    }
  })

  it('sends the French address of the comments before REV-114 to the new one, without a sign-in', async () => {
    for (let auth of [fakeAuth().deps, null]) {
      let response = await router(auth).fetch(new Request('https://review.sakuga.dev/docs/commandes?from=hint', { headers: BROWSER }))
      assert.equal(response.status, 301)
      assert.equal(response.headers.get('Location'), '/docs/commands?from=hint')
      assert.equal(response.headers.get('Set-Cookie'), null)
    }
  })
})
