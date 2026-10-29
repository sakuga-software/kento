import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createRepoCheck } from './check.ts'
import type { CheckedRepo, RepoView, ReposStore } from './store.ts'

const ORG = { id: 'org-1', githubInstallationId: 11, login: 'sakuga-software' }
const CALLER = 'jobs:\n  review:\n    uses: sakuga-software/sakuga-review/.github/workflows/review.yml@stable\n'

/** A GitHub of three repositories: a caller of review.yml, one with no workflow directory, one that fails. */
function fakeGitHub(now?: () => number) {
  let calls: string[] = []
  let mints: { githubRepoId: number | null; permissions?: Record<string, string> }[] = []
  let fetch = (async (input: string | URL | Request) => {
    let url = new URL(String(input))
    calls.push(url.pathname)
    let json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.pathname === '/installation/repositories') {
      return json(200, {
        total_count: 4,
        repositories: [
          { id: 1, full_name: 'sakuga-software/orchard', private: true, default_branch: 'main' },
          { id: 2, full_name: 'sakuga-software/fruitback', private: false, default_branch: 'main' },
          { id: 3, full_name: 'sakuga-software/broken', private: true, default_branch: 'main' },
          { id: 4, full_name: 'sakuga-software/old', private: true, default_branch: 'main', archived: true },
        ],
      })
    }
    if (url.pathname === '/repos/sakuga-software/orchard/contents/.github/workflows') {
      return json(200, [
        { type: 'file', name: 'sakuga-review.yml', path: '.github/workflows/sakuga-review.yml' },
        { type: 'file', name: 'README.md', path: '.github/workflows/README.md' },
      ])
    }
    if (url.pathname === '/repos/sakuga-software/orchard/contents/.github/workflows/sakuga-review.yml') {
      return json(200, { encoding: 'base64', content: Buffer.from(CALLER).toString('base64') })
    }
    if (url.pathname === '/repos/sakuga-software/broken/contents/.github/workflows') return json(502, { message: 'Bad Gateway' })
    return json(404, { message: 'Not Found' })
  }) as typeof globalThis.fetch

  let saved: CheckedRepo[][] = []
  let store: ReposStore = {
    list: async () => [],
    setEnabled: async () => null,
    async saveCheck(_orgId, repos) {
      saved.push(repos)
    },
  }
  let check = createRepoCheck({
    store,
    apiUrl: 'https://api.github.test',
    fetch,
    now,
    async mintInstallationToken(target) {
      mints.push(target)
      return { token: 'ghs_check', expiresAt: '2027-01-01T00:00:00Z' }
    },
  })
  return { check, calls, mints, saved }
}

describe('the check of the repositories on GitHub', () => {
  it('reads the list and the workflows, writes what it read, and skips the archived and the failed', async () => {
    let { check, mints, saved, calls } = fakeGitHub()
    assert.deepEqual(await check.run(ORG), { repos: 2, failed: 1 })
    // One token for the whole installation, that reads only.
    assert.deepEqual(mints, [{ installationId: 11, githubRepoId: null, permissions: { contents: 'read' } }])
    let byName = Object.fromEntries(saved[0]!.map((repo) => [repo.fullName, repo]))
    assert.deepEqual(Object.keys(byName).sort(), ['sakuga-software/fruitback', 'sakuga-software/orchard'])
    assert.deepEqual(byName['sakuga-software/orchard']!.workflow, { mode: 'reusable', path: '.github/workflows/sakuga-review.yml', ref: 'stable' })
    assert.equal(byName['sakuga-software/orchard']!.private, true)
    assert.deepEqual(byName['sakuga-software/fruitback']!.workflow, { mode: 'none', path: null, ref: null })
    assert.equal(calls.includes('/repos/sakuga-software/orchard/contents/.github/workflows/README.md'), false)
    assert.equal(calls.some((path) => path.includes('/old/')), false)
  })

  it('starts in the background only when the rows are old or never checked, once at a time', async () => {
    let { check, saved } = fakeGitHub()
    let fresh: RepoView = {
      id: 'r', githubRepoId: 1, fullName: 'sakuga-software/orchard', enabled: true, defaultLevel: 'lite', private: true,
      defaultBranch: 'main', workflow: 'none', workflowPath: null, workflowRef: null, workflowCheckedAt: new Date(),
      streak: 0, resetBy: null, lastReview: null,
    }
    assert.equal(check.refreshIfStale(ORG, [fresh]), false)
    let old = { ...fresh, workflowCheckedAt: new Date(Date.now() - 11 * 60_000) }
    assert.equal(check.refreshIfStale(ORG, [old]), true)
    assert.equal(check.refreshIfStale(ORG, [old]), true, 'the same check runs')
    await check.run(ORG)
    assert.equal(saved.length, 1)
  })

  it('a row that the check could not write starts no new check before CHECK_MAX_AGE_MS', async () => {
    let clock = { now: Date.parse('2026-10-29T10:00:00Z') }
    let { check, calls } = fakeGitHub(() => clock.now)
    let neverChecked: RepoView = {
      id: 'r', githubRepoId: 3, fullName: 'sakuga-software/broken', enabled: true, defaultLevel: 'lite', private: null,
      defaultBranch: null, workflow: null, workflowPath: null, workflowRef: null, workflowCheckedAt: null,
      streak: 0, resetBy: null, lastReview: null,
    }
    // A restart: no check in this process yet, and a row never checked.
    assert.equal(check.refreshIfStale(ORG, [neverChecked]), true)
    await check.run(ORG)
    let lists = () => calls.filter((path) => path === '/installation/repositories').length
    assert.equal(lists(), 1)
    // GitHub failed for `broken`: its row stays null, and the next loads start nothing.
    clock.now += 9 * 60_000
    assert.equal(check.refreshIfStale(ORG, [neverChecked]), false)
    assert.equal(lists(), 1)
    clock.now += 2 * 60_000
    assert.equal(check.refreshIfStale(ORG, [neverChecked]), true)
  })
})
