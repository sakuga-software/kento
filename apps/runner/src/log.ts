// The log of the runner: one JSON object per line. Every line goes through `redact` first, so a
// secret that the runner knows never reaches the output, even inside the message of an error.

const secrets = new Set<string>();

/** Adds a value that no log line may contain: a token or a key. */
export function addSecret(value: string | null | undefined): void {
  if (value && value.length >= 4) secrets.add(value);
}

/** Removes a value that is no longer in use, for example the token of a finished job. */
export function removeSecret(value: string | null | undefined): void {
  if (value) secrets.delete(value);
}

// Tokens that the runner may not know but that must never appear: GitHub tokens, and the
// credentials of a URL.
const PATTERNS: RegExp[] = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /(https?:\/\/)[^\s/@]+@/g, /kento_rt_[A-Za-z0-9_-]{20,}/g];

export function redact(text: string): string {
  let out = text;
  // The longest first, so that a secret that holds another one is removed whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('[redacted]');
  for (const pattern of PATTERNS) out = out.replace(pattern, (match, scheme?: string) => (scheme && match.startsWith(scheme) ? `${scheme}[redacted]@` : '[redacted]'));
  return out;
}

type Level = 'info' | 'warn' | 'error';

/** Where the lines go. A test replaces it to read them. */
export const output: { write: (level: Level, line: string) => void } = {
  write: (level, line) => void (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`),
};

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  // A field never replaces the time, the level or the event of the line.
  output.write(level, redact(JSON.stringify(Object.assign({ time: new Date().toISOString(), level, event }, fields, { level, event }))));
}

export function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
