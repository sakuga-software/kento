import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { CheckDatabase } from '../db/health.ts'
import { createAppRouter } from '../router.ts'
import { routes } from '../routes.ts'
import { disabledWebhook } from '../github/test-helpers.ts'

function routerWith(checkDatabase: CheckDatabase) {
  return createAppRouter({ checkDatabase, version: '1.2.3', commit: 'abc1234', webhook: disabledWebhook })
}

function get(router: ReturnType<typeof routerWith>, href: string) {
  return router.fetch(new URL(href, 'http://localhost'))
}

describe('GET /healthz', () => {
  it('returns 200 with the version and the state of the database', async () => {
    let calls = 0
    let router = routerWith(async () => {
      calls++
      return { status: 'ok', latencyMs: 3, migrations: 1 }
    })

    let response = await get(router, routes.healthz.href())

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(await response.json(), {
      status: 'ok',
      version: '1.2.3',
      commit: 'abc1234',
      database: { status: 'ok', latencyMs: 3, migrations: 1 },
    })
    assert.equal(calls, 1)
  })

  it('reads the database again on each call', async () => {
    let calls = 0
    let router = routerWith(async () => {
      calls++
      return { status: 'ok', latencyMs: 1, migrations: 1 }
    })

    await get(router, routes.healthz.href())
    await get(router, routes.healthz.href())

    assert.equal(calls, 2)
  })

  it('returns 503 when the database does not answer', async () => {
    let router = routerWith(async () => ({ status: 'error', latencyMs: 2000, error: 'timeout' }))

    let response = await get(router, routes.healthz.href())

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      status: 'error',
      version: '1.2.3',
      commit: 'abc1234',
      database: { status: 'error', latencyMs: 2000, error: 'timeout' },
    })
  })
})
