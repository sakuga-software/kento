import { createHash, generateKeyPairSync } from 'node:crypto'

import * as assert from 'remix/assert'
import { finishExternalAuth, startExternalAuth } from 'remix/auth'
import { createSession, Session } from 'remix/session'
import { describe, it } from 'remix/test'

import { createGitHubSignIn, createRoleLookup, type OrgAccount } from './github.ts'

let { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

type Call = { url: string; init: RequestInit }

function fakeFetch(answer: (url: string, init: RequestInit) => Response) {
  let calls: Call[] = []
  let fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer(url, init)
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

describe('createGitHubSignIn', () => {
  let transaction = { provider: 'github', state: 'the-state', codeVerifier: 'the-verifier-of-pkce-0123456789' }

  function provider(fetch: typeof globalThis.fetch) {
    return createGitHubSignIn({
      clientId: 'Iv23li',
      clientSecret: 'the-client-secret',
      redirectUri: new URL('https://review.sakuga.dev/auth/github/callback'),
      oauthUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      fetch,
    })
  }

  it('sends the browser to GitHub with the state and a S256 challenge, never the verifier', async () => {
    let { fetch } = fakeFetch(() => new Response(null, { status: 500 }))
    let session = createSession()
    let context = { get: (key: unknown) => (key === Session ? session : undefined) }
    let response = await startExternalAuth(provider(fetch), context as never)
    let url = new URL(response.headers.get('Location')!)
    let stored = session.get('__auth') as { state: string; codeVerifier: string }

    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize')
    assert.equal(url.searchParams.get('client_id'), 'Iv23li')
    assert.equal(url.searchParams.get('redirect_uri'), 'https://review.sakuga.dev/auth/github/callback')
    assert.equal(url.searchParams.get('state'), stored.state)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(stored.codeVerifier).digest('base64url'))
    assert.ok(!url.href.includes(stored.codeVerifier))
  })

  it('trades the code with the verifier, reads /user, and keeps no token', async () => {
    let { calls, fetch } = fakeFetch((url) =>
      url.endsWith('/access_token')
        ? Response.json({ access_token: 'ghu_user_token', token_type: 'bearer' })
        : Response.json({ id: 42, login: 'alex', name: 'Alex', avatar_url: 'https://avatars.githubusercontent.com/u/42' }),
    )
    let session = createSession()
    session.set('__auth', transaction)
    let context = {
      get: (key: unknown) => (key === Session ? session : undefined),
      url: new URL('https://review.sakuga.dev/auth/github/callback?code=the-code&state=the-state'),
    }

    let { result } = await finishExternalAuth(provider(fetch), context as never)

    assert.deepEqual(result.profile, { id: 42, login: 'alex', name: 'Alex', avatarUrl: 'https://avatars.githubusercontent.com/u/42' })
    assert.equal(calls[0]!.url, 'https://github.com/login/oauth/access_token')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      client_id: 'Iv23li',
      client_secret: 'the-client-secret',
      code: 'the-code',
      redirect_uri: 'https://review.sakuga.dev/auth/github/callback',
      code_verifier: transaction.codeVerifier,
    })
    assert.equal(calls[1]!.url, 'https://api.github.com/user')
    assert.equal((calls[1]!.init.headers as Record<string, string>).Authorization, 'Bearer ghu_user_token')
    // The transaction is gone from the session; the token never goes there.
    assert.equal(session.get('__auth'), undefined)
    assert.ok(!JSON.stringify(session.data).includes('ghu_user_token'))
  })

  it('fails when GitHub refuses the code', async () => {
    let { fetch } = fakeFetch(() => Response.json({ error: 'bad_verification_code' }))
    let session = createSession()
    session.set('__auth', transaction)
    let context = {
      get: (key: unknown) => (key === Session ? session : undefined),
      url: new URL('https://review.sakuga.dev/auth/github/callback?code=x&state=the-state'),
    }
    await assert.rejects(() => finishExternalAuth(provider(fetch), context as never), /bad_verification_code/)
  })
})

describe('createRoleLookup', () => {
  let org: OrgAccount = { githubInstallationId: 77, githubAccountId: 900, login: 'sakuga-software' }
  let now = Date.parse('2026-10-28T12:00:00Z')

  function lookup(membership: (login: string) => Response, tokenStatus = 201) {
    let { calls, fetch } = fakeFetch((url) => {
      if (url.endsWith('/access_tokens')) {
        return tokenStatus === 201
          ? Response.json({ token: 'ghs_members', expires_at: '2026-10-28T13:00:00Z' }, { status: 201 })
          : Response.json({ message: 'no permission' }, { status: tokenStatus })
      }
      return membership(url.split('/').pop()!)
    })
    return { calls, lookupRole: createRoleLookup({ appId: '12345', privateKey, apiUrl: 'https://api.github.com', fetch, now: () => now }) }
  }

  it('reads the role with a token of the installation limited to members: read', async () => {
    let { calls, lookupRole } = lookup((login) =>
      login === 'alex' ? Response.json({ state: 'active', role: 'admin' }) : Response.json({ state: 'active', role: 'member' }),
    )

    assert.equal(await lookupRole(org, { githubId: 1, login: 'alex' }), 'admin')
    assert.equal(await lookupRole(org, { githubId: 2, login: 'camille' }), 'member')

    assert.equal(calls[0]!.url, 'https://api.github.com/app/installations/77/access_tokens')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { permissions: { members: 'read' } })
    assert.equal(calls[1]!.url, 'https://api.github.com/orgs/sakuga-software/memberships/alex')
    assert.equal((calls[1]!.init.headers as Record<string, string>).Authorization, 'Bearer ghs_members')
    // One token for both lookups, until it nears its end.
    assert.equal(calls.filter((c) => c.url.endsWith('/access_tokens')).length, 1)
  })

  it('gives no access to an invitation not accepted, to a person outside of the org, or without the permission', async () => {
    let pending = lookup(() => Response.json({ state: 'pending', role: 'admin' }))
    assert.equal(await pending.lookupRole(org, { githubId: 2, login: 'camille' }), null)

    let outside = lookup(() => Response.json({ message: 'Not Found' }, { status: 404 }))
    assert.equal(await outside.lookupRole(org, { githubId: 3, login: 'stranger' }), null)

    let noPermission = lookup(() => Response.json({ state: 'active', role: 'admin' }), 422)
    assert.equal(await noPermission.lookupRole(org, { githubId: 2, login: 'camille' }), null)
  })

  it('makes the owner of a personal account its admin, with no call', async () => {
    let { calls, lookupRole } = lookup(() => Response.json({}, { status: 500 }))
    assert.equal(await lookupRole({ ...org, githubAccountId: 42 }, { githubId: 42, login: 'alex' }), 'admin')
    assert.equal(calls.length, 0)
  })

  it('throws when GitHub fails, so the caller can tell it from a refusal', async () => {
    let failing = lookup(() => new Response('bad gateway', { status: 502 }))
    await assert.rejects(() => failing.lookupRole(org, { githubId: 2, login: 'camille' }), /GitHub answered 502/)
    let noToken = lookup(() => Response.json({}), 401)
    await assert.rejects(() => noToken.lookupRole(org, { githubId: 2, login: 'camille' }), /GitHub answered 401/)
  })
})
