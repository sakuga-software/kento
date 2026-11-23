// KNT-189. The stream of the card "Queue and runners": only for a signed-in member, only the org of
// the session, a few streams per session and for the service, a heartbeat and an end; and, from the
// Fable critique of #53, a restart that the browser waits out, the end of the streams of a session
// that signs out, switches org or loses its membership, and the cut of a client that reads nothing.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { ROLE_TTL_MS } from '../auth/access.ts'
import { CAMILLE, cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, OTHER_ORG, SESSION_COOKIE, STRANGER } from '../auth/test-helpers.ts'
import type { DashboardStore, QueueCardView } from '../dashboard/store.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import type { LiveOptions } from './controllers/deps.ts'
import { sseParser, type SseEvent } from './public/sse.ts'

const NOW = new Date('2026-11-21T10:00:00Z')

/** The card of an org: its runner carries the id of the org in its name. */
function cardOf(orgId: string): QueueCardView {
  return {
    now: NOW,
    queue: { running: [], queued: [], runningCount: 0, queuedCount: 0 },
    runners: [{ id: `r-${orgId}`, name: `runner-of-${orgId}`, orgId, lastSeenAt: new Date(NOW.getTime() - 5_000), running: 0, busy: false }],
    runnerCounts: { online: 1, late: 0, offline: 0, ready: 1 },
  }
}

function setup(live: LiveOptions = {}, failing = false) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, OCTOCAT, 'member')
  auth.setRole(ORG, CAMILLE, 'member')
  auth.setRole(OTHER_ORG, CAMILLE, 'member')
  let cards: string[] = []
  let store: DashboardStore = {
    async screen() {
      throw new Error('the stream reads only the card')
    },
    async queueCard(orgId) {
      cards.push(orgId)
      if (failing) throw new Error('database gone')
      return cardOf(orgId)
    },
    async retryTarget() {
      return null
    },
    async retry() {
      return { kind: 'not_found' }
    },
    async dismissFailure() {
      return false
    },
  }
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    dashboard: { store, githubUrl: 'https://github.com', readPullRequest: null, live: { intervalMs: 20, ...live } },
  })

  function request(path: string, cookie?: string | null, form?: Record<string, string>, extra: Record<string, string> = {}) {
    let headers = new Headers({ Accept: form ? 'text/html' : 'text/event-stream', ...extra })
    if (cookie) headers.set('Cookie', cookie)
    let init: RequestInit = form ? { method: 'POST', headers, body: new URLSearchParams(form) } : { headers }
    return router.fetch(new Request(new URL(path, 'http://localhost'), init))
  }

  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookiesOf(start))
    return cookieOf(callback, SESSION_COOKIE)
  }

  /** The CSRF token of a session, from a screen. */
  async function csrfOf(cookie: string | null) {
    let html = await (await request('/runners', cookie)).text()
    return /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
  }

  return { auth, request, signIn, csrfOf, cards }
}

/** The first `count` events of a stream, then the stream is closed. */
async function eventsOf(response: Response, count: number): Promise<SseEvent[]> {
  let reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let found: SseEvent[] = []
  let feed = sseParser((event) => found.push(event))
  while (found.length < count) {
    let { value, done } = await reader.read()
    if (done) break
    if (value) feed(value)
  }
  await reader.cancel()
  return found
}

/** The raw text of a stream until `until` matches it, the stream ends, or `withinMs` passes. */
async function textOf(response: Response, until: RegExp, withinMs = 5_000): Promise<{ text: string; done: boolean; ms: number }> {
  let started = Date.now()
  let reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  let timer = setTimeout(() => void reader.cancel(), withinMs)
  try {
    for (;;) {
      let { value, done } = await reader.read()
      if (done) return { text, done: Date.now() - started < withinMs, ms: Date.now() - started }
      text += value
      if (until.test(text)) {
        await reader.cancel()
        return { text, done: false, ms: Date.now() - started }
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Runs `body` with the lines of stderr swallowed: the warnings of the refused requests. */
async function quiet<T>(body: () => Promise<T>): Promise<T> {
  let write = process.stderr.write
  process.stderr.write = () => true
  try {
    return await body()
  } finally {
    process.stderr.write = write
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the live card of the dashboard (KNT-189)', () => {
  it('sends nothing to a request without a session, nor to a person of no org', async () => {
    let { request, signIn, cards } = setup()
    let anonymous = await request('/dashboard/live')
    assert.notEqual(anonymous.status, 200)
    assert.notEqual(anonymous.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
    assert.match(anonymous.headers.get('Location') ?? '', /^\/login/)

    let stranger = await signIn(STRANGER)
    let refused = await request('/dashboard/live', stranger)
    assert.notEqual(refused.status, 200)
    assert.notEqual(refused.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
    assert.deepEqual(cards, [], 'no card was read')
  })

  it('sends the card of the org of the session, never the one that a session or a query names', async () => {
    let { auth, request, signIn, cards } = setup()
    let cookie = await signIn(OCTOCAT)
    // The session names an org of which octocat is not a member, and so does the query.
    for (let session of auth.tables.sessions!) session.activeOrganizationId = OTHER_ORG.id
    let response = await request(`/dashboard/live?org=${OTHER_ORG.id}`, cookie)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    let [event] = await eventsOf(response, 1)
    assert.equal(event?.type, 'queue')
    let { org, html } = JSON.parse(event!.data) as { org: string; html: string }
    // The org of the card: a page of another org reloads itself (Fable P3-1).
    assert.equal(org, ORG.id)
    assert.match(html, /^<div id="dash-queue-card" class="card dash-queue">/)
    assert.match(html, /runner-of-org-1/)
    assert.doesNotMatch(html, /org-2/)
    assert.match(html, /<span data-ready="1"[^>]*class="runner-ready">1 ready \/ 1 online<\/span>/)
    assert.ok(cards.length > 0)
    assert.ok(
      cards.every((org) => org === ORG.id),
      `the store read only the org of the membership: ${cards.join(', ')}`,
    )
  })

  it('sends the stream plain to a browser that accepts brotli and gzip, each event at once (KNT-202)', async () => {
    let { request, signIn } = setup()
    let cookie = await signIn(OCTOCAT)
    let response = await request('/dashboard/live', cookie, undefined, { 'Accept-Encoding': 'gzip, deflate, br, zstd' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
    assert.equal(response.headers.get('Content-Encoding'), null)
    let [event] = await eventsOf(response, 1)
    assert.equal(event?.type, 'queue')
  })

  it('holds a few streams per session, asks the fifth to wait (429 with Retry-After), and frees a place when a stream closes', async () => {
    let { request, signIn } = setup({ perSession: 2 })
    let cookie = await signIn(OCTOCAT)
    let first = await request('/dashboard/live', cookie)
    let second = await request('/dashboard/live', cookie)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    let third = await request('/dashboard/live', cookie)
    assert.equal(third.status, 429)
    assert.equal(third.headers.get('Retry-After'), '30')
    await first.body!.cancel()
    let again = await request('/dashboard/live', cookie)
    assert.equal(again.status, 200)
    await second.body!.cancel()
    await again.body!.cancel()
  })

  it('holds a few streams for the whole service, and asks for a wait beyond (Fable P2-3)', async () => {
    let { request, signIn } = setup({ total: 1 })
    let octocat = await signIn(OCTOCAT)
    let camille = await signIn(CAMILLE)
    let first = await request('/dashboard/live', octocat)
    assert.equal(first.status, 200)
    let other = await quiet(() => request('/dashboard/live', camille))
    assert.equal(other.status, 503)
    assert.equal(other.headers.get('Retry-After'), '30')
    await first.body!.cancel()
    let later = await request('/dashboard/live', camille)
    assert.equal(later.status, 200)
    await later.body!.cancel()
  })

  it('sends a heartbeat, and ends at its time with "end" so that the browser checks the session again', async () => {
    let { request, signIn } = setup({ heartbeatMs: 10, maxMs: 120, perSession: 1 })
    let cookie = await signIn(OCTOCAT)
    let beat = await textOf(await request('/dashboard/live', cookie), /^: ping$/m)
    assert.equal(beat.done, false)
    await wait(20)

    let full = await textOf(await request('/dashboard/live', cookie), /(?!)/)
    assert.equal(full.done, true)
    assert.match(full.text, /event: end\ndata: \{\}\n\n$/)
    // The stream that ended was read out: it gave its place back.
    let next = await request('/dashboard/live', cookie)
    assert.equal(next.status, 200)
    await next.body!.cancel()
  })

  it('ends the stream without "end" when the card cannot be read, so that the browser waits and retries (Kentō #4570e9)', async () => {
    let { request, signIn } = setup({ heartbeatMs: 1000 }, true)
    let cookie = await signIn(OCTOCAT)
    let { text, done } = await quiet(async () => textOf(await request('/dashboard/live', cookie), /(?!)/))
    assert.equal(done, true)
    assert.doesNotMatch(text, /event: (queue|end)/)
  })

  it('ends every stream at once when the server shuts down, and asks the browser to come back (Fable P2-1, P3-3)', async () => {
    let closing = new AbortController()
    let { request, signIn } = setup({ closing: closing.signal })
    let cookie = await signIn(OCTOCAT)
    let response = await request('/dashboard/live', cookie)
    setTimeout(() => closing.abort(), 30)
    // Well before the end of its time (2 minutes): the stream listens to the shutdown.
    let { done, ms } = await textOf(response, /(?!)/, 2_000)
    assert.equal(done, true)
    assert.ok(ms < 1_000, `ended after ${ms} ms`)
    let during = await request('/dashboard/live', cookie)
    assert.equal(during.status, 503)
    assert.equal(during.headers.get('Retry-After'), '5')
  })

  it('stops reading the card of the org once its last stream is gone (Fable P3-3)', async () => {
    let { request, signIn, cards } = setup()
    let cookie = await signIn(OCTOCAT)
    await eventsOf(await request('/dashboard/live', cookie), 1)
    await wait(30)
    let after = cards.length
    await wait(100)
    assert.equal(cards.length, after, 'the source of the org stopped with its last stream')
  })

  it('ends the streams of a session at its sign-out (Fable P2-2)', async () => {
    let { request, signIn, csrfOf } = setup()
    let cookie = await signIn(OCTOCAT)
    let token = await csrfOf(cookie)
    let response = await request('/dashboard/live', cookie)
    setTimeout(() => void request('/logout', cookie, { _csrf: token }), 30)
    let { done, ms, text } = await textOf(response, /(?!)/, 2_000)
    assert.equal(done, true)
    assert.ok(ms < 1_000, `ended after ${ms} ms`)
    // No "end": the browser connects again, and the sign-in refuses it.
    assert.doesNotMatch(text, /event: end/)
    assert.match((await request('/dashboard/live', cookie)).headers.get('Location') ?? '', /^\/login/)
  })

  it('ends the streams of a session when it switches to another org (Fable P2-2, P3-1)', async () => {
    let { request, signIn, csrfOf } = setup()
    let cookie = await signIn(CAMILLE)
    let token = await csrfOf(cookie)
    let response = await request('/dashboard/live', cookie)
    let first = await textOf(response, /event: queue\ndata: (.*)\n\n/)
    let org = (JSON.parse(/event: queue\ndata: (.*)\n\n/.exec(first.text)![1]!) as { org: string }).org
    let other = org === ORG.id ? OTHER_ORG.id : ORG.id
    let second = await request('/dashboard/live', cookie)
    setTimeout(() => void request('/preferences/org', cookie, { _csrf: token, orgId: other, returnTo: '/' }), 30)
    let { done, ms } = await textOf(second, /(?!)/, 2_000)
    assert.equal(done, true)
    assert.ok(ms < 1_000, `ended after ${ms} ms`)
    let [event] = await eventsOf(await request('/dashboard/live', cookie), 1)
    assert.equal((JSON.parse(event!.data) as { org: string }).org, other)
  })

  it('ends a stream whose member left the org, at its next check (Fable P2-2)', async () => {
    let { auth, request, signIn } = setup({ recheckMs: 40 })
    let cookie = await signIn(OCTOCAT)
    let response = await request('/dashboard/live', cookie)
    // GitHub no longer counts octocat in the org, and the role is old enough to be asked again.
    auth.setRole(ORG, OCTOCAT, null)
    auth.clock.now += ROLE_TTL_MS + 1000
    let { done, ms } = await quiet(() => textOf(response, /(?!)/, 2_000))
    assert.equal(done, true)
    assert.ok(ms < 1_000, `ended after ${ms} ms`)
  })

  it('keeps a stream whose session and org are still valid at each check', async () => {
    let { request, signIn } = setup({ recheckMs: 20 })
    let cookie = await signIn(OCTOCAT)
    let response = await request('/dashboard/live', cookie)
    let { done } = await textOf(response, /(?!)/, 300)
    assert.equal(done, false, 'the stream was still open after several checks')
  })

  it('cuts a stream whose client reads nothing, and frees its place (Fable P2-3)', async () => {
    let { request, signIn } = setup({ heartbeatMs: 5, stallMs: 60, highWaterMark: 256, perSession: 1 })
    let cookie = await signIn(OCTOCAT)
    let stalled = await request('/dashboard/live', cookie)
    // Nothing reads it: the card and the heartbeats fill its 256 bytes, then it waits 60 ms.
    await wait(200)
    let reader = stalled.body!.getReader()
    let failed = false
    try {
      for (;;) if ((await reader.read()).done) break
    } catch {
      failed = true
    }
    assert.equal(failed, true, 'the stream was cut')
    let next = await request('/dashboard/live', cookie)
    assert.equal(next.status, 200, 'the place came back')
    await next.body!.cancel()
  })

  it('keeps the place of a stream that ended until its client reads it out (Fable P2-3)', async () => {
    let { request, signIn } = setup({ maxMs: 40, stallMs: 200, highWaterMark: 64 * 1024, perSession: 1 })
    let cookie = await signIn(OCTOCAT)
    let ended = await request('/dashboard/live', cookie)
    // Its time is over, but nobody read the end: it still holds its place.
    await wait(100)
    assert.equal((await request('/dashboard/live', cookie)).status, 429)
    let { done } = await textOf(ended, /(?!)/)
    assert.equal(done, true)
    await wait(80)
    let next = await request('/dashboard/live', cookie)
    assert.equal(next.status, 200)
    await next.body!.cancel()
  })
})
