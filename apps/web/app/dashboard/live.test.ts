import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createLiveHub } from './live.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the source of the live card (KNT-189)', () => {
  it('reads each org once per tick, whatever the number of its listeners, and sends a payload only when it changed', async () => {
    let reads: string[] = []
    let version = 0
    let hub = createLiveHub({ intervalMs: 20, read: async (orgId) => (reads.push(orgId), `${orgId}:${version}`) })
    let a: string[] = []
    let b: string[] = []
    let c: string[] = []
    let stopA = hub.subscribe('org-1', (p) => a.push(p))
    let stopB = hub.subscribe('org-1', (p) => b.push(p))
    let stopC = hub.subscribe('org-2', (p) => c.push(p))
    await wait(110)
    let perOrg = (org: string) => reads.filter((r) => r === org).length
    // One timer per org: about 1 + 110 / 20 reads, never one per listener.
    assert.ok(perOrg('org-1') >= 3 && perOrg('org-1') <= 7, `reads of org-1: ${perOrg('org-1')}`)
    assert.deepEqual(a, ['org-1:0'], 'the same payload is sent once')
    assert.deepEqual(b, ['org-1:0'])
    assert.deepEqual(c, ['org-2:0'])
    version = 1
    await wait(50)
    assert.deepEqual(a, ['org-1:0', 'org-1:1'])
    assert.deepEqual(c, ['org-2:0', 'org-2:1'])
    stopA()
    stopB()
    stopC()
    assert.deepEqual(hub.orgs(), [])
    let after = reads.length
    await wait(60)
    assert.equal(reads.length, after, 'no read once the last listener left')
  })

  it('gives a new listener the last payload at once', async () => {
    let hub = createLiveHub({ intervalMs: 1000, read: async () => 'card' })
    let stop = hub.subscribe('org-1', () => {})
    await wait(10)
    let late: string[] = []
    let stopLate = hub.subscribe('org-1', (p) => late.push(p))
    assert.deepEqual(late, ['card'])
    stop()
    stopLate()
  })

  it('never runs two reads of one org at once, and goes on after a failed read', async () => {
    let running = 0
    let most = 0
    let calls = 0
    let hub = createLiveHub({
      intervalMs: 5,
      read: async () => {
        calls += 1
        running += 1
        most = Math.max(most, running)
        await wait(30)
        running -= 1
        if (calls === 1) throw new Error('database gone')
        return 'card'
      },
    })
    let got: string[] = []
    let write = process.stderr.write
    process.stderr.write = () => true
    try {
      let stop = hub.subscribe('org-1', (p) => got.push(p))
      await wait(100)
      stop()
    } finally {
      process.stderr.write = write
    }
    assert.equal(most, 1)
    assert.deepEqual(got, ['card'])
  })

  it('drops the listeners of an org after 3 failed reads in a row, and a good read starts the count again (Kentō #4570e9)', async () => {
    let results: ('ok' | 'fail')[] = ['fail', 'fail', 'ok', 'fail', 'fail', 'fail']
    let hub = createLiveHub({
      intervalMs: 10,
      read: async () => {
        let next = results.shift() ?? 'ok'
        if (next === 'fail') throw new Error('database gone')
        return 'card'
      },
    })
    let got: string[] = []
    let dropped: string[] = []
    let write = process.stderr.write
    process.stderr.write = () => true
    try {
      hub.subscribe('org-1', (p) => got.push(p), () => dropped.push('a'))
      hub.subscribe('org-1', () => {}, () => dropped.push('b'))
      await wait(120)
    } finally {
      process.stderr.write = write
    }
    // Two failures, a good read ("card" sent), then three failures: the source gives up.
    assert.deepEqual(got, ['card'])
    assert.deepEqual(dropped.sort(), ['a', 'b'])
    assert.deepEqual(hub.orgs(), [])
  })

  it('gives the payload to every listener when one throws, and does not count it as a failed read (Kentō #a2a122)', async () => {
    let reads = 0
    let version = 0
    let hub = createLiveHub({ intervalMs: 10, failures: 2, read: async () => ((reads += 1), `card-${version}`) })
    let got: string[] = []
    let dropped = 0
    let write = process.stderr.write
    process.stderr.write = () => true
    try {
      hub.subscribe('org-1', () => {
        throw new Error('a broken listener')
      }, () => (dropped += 1))
      hub.subscribe('org-1', (p) => got.push(p), () => (dropped += 1))
      await wait(30)
      version = 1
      await wait(30)
      version = 2
      await wait(30)
    } finally {
      process.stderr.write = write
    }
    assert.deepEqual(got, ['card-0', 'card-1', 'card-2'])
    assert.equal(dropped, 0, 'a throwing listener is not a failed read')
    assert.deepEqual(hub.orgs(), ['org-1'])
    hub.close()
  })

  it('stops every source on close', async () => {
    let reads = 0
    let hub = createLiveHub({ intervalMs: 10, read: async () => String((reads += 1)) })
    hub.subscribe('org-1', () => {})
    hub.subscribe('org-2', () => {})
    await wait(15)
    hub.close()
    assert.deepEqual(hub.orgs(), [])
    let after = reads
    await wait(40)
    assert.equal(reads, after)
  })
})
