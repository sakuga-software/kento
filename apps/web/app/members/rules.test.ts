import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { decideInvite, decideMemberChange, rolesFor, type MemberFacts } from './rules.ts'

// KNT-150. Who changes which membership of an org.
const owner: MemberFacts = { userId: 'o', role: 'owner', source: 'github' }
const admin: MemberFacts = { userId: 'a', role: 'admin', source: 'github' }
const member: MemberFacts = { userId: 'm', role: 'member', source: 'github' }
const guest: MemberFacts = { userId: 'g', role: 'member', source: 'invitation' }
const guestAdmin: MemberFacts = { userId: 'ga', role: 'admin', source: 'invitation' }
const guestOwner: MemberFacts = { userId: 'go', role: 'owner', source: 'invitation' }

describe('the changes of a membership', () => {
  it('a member changes nobody, and leaves only a membership from an invitation', () => {
    assert.equal(decideMemberChange(member, guest, { kind: 'role', role: 'admin' }, 1), 'not_admin')
    assert.equal(decideMemberChange(member, guest, { kind: 'remove' }, 1), 'not_admin')
    assert.equal(decideMemberChange(guest, guest, { kind: 'leave' }, 1), null)
    assert.equal(decideMemberChange(member, member, { kind: 'leave' }, 1), 'github')
    assert.equal(decideMemberChange(member, guest, { kind: 'leave' }, 1), 'not_admin', 'leave is for oneself')
  })

  it('an admin sets member or admin on a membership from an invitation, and removes it', () => {
    assert.equal(decideMemberChange(admin, guest, { kind: 'role', role: 'admin' }, 1), null)
    assert.equal(decideMemberChange(admin, guestAdmin, { kind: 'role', role: 'member' }, 1), null)
    assert.equal(decideMemberChange(admin, guest, { kind: 'remove' }, 1), null)
    assert.equal(decideMemberChange(admin, guest, { kind: 'role', role: 'member' }, 1), 'same_role')
  })

  it('only an owner gives, takes or removes the owner role', () => {
    assert.equal(decideMemberChange(admin, guest, { kind: 'role', role: 'owner' }, 1), 'not_owner')
    assert.equal(decideMemberChange(admin, guestOwner, { kind: 'role', role: 'admin' }, 1), 'not_owner')
    assert.equal(decideMemberChange(admin, guestOwner, { kind: 'remove' }, 1), 'not_owner')
    assert.equal(decideMemberChange(owner, guest, { kind: 'role', role: 'owner' }, 1), null)
    assert.equal(decideMemberChange(owner, guestOwner, { kind: 'remove' }, 1), null)
  })

  it('GitHub decides a membership from GitHub: Kentō only gives owner to a GitHub admin, or takes it back', () => {
    assert.equal(decideMemberChange(owner, admin, { kind: 'role', role: 'owner' }, 1), null)
    assert.equal(decideMemberChange(owner, { ...owner, userId: 'o2' }, { kind: 'role', role: 'admin' }, 1), null)
    assert.equal(decideMemberChange(owner, member, { kind: 'role', role: 'owner' }, 1), 'github', 'GitHub says member')
    assert.equal(decideMemberChange(owner, admin, { kind: 'role', role: 'member' }, 1), 'github')
    assert.equal(decideMemberChange(owner, { ...owner, userId: 'o2' }, { kind: 'role', role: 'member' }, 1), 'github')
    assert.equal(decideMemberChange(owner, member, { kind: 'remove' }, 1), 'github')
    assert.equal(decideMemberChange(admin, member, { kind: 'remove' }, 1), 'github')
  })

  it('never leaves the org without an active owner', () => {
    assert.equal(decideMemberChange(owner, owner, { kind: 'role', role: 'admin' }, 0), 'last_owner')
    assert.equal(decideMemberChange(guestOwner, guestOwner, { kind: 'leave' }, 0), 'last_owner')
    assert.equal(decideMemberChange(guestOwner, guestOwner, { kind: 'leave' }, 1), null)
    assert.equal(decideMemberChange(owner, guestOwner, { kind: 'remove' }, 0), 'last_owner')
    assert.equal(decideMemberChange(owner, guestOwner, { kind: 'role', role: 'member' }, 0), 'last_owner')
    assert.equal(decideMemberChange(owner, owner, { kind: 'role', role: 'admin' }, 1), null)
  })

  it('offers on the screen only the roles that would pass', () => {
    assert.deepEqual(rolesFor(owner, admin, 1), ['owner', 'admin'])
    assert.deepEqual(rolesFor(owner, member, 1), ['member'])
    assert.deepEqual(rolesFor(admin, guest, 1), ['admin', 'member'])
    assert.deepEqual(rolesFor(owner, guest, 1), ['owner', 'admin', 'member'])
    assert.deepEqual(rolesFor(owner, owner, 0), ['owner'])
    assert.deepEqual(rolesFor(member, guest, 1), ['member'])
  })
})

describe('an invitation', () => {
  it('is for an owner or an admin, as a member or an admin', () => {
    assert.equal(decideInvite(owner, 'member'), null)
    assert.equal(decideInvite(admin, 'admin'), null)
    assert.equal(decideInvite(member, 'member'), 'not_admin')
    assert.equal(decideInvite(admin, 'owner'), 'bad_role')
  })
})
