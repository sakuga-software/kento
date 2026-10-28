import * as assert from 'remix/assert'
import { afterEach, beforeEach, describe, it } from 'remix/test'

import { createAppRouter } from '../router.ts'
import { routes } from '../routes.ts'
import { sign } from './signature.ts'
import {
  pullRequestPayload,
  signedRequest,
  spyStore,
  TEST_SECRET,
  webhookDeps,
  type SignedRequestOptions,
} from './test-helpers.ts'
import { MAX_WEBHOOK_BODY_BYTES, type WebhookDependencies } from './webhook.ts'

function routerWith(webhook: WebhookDependencies) {
  return createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook,
  })
}

// Captures the log lines, to prove that no secret and no signature reaches them.
let output = ''
let restore: (() => void) | undefined

beforeEach(() => {
  output = ''
  let stdout = process.stdout.write.bind(process.stdout)
  let stderr = process.stderr.write.bind(process.stderr)
  let capture = (chunk: unknown) => {
    output += String(chunk)
    return true
  }
  process.stdout.write = capture as typeof process.stdout.write
  process.stderr.write = capture as typeof process.stderr.write
  restore = () => {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
})

afterEach(() => restore?.())

async function send(payload: unknown, options: SignedRequestOptions = {}, overrides: Partial<WebhookDependencies> = {}) {
  let store = spyStore()
  let router = routerWith(webhookDeps(store.apply, overrides))
  let response = await router.fetch(signedRequest(payload, options))
  return { response, calls: store.calls }
}

describe('POST /webhooks/github', () => {
  it('has the path of the App settings', () => {
    assert.equal(routes.githubWebhook.href(), '/webhooks/github')
  })

  it('queues a job for a signed push, with the delivery id', async () => {
    let { response, calls } = await send(pullRequestPayload())
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { outcome: 'queued', jobId: 'job-1', cancelled: 0 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command.type, 'enqueue_review')
    assert.equal(calls[0]!.deliveryId, 'd0000000-0000-0000-0000-000000000001')
    assert.match(output, /"event":"webhook.applied","githubEvent":"pull_request","action":"synchronize".*"outcome":"queued"/)
  })

  it('rejects a wrong signature with 401, and the store is never called', async () => {
    let { response, calls } = await send(pullRequestPayload(), { secret: `${TEST_SECRET}-other` })
    assert.equal(response.status, 401)
    assert.equal(await response.text(), 'invalid signature')
    assert.equal(calls.length, 0)
  })

  it('rejects a missing signature with 401', async () => {
    let { response, calls } = await send(pullRequestPayload(), { signature: null })
    assert.equal(response.status, 401)
    assert.equal(calls.length, 0)
  })

  it('rejects a malformed signature with 401', async () => {
    for (let signature of ['', 'sha256=', 'sha1=abc', `sha256=${'0'.repeat(64)}`]) {
      let { response, calls } = await send(pullRequestPayload(), { signature })
      assert.equal(response.status, 401, signature)
      assert.equal(calls.length, 0)
    }
  })

  it('rejects a body changed after signing with 401', async () => {
    let original = JSON.stringify(pullRequestPayload())
    let changed = original.replace('"synchronize"', '"opened"')
    let { response, calls } = await send(null, { body: changed, signature: sign(TEST_SECRET, original) })
    assert.equal(response.status, 401)
    assert.equal(calls.length, 0)
  })

  it('answers 503 without a secret, and the store is never called', async () => {
    let { response, calls } = await send(pullRequestPayload(), {}, { secret: null })
    assert.equal(response.status, 503)
    assert.equal(calls.length, 0)
  })

  it('answers 400 without a delivery id or event, before it reads the body', async () => {
    for (let options of [{ deliveryId: null }, { deliveryId: '<script>' }, { event: 'Pull Request' }] as SignedRequestOptions[]) {
      let { response, calls } = await send(pullRequestPayload(), options)
      assert.equal(response.status, 400)
      assert.equal(calls.length, 0)
    }
  })

  it('answers 413 to a body over the limit, signed or not', async () => {
    let body = JSON.stringify({ padding: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES) })
    let { response, calls } = await send(null, { body })
    assert.equal(response.status, 413)
    assert.equal(calls.length, 0)
  })

  it('answers 400 to a signed body that is not JSON', async () => {
    let { response, calls } = await send(null, { body: 'not json' })
    assert.equal(response.status, 400)
    assert.equal(calls.length, 0)
  })

  it('answers 400 to a signed body that is JSON but not an object', async () => {
    for (let body of ['null', '[]', '42', '"text"']) {
      let { response, calls } = await send(null, { body })
      assert.equal(response.status, 400, body)
      assert.equal((await response.json()).outcome, 'invalid')
      assert.equal(calls.length, 0)
    }
  })

  it('answers the ping of a new webhook', async () => {
    let { response, calls } = await send({ zen: 'Design for failure.', hook_id: 1 }, { event: 'ping' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { outcome: 'pong' })
    assert.equal(calls.length, 0)
  })

  it('ignores a draft with 202 and no call to the store', async () => {
    let { response, calls } = await send(pullRequestPayload({ draft: true }))
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { outcome: 'ignored', reason: 'draft pull request' })
    assert.equal(calls.length, 0)
  })

  it('answers 500 when the store fails, so that GitHub can redeliver', async () => {
    let router = routerWith(webhookDeps(() => Promise.reject(new Error('connection refused'))))
    let response = await router.fetch(signedRequest(pullRequestPayload()))
    assert.equal(response.status, 500)
    assert.match(output, /"event":"webhook.failed"/)
  })

  it('accepts only POST', async () => {
    let router = routerWith(webhookDeps(spyStore().apply))
    let response = await router.fetch(new URL('/webhooks/github', 'http://localhost'))
    assert.equal(response.status, 405)
  })

  it('never writes the secret or a signature in the logs', async () => {
    let payload = pullRequestPayload()
    await send(payload)
    await send(payload, { secret: `${TEST_SECRET}-other` })
    assert.match(output, /webhook.bad_signature/)
    assert.doesNotMatch(output, new RegExp(TEST_SECRET))
    assert.doesNotMatch(output, /sha256=/)
  })
})
