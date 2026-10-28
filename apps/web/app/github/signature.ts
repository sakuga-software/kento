import { createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/

/**
 * Checks `X-Hub-Signature-256` against the HMAC-SHA256 of the raw body. The comparison takes the same
 * time for every wrong signature of the right format, so a caller cannot find the signature byte by
 * byte. A missing or malformed header fails.
 */
export function verifySignature(secret: string, body: Uint8Array, header: string | null): boolean {
  let match = header === null ? null : SIGNATURE_HEADER.exec(header.trim().toLowerCase())
  if (!match) return false
  let expected = createHmac('sha256', secret).update(body).digest()
  let received = Buffer.from(match[1]!, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

/** The value of `X-Hub-Signature-256` for a body. The tests sign their requests with it. */
export function sign(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}
