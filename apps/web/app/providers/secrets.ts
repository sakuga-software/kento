import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * The encryption of the keys of the providers at rest: AES-256-GCM under a master key of the
 * environment (`KENTO_SECRETS_KEY`, 32 random bytes in base64). Each ciphertext names the master key
 * that made it, so a rotation adds the new key and keeps the old ones in
 * `KENTO_SECRETS_PREVIOUS_KEYS` until `app/providers/rotate-keys.ts` has encrypted every row again.
 *
 * Each ciphertext is bound to its row (the additional data is the id and the org of the provider):
 * a ciphertext copied to the row of another org does not decrypt, so a write to the database alone
 * cannot send the key of one org to the runners of another.
 *
 * No function here logs, and no error holds a key, a plaintext or a ciphertext.
 */

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

export class SecretsError extends Error {
  override name = 'SecretsError'
}

/** The id of a master key: 16 hex characters of a hash. It names the key; it does not reveal it. */
export function masterKeyId(key: Buffer): string {
  return createHash('sha256').update('kento-secrets-key-id\0').update(key).digest('hex').slice(0, 16)
}

/** What binds a ciphertext to its row. */
export function providerAad(provider: { id: string; orgId: string }): string {
  return `kento:provider:${provider.id}:${provider.orgId}`
}

export interface SecretBox {
  /** The id of the master key that encrypts. */
  readonly keyId: string
  encrypt(plaintext: string, aad: string): string
  /** Throws a SecretsError when the ciphertext is not ours, was changed, or its master key is gone. */
  decrypt(ciphertext: string, aad: string): string
  /** Whether a ciphertext was made with an earlier master key: the rotation encrypts it again. */
  isStale(ciphertext: string): boolean
}

export function createSecretBox(current: Buffer, previous: readonly Buffer[] = []): SecretBox {
  if (current.length !== 32) throw new SecretsError('the master key must be 32 bytes')
  let keys = new Map<string, Buffer>()
  for (let key of [current, ...previous]) {
    if (key.length !== 32) throw new SecretsError('every master key must be 32 bytes')
    keys.set(masterKeyId(key), key)
  }
  let keyId = masterKeyId(current)

  return {
    keyId,
    encrypt(plaintext, aad) {
      let iv = randomBytes(IV_BYTES)
      let cipher = createCipheriv('aes-256-gcm', current, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(Buffer.from(aad, 'utf8'))
      let body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
      return [VERSION, keyId, iv.toString('base64url'), body.toString('base64url')].join(':')
    },
    decrypt(ciphertext, aad) {
      let parts = ciphertext.split(':')
      if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretsError('not a ciphertext of this service')
      let key = keys.get(parts[1]!)
      if (!key) throw new SecretsError(`the master key ${parts[1]} is not configured`)
      let iv = Buffer.from(parts[2]!, 'base64url')
      let body = Buffer.from(parts[3]!, 'base64url')
      if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new SecretsError('not a ciphertext of this service')
      try {
        let decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
        decipher.setAAD(Buffer.from(aad, 'utf8'))
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
        return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8')
      } catch {
        throw new SecretsError('the ciphertext does not match its row or its master key')
      }
    },
    isStale(ciphertext) {
      return ciphertext.split(':')[1] !== keyId
    },
  }
}

/**
 * The master keys of the environment, or null when `KENTO_SECRETS_KEY` is not set: the screen then
 * refuses to store a key. Throws a SecretsError that names the variable, never its value.
 */
export function readMasterKeys(env: Record<string, string | undefined>): { current: Buffer; previous: Buffer[] } | null {
  let current = env.KENTO_SECRETS_KEY?.trim()
  if (!current) return null
  let decode = (value: string, name: string) => {
    let bytes = Buffer.from(value, 'base64')
    if (bytes.length !== 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new SecretsError(`${name} must be 32 random bytes in base64 (openssl rand -base64 32)`)
    }
    return bytes
  }
  let previous = (env.KENTO_SECRETS_PREVIOUS_KEYS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => decode(value, 'KENTO_SECRETS_PREVIOUS_KEYS'))
  return { current: decode(current, 'KENTO_SECRETS_KEY'), previous }
}

/** The last 4 characters of a key, the only part that the screen shows. */
export function last4(key: string): string {
  return key.slice(-4)
}
