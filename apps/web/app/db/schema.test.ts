import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { LEVELS, PROVIDER_KINDS } from '@kento-review/protocol'

import { providerKind, reviewLevel } from './schema.ts'

// The enums of Postgres keep their literals: a change of them is a migration. These tests catch a
// level or a provider added to packages/protocol and not to the database.
describe('schema enums', () => {
  it('review_level holds the levels of the protocol, in order', () => {
    assert.deepEqual([...reviewLevel.enumValues], [...LEVELS])
  })

  it('provider_kind holds the providers of the protocol, in order', () => {
    assert.deepEqual([...providerKind.enumValues], [...PROVIDER_KINDS])
  })
})
