// REV-18. The form of « Mark dismissed » and « Mark wontfix », and the reply in a thread.
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
    assert.deepEqual(readStatusForm(form([['ids', A], ['ids', B], ['ids', A], ['status', 'dismissed'], ['reason', 'Off topic']])), {
      ok: true,
      ids: [A, B],
      status: 'dismissed',
      reason: 'Off topic',
    })
  })

  // REV-114. A page opened before the deploy posts the French reason: it is stored in English.
  it('reads a French reason of the dialog before the deploy as its English value', () => {
    for (let [french, english] of [['Faux positif', 'False positive'], ['Hors sujet', 'Off topic'], ['Déjà connu', 'Already known'], ['Style, pas un défaut', 'Style, not a defect']]) {
      assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'dismissed'], ['reason', french!]])), { ok: true, ids: [A], status: 'dismissed', reason: english })
    }
    // A key of the prototype of the table is no French reason.
    for (let key of ['constructor', 'toString', '__proto__']) {
      assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'dismissed'], ['reason', key]])), { ok: false, error: 'reason' })
    }
  })

  it('takes « Other » with the reason of the person, and a wontfix with no reason', () => {
    let other = readStatusForm(form([['ids', A], ['status', 'dismissed'], ['reason', OTHER_REASON], ['other', '  Corrigé ailleurs  ']]))
    assert.deepEqual(other, { ok: true, ids: [A], status: 'dismissed', reason: 'Corrigé ailleurs' })
    assert.deepEqual(readStatusForm(form([['ids', A], ['status', 'wontfix']])), { ok: true, ids: [A], status: 'wontfix', reason: null })
  })

  it('refuses no finding, too many, another status, a dismissal with no reason, a reason not offered, a reason too long', () => {
    assert.deepEqual(readStatusForm(form([['ids', 'nope'], ['status', 'dismissed'], ['reason', 'Off topic']])), { ok: false, error: 'none' })
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
      replyText('dismissed', 'Off topic', 'alex'),
      'Finding dismissed by @alex on Kentō. Reason: "Off topic". The next reviews will not comment on it again.',
    )
    assert.equal(replyText('wontfix', null, 'camille'), "Finding kept as is (won't fix) by @camille on Kentō. The next reviews will not comment on it again.")
  })
})
