// KNT-189. The live card "Queue and runners" of the dashboard. The jobs and the runners send no
// notification (no LISTEN/NOTIFY), so the card is read again on a timer: one timer per org, shared
// by every open stream of that org, that runs only while one stream at least is open. Each stream
// gets the same payload, and only when it changed.
import { errorMessage, log } from '../log.ts'

/** The card is read again this often, while one person at least has the dashboard open. */
export const LIVE_INTERVAL_MS = 3_000

/**
 * After this many failed reads in a row (9 s at the default interval), the source drops its
 * listeners: their streams end, the browsers say "Retrying…", and the page re-read takes the card
 * again. A card that the database cannot read is never shown as live (Kentō #4570e9).
 */
export const LIVE_FAILURES = 3

/** Receives the payload of the org: at once when the source has one, then at each change. */
export type LiveListener = (payload: string) => void
/** Called once when the source of the org gives up after LIVE_FAILURES failed reads. */
export type LiveFailure = () => void

export interface LiveHub {
  /** Starts the source of the org with its first listener. The function that it returns stops the listener. */
  subscribe(orgId: string, listener: LiveListener, onFailure?: LiveFailure): () => void
  /** The orgs that have a source now (tests, logs). */
  orgs(): string[]
  /** Stops every source: the server shuts down. */
  close(): void
}

export interface LiveHubOptions {
  /** Reads the payload of one org. The payload is the same for every member of the org. */
  read(orgId: string): Promise<string>
  intervalMs?: number
  /** Default LIVE_FAILURES. */
  failures?: number
}

interface Source {
  listeners: Map<LiveListener, LiveFailure | undefined>
  last: string | null
  timer: ReturnType<typeof setInterval>
  /** A read is running: the next tick skips, so that a slow database never gets two reads of one org. */
  reading: boolean
  /** The failed reads in a row. */
  failed: number
}

export function createLiveHub({ read, intervalMs = LIVE_INTERVAL_MS, failures = LIVE_FAILURES }: LiveHubOptions): LiveHub {
  let sources = new Map<string, Source>()

  async function tick(orgId: string, source: Source) {
    if (source.reading) return
    source.reading = true
    try {
      let payload = await read(orgId)
      // The last listener left during the read: the source is gone.
      if (sources.get(orgId) !== source) return
      source.failed = 0
      if (payload === source.last) return
      source.last = payload
      for (let listener of source.listeners.keys()) listener(payload)
    } catch (error) {
      source.failed += 1
      log('warn', 'dashboard.live_read_failed', { orgId, failed: source.failed, error: errorMessage(error) })
      if (source.failed >= failures && sources.get(orgId) === source) {
        let dropped = [...source.listeners.values()]
        source.listeners.clear()
        stop(orgId, source)
        for (let onFailure of dropped) onFailure?.()
      }
    } finally {
      source.reading = false
    }
  }

  function stop(orgId: string, source: Source) {
    clearInterval(source.timer)
    if (sources.get(orgId) === source) sources.delete(orgId)
  }

  return {
    subscribe(orgId, listener, onFailure) {
      let source = sources.get(orgId)
      if (!source) {
        let created: Source = { listeners: new Map(), last: null, reading: false, failed: 0, timer: setInterval(() => void tick(orgId, created), intervalMs) }
        created.timer.unref?.()
        source = created
        sources.set(orgId, source)
        source.listeners.set(listener, onFailure)
        void tick(orgId, source)
      } else {
        source.listeners.set(listener, onFailure)
        if (source.last !== null) listener(source.last)
      }
      let owner = source
      return () => {
        owner.listeners.delete(listener)
        if (owner.listeners.size === 0) stop(orgId, owner)
      }
    },
    orgs() {
      return [...sources.keys()]
    },
    close() {
      for (let [orgId, source] of sources) {
        source.listeners.clear()
        stop(orgId, source)
      }
    },
  }
}
