import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { RUNNER_TOKEN_PREFIX } from '@kento/protocol'

/**
 * A registration token of the Runners screen starts with this prefix: the service tells it from the
 * registration token of the environment, and a secret scanner can find a leaked one.
 */
export const REGISTRATION_TOKEN_PREFIX = 'kento_reg_'

/** A new registration token: the prefix and 32 random bytes. */
export function newRegistrationToken(): string {
  return `${REGISTRATION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** A new runner token: the prefix and 32 random bytes. */
export function newRunnerToken(): string {
  return `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/**
 * The hash that the database keeps. A runner token has 256 random bits, so a plain SHA-256 is
 * enough: no one can guess a token from its hash, and the lookup by hash needs no salt.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(request: Request): string | null {
  let match = /^Bearer ([\x21-\x7e]{1,500})$/.exec(request.headers.get('Authorization') ?? '')
  return match ? match[1]! : null
}

/** Compares two secrets in a time that does not depend on where they differ. */
export function sameSecret(given: string, expected: string): boolean {
  let a = createHash('sha256').update(given).digest()
  let b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
