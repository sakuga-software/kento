import { generateKeyPairSync, verify } from 'node:crypto'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createInstallationTokenMinter, readPrivateKey } from './installation-token.ts'

let { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
let pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

describe('installation tokens', () => {
  it('asks GitHub for a token limited to the repository, contents: read, signed by the App', async () => {
    let calls: { url: string; init: RequestInit }[] = []
    let mint = createInstallationTokenMinter({
      appId: '12345',
      privateKey: readPrivateKey(pem),
      now: () => 1_800_000_000_000,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return Response.json({ token: 'ghs_test', expires_at: '2027-01-15T09:00:00Z' }, { status: 201 })
      }) as typeof fetch,
    })

    let token = await mint({ installationId: 77, githubRepoId: 3001 })

    assert.deepEqual(token, { token: 'ghs_test', expiresAt: '2027-01-15T09:00:00Z' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.github.com/app/installations/77/access_tokens')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      repository_ids: [3001],
      permissions: { contents: 'read' },
    })

    let jwt = (calls[0]!.init.headers as Record<string, string>).Authorization!.replace('Bearer ', '')
    let [header, payload, signature] = jwt.split('.')
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url')))
    assert.deepEqual(JSON.parse(Buffer.from(payload!, 'base64url').toString()), {
      iat: 1_800_000_000 - 60,
      exp: 1_800_000_000 + 540,
      iss: '12345',
    })
  })

  it('reads a PEM written on one line with \\n', () => {
    assert.equal(readPrivateKey(pem.replaceAll('\n', '\\n')).asymmetricKeyType, 'rsa')
    assert.throws(() => readPrivateKey('not a key'))
  })

  it('throws when GitHub refuses, without the JWT in the message', async () => {
    let mint = createInstallationTokenMinter({
      appId: '1',
      privateKey: readPrivateKey(pem),
      fetch: (async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch,
    })
    await assert.rejects(mint({ installationId: 1, githubRepoId: 2 }), /GitHub answered 404: \{"message":"Not Found"\}/)
  })
})
