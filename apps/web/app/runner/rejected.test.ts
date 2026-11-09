import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { sendableRejected, type RejectedRow } from './rejected.ts'

const SHA = 'a'.repeat(40)
const row = (over: Partial<RejectedRow> = {}): RejectedRow => ({
  path: 'src/a.ts',
  line: 7,
  title: 'Le port n’est pas validé',
  category: 'bug',
  severity: 'major',
  status: 'dismissed',
  reason: 'validé par le schéma',
  commit: SHA,
  ...over,
})

describe('sendableRejected (REV-95)', () => {
  it('keeps the rows that the protocol accepts, and cuts the title and the cause', () => {
    let warned: Record<string, unknown>[] = []
    let out = sendableRejected([row(), row({ title: 't'.repeat(1200), reason: 'r'.repeat(600) })], (f) => warned.push(f))
    assert.equal(out.length, 2)
    assert.equal(out[1]!.title.length, 1000)
    assert.equal(out[1]!.reason!.length, 500)
    assert.deepEqual(warned, [])
  })

  it('leaves out each row that the protocol refuses, with its reason, even with a null column, and keeps the others', () => {
    let warned: Record<string, unknown>[] = []
    let out = sendableRejected(
      [row({ path: null }), row({ commit: 'abc' }), row({ line: 10_000_001 }), row({ category: 'style' as never }), row({ title: 'kept' })],
      (f) => warned.push(f),
    )
    assert.deepEqual(out.map((r) => r.title), ['kept'])
    assert.deepEqual(warned, [
      { path: '', line: 7, reason: 'a column is null' },
      { path: 'src/a.ts', line: 7, reason: 'last_seen_sha is not a commit' },
      { path: 'src/a.ts', line: 10_000_001, reason: 'path, title or line beyond the limits of the protocol' },
      { path: 'src/a.ts', line: 7, reason: 'unknown category style' },
    ])
  })
})
