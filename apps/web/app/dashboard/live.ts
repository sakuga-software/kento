// KNT-189. The live card "Queue and runners" of the dashboard. The jobs and the runners send no
// notification (no LISTEN/NOTIFY), so the card is read again on a timer: one timer per org, shared
// by every open stream of that org, that runs only while one stream at least is open. Each stream
// gets the same payload, and only when it changed.
import { errorMessage, log } from '../log.ts'

/** The card is read again this often, while one person at least has the dashboard open. */
export const LIVE_INTERVAL_MS = 3_000

/** Receives the payload of the org: at once when the source has one, then at each change. */
export type LiveListener = (payload: string) => void

export interface LiveHub {
  /** Starts the source of the org with its first listener. The function that it returns stops the listener. */
  subscribe(orgId: string, listener: LiveListener): () => void
  /** The orgs that have a source now (tests, logs). */
  orgs(): string[]
  /** Stops every source: the server shuts down. */
  close(): void
}

export interface LiveHubOptions {
  /** Reads the payload of one org. The payload is the same for every member of the org. */
  read(orgId: string): Promise<string>
  intervalMs?: number
}

interface Source {
  listeners: Set<LiveListener>
  last: string | null
  timer: ReturnType<typeof setInterval>
  /** A read is running: the next tick skips, so that a slow database never gets two reads of one org. */
  reading: boolean
}

export function createLiveHub({ read, intervalMs = LIVE_INTERVAL_MS }: LiveHubOptions): LiveHub {
  let sources = new Map<string, Source>()

  async function tick(orgId: string, source: Source) {
    if (source.reading) return
    source.reading = true
    try {
      let payload = await read(orgId)
      // The last listener left during the read: the source is gone.
      if (sources.get(orgId) !== source || payload === source.last) return
      source.last = payload
      for (let listener of source.listeners) listener(payload)
    } catch (error) {
      log('warn', 'dashboard.live_read_failed', { orgId, error: errorMessage(error) })
    } finally {
      source.reading = false
    }
  }

  function stop(orgId: string, source: Source) {
    clearInterval(source.timer)
    if (sources.get(orgId) === source) sources.delete(orgId)
  }

  return {
    subscribe(orgId, listener) {
      let source = sources.get(orgId)
      if (!source) {
        let created: Source = { listeners: new Set(), last: null, reading: false, timer: setInterval(() => void tick(orgId, created), intervalMs) }
        created.timer.unref?.()
        source = created
        sources.set(orgId, source)
        source.listeners.add(listener)
        void tick(orgId, source)
      } else {
        source.listeners.add(listener)
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
