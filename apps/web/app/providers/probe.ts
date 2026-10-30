import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { defaultBaseUrl } from '@sakuga-review/engine/providers'
import type { ProviderKind } from '@sakuga-review/protocol'

/**
 * « Tester » on the screen: one call that reads the list of models of the provider with its key. It
 * costs nothing and tells a valid key (200) from a refused one (401, 403).
 *
 * - `ok`: the provider answered.
 * - `refused`: it refused the key.
 * - `failed`: anything else (a timeout, a 500, a URL that the service may not call); the state of
 *   the provider does not change.
 */
export type ProbeResult = { outcome: 'ok' } | { outcome: 'refused'; status: number; message: string } | { outcome: 'failed'; message: string }

export interface ProbeTarget {
  kind: ProviderKind
  baseUrl: string | null
  apiKey: string
}

export type Probe = (target: ProbeTarget) => Promise<ProbeResult>

/** The 16 bytes of an IPv6 address, from any of its written forms, or null. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, '')
  // A dotted IPv4 at the end (`::ffff:127.0.0.1`) is the last two groups.
  let dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null
    let [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number]
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  let halves = text.split('::')
  if (halves.length > 2) return null
  let groupsOf = (value: string) => (value ? value.split(':') : [])
  let left = groupsOf(halves[0]!)
  let right = halves.length === 2 ? groupsOf(halves[1]!) : []
  let fill = 8 - left.length - right.length
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null
  let groups = [...left, ...Array<string>(fill).fill('0'), ...right]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff])
}

function privateIpv4(a: number, b: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  )
}

/**
 * Whether an address is on a private, loopback, link-local or reserved network. The service never
 * sends a key there: an admin could otherwise make it call its own network (the metadata server of
 * a cloud, the database) with the URL of a provider. An IPv6 address that carries an IPv4 one
 * (mapped `::ffff:7f00:1`, compatible `::7f00:1`, NAT64 `64:ff9b::7f00:1`), in any written form, is
 * judged by that IPv4. An address that does not parse counts as private.
 */
export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    let [a, b] = address.split('.').map(Number) as [number, number]
    return privateIpv4(a, b)
  }
  let bytes = ipv6Bytes(address)
  if (!bytes || bytes.length !== 16) return true
  let zeros = (from: number, to: number) => bytes!.slice(from, to).every((x) => x === 0)
  let v4 = bytes.slice(12) as [number, number, number, number]
  // ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return privateIpv4(v4[0], v4[1])
  if (zeros(0, 12)) return zeros(12, 15) ? true : privateIpv4(v4[0], v4[1])
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return privateIpv4(v4[0], v4[1])
  let first = bytes[0]!
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  return (first & 0xfe) === 0xfc || (first === 0xfe && (bytes[1]! & 0xc0) >= 0x80) || first === 0xff
}

/** The URL that a probe reads, by kind. */
export function probeUrl(kind: ProviderKind, baseUrl: string | null): string | null {
  let base = (baseUrl ?? defaultBaseUrl(kind))?.replace(/\/+$/, '')
  if (!base) return null
  switch (kind) {
    case 'openrouter':
      return `${base}/key`
    case 'anthropic':
      return `${base}/v1/models`
    case 'openai_compatible':
      return `${base}/models`
    case 'ollama':
      // The server is on the network of a runner: the service cannot reach it.
      return null
  }
}

export function createProbe(options: { fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]>; timeoutMs?: number } = {}): Probe {
  let doFetch = options.fetch ?? globalThis.fetch
  let resolve = options.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address))
  return async ({ kind, baseUrl, apiKey }) => {
    let target = probeUrl(kind, baseUrl)
    if (!target) return { outcome: 'failed', message: 'Ce provider se teste depuis le runner qui le tient.' }
    let url = new URL(target)
    if (url.protocol !== 'https:') return { outcome: 'failed', message: 'Le service n’appelle un provider qu’en HTTPS. Mettez une URL en https://.' }
    let host = url.hostname.replace(/^\[|\]$/g, '')
    let addresses: string[]
    try {
      addresses = isIP(host) ? [host] : await resolve(host)
    } catch {
      return { outcome: 'failed', message: `Le nom ${host} ne se résout pas. Vérifiez l’URL du provider.` }
    }
    if (addresses.length === 0 || addresses.some(privateAddress)) {
      return { outcome: 'failed', message: `${host} est sur un réseau privé, et le service ne l’appelle pas. Pour qu’un runner de ce réseau l’appelle, ajoutez-le avec « La clé reste sur le runner ».` }
    }
    let headers: Record<string, string> =
      kind === 'anthropic' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${apiKey}` }
    let response: Response
    try {
      // No redirect: a redirect could lead the key to another host.
      response = await doFetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) })
    } catch (error) {
      return { outcome: 'failed', message: error instanceof Error && error.name === 'TimeoutError' ? 'Pas de réponse en 10 s. Vérifiez l’URL, puis relancez le test.' : 'Le provider ne répond pas. Vérifiez l’URL, puis relancez le test.' }
    }
    if (response.status === 401 || response.status === 403) {
      // The whole head: a JSON error cut short would not parse. apiErrorMessage keeps 200 characters.
      let text = await readHead(response, 4096)
      return { outcome: 'refused', status: response.status, message: `${response.status} ${apiErrorMessage(text)}`.trim() }
    }
    // The status says it all: the body is never read.
    await response.body?.cancel().catch(() => {})
    if (response.ok) return { outcome: 'ok' }
    return { outcome: 'failed', message: `Le provider a répondu ${response.status}. Vérifiez l’URL, puis relancez le test.` }
  }
}

/**
 * The first `max` bytes of a body, then the body is cancelled: a server that answers with a huge
 * body cannot fill the memory of the service. The success of a probe never reads its body.
 */
export async function readHead(response: Response, max: number): Promise<string> {
  if (!response.body) return ''
  let reader = response.body.getReader()
  let chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < max) {
      let { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    // A body that breaks is an empty message.
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8')
}

/** The message of a JSON error of a provider, or nothing. Never the body itself: it could echo a header. */
function apiErrorMessage(text: string): string {
  try {
    let body = JSON.parse(text)
    let message = body?.error?.message ?? body?.message
    return typeof message === 'string' ? message.slice(0, 200) : ''
  } catch {
    return ''
  }
}
