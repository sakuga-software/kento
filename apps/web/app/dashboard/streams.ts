// KNT-189. The open streams of the live card, by session (Fable P2-2, P2-3 of #53). A stream holds
// its place from its start until its response is read out or cut, not only until it stops sending:
// a client that stops reading keeps its socket, so it keeps its place too. The sign-out, the switch
// of org and the end of a session end the streams of that session at once.

/** The streams that one session holds at once: a few tabs. */
export const LIVE_PER_SESSION = 4
/** The streams of the whole service: beyond, a new one waits (503). */
export const LIVE_TOTAL = 200

/** Why a stream ends before its time. */
export type EndReason = 'sign-out' | 'org switch' | 'session ended' | 'shutdown'

export interface LiveEntry {
  sessionId: string
  /** Ends the stream with no event `end`: the browser connects again, and the checks run again. */
  end(reason: EndReason): void
}

export interface LiveRegistry {
  /** Whether a new stream of the session may open: `session` and `total` say which limit it meets. */
  admit(sessionId: string): 'ok' | 'session' | 'total'
  add(entry: LiveEntry): void
  /** Frees the place of a stream: its response was read out or cut. */
  remove(entry: LiveEntry): void
  /** Ends the streams of a session (they free their places when their responses close). */
  endSession(sessionId: string, reason: EndReason): void
  endAll(reason: EndReason): void
  /** The places held now. */
  size(): number
}

export function createLiveRegistry(limits: { perSession?: number; total?: number } = {}): LiveRegistry {
  let perSession = limits.perSession ?? LIVE_PER_SESSION
  let total = limits.total ?? LIVE_TOTAL
  let bySession = new Map<string, Set<LiveEntry>>()
  let count = 0
  return {
    admit(sessionId) {
      if (count >= total) return 'total'
      if ((bySession.get(sessionId)?.size ?? 0) >= perSession) return 'session'
      return 'ok'
    },
    add(entry) {
      let entries = bySession.get(entry.sessionId) ?? new Set()
      if (entries.has(entry)) return
      entries.add(entry)
      bySession.set(entry.sessionId, entries)
      count += 1
    },
    remove(entry) {
      let entries = bySession.get(entry.sessionId)
      if (!entries?.delete(entry)) return
      count -= 1
      if (entries.size === 0) bySession.delete(entry.sessionId)
    },
    // A copy of each set: an entry that ends can free its place at once, and leave the set.
    endSession(sessionId, reason) {
      for (let entry of Array.from(bySession.get(sessionId) ?? [])) entry.end(reason)
    },
    endAll(reason) {
      for (let entry of Array.from(bySession.values()).flatMap((entries) => Array.from(entries))) entry.end(reason)
    },
    size() {
      return count
    },
  }
}
