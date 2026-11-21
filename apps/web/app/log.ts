type Level = 'info' | 'warn' | 'error'

/**
 * Writes one JSON object per line on stdout (info) or stderr (warn, error). Loki reads the
 * container output, and Grafana can filter on `level` and `event`.
 */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  // A field never replaces the time, the level or the event of the line.
  let own = { time: new Date().toISOString(), level, event }
  let line = JSON.stringify(Object.assign({ ...own }, fields, own))
  if (level === 'info') {
    process.stdout.write(`${line}\n`)
  } else {
    process.stderr.write(`${line}\n`)
  }
}

/**
 * The message of an error, without its stack. KNT-150: the message of a failed query of Drizzle
 * ends with the parameters of the query (`\nparams: …`), which can hold a token, a PKCE verifier or
 * a login. The message stops before them, and the cause is followed only for its code.
 */
export function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  let params = message.search(/\n\s*params:/)
  if (params < 0) return message
  let code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined
  return `${message.slice(0, params)}${typeof code === 'string' ? ` (${code})` : ''}`
}
