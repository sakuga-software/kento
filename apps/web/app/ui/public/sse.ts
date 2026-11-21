// KNT-189. What the live card of the dashboard needs to read a stream of server-sent events with
// `fetch` (an EventSource hides the status of the answer: a sign-in redirect would look like a
// network error, and it would try again forever).

export interface SseEvent {
  /** The field `event`, or `message` without it. */
  type: string
  /** The lines `data`, joined with a newline. */
  data: string
}

/**
 * A parser of the text of a stream, chunk by chunk, as the format of the HTML standard says: an
 * event ends at an empty line, a line that starts with `:` is a comment (the heartbeat), and an
 * event with no `data` is not sent.
 */
export function sseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let buffer = ''
  let type = ''
  let data: string[] = []
  return (chunk) => {
    buffer += chunk
    let lines = buffer.split(/\r\n|\r|\n/)
    // The last part has no end of line yet: it waits for the next chunk.
    buffer = lines.pop() ?? ''
    for (let line of lines) {
      if (line === '') {
        if (data.length > 0) onEvent({ type: type || 'message', data: data.join('\n') })
        type = ''
        data = []
        continue
      }
      if (line.startsWith(':')) continue
      let colon = line.indexOf(':')
      let field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') type = value
      else if (field === 'data') data.push(value)
    }
  }
}

/** The longest wait between two tries. */
export const BACKOFF_MAX_MS = 30_000

/**
 * The wait before the try `attempt` (0 for the first one after a failure): 1 s, 2 s, 4 s… up to
 * 30 s, between half of it and all of it, so that the tabs of a restart do not come back together.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  let ceiling = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.max(0, attempt))
  return Math.round(ceiling / 2 + (random() * ceiling) / 2)
}
