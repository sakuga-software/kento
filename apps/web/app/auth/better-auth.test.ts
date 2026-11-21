import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, fakeAuth, OCTOCAT, ORG, OTHER_ORG, STRANGER } from './test-helpers.ts'
import { beforeSessionCreate, checkSignIn, githubEmail, SESSION_TTL_MS, type SignInScope } from './better-auth.ts'

// KNT-150. The hook that decides whether Better Auth writes a session, and what goes in it.
describe('the hook before a session is written', () => {
  const NOW = Date.parse('2026-11-20T12:00:00Z')

  function allowed(): SignInScope {
    return {
      profile: OCTOCAT,
      decision: { kind: 'allowed', roles: [{ org: ORG, role: 'admin', answer: { role: 'admin', from: ORG.installations.map((i) => i.id) } }], unconfirmed: [], invited: [] },
      clientIp: '203.0.113.5',
    }
  }

  it('writes no session outside of a sign-in, or for a sign-in that Kentō did not allow', async () => {
    let { deps } = fakeAuth()
    let session = { userId: 'user-1', token: 't' }
    assert.equal(await beforeSessionCreate(deps.store, session, undefined, NOW), false)
    assert.equal(await beforeSessionCreate(deps.store, session, { profile: OCTOCAT, decision: null }, NOW), false)
    assert.equal(await beforeSessionCreate(deps.store, session, { profile: OCTOCAT, decision: { kind: 'refused' } }, NOW), false)
    assert.equal(await beforeSessionCreate(deps.store, session, { profile: OCTOCAT, decision: { kind: 'unknown' } }, NOW), false)
    assert.equal(
      await beforeSessionCreate(deps.store, session, { profile: OCTOCAT, decision: { kind: 'allowed', roles: [], unconfirmed: [], invited: [] } }, NOW),
      false,
      'no org to show',
    )
    assert.equal(await beforeSessionCreate(deps.store, { userId: 'nobody', token: 't' }, allowed(), NOW), false, 'a user that is gone')
  })

  it('saves the roles, and ends the session 7 days after the sign-in in the org of the decision', async () => {
    let auth = fakeAuth()
    auth.tables.users!.push({ id: 'user-2', githubId: CAMILLE.id, login: CAMILLE.login })
    let result = await beforeSessionCreate(auth.deps.store, { userId: 'user-2', token: 't' }, allowed(), NOW)
    assert.ok(result)
    assert.equal(result.data.activeOrganizationId, ORG.id)
    assert.equal((result.data.expiresAt as Date).getTime(), NOW + SESSION_TTL_MS)
    assert.equal(result.data.token, 't', 'the rest of the row stays')
    assert.equal(result.data.ipAddress, '203.0.113.5', 'the address that Kentō resolved')
    assert.equal(auth.memberships.get(`user-2/${ORG.id}`)?.role, 'owner', 'the first admin of an org with no owner')
  })

  it('KNT-150: shows the org of an invitation when GitHub counts the person nowhere', async () => {
    let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
    auth.tables.users!.push({ id: 'user-2', githubId: CAMILLE.id, login: CAMILLE.login })
    await auth.deps.store.saveMembership('user-2', OTHER_ORG.id, 'member', 'invitation')
    let scope: SignInScope = { profile: CAMILLE, decision: { kind: 'allowed', roles: [], unconfirmed: [], invited: [OTHER_ORG] } }
    let result = await beforeSessionCreate(auth.deps.store, { userId: 'user-2', token: 't' }, scope, NOW)
    assert.ok(result)
    assert.equal(result.data.activeOrganizationId, OTHER_ORG.id)
  })

  it('KNT-150: never shows an org where the person is not a member once the roles are saved', async () => {
    let auth = fakeAuth({ orgs: [ORG] })
    auth.tables.users!.push({ id: 'user-2', githubId: CAMILLE.id, login: CAMILLE.login })
    // The invited org is gone (no membership any more), and GitHub gives no role: no org, no session.
    let scope: SignInScope = { profile: CAMILLE, decision: { kind: 'allowed', roles: [], unconfirmed: [], invited: [OTHER_ORG] } }
    assert.equal(await beforeSessionCreate(auth.deps.store, { userId: 'user-2', token: 't' }, scope, NOW), false)
  })
})

describe('the gate of the sign-in', () => {
  it('refuses an identity that is not the one this sign-in read on GitHub, before asking GitHub', async () => {
    let auth = fakeAuth()
    auth.setRole(ORG, OCTOCAT, 'admin')
    let scope: SignInScope = { profile: OCTOCAT, decision: null }
    assert.deepEqual(await checkSignIn(auth.deps.store, auth.deps.lookupRole, scope, { email: githubEmail(CAMILLE.id) }), { error: 'failed' })
    assert.deepEqual(await checkSignIn(auth.deps.store, auth.deps.lookupRole, scope, { email: undefined }), { error: 'failed' })
    assert.deepEqual(await checkSignIn(auth.deps.store, auth.deps.lookupRole, undefined, { email: githubEmail(OCTOCAT.id) }), { error: 'failed' })
    assert.deepEqual(auth.lookups, [])
    assert.equal(scope.decision, null)

    assert.equal(await checkSignIn(auth.deps.store, auth.deps.lookupRole, scope, { email: githubEmail(OCTOCAT.id) }), undefined)
    assert.equal((scope.decision as SignInScope['decision'])?.kind, 'allowed')
  })
})

describe('KNT-150: a session with no org, for an invitation', () => {
  it('is written only while the invitation is still pending', async () => {
    let auth = fakeAuth()
    auth.tables.users!.push({ id: 'user-3', githubId: STRANGER.id, login: STRANGER.login })
    let scope: SignInScope = { profile: STRANGER, decision: { kind: 'allowed', roles: [], unconfirmed: [], invited: [], pending: 1 } }
    auth.invite(STRANGER, 1)
    let written = await beforeSessionCreate(auth.deps.store, { userId: 'user-3', token: 't' }, scope, Date.now())
    assert.ok(written)
    assert.equal(written.data.activeOrganizationId, null)
    // The invitation ended between the decision and the session: no session.
    auth.invite(STRANGER, 0)
    assert.equal(await beforeSessionCreate(auth.deps.store, { userId: 'user-3', token: 't' }, scope, Date.now()), false)
  })
})
