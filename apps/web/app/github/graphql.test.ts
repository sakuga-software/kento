import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { GitHub } from '../publish/github.ts'
import { resolveReviewThread, reviewThreadPages } from './graphql.ts'

/** A GitHub that answers the GraphQL calls from `pages`, and records them. */
function fakeGitHub(pages: { nodes: { id: string }[]; next: string | null }[]) {
  let calls: { query: string; variables: Record<string, unknown> }[] = []
  let github: GitHub = {
    rest: async () => {
      throw new Error('no REST call expected')
    },
    send: async () => {
      throw new Error('no REST call expected')
    },
    graphql: async (query, variables) => {
      calls.push({ query, variables })
      let page = pages[calls.length - 1]!
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: page.next !== null, endCursor: page.next }, nodes: page.nodes } } } } as never
    },
  }
  return { github, calls }
}

describe('the GraphQL calls of the review threads (REV-47)', () => {
  it('reads every page, with the cursor of the page before, and the fields and fragments of the caller', async () => {
    let { github, calls } = fakeGitHub([
      { nodes: [{ id: 'T1' }, { id: 'T2' }], next: 'C1' },
      { nodes: [{ id: 'T3' }], next: null },
    ])
    let seen: string[] = []
    for await (let nodes of reviewThreadPages<{ id: string }>(github, { owner: 'sakuga-software', name: 'app', pr: 12 }, 'id ...f', 'fragment f on X { id }')) {
      seen.push(...nodes.map((n) => n.id))
    }
    assert.deepEqual(seen, ['T1', 'T2', 'T3'])
    assert.deepEqual(
      calls.map((c) => c.variables),
      [
        { owner: 'sakuga-software', name: 'app', number: 12, after: null },
        { owner: 'sakuga-software', name: 'app', number: 12, after: 'C1' },
      ],
    )
    assert.ok(calls[0]!.query.startsWith('fragment f on X { id }'))
    assert.match(calls[0]!.query, /reviewThreads\(first: 100, after: \$after\) \{\s+pageInfo \{ hasNextPage endCursor \}\s+nodes \{ id \.\.\.f \}/)
  })

  it('resolves a thread by its id', async () => {
    let { github, calls } = fakeGitHub([{ nodes: [], next: null }])
    await resolveReviewThread(github, 'PRRT_1')
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.query, /resolveReviewThread\(input: \{threadId: \$id\}\)/)
    assert.deepEqual(calls[0]!.variables, { id: 'PRRT_1' })
  })
})
