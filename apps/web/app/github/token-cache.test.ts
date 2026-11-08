import * as assert from 'remix/assert'
import { beforeEach, describe, it } from 'remix/test'

import { GitHubError } from '../publish/github.ts'
import type { MintInstallationToken } from './installation-token.ts'
import { createInstallationTokenCache, REFRESH_MARGIN_MS } from './token-cache.ts'

const START = Date.parse('2026-11-08T12:00:00Z')
const HOUR = 60 * 60_000
const REPO = { installationId: 77, githubRepoId: 3001 }

describe('installation token cache (REV-92)', () => {
  let clock: number
  let mints: Parameters<MintInstallationToken>[0][]
  let lifetime: number
  let mintFails: boolean

  let mint: MintInstallationToken = async (target) => {
    mints.push(target)
    if (mintFails) throw new Error('GitHub answered 502')
    return { token: `ghs_${mints.length}`, expiresAt: new Date(clock + lifetime).toISOString() }
  }

  function cache() {
    return createInstallationTokenCache({ mint, permissions: { pull_requests: 'read' }, now: () => clock })
  }

  const tokenOf = async (c: ReturnType<typeof cache>, target = REPO) => c.run(target, async (t) => t.token)

  beforeEach(() => {
    clock = START
    mints = []
    lifetime = HOUR
    mintFails = false
  })

  it('mints once for two runs on the same repository, with the permissions of the cache', async () => {
    let c = cache()
    assert.equal(await tokenOf(c), 'ghs_1')
    clock += 30 * 60_000
    assert.equal(await tokenOf(c), 'ghs_1')
    assert.deepEqual(mints, [{ ...REPO, permissions: { pull_requests: 'read' } }])
  })

  it('mints again a token that expires in less than the margin', async () => {
    let c = cache()
    assert.equal(await tokenOf(c), 'ghs_1')
    // One minute before the margin: still kept.
    clock = START + HOUR - REFRESH_MARGIN_MS - 60_000
    assert.equal(await tokenOf(c), 'ghs_1')
    // Inside the margin: a new token, before GitHub refuses the old one.
    clock = START + HOUR - REFRESH_MARGIN_MS + 1
    assert.equal(await tokenOf(c), 'ghs_2')
    assert.equal(mints.length, 2)
  })

  it('never keeps a token that GitHub gives with less time than the margin', async () => {
    lifetime = REFRESH_MARGIN_MS - 1
    let c = cache()
    assert.equal(await tokenOf(c), 'ghs_1')
    assert.equal(await tokenOf(c), 'ghs_2')
  })

  it('claims that wait for one mint share its token, even one given with less time than the margin', async () => {
    lifetime = REFRESH_MARGIN_MS - 1
    let c = cache()
    let tokens = await Promise.all([tokenOf(c), tokenOf(c), tokenOf(c)])
    assert.deepEqual(tokens, ['ghs_1', 'ghs_1', 'ghs_1'])
    assert.equal(mints.length, 1)
    // The token is not kept for the next claim.
    assert.equal(await tokenOf(c), 'ghs_2')
  })

  it('keeps one token for each repository and installation', async () => {
    let c = cache()
    await tokenOf(c)
    await tokenOf(c, { installationId: 77, githubRepoId: 3002 })
    await tokenOf(c, { installationId: 78, githubRepoId: 3001 })
    await tokenOf(c)
    assert.deepEqual(mints.map((m) => [m.installationId, m.githubRepoId]), [[77, 3001], [77, 3002], [78, 3001]])
  })

  it('makes one mint for claims that come together', async () => {
    let c = cache()
    let tokens = await Promise.all([tokenOf(c), tokenOf(c), tokenOf(c)])
    assert.deepEqual(tokens, ['ghs_1', 'ghs_1', 'ghs_1'])
    assert.equal(mints.length, 1)
  })

  it('on a 401, forgets the token and mints a new one once', async () => {
    let c = cache()
    await tokenOf(c)
    let used: string[] = []
    let result = await c.run(REPO, async (t) => {
      used.push(t.token)
      if (t.token === 'ghs_1') throw new GitHubError('POST', '/graphql', 401, 'Bad credentials')
      return 'read'
    })
    assert.equal(result, 'read')
    assert.deepEqual(used, ['ghs_1', 'ghs_2'])
    // The new token is the kept one now.
    assert.equal(await tokenOf(c), 'ghs_2')
    assert.equal(mints.length, 2)
  })

  it('a second 401 fails the run, with no third mint', async () => {
    let c = cache()
    let calls = 0
    await assert.rejects(
      c.run(REPO, async () => {
        calls++
        throw new GitHubError('POST', '/graphql', 401, 'Bad credentials')
      }),
      /answered 401/,
    )
    assert.equal(calls, 2)
    assert.equal(mints.length, 2)
  })

  it('an error other than a 401 keeps the token, and is not retried', async () => {
    let c = cache()
    let calls = 0
    await assert.rejects(
      c.run(REPO, async () => {
        calls++
        throw new GitHubError('POST', '/graphql', 502, 'Bad gateway')
      }),
      /answered 502/,
    )
    assert.equal(calls, 1)
    assert.equal(await tokenOf(c), 'ghs_1')
    assert.equal(mints.length, 1)
  })

  it('does not keep a failed mint', async () => {
    let c = cache()
    mintFails = true
    await assert.rejects(tokenOf(c), /502/)
    mintFails = false
    assert.equal(await tokenOf(c), 'ghs_2')
    assert.equal(await tokenOf(c), 'ghs_2')
  })
})
