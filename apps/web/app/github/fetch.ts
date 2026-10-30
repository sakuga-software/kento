/** A read of GitHub for a screen gives up after this: the screen then shows the rest. */
export const SCREEN_GITHUB_TIMEOUT_MS = 5_000

/** A fetch that gives up after `ms`: a screen does not wait the 30 s of the publisher on GitHub. */
export function fetchWithin(ms: number, base: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return (url, init) => base(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) })
}
