import * as assert from 'remix/assert'
import { afterEach, beforeEach, describe, it } from 'remix/test'

import { CANCEL_REASON } from '../db/webhook-store.ts'
import type { DeliveryRecord } from '../github/webhook.ts'
import { issueCommentPayload, pullRequestPayload, signedRequest, spyStore, webhookDeps } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { appStatusReason, deliveryReason, jobReason, reasonSentence } from './reasons.tsx'

describe('the reason of a failed job (REV-44)', () => {
  it('says what happened and what to do, in French, for each reason that Kentō writes', () => {
    let cases: [string, RegExp, RegExp][] = [
      ['the provider « Anthropic » refused its key (401): unauthorized', /^le provider « Anthropic » a refusé sa clé, code 401$/, /Remplacez sa clé dans Réglages/],
      ['installation token: GitHub answered 404: Not Found', /pas donné de token pour ce repo/, /App GitHub est toujours installée/],
      ['review threads: POST /graphql answered 502: bad gateway', /fils de la PR/, /Relancez dans quelques minutes/],
      ['rules: connection reset', /règles du repo/, /Relancez/],
      ['the provider « vLLM » needs a trusted runner', /runner de confiance/, /écran Runners/],
      ['the provider « vLLM » is not of the org of the runner', /autre organisation/, /config du repo/],
      ['the key of the provider « vLLM » cannot be decrypted: bad tag', /clé maître du service/, /KENTO_SECRETS_KEY/],
      ['no model key: set PROVIDER_API_KEY on the runner, or mark the runner as trusted', /pas de clé pour ce provider/, /PROVIDER_API_KEY/],
      ['clone failed: git fetch failed (128): fatal: could not read', /cloner le repo/, /App GitHub a toujours accès/],
      ['the service refused the review: result: the service answered 400 bad finding', /refusé le résultat du runner/, /version que montre l’écran Runners/],
      ['the provider openai_compatible needs a base URL', /pas d’URL/, /Ajoutez son URL dans Réglages/],
      ['no model is set for the provider ollama at this level', /provider ou un modèle que le job n’a pas/, /config du repo/],
      ['the provider p-2 that the config chose is not in the job', /provider ou un modèle que le job n’a pas/, /config du repo/],
      ['no model gave a usable answer: TimeoutError: The operation was aborted due to timeout', /pas répondu à temps/, /Relancez/],
      ['no model gave a usable answer: ProviderError: Anthropic answered 529: overloaded', /indisponible ou surchargé, code 529/, /Relancez dans quelques minutes/],
      ['provider: 529 overloaded after 3 attempts', /indisponible ou surchargé, code 529/, /Relancez dans quelques minutes/],
      ['no model gave a usable answer: ProviderError: OpenRouter answered 429: rate limited', /limite le nombre d’appels, code 429/, /relevez la limite/],
      ['no model gave a usable answer: ProviderError: OpenRouter answered 404: no such model', /ne connaît pas le modèle/, /id du modèle/],
      ['no model gave a usable answer: ProviderError: OpenRouter answered 401: bad key', /refusé la clé, code 401/, /PROVIDER_API_KEY/],
      ['no model gave a usable answer: ProviderError: OpenRouter answered 400: context too long', /refusé la demande, code 400/, /détails techniques/],
      ['no model gave a usable answer: ProviderError: The OpenAI-compatible server answered 503: down', /indisponible ou surchargé, code 503/, /Relancez dans quelques minutes/],
      ['no model gave a usable answer: ProviderError: Ollama gave no JSON object', /réponse illisible/, /autre modèle/],
      ['no model gave a usable answer: ProviderError: Anthropic declined the request (cyber)', /refusé de traiter cette PR/, /autre modèle/],
    ]
    for (let [raw, text, action] of cases) {
      let reason = jobReason(raw, null)
      assert.match(reason.text, text, raw)
      assert.match(reason.action, action, raw)
      assert.equal(reason.raw, raw, 'the text of the service stays under « Détails techniques »')
      assert.doesNotMatch(reason.text, /\b(?:the|failed|answered|refused|provider:)\b/, `no English in « ${reason.text} »`)
    }
  })

  it('says how many times the runner went silent, with no technical details', () => {
    assert.deepEqual(jobReason('lease expired 2 times', 'runners-host'), {
      text: 'le runner a cessé de répondre pendant le job deux fois, en dernier runners-host',
      action: 'Vérifiez sur l’écran Runners qu’un runner est en ligne, puis relancez.',
      raw: null,
    })
    assert.equal(jobReason('lease expired 1 times', null).text, 'le runner a cessé de répondre pendant le job une fois')
    assert.equal(jobReason('lease expired 7 times', null).text, 'le runner a cessé de répondre pendant le job 7 fois')
    assert.deepEqual(jobReason(null, null), { text: 'aucune raison enregistrée', action: 'Relancez la review. Si elle échoue encore, lisez les logs du runner.', raw: null })
  })

  it('an unknown reason is named as such, and its text, without secrets, goes under the details', () => {
    let reason = jobReason('boom: Bearer abcdefghijklmnop and sk-or-v1-0123456789abcdef', 'x')
    assert.equal(reason.text, 'le runner a renvoyé une erreur que Kentō ne connaît pas')
    assert.equal(reason.action, 'Lisez les détails techniques, puis relancez.')
    assert.equal(reason.raw, 'boom: *** and ***')
    assert.ok(jobReason('x'.repeat(400), null).raw!.length <= 300)
  })

  it('a status that does not come from a provider is not read as one', () => {
    for (let raw of ['result: GET /repos/x answered 404: Not Found', 'something answered 529 overloaded']) {
      assert.equal(jobReason(raw, null).text, 'le runner a renvoyé une erreur que Kentō ne connaît pas', raw)
    }
  })

  it('a status inside the text of a provider error is not the status of the provider', () => {
    let reason = jobReason('no model gave a usable answer: ProviderError: Ollama gave JSON that does not parse: upstream answered 502', null)
    assert.equal(reason.text, 'le modèle a donné une réponse illisible')
  })

  it('a known phrase in the middle of another error does not classify it', () => {
    for (let raw of [
      'git push: the remote declined the request',
      'config: the provider x needs a base URL, see the docs',
      'TypeError: TimeoutError is not defined',
      'the parser gave no JSON object',
      'no model gave a usable answer: Error: socket closed, the server declined the request',
    ]) {
      assert.equal(jobReason(raw, null).text, 'le runner a renvoyé une erreur que Kentō ne connaît pas', raw)
    }
  })

  it('the status of a provider wins over a timeout named in its answer', () => {
    let reason = jobReason('no model gave a usable answer: ProviderError: OpenRouter answered 429: upstream TimeoutError', null)
    assert.equal(reason.text, 'le provider limite le nombre d’appels, code 429')
  })

  it('reads as one sentence', () => {
    assert.equal(reasonSentence(jobReason('rules: down', null)), 'Kentō n’a pas pu lire les règles du repo. Relancez dans quelques minutes.')
    assert.equal(reasonSentence({ text: 'PR fermée', action: '', raw: null }), 'PR fermée.')
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
      assert.equal(reason.raw, null, `« ${raw} » has a translation`)
      assert.notEqual(reason.text, raw)
    }
    assert.equal(deliveryReason(delivery('pushed by an untrusted bot'))!.action, 'Ajoutez-le aux bots de confiance pour qu’il déclenche une review.')
    assert.equal(deliveryReason(delivery('trigger of the config is ready'))!.text, 'la config du repo lance ses reviews au passage en « Ready for review »')
    assert.equal(deliveryReason(delivery('daily cost limit of the org is reached'))!.text, 'plafond quotidien de l’organisation atteint')
    assert.equal(deliveryReason(delivery(null)), null)
  })

  it('a failure of the service tells to replay the delivery, and keeps its error under the details', () => {
    assert.deepEqual(deliveryReason(delivery('database is down', 500, 'failed')), {
      text: 'Kentō n’a pas traité la livraison',
      action: 'Rejouez-la depuis la page de l’App.',
      raw: 'database is down',
    })
    assert.equal(deliveryReason(delivery('body is not JSON', 400, 'invalid'))!.text, 'GitHub a envoyé un contenu que Kentō ne lit pas')
    assert.deepEqual(deliveryReason(delivery(null, 400, 'invalid')), {
      text: 'GitHub a envoyé un contenu que Kentō ne lit pas',
      action: 'Ouvrez-la dans « Recent Deliveries », sur la page de l’App, pour lire ce que GitHub a envoyé.',
      raw: null,
    })
    assert.deepEqual(deliveryReason(delivery('something new', 202, 'skipped')), { text: 'raison que Kentō ne traduit pas', action: '', raw: 'something new' })
  })
})

describe('the error of the read of the App (REV-44)', () => {
  it('names the cause by the status of GitHub, and what to do', () => {
    assert.equal(reasonSentence(appStatusReason('GET /app answered 401: Bad credentials')), 'GitHub a refusé la clé de l’App, code 401. Vérifiez GITHUB_APP_ID et GITHUB_APP_PRIVATE_KEY sur le service.')
    assert.match(appStatusReason('GET /app/installations/1001 answered 404: Not Found').action, /Réinstallez l’App/)
    assert.match(appStatusReason('GET /app answered 403: rate limit').text, /code 403/)
    assert.match(appStatusReason('GET /app answered 502: bad gateway').text, /indisponible, code 502/)
    let down = appStatusReason('fetch failed')
    assert.equal(reasonSentence(down), 'GitHub ne répond pas sur l’App. Rechargez la page dans quelques minutes.')
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

  it('answers and keeps the same English reason, and the screen shows it in French', async () => {
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
    for (let record of records) assert.equal(deliveryReason(record)!.raw, null, `« ${record.reason} » has a translation`)
  })
})
