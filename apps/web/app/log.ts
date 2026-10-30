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

/** The message of an error, without its stack. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
