import { generateKeyPairSync } from 'node:crypto'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createGitHubOAuth, createGitHubPeople, createRoleLookup, type InstallationAccount } from './github.ts'

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

describe('createGitHubOAuth', () => {
  function oauth(fetch: typeof globalThis.fetch) {
    return createGitHubOAuth({
      clientId: 'Iv23li',
      clientSecret: 'the-client-secret',
      redirectUri: new URL('https://kento.example.com/auth/github/callback'),
      oauthUrl: 'https://github.com/',
      apiUrl: 'https://api.github.com/',
      fetch,
    })
  }

  it('gives Better Auth the addresses of the GitHub of the configuration', () => {
    let { fetch } = fakeFetch(() => new Response(null, { status: 500 }))
    let github = oauth(fetch)
    assert.equal(github.authorizationUrl, 'https://github.com/login/oauth/authorize')
    assert.equal(github.tokenUrl, 'https://github.com/login/oauth/access_token')
    assert.equal(github.redirectUri.href, 'https://kento.example.com/auth/github/callback')
  })

  it('trades the code with the verifier, then reads /user with the token', async () => {
    let { calls, fetch } = fakeFetch((url) =>
      url.endsWith('/access_token')
        ? Response.json({ access_token: 'ghu_user_token', token_type: 'bearer' })
        : Response.json({ id: 42, login: 'octocat', name: 'Octocat', avatar_url: 'https://avatars.githubusercontent.com/u/42' }),
    )
    let github = oauth(fetch)
    let tokens = await github.exchangeCode({ code: 'the-code', codeVerifier: 'the-verifier', redirectUri: 'https://kento.example.com/auth/github/callback' })
    assert.deepEqual(tokens, { accessToken: 'ghu_user_token' })
    assert.equal(calls[0]!.url, 'https://github.com/login/oauth/access_token')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      client_id: 'Iv23li',
      client_secret: 'the-client-secret',
      code: 'the-code',
      redirect_uri: 'https://kento.example.com/auth/github/callback',
      code_verifier: 'the-verifier',
    })

    let profile = await github.readProfile(tokens.accessToken)
    assert.deepEqual(profile, { id: 42, login: 'octocat', name: 'Octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/42' })
    assert.equal(calls[1]!.url, 'https://api.github.com/user')
    assert.equal((calls[1]!.init.headers as Record<string, string>).Authorization, 'Bearer ghu_user_token')
  })

  it('fails when GitHub refuses the code, or answers /user without an id', async () => {
    let refused = oauth(fakeFetch(() => Response.json({ error: 'bad_verification_code' })).fetch)
    await assert.rejects(() => refused.exchangeCode({ code: 'x', codeVerifier: null, redirectUri: 'https://kento.example.com/auth/github/callback' }), /bad_verification_code/)
    let broken = oauth(fakeFetch(() => Response.json({ login: 'octocat' })).fetch)
    await assert.rejects(() => broken.readProfile('ghu_user_token'), /without an id/)
  })

  it('keeps only an https avatar', async () => {
    let github = oauth(fakeFetch(() => Response.json({ id: 1, login: 'octocat', name: null, avatar_url: 'http://example.com/a.png' })).fetch)
    assert.equal((await github.readProfile('t')).avatarUrl, null)
  })
})

describe('createRoleLookup', () => {
  let org: InstallationAccount = { githubInstallationId: 77, githubAccountId: 900, login: 'sakuga-software' }
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
      login === 'octocat' ? Response.json({ state: 'active', role: 'admin' }) : Response.json({ state: 'active', role: 'member' }),
    )

    assert.equal(await lookupRole(org, { githubId: 1, login: 'octocat' }), 'admin')
    assert.equal(await lookupRole(org, { githubId: 2, login: 'camille' }), 'member')

    assert.equal(calls[0]!.url, 'https://api.github.com/app/installations/77/access_tokens')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { permissions: { members: 'read' } })
    assert.equal(calls[1]!.url, 'https://api.github.com/orgs/sakuga-software/memberships/octocat')
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
    assert.equal(await lookupRole({ ...org, githubAccountId: 42 }, { githubId: 42, login: 'octocat' }), 'admin')
    assert.equal(calls.length, 0)
  })

  it('throws when GitHub fails, so the caller can tell it from a refusal', async () => {
    let failing = lookup(() => new Response('bad gateway', { status: 502 }))
    await assert.rejects(() => failing.lookupRole(org, { githubId: 2, login: 'camille' }), /GitHub answered 502/)
    let noToken = lookup(() => Response.json({}), 401)
    await assert.rejects(() => noToken.lookupRole(org, { githubId: 2, login: 'camille' }), /GitHub answered 401/)
  })
})

describe('KNT-150: the account of a login', () => {
  let org: InstallationAccount = { githubInstallationId: 77, githubAccountId: 900, login: 'sakuga-software' }

  function people(user: (login: string) => Response) {
    let { calls, fetch } = fakeFetch((url) =>
      url.endsWith('/access_tokens')
        ? Response.json({ token: 'ghs_members', expires_at: '2026-10-28T13:00:00Z' }, { status: 201 })
        : user(decodeURIComponent(url.split('/').pop()!)),
    )
    let now = Date.parse('2026-10-28T12:00:00Z')
    return { calls, ...createGitHubPeople({ appId: '12345', privateKey, apiUrl: 'https://api.github.com', fetch, now: () => now }) }
  }

  it('reads a person with the token of the installation, and nothing for an org, a bot or an unknown login', async () => {
    let { calls, lookupUser } = people((login) =>
      login === 'camille'
        ? Response.json({ id: 2, login: 'Camille', type: 'User' })
        : login === 'acme'
          ? Response.json({ id: 9, login: 'acme', type: 'Organization' })
          : Response.json({ message: 'Not Found' }, { status: 404 }),
    )
    assert.deepEqual(await lookupUser(org, 'camille'), { id: 2, login: 'Camille' })
    assert.equal(await lookupUser(org, 'acme'), null)
    assert.equal(await lookupUser(org, 'nobody'), null)
    let user = calls.find((c) => c.url === 'https://api.github.com/users/camille')!
    assert.equal(new Headers(user.init.headers).get('Authorization'), 'Bearer ghs_members')
    // A login that GitHub cannot have never leaves Kentō.
    let before = calls.length
    assert.equal(await lookupUser(org, '../app'), null)
    assert.equal(await lookupUser(org, 'a--b'), null)
    assert.equal(calls.length, before)
  })

  it('throws when GitHub fails, so the screen says so', async () => {
    let { lookupUser } = people(() => Response.json({ message: 'boom' }, { status: 502 }))
    await assert.rejects(lookupUser(org, 'camille'), /502/)
  })
})
