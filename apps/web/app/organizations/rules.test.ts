import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { decideMove, readOrgName, slugOf } from './rules.ts'

// KNT-150. The rename of an org and the move of an installation.
describe('the move of an installation', () => {
  let into = { kind: 'org', role: 'owner', active: 1, adminOfOne: true, otherAccounts: true, personal: false } as const
  let ok = { fromRole: 'owner', to: into, sameOrg: false, movedAdmin: true, movedPersonal: false, remainingAdmin: false, last: false, deleteConfirmed: false } as const

  it('into an org: an owner of both whom GitHub counts as an admin of the account that moves and of one already there', () => {
    assert.equal(decideMove(ok), null)
    assert.equal(decideMove({ ...ok, fromRole: 'admin' }), 'not_owner')
    assert.equal(decideMove({ ...ok, fromRole: null }), 'not_owner')
    assert.equal(decideMove({ ...ok, to: { ...into, role: 'admin' } }), 'target_not_owner')
    assert.equal(decideMove({ ...ok, to: { ...into, role: null } }), 'target_not_owner')
    assert.equal(decideMove({ ...ok, movedAdmin: false }), 'not_github_admin')
    assert.equal(decideMove({ ...ok, to: { ...into, adminOfOne: false } }), 'not_target_admin')
    assert.equal(decideMove({ ...ok, to: { ...into, active: 0 } }), 'target_inactive')
    assert.equal(decideMove({ ...ok, sameOrg: true }), 'same_org')
  })

  it('keeps an installation on a personal account in an org of its own', () => {
    assert.equal(decideMove({ ...ok, movedPersonal: true }), 'personal_account')
    assert.equal(decideMove({ ...ok, to: { ...into, personal: true } }), 'personal_account')
    // Back into an org that holds only its own account (a suspended installation of it): allowed.
    assert.equal(decideMove({ ...ok, movedPersonal: true, to: { ...into, otherAccounts: false } }), null)
    assert.equal(decideMove({ ...ok, movedPersonal: true, to: { kind: 'new' } }), null)
  })

  it('into a new org: GitHub counts the person as an admin of the account', () => {
    assert.equal(decideMove({ ...ok, to: { kind: 'new' } }), null)
    assert.equal(decideMove({ ...ok, to: { kind: 'new' }, movedAdmin: false }), 'not_github_admin')
  })

  it('a detach needs an owner whom GitHub counts as an admin of another account of the org, and no right on the one that leaves', () => {
    let detach = { ...ok, to: { kind: 'detach' }, movedAdmin: false } as const
    assert.equal(decideMove({ ...detach, remainingAdmin: true }), null)
    assert.equal(decideMove(detach), 'not_remaining_admin')
    assert.equal(decideMove({ ...detach, remainingAdmin: true, fromRole: 'admin' }), 'not_owner')
  })

  it('moves the last installation only when the form confirms that the empty org goes', () => {
    assert.equal(decideMove({ ...ok, last: true }), 'last_installation')
    assert.equal(decideMove({ ...ok, last: true, deleteConfirmed: true }), null)
    assert.equal(decideMove({ ...ok, to: { kind: 'new' }, last: true }), 'last_installation')
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
    assert.equal(readOrgName('a\u200bcme'), null, 'a zero-width space')
    assert.equal(readOrgName('\u2060acme'), null, 'a word joiner')
    assert.equal(readOrgName(undefined), null)
  })

  it('gives a slug of lowercase letters, digits and dashes', () => {
    assert.equal(slugOf('Acme Labs'), 'acme-labs')
    assert.equal(slugOf('Ça marche !'), 'ca-marche')
    assert.equal(slugOf('***'), 'org')
  })
})
