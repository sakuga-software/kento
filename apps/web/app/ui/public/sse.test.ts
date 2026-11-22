import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BACKOFF_MAX_MS, backoffMs, RETRY_AFTER_MAX_MS, retryAfterMs, sseParser, type SseEvent } from './sse.ts'

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

  it('reads the wait of a Retry-After, in seconds or as a date, within bounds (Fable P2-1, P3-2)', () => {
    let now = Date.parse('2026-11-21T10:00:00Z')
    assert.equal(retryAfterMs('5', now), 5000)
    assert.equal(retryAfterMs(' 30 ', now), 30_000)
    assert.equal(retryAfterMs('Sat, 21 Nov 2026 10:00:10 GMT', now), 10_000)
    assert.equal(retryAfterMs('Sat, 21 Nov 2026 09:00:00 GMT', now), 0)
    assert.equal(retryAfterMs('86400', now), RETRY_AFTER_MAX_MS)
    assert.equal(retryAfterMs(null, now), null)
    assert.equal(retryAfterMs('soon', now), null)
  })
})
