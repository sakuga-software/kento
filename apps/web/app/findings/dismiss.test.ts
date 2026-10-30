// REV-18. The form of « Marquer dismissed » and « Marquer wontfix », and the reply in a thread.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BULK_MAX, OTHER_REASON, readStatusForm, replyText } from './dismiss.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function form(fields: [string, string][]) {
  let data = new FormData()
  for (let [name, value] of fields) data.append(name, value)
  return data
}

describe('the form of a change of status', () => {
  it('reads the ids, once each, and a reason of the dialog', () => {
    assert.deepEqual(readStatusForm(form([['ids', A], ['ids', B], ['ids', A], ['status', 'dismissed'], ['reason', 'Hors sujet']])), {
      ok: true,
      ids: [A, B],
      status: 'dismissed',
      reason: 'Hors sujet',
    })
  })

  it('takes « Autre » with the reason of the person, and a wontfix with no reason', () => {
    let other = readStatusForm(form([['ids', A], ['status', 'dismissed'], ['reason', OTHER_REASON], ['other', '  Corrigé ailleurs  ']]))
    assert.deepEqual(other, { ok: true, ids: [A], status: 'dismissed', reason: 'Corrigé ailleurs' })
    assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'wontfix']])), { ok: true, ids: [A], status: 'wontfix', reason: null })
  })

  it('refuses no finding, too many, another status, a dismissal with no reason, a reason not offered, a reason too long', () => {
    assert.deepEqual(readStatusForm(form([['ids', 'nope'], ['status', 'dismissed'], ['reason', 'Hors sujet']])), { ok: false, error: 'none' })
    let many = Array.from({ length: BULK_MAX + 1 }, (_, n) => ['ids', `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`] as [string, string])
    assert.deepEqual(readStatusForm(form([...many, ['status', 'wontfix']])), { ok: false, error: 'too_many' })
    assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'open']])), { ok: false, error: 'status' })
    assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'dismissed']])), { ok: false, error: 'reason' })
    assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'dismissed'], ['reason', OTHER_REASON], ['other', ' ']])), { ok: false, error: 'reason' })
    assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'dismissed'], ['reason', 'Je ne suis pas dans la liste']])), { ok: false, error: 'reason' })
    assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'dismissed'], ['reason', OTHER_REASON], ['other', 'x'.repeat(501)]])), {
      ok: false,
      error: 'reason_long',
    })
  })

  it('writes the reply of the thread with the person and the reason', () => {
    assert.equal(
      replyText('dismissed', 'Hors sujet', 'alex'),
      'Finding écarté (dismissed) par @alex sur Kentō. Motif : « Hors sujet ». Les prochaines reviews ne le commenteront plus.',
    )
    assert.equal(replyText('wontfix', null, 'camille'), 'Finding accepté tel quel (wontfix) par @camille sur Kentō. Les prochaines reviews ne le commenteront plus.')
  })
})
