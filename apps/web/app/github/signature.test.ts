import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { sign, verifySignature } from './signature.ts'

const secret = 'test-webhook-secret-0123456789abcdef0123456789'
const body = new TextEncoder().encode('{"action":"synchronize"}')

describe('verifySignature', () => {
  it('accepts the HMAC-SHA256 of the raw body', () => {
    assert.equal(verifySignature(secret, body, sign(secret, body)), true)
  })

  // The example of the GitHub documentation: secret « It's a Secret to Everybody », body « Hello, World! ».
  it('matches the example of the GitHub documentation', () => {
    let header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
    assert.equal(verifySignature("It's a Secret to Everybody", new TextEncoder().encode('Hello, World!'), header), true)
  })

  it('accepts the hex digest in upper case', () => {
    assert.equal(verifySignature(secret, body, sign(secret, body).toUpperCase().replace('SHA256=', 'sha256=')), true)
  })

  it('refuses a missing, empty or malformed header', () => {
    let digest = sign(secret, body).slice('sha256='.length)
    for (let header of [null, '', 'sha256=', digest, `sha1=${digest}`, `sha256=${digest}00`, `sha256=${digest.slice(2)}`, `sha256=${'z'.repeat(64)}`]) {
      assert.equal(verifySignature(secret, body, header), false, String(header))
    }
  })

  it('refuses a body changed by one byte', () => {
    let changed = new TextEncoder().encode('{"action":"synchronizE"}')
    assert.equal(verifySignature(secret, changed, sign(secret, body)), false)
  })

  it('refuses a signature made with another secret', () => {
    assert.equal(verifySignature(secret, body, sign(`${secret}x`, body)), false)
  })

  it('refuses the signature of the parsed then serialized JSON when the raw bytes differ', () => {
    let raw = new TextEncoder().encode('{ "action": "synchronize" }')
    assert.equal(verifySignature(secret, raw, sign(secret, JSON.stringify(JSON.parse('{ "action": "synchronize" }')))), false)
  })
})
