import * as assert from 'remix/assert'
import { afterEach, beforeEach, describe, it } from 'remix/test'

import { CANCEL_REASON } from '../db/webhook-store.ts'
import type { DeliveryRecord } from '../github/webhook.ts'
import { issueCommentPayload, pullRequestPayload, signedRequest, spyStore, webhookDeps } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { appStatusReason, deliveryReason, jobReason, reasonSentence } from './reasons.tsx'

describe('the reason of a failed job (REV-44)', () => {
  it('says what happened and what to do, in plain words, for each reason that Kentō writes', () => {
    let cases: [string, RegExp, RegExp][] = [
      ['the provider "Anthropic" refused its key (401): unauthorized', /^the provider "Anthropic" refused its key, code 401$/, /Replace its key in Settings/],
      ['installation token: GitHub answered 404: Not Found', /gave no token for this repo/, /GitHub App is still installed/],
      ['review threads: POST /graphql answered 502: bad gateway', /threads of the pull request/, /Retry in a few minutes/],
      ['rules: connection reset', /rules of the repo/, /Retry/],
      ['the provider "vLLM" needs a trusted runner', /only to a trusted runner/, /Runners screen/],
      ['the provider "vLLM" is not of the org of the runner', /another organization/, /config of the repo/],
      ['the key of the provider "vLLM" cannot be decrypted: bad tag', /master key of the service/, /KENTO_SECRETS_KEY/],
      ['no model key: set PROVIDER_API_KEY on the runner, or mark the runner as trusted', /no key for this provider/, /PROVIDER_API_KEY/],
      ['clone failed: git fetch failed (128): fatal: could not read', /could not clone the repo/, /GitHub App still has access/],
      ['the service refused the review: result: the service answered 400 bad finding', /refused the result of the runner/, /version that the Runners screen shows/],
      ['the provider openai_compatible needs a base URL', /has no URL/, /Add its URL in Settings/],
      ['no model is set for the provider ollama at this level', /a provider or a model that the job does not have/, /config of the repo/],
      ['the provider p-2 that the config chose is not in the job', /a provider or a model that the job does not have/, /config of the repo/],
      ['no model gave a usable answer: TimeoutError: The operation was aborted due to timeout', /did not answer in time/, /Retry/],
      ['no model gave a usable answer: ProviderError: Anthropic answered 529: overloaded', /unavailable or overloaded, code 529/, /Retry in a few minutes/],
      ['provider: 529 overloaded after 3 attempts', /unavailable or overloaded, code 529/, /Retry in a few minutes/],
      ['no model gave a usable answer: ProviderError: OpenRouter answered 429: rate limited', /limits the number of calls, code 429/, /raise the limit/],
      ['no model gave a usable answer: ProviderError: OpenRouter answered 404: no such model', /does not know the model/, /id of the model/],
      ['no model gave a usable answer: ProviderError: OpenRouter answered 401: bad key', /refused the key, code 401/, /PROVIDER_API_KEY/],
      ['no model gave a usable answer: ProviderError: OpenRouter answered 400: context too long', /refused the request, code 400/, /technical details/],
      ['no model gave a usable answer: ProviderError: The OpenAI-compatible server answered 503: down', /unavailable or overloaded, code 503/, /Retry in a few minutes/],
      ['no model gave a usable answer: ProviderError: Ollama gave no JSON object', /an answer that Kentō cannot read/, /another model/],
      ['no model gave a usable answer: ProviderError: Anthropic declined the request (cyber)', /declined to process this pull request/, /another model/],
    ]
    for (let [raw, text, action] of cases) {
      let reason = jobReason(raw, null)
      assert.match(reason.text, text, raw)
      assert.match(reason.action, action, raw)
      assert.equal(reason.raw, raw, 'the text of the service stays under "Technical details"')
      assert.notEqual(reason.text, raw)
      assert.doesNotMatch(reason.text, /\b(?:answered|provider:)/, `no text of the service in "${reason.text}"`)
    }
  })

  it('says how many times the runner went silent, with no technical details', () => {
    assert.deepEqual(jobReason('lease expired 2 times', 'runners-host'), {
      text: 'the runner stopped answering during the job twice, last runners-host',
      action: 'Check on the Runners screen that a runner is online, then retry.',
      raw: null,
    })
    assert.equal(jobReason('lease expired 1 times', null).text, 'the runner stopped answering during the job once')
    assert.equal(jobReason('lease expired 7 times', null).text, 'the runner stopped answering during the job 7 times')
    assert.deepEqual(jobReason(null, null), { text: 'no reason recorded', action: 'Retry the review. If it fails again, read the logs of the runner.', raw: null })
  })

  it('an unknown reason is named as such, and its text, without secrets, goes under the details', () => {
    let reason = jobReason('boom: Bearer abcdefghijklmnop and sk-or-v1-0123456789abcdef', 'x')
    assert.equal(reason.text, 'the runner sent an error that Kentō does not know')
    assert.equal(reason.action, 'Read the technical details, then retry.')
    assert.equal(reason.raw, 'boom: *** and ***')
    assert.ok(jobReason('x'.repeat(400), null).raw!.length <= 300)
  })

  it('a status that does not come from a provider is not read as one', () => {
    for (let raw of ['result: GET /repos/x answered 404: Not Found', 'something answered 529 overloaded']) {
      assert.equal(jobReason(raw, null).text, 'the runner sent an error that Kentō does not know', raw)
    }
  })

  it('a status inside the text of a provider error is not the status of the provider', () => {
    let reason = jobReason('no model gave a usable answer: ProviderError: Ollama gave JSON that does not parse: upstream answered 502', null)
    assert.equal(reason.text, 'the model gave an answer that Kentō cannot read')
  })

  it('a known phrase in the middle of another error does not classify it', () => {
    for (let raw of [
      'git push: the remote declined the request',
      'config: the provider x needs a base URL, see the docs',
      'TypeError: TimeoutError is not defined',
      'the parser gave no JSON object',
      'no model gave a usable answer: Error: socket closed, the server declined the request',
    ]) {
      assert.equal(jobReason(raw, null).text, 'the runner sent an error that Kentō does not know', raw)
    }
  })

  it('the status of a provider wins over a timeout named in its answer', () => {
    let reason = jobReason('no model gave a usable answer: ProviderError: OpenRouter answered 429: upstream TimeoutError', null)
    assert.equal(reason.text, 'the provider limits the number of calls, code 429')
  })

  it('reads as one sentence', () => {
    assert.equal(reasonSentence(jobReason('rules: down', null)), 'Kentō could not read the rules of the repo. Retry in a few minutes.')
    assert.equal(reasonSentence({ text: 'pull request closed', action: '', raw: null }), 'Pull request closed.')
  })
})

describe('the reason of a webhook delivery (REV-44)', () => {
  const delivery = (reason: string | null, status = 202, outcome = 'ignored') => ({ status, outcome, reason })

  it('translates each reason that the webhook writes, with no technical details', () => {
    let reasons = [
      'draft pull request',
      'pushed by an untrusted bot',
      'opened by an untrusted bot',
      'command of an untrusted bot',
      'pull request from a fork',
      'pull request is closed',
      'event check_run is not handled',
      'pull_request action labeled creates no job',
      'issue_comment action edited gives no command',
      'installation action new_permissions_accepted is not handled',
      'installation_repositories action foo is not handled',
      'comment is not on a pull request',
      'comment is not a command',
      'comment of the App itself',
      'comment already created a job',
      'delivery already created a job',
      'head already had a review job',
      'repository is not enabled: the workflow keeps the command',
      'repository is not enabled',
      'unknown repository',
      'installation is suspended',
      'GitHub App is not configured',
      'commands are not configured',
      'commenter cannot write to the repository',
      'no changed file under the paths of the config',
      'trigger of the config is command',
      'daily cost limit of the org is reached',
      'monthly cost limit of the org is reached',
      'monthly cost limit of the repository is reached',
      CANCEL_REASON.closed,
    ]
    for (let raw of reasons) {
      let reason = deliveryReason(delivery(raw))
      assert.ok(reason, raw)
      assert.equal(reason.raw, null, `"${raw}" has a translation`)
      assert.ok(reason.text, raw)
    }
    assert.equal(deliveryReason(delivery('pushed by an untrusted bot'))!.action, 'Add it to the trusted bots so that it starts a review.')
    assert.equal(deliveryReason(delivery('trigger of the config is ready'))!.text, 'the config of the repo starts its reviews when the pull request becomes "Ready for review"')
    assert.equal(deliveryReason(delivery('daily cost limit of the org is reached'))!.text, 'daily cost cap of the organization reached')
    assert.equal(deliveryReason(delivery(null)), null)
  })

  it('a failure of the service tells to replay the delivery, and keeps its error under the details', () => {
    assert.deepEqual(deliveryReason(delivery('database is down', 500, 'failed')), {
      text: 'Kentō did not process the delivery',
      action: 'Redeliver it from the page of the App.',
      raw: 'database is down',
    })
    assert.equal(deliveryReason(delivery('body is not JSON', 400, 'invalid'))!.text, 'GitHub sent a content that Kentō cannot read')
    assert.deepEqual(deliveryReason(delivery(null, 400, 'invalid')), {
      text: 'GitHub sent a content that Kentō cannot read',
      action: 'Open it in "Recent Deliveries", on the page of the App, to read what GitHub sent.',
      raw: null,
    })
    assert.deepEqual(deliveryReason(delivery('something new', 202, 'skipped')), { text: 'a reason that Kentō does not translate', action: '', raw: 'something new' })
  })
})

describe('the error of the read of the App (REV-44)', () => {
  it('names the cause by the status of GitHub, and what to do', () => {
    assert.equal(reasonSentence(appStatusReason('GET /app answered 401: Bad credentials')), 'GitHub refused the key of the App, code 401. Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the service.')
    assert.match(appStatusReason('GET /app/installations/1001 answered 404: Not Found').action, /Install the App on the organization again/)
    assert.match(appStatusReason('GET /app answered 403: rate limit').text, /code 403/)
    assert.match(appStatusReason('GET /app answered 502: bad gateway').text, /unavailable, code 502/)
    let down = appStatusReason('fetch failed')
    assert.equal(reasonSentence(down), 'GitHub does not answer about the App. Reload the page in a few minutes.')
    assert.equal(down.raw, 'fetch failed')
  })
})

describe('the answers of the webhook stay in English (REV-44)', () => {
  // The screens translate the reasons; the webhook answers GitHub and keeps them as they were.
  // The webhook logs each delivery: kept out of the output of the tests.
  let restore: (() => void) | undefined
  beforeEach(() => {
    let write = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    restore = () => (process.stdout.write = write)
  })
  afterEach(() => restore?.())

  it('answers and keeps the same English reason, and the screen shows it in plain words', async () => {
    let records: DeliveryRecord[] = []
    let router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '1.2.3',
      commit: null,
      webhook: webhookDeps(spyStore().apply, { recordDelivery: async (record) => void records.push(record) }),
    })
    let renovate = { login: 'renovate[bot]', type: 'Bot' }
    let sent: [unknown, string, string][] = [
      [pullRequestPayload({ draft: true }), 'pull_request', 'draft pull request'],
      [pullRequestPayload({ sender: renovate }), 'pull_request', 'pushed by an untrusted bot'],
      [pullRequestPayload({ headRepoId: 999 }), 'pull_request', 'pull request from a fork'],
      [issueCommentPayload({ body: 'thanks' }), 'issue_comment', 'comment is not a command'],
    ]
    for (let [i, [payload, event, reason]] of sent.entries()) {
      let response = await router.fetch(signedRequest(payload, { event, deliveryId: `d-${i}` }))
      assert.equal(response.status, 202)
      assert.deepEqual(await response.json(), { outcome: 'ignored', reason })
    }
    assert.deepEqual(records.map((r) => r.reason), sent.map(([, , reason]) => reason))
    for (let record of records) assert.equal(deliveryReason(record)!.raw, null, `"${record.reason}" has a translation`)
  })
})
