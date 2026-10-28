import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BodyTooLargeError, readBodyLimited } from './read-body.ts'

// highWaterMark 0: the stream pulls only when the reader asks, so `pulls` counts the reads.
function streamOf(chunks: number[], onPull?: () => void): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream(
    {
    pull(controller) {
      onPull?.()
      if (index === chunks.length) return controller.close()
      controller.enqueue(new Uint8Array(chunks[index++]!))
    },
    },
    { highWaterMark: 0 },
  )
}

describe('readBodyLimited', () => {
  it('returns the bytes of a body under the limit', async () => {
    let request = new Request('http://localhost/', { method: 'POST', body: 'hello' })
    assert.equal(new TextDecoder().decode(await readBodyLimited(request, 5)), 'hello')
  })

  it('refuses a Content-Length over the limit before it reads a byte', async () => {
    let pulls = 0
    let request = new Request('http://localhost/', {
      method: 'POST',
      body: streamOf([10], () => pulls++),
      headers: { 'Content-Length': '11' },
      duplex: 'half',
    } as RequestInit)
    await assert.rejects(readBodyLimited(request, 10), BodyTooLargeError)
    assert.equal(pulls, 0)
  })

  it('stops a chunked body as soon as it passes the limit', async () => {
    let pulls = 0
    let request = new Request('http://localhost/', {
      method: 'POST',
      body: streamOf([4, 4, 4, 4, 4, 4], () => pulls++),
      duplex: 'half',
    } as RequestInit)
    await assert.rejects(readBodyLimited(request, 10), BodyTooLargeError)
    // Three chunks of 4 bytes pass 10: the reader stops there, and does not drain the stream.
    assert.ok(pulls <= 4, `pulled ${pulls} times`)
  })

  it('returns an empty body', async () => {
    let request = new Request('http://localhost/', { method: 'POST' })
    assert.equal((await readBodyLimited(request, 10)).byteLength, 0)
  })
})
