import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { createRouter } from 'remix/router'

import { requestLogger } from './request-logger.ts'

/** The lines that `run` writes on stderr and stdout, parsed. */
async function linesOf(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  let lines: string[] = []
  let out = process.stdout.write
  let err = process.stderr.write
  let capture = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write
  process.stdout.write = capture
  process.stderr.write = capture
  try {
    await run().catch(() => {})
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
  return lines.flatMap((line) => line.split('\n').filter(Boolean)).map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('the log of the requests', () => {
  it('logs a request that the client abandoned as a 499 at info, and a thrown error as a 500 (KNT-189)', async () => {
    let router = createRouter({ middleware: [requestLogger()] })
    let gate = Promise.withResolvers<void>()
    router.get('/slow', async () => {
      await gate.promise
      return new Response('late')
    })
    router.get('/broken', () => {
      throw new Error('boom')
    })

    let client = new AbortController()
    let aborted = await linesOf(async () => {
      let pending = router.fetch(new Request('http://localhost/slow', { signal: client.signal }))
      client.abort()
      gate.resolve()
      await pending
    })
    let left = aborted.find((line) => line.path === '/slow')
    assert.equal(left?.level, 'info')
    assert.equal(left?.status, 499)
    assert.equal(left?.aborted, true)

    let broken = await linesOf(() => router.fetch(new Request('http://localhost/broken')))
    let failed = broken.find((line) => line.path === '/broken')
    assert.equal(failed?.level, 'error')
    assert.equal(failed?.status, 500)
  })
})
