// KNT-150. A limit on the start of a GitHub sign-in and on its callback, by client.
//
// The limiter of Better Auth is off (app/auth/better-auth.ts): it keys on an `X-Forwarded-For`
// that the client can write, or else on one bucket that everyone shares, so a flood from one place
// stops every sign-in. Here the key is the address of the client as Kentō resolves it: the address
// of the socket, or the address that a trusted proxy added (KENTO_TRUSTED_PROXY_HOPS). A chain that
// does not resolve falls back to the address of the socket, never to a bucket of everyone.
import { isIP } from 'node:net'

/** The address of the socket of each request, written by server.ts before the router reads it. */
const socketAddresses = new WeakMap<Request, string>()

/** server.ts: the address of the socket of a request. */
export function rememberClientAddress(request: Request, address: string): void {
  socketAddresses.set(request, address)
}

/** The address of the socket of a request, or null for a request that no server received (a test). */
export function socketAddressOf(request: Request): string | null {
  return socketAddresses.get(request) ?? null
}

/**
 * The address of the client of a request. `trustedHops` proxies are in front of the service (0:
 * none, the socket is the client). Each one appends the address it received from to
 * `X-Forwarded-For`, so the client is the entry `trustedHops` from the end; the entries before it
 * are written by the client and never read. A missing header, a chain shorter than the trusted
 * hops, or an entry that is not an address gives the address of the socket.
 */
export function clientAddress(request: Request, socket: string | null, trustedHops: number): string | null {
  if (trustedHops <= 0 || socket === null) return socket
  let header = request.headers.get('X-Forwarded-For')
  if (!header) return socket
  let chain = header.split(',').map((entry) => entry.trim())
  if (chain.length < trustedHops) return socket
  let candidate = chain[chain.length - trustedHops]!
  return isIP(candidate) ? candidate : socket
}

/**
 * The key of an address in a limit: an IPv4 address as it is, an IPv6 address by its /64 (one
 * client usually holds a whole /64, and would get a new bucket per address otherwise).
 */
export function limitKey(address: string): string {
  let mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return mapped[1]!
  if (isIP(address) !== 6) return address
  let [head = '', tail = ''] = address.toLowerCase().split('::')
  let left = head ? head.split(':') : []
  let right = tail ? tail.split(':') : []
  let groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

export interface RateLimiter {
  /** Counts one request of `key`. False when the key is over its limit in the current window. */
  hit(key: string): boolean
}

/**
 * A fixed window of `windowMs` per key, `max` requests in it. The keys of past windows are dropped,
 * and the map never holds more than `maxKeys`: past it, the oldest keys go first.
 */
export function createRateLimiter(options: { windowMs: number; max: number; now?: () => number; maxKeys?: number }): RateLimiter {
  let now = options.now ?? Date.now
  let maxKeys = options.maxKeys ?? 50_000
  let windows = new Map<string, { start: number; count: number }>()
  return {
    hit(key) {
      let at = now()
      let current = windows.get(key)
      if (!current || at - current.start >= options.windowMs) {
        windows.delete(key)
        if (windows.size >= maxKeys) {
          for (let [old, window] of windows) {
            if (at - window.start >= options.windowMs || windows.size >= maxKeys) windows.delete(old)
            else break
          }
        }
        windows.set(key, { start: at, count: 1 })
        return true
      }
      current.count++
      return current.count <= options.max
    },
  }
}

/** The default of KENTO_SIGN_IN_LIMIT: the starts of a sign-in per minute and per client. Each one writes a row of `verifications`. */
export const SIGN_IN_STARTS_PER_MINUTE = 10
