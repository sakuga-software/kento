import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { failureComment, failureMarker, sanitizeReason, type FailedJob } from './failure.ts'

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
const NOT_FOUND =
  'no model gave a usable answer: ProviderError: Anthropic answered 404: ' +
  '{"type":"error","error":{"type":"not_found_error","message":"model: anthropic/claude-sonnet-5.5"},"request_id":"req_011CXk7rT2mVb9QpLzN4wYhD8eFs"}'

function job(overrides: Partial<FailedJob> = {}): FailedJob {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'review',
    level: 'lite',
    headSha: HEAD,
    failureReason: NOT_FOUND,
    commenter: null,
    configUrl: 'https://review.sakuga.dev/repos/11111111-1111-4111-8111-111111111111/config',
    ...overrides,
  }
}

describe('sanitizeReason', () => {
  it('keeps the error of the provider and the model id, and masks the long request id', () => {
    let reason = sanitizeReason(NOT_FOUND)
    assert.ok(reason.includes('Anthropic answered 404'))
    assert.ok(reason.includes('model: anthropic/claude-sonnet-5.5'))
    assert.ok(!reason.includes('req_011CXk7rT2mVb9QpLzN4wYhD8eFs'))
  })

  it('masks the keys and the tokens', () => {
    for (let secret of [
      'sk-or-v1-0123456789abcdef',
      'sk-ant-api03-AbCdEfGhIjKl',
      'ghs_16C7e42F292c6912E7710c838347Ae178B4a',
      'github_pat_11ABCDEFG0123456789',
      'Bearer eyJhbGciOiJIUzI1NiJ9',
      'dGhpcyBpcyBhIHNlY3JldCBrZXkgMTIzNDU2Nzg5MA==',
      'deadbeef0123456789deadbeef0123456789abcd',
      // A JWT has dots, and its payload can hold no digit.
      'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhcHAifQ.c2lnbmF0dXJl',
    ]) {
      let reason = sanitizeReason(`the provider refused the key ${secret} (401)`)
      assert.ok(!reason.includes(secret), reason)
      assert.ok(reason.includes('***'), reason)
      assert.ok(reason.endsWith('(401)'), reason)
    }
  })

  it('keeps a long path or a long model id that holds no secret', () => {
    let reason = sanitizeReason('clone failed: packages/engine/src/providers/openai-compatible.ts (meta-llama/Llama-4-Maverick-17B)')
    assert.ok(reason.includes('packages/engine/src/providers/openai-compatible.ts'), reason)
    assert.ok(reason.includes('meta-llama/Llama-4-Maverick-17B'), reason)
  })

  it('keeps the first line, at most 300 characters, with no backquote', () => {
    assert.equal(sanitizeReason('\n  clone failed: `git` exited 128\nfatal: secret detail'), "clone failed: 'git' exited 128")
    let long = sanitizeReason('x '.repeat(400))
    assert.equal(long.length, 300)
    assert.ok(long.endsWith('…'))
  })

  it('says that the reason is unknown when there is none', () => {
    assert.equal(sanitizeReason(null), 'raison inconnue')
    assert.equal(sanitizeReason('  \n '), 'raison inconnue')
  })
})

describe('failureComment', () => {
  it('tells an automatic review how to run it again, with the link to the config', () => {
    assert.equal(
      failureComment(job()),
      [
        '**Kentō · review en échec** au commit `abcdef012`',
        'La review `lite` de ce commit a échoué : Kentō ne la relancera pas seul.',
        `Raison : \`${sanitizeReason(NOT_FOUND)}\``,
        'Pour relancer : `@kento-review lite`. Si l’erreur vient d’un modèle ou d’un provider, vérifiez la ' +
          '[config du repo](https://review.sakuga.dev/repos/11111111-1111-4111-8111-111111111111/config).',
        failureMarker('00000000-0000-4000-8000-000000000001'),
      ].join('\n\n'),
    )
  })

  it('names the author of the command, and has no link without the public URL', () => {
    let body = failureComment(job({ level: 'heavy', commenter: 'alex', configUrl: null }))
    assert.ok(body.includes('@alex La review `heavy` de ce commit a échoué'))
    assert.ok(body.includes('Pour relancer : `@kento-review heavy`.\n\n'))
    assert.ok(!body.includes('config du repo'))
  })

  it('words a resolve job as a resolution of the threads', () => {
    let body = failureComment(job({ kind: 'resolve', level: 'balanced' }))
    assert.ok(body.startsWith('**Kentō · résolution des fils en échec** au commit `abcdef012`'))
    assert.ok(body.includes('`@kento-review resolve balanced`'))
  })

  it('ends with the marker of the job', () => {
    assert.ok(failureComment(job()).endsWith('<!-- kento:failure 00000000-0000-4000-8000-000000000001 -->'))
  })
})
