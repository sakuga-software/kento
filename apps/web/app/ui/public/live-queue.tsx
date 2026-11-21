// KNT-189. The card "Queue and runners" of the dashboard, live. The server renders the card and an
// empty state; in the browser this component opens the stream of the card (`/dashboard/live`, the
// org of the session only) and puts each card that comes in place of the one on the page. It says
// "Live" while the stream is open, and "Retrying…" while it waits to try again. Without
// JavaScript, or when the stream is closed, the card is the one of the page, and
// public/assets/dashboard.js reads it again every 10 s.
import { clientEntry, ref, type Handle } from 'remix/component'

import { pageRoutes } from '../../routes.ts'
import { backoffMs, sseParser } from './sse.ts'

/** The id of the card, on the page and in each card of the stream. */
export const QUEUE_CARD_ID = 'dash-queue-card'

/**
 * The server sends a comment every 25 s: with nothing for this long, the connection is dead (a
 * proxy, a laptop that slept) and the component opens another one.
 */
export const SILENCE_MS = 60_000

/**
 * - `off`: no stream (the server render, a hidden tab, a sign-in that ended);
 * - `connecting`: the first answer is on its way;
 * - `live`: the card follows the stream;
 * - `reconnecting`: the stream failed, the next try waits.
 */
export type LiveState = 'off' | 'connecting' | 'live' | 'reconnecting'

/** What the stream sends in each event `queue`. */
interface QueuePayload {
  html: string
}

export const LiveQueue = clientEntry(import.meta.url, function LiveQueue(handle: Handle<Record<string, never>>) {
  let state: LiveState = 'off'
  let node: HTMLElement | null = null
  /** A card that came while the focus was in the card: it waits until the focus leaves. */
  let pending: string | null = null
  /** The connection now, to close it when the tab hides or the component goes. */
  let current: AbortController | null = null

  let section = () => node?.closest<HTMLElement>('[data-live-queue]') ?? null

  let setState = (next: LiveState) => {
    if (next === state) return
    state = next
    let host = section()
    // dashboard.js reads it: while the card is live, its read of the page keeps this section.
    if (host) host.dataset.liveState = next
    void handle.update()
  }

  let apply = (html: string) => {
    let card = section()?.querySelector<HTMLElement>(`#${QUEUE_CARD_ID}`)
    if (!card) return
    // A person who is on a link of the card keeps their focus: no swap under them.
    if (card.contains(document.activeElement)) {
      pending = html
      return
    }
    pending = null
    // DOMParser: the scripts of a parsed document never run (the card has none anyway).
    let next = new DOMParser().parseFromString(html, 'text/html').getElementById(QUEUE_CARD_ID)
    if (!next) return
    let before = card.querySelector('[data-ready]')?.getAttribute('data-ready')
    let ready = next.querySelector('[data-ready]')
    // kento.css marks a count that changed, without motion for prefers-reduced-motion.
    if (ready && before != null && before !== ready.getAttribute('data-ready')) ready.classList.add('is-changed')
    card.replaceWith(document.adoptNode(next))
  }

  let sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      let timer = setTimeout(resolve, ms)
      handle.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })

  let visible = () =>
    new Promise<void>((resolve) => {
      if (document.visibilityState === 'visible' || handle.signal.aborted) return resolve()
      let done = () => {
        if (document.visibilityState !== 'visible' && !handle.signal.aborted) return
        document.removeEventListener('visibilitychange', done)
        resolve()
      }
      document.addEventListener('visibilitychange', done)
      handle.signal.addEventListener('abort', done, { once: true })
    })

  /** One connection. `ended`: the server closed it at the end of its time, so the next one opens at once. */
  let connect = async (): Promise<'ended' | 'failed' | 'refused'> => {
    let controller = new AbortController()
    current = controller
    let silence: ReturnType<typeof setTimeout> | undefined
    let listen = () => {
      clearTimeout(silence)
      silence = setTimeout(() => controller.abort(), SILENCE_MS)
    }
    let ended = false
    try {
      listen()
      let response = await fetch(pageRoutes.dashboardLive.href(), {
        headers: { Accept: 'text/event-stream' },
        credentials: 'same-origin',
        cache: 'no-store',
        // A redirect is the sign-in page: the session ended, and trying again cannot help.
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403 || response.status === 404) return 'refused'
      if (!response.ok || !response.body) return 'failed'
      let reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let feed = sseParser((event) => {
        if (event.type === 'end') ended = true
        if (event.type !== 'queue') return
        let payload = JSON.parse(event.data) as QueuePayload
        apply(payload.html)
        setState('live')
      })
      for (;;) {
        let { value, done } = await reader.read()
        if (done) break
        listen()
        if (value) feed(value)
      }
      return ended ? 'ended' : 'failed'
    } catch {
      return 'failed'
    } finally {
      clearTimeout(silence)
      if (current === controller) current = null
    }
  }

  let loop = async () => {
    let attempt = 0
    while (!handle.signal.aborted) {
      if (document.visibilityState !== 'visible') {
        setState('off')
        await visible()
        continue
      }
      if (state !== 'reconnecting') setState('connecting')
      let outcome = await connect()
      if (handle.signal.aborted) return
      if (outcome === 'refused') return setState('off')
      // The tab hid during the stream: the loop waits for it without a "Retrying…".
      if (document.visibilityState !== 'visible') continue
      if (outcome === 'ended') {
        attempt = 0
        continue
      }
      setState('reconnecting')
      await sleep(backoffMs(attempt))
      attempt += 1
    }
  }

  handle.queueTask(() => {
    let host = section()
    if (!host) return
    // A hidden tab holds no stream: the server reads nothing for it.
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'visible') current?.abort()
      },
      { signal: handle.signal },
    )
    host.addEventListener(
      'focusout',
      (event) => {
        let card = host.querySelector(`#${QUEUE_CARD_ID}`)
        if (pending !== null && !(event.relatedTarget instanceof Node && card?.contains(event.relatedTarget))) apply(pending)
      },
      { signal: handle.signal },
    )
    handle.signal.addEventListener('abort', () => current?.abort(), { once: true })
    void loop()
  })

  return () => (
    <span
      class="live-state"
      data-state={state}
      role="status"
      hidden={state === 'off' || state === 'connecting'}
      title={state === 'reconnecting' ? 'The live updates stopped. The card tries to connect again.' : undefined}
      mix={ref((element: HTMLElement) => (node = element))}
    >
      {/* "Retrying…": "Reconnecting…" does not fit beside the title in the side column of 340 px. */}
      {state === 'live' ? 'Live' : state === 'reconnecting' ? 'Retrying…' : ''}
    </span>
  )
})
