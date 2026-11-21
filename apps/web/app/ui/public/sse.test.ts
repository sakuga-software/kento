import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BACKOFF_MAX_MS, backoffMs, sseParser, type SseEvent } from './sse.ts'

describe('the stream reader of the live card (KNT-189)', () => {
  it('reads events across chunks, skips the comments, and joins the data lines', () => {
    let events: SseEvent[] = []
    let feed = sseParser((event) => events.push(event))
    feed(': ping\n\nevent: queue\ndata: {"html":')
    assert.deepEqual(events, [])
    feed('"<div>"}\n\n')
    feed('data: one\r\ndata: two\r\n\r\nevent: end\n')
    feed('data: {}\n\nevent: nothing\n\n')
    assert.deepEqual(events, [
      { type: 'queue', data: '{"html":"<div>"}' },
      { type: 'message', data: 'one\ntwo' },
      { type: 'end', data: '{}' },
    ])
  })

  it('waits longer after each failure, up to 30 s, with a spread', () => {
    assert.equal(backoffMs(0, () => 0), 500)
    assert.equal(backoffMs(0, () => 1), 1000)
    assert.equal(backoffMs(3, () => 1), 8000)
    assert.equal(backoffMs(20, () => 1), BACKOFF_MAX_MS)
    assert.equal(backoffMs(20, () => 0), BACKOFF_MAX_MS / 2)
  })
})
