import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { decideMove, readOrgName, slugOf } from './rules.ts'

// KNT-150. The rename of an org and the move of an installation.
describe('the move of an installation', () => {
  let ok = { fromRole: 'owner', toRole: 'owner', sameOrg: false, githubAdmin: true, last: false, deleteConfirmed: false } as const

  it('needs an owner of both orgs whom GitHub counts as an admin of the account', () => {
    assert.equal(decideMove(ok), null)
    assert.equal(decideMove({ ...ok, toRole: 'new' }), null)
    assert.equal(decideMove({ ...ok, fromRole: 'admin' }), 'not_owner')
    assert.equal(decideMove({ ...ok, fromRole: null }), 'not_owner')
    assert.equal(decideMove({ ...ok, toRole: 'admin' }), 'target_not_owner')
    assert.equal(decideMove({ ...ok, toRole: null }), 'target_not_owner')
    assert.equal(decideMove({ ...ok, githubAdmin: false }), 'not_github_admin')
    assert.equal(decideMove({ ...ok, sameOrg: true }), 'same_org')
  })

  it('moves the last installation only when the form confirms that the empty org goes', () => {
    assert.equal(decideMove({ ...ok, last: true }), 'last_installation')
    assert.equal(decideMove({ ...ok, last: true, deleteConfirmed: true }), null)
  })
})

describe('the name of an org', () => {
  it('is one trimmed line of 1 to 60 characters', () => {
    assert.equal(readOrgName('  Acme   Labs '), 'Acme Labs')
    assert.equal(readOrgName(''), null)
    assert.equal(readOrgName('   '), null)
    assert.equal(readOrgName('x'.repeat(61)), null)
    assert.equal(readOrgName('a\u0000b'), null)
    assert.equal(readOrgName('a‮b'), null)
    assert.equal(readOrgName(undefined), null)
  })

  it('gives a slug of lowercase letters, digits and dashes', () => {
    assert.equal(slugOf('Acme Labs'), 'acme-labs')
    assert.equal(slugOf('Ça marche !'), 'ca-marche')
    assert.equal(slugOf('***'), 'org')
  })
})
