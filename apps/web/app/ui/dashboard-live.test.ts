// KNT-189. The stream of the card "Queue and runners": only for a signed-in member, only the org of
// the session, a few streams per session, a heartbeat and an end.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, OTHER_ORG, SESSION_COOKIE, STRANGER } from '../auth/test-helpers.ts'
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

function setup(live: LiveOptions = {}) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, OCTOCAT, 'member')
  let cards: string[] = []
  let store: DashboardStore = {
    async screen() {
      throw new Error('the stream reads only the card')
    },
    async queueCard(orgId) {
      cards.push(orgId)
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

  function request(path: string, cookie?: string | null) {
    let headers = new Headers({ Accept: 'text/event-stream' })
    if (cookie) headers.set('Cookie', cookie)
    return router.fetch(new Request(new URL(path, 'http://localhost'), { headers }))
  }

  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookiesOf(start))
    return cookieOf(callback, SESSION_COOKIE)
  }

  return { auth, request, signIn, cards }
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

/** The raw text of a stream until `until` matches it or the stream ends. */
async function textOf(response: Response, until: RegExp): Promise<{ text: string; done: boolean }> {
  let reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  for (;;) {
    let { value, done } = await reader.read()
    if (done) return { text, done: true }
    text += value
    if (until.test(text)) {
      await reader.cancel()
      return { text, done: false }
    }
  }
}

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
    let { html } = JSON.parse(event!.data) as { html: string }
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

  it('holds a few streams per session, and frees one when it closes', async () => {
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

  it('sends a heartbeat, and ends at its time so that the browser checks the session again', async () => {
    let { request, signIn } = setup({ heartbeatMs: 10, maxMs: 120, perSession: 1 })
    let cookie = await signIn(OCTOCAT)
    let beat = await textOf(await request('/dashboard/live', cookie), /^: ping$/m)
    assert.equal(beat.done, false)

    let full = await textOf(await request('/dashboard/live', cookie), /(?!)/)
    assert.equal(full.done, true)
    assert.match(full.text, /event: end\ndata: \{\}\n\n$/)
    // The stream that ended gave its place back.
    let next = await request('/dashboard/live', cookie)
    assert.equal(next.status, 200)
    await next.body!.cancel()
  })

  it('ends every stream when the server shuts down', async () => {
    let closing = new AbortController()
    let { request, signIn } = setup({ closing: closing.signal })
    let cookie = await signIn(OCTOCAT)
    let response = await request('/dashboard/live', cookie)
    setTimeout(() => closing.abort(), 30)
    let { done } = await textOf(response, /(?!)/)
    assert.equal(done, true)
    assert.equal((await request('/dashboard/live', cookie)).status, 404)
  })
})
