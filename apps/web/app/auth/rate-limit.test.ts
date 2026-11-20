import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { clientAddress, createRateLimiter, limitKey } from './rate-limit.ts'

// KNT-150. The address of the client of a sign-in, and the limit by client.
describe('the address of the client', () => {
  let request = (forwarded?: string) => new Request('http://localhost/login/github', { headers: forwarded ? { 'X-Forwarded-For': forwarded } : {} })

  it('is the socket without a trusted proxy, whatever the client writes', () => {
    assert.equal(clientAddress(request('192.0.2.1'), '203.0.113.5', 0), '203.0.113.5')
    assert.equal(clientAddress(request(), '203.0.113.5', 0), '203.0.113.5')
  })

  it('is the entry that the outermost trusted proxy added, never one that the client wrote', () => {
    // One proxy (Traefik) appends the address it got the request from.
    assert.equal(clientAddress(request('198.51.100.9'), '10.0.0.2', 1), '198.51.100.9')
    assert.equal(clientAddress(request('192.0.2.1, 198.51.100.9'), '10.0.0.2', 1), '198.51.100.9')
    // Two proxies: a CDN, then Traefik.
    assert.equal(clientAddress(request('192.0.2.1, 198.51.100.9, 10.1.1.1'), '10.0.0.2', 2), '198.51.100.9')
  })

  it('falls back to the socket on a chain that does not resolve, never to one shared value', () => {
    assert.equal(clientAddress(request(), '10.0.0.2', 1), '10.0.0.2')
    assert.equal(clientAddress(request('198.51.100.9'), '10.0.0.2', 2), '10.0.0.2', 'shorter than the trusted hops')
    assert.equal(clientAddress(request('not-an-address'), '10.0.0.2', 1), '10.0.0.2')
    assert.equal(clientAddress(request(''), '10.0.0.2', 1), '10.0.0.2')
    assert.equal(clientAddress(request('198.51.100.9'), null, 1), null, 'no socket: a request that no server received')
  })

  it('keys an IPv6 address by its /64, and an IPv4 one as it is', () => {
    assert.equal(limitKey('203.0.113.5'), '203.0.113.5')
    assert.equal(limitKey('::ffff:203.0.113.5'), '203.0.113.5')
    assert.equal(limitKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64')
    assert.equal(limitKey('2001:db8:1:2::9'), '2001:db8:1:2::/64')
    assert.equal(limitKey('2001:0db8:0001:0002:ffff::1'), '2001:db8:1:2::/64')
    assert.equal(limitKey('2001:db8::1'), '2001:db8:0:0::/64')
    assert.equal(limitKey('::1'), '0:0:0:0::/64')
  })
})

describe('the limit by client', () => {
  it('lets `max` requests of a key pass in a window, then refuses until the next window', () => {
    let clock = { now: 0 }
    let limiter = createRateLimiter({ windowMs: 60_000, max: 3, now: () => clock.now })
    assert.deepEqual([1, 2, 3, 4].map(() => limiter.hit('a')), [true, true, true, false])
    assert.equal(limiter.hit('b'), true, 'another key has its own count')
    clock.now = 60_000
    assert.equal(limiter.hit('a'), true)
  })

  it('holds a bounded number of keys', () => {
    let clock = { now: 0 }
    let limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => clock.now, maxKeys: 3 })
    for (let key of ['a', 'b', 'c', 'd']) assert.equal(limiter.hit(key), true)
    // `a` was dropped to make room: it starts a new window.
    assert.equal(limiter.hit('a'), true)
    assert.equal(limiter.hit('d'), false)
  })
})
