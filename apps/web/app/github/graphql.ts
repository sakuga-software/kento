// REV-47. The GraphQL calls of GitHub that the publication of a review and of a resolve share: the
// pages of the review threads of a pull request, and the resolution of a thread.
import type { GitHub } from '../publish/github.ts'

/** A pull request, as GraphQL names it. */
export interface PullTarget {
  owner: string
  name: string
  pr: number
}

type ThreadsPage<TNode> = {
  repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: TNode[] } } }
}

/**
 * The review threads of a pull request, one page of 100 threads at a time, in the order of GitHub.
 * `nodeFields` selects the fields of a thread, and `TNode` is their type; `fragments` declares the
 * fragments that `nodeFields` uses.
 */
export async function* reviewThreadPages<TNode>(github: GitHub, target: PullTarget, nodeFields: string, fragments = ''): AsyncGenerator<TNode[]> {
  let query = `${fragments}
  query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ${nodeFields} }
        }
      }
    }
  }`
  let after: string | null = null
  for (;;) {
    let data: ThreadsPage<TNode> = await github.graphql(query, { owner: target.owner, name: target.name, number: target.pr, after })
    let page = data.repository.pullRequest.reviewThreads
    yield page.nodes
    if (!page.pageInfo.hasNextPage) return
    after = page.pageInfo.endCursor
  }
}

/** Resolves a review thread. GitHub refuses it to an App that cannot write the contents. */
export async function resolveReviewThread(github: GitHub, threadId: string): Promise<void> {
  await github.graphql('mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }', { id: threadId })
}

/** REV-99. Opens a resolved review thread again. GitHub refuses it to an App that cannot write the contents. */
export async function unresolveReviewThread(github: GitHub, threadId: string): Promise<void> {
  await github.graphql('mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id } } }', { id: threadId })
}
