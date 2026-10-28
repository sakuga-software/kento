// The open review threads of a pull request, read by the service when a runner claims a resolve job
// (REV-7). The query is the one of `resolve` in review/sakuga-review.ts. The runner gets the threads
// in the job, already cleaned: it never reads GitHub with a token that can see the pull request.
import { cleanBody, markerResolve } from '@sakuga-review/engine/threads'
import { MAX_RESOLVE_THREADS, type ResolveInput, type ResolveThread } from '@sakuga-review/protocol'

import type { TokenPermissions } from '../github/installation-token.ts'
import type { GitHub } from '../publish/github.ts'

/** Read the review threads. Nothing else. */
export const THREADS_PERMISSIONS: TokenPermissions = { pull_requests: 'read' }

// A long thread keeps its first comment and its newest ones: the reply of a resolve, with its marker,
// is among the newest.
const QUERY = `
  fragment threadComment on PullRequestReviewComment { databaseId body author { login __typename } originalCommit { oid } }
  query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id isResolved path line originalLine
            opener: comments(first: 1) { nodes { ...threadComment } }
            recent: comments(last: 29) { nodes { ...threadComment } }
          }
        }
      }
    }
  }`

type Comment = { databaseId: number; body: string; author: { login: string; __typename: string } | null; originalCommit: { oid: string } | null }
type Node = {
  id: string
  isResolved: boolean
  path: string
  line: number | null
  originalLine: number | null
  opener: { nodes: Comment[] }
  recent: { nodes: Comment[] }
}

/** GitHub caps a pull request at a few thousand threads: 50 pages is far beyond. */
const MAX_PAGES = 50

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** An open thread as GitHub gives it: the comments keep their raw body. */
export type OpenThread = {
  id: string
  path: string
  line: number | null
  comments: { id: number; author: string; isBot: boolean; body: string; commit: string | null }[]
}

/** The unresolved review threads of a pull request, of every author, in the order of GitHub. */
export async function readOpenThreads(github: GitHub, fullName: string, pr: number): Promise<OpenThread[]> {
  let [owner, name] = fullName.split('/') as [string, string]
  let open: OpenThread[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    let data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } } } } =
      await github.graphql(QUERY, { owner, name, number: pr, after })
    let threads = data.repository.pullRequest.reviewThreads
    for (let node of threads.nodes) {
      let first = node.opener.nodes[0]
      if (node.isResolved || !first) continue
      let comments = [first, ...node.recent.nodes.filter((c) => c.databaseId !== first.databaseId)]
      open.push({
        id: node.id,
        path: node.path.slice(0, 1000),
        line: node.line ?? node.originalLine ?? null,
        comments: comments.map((c) => {
          let login = c.author?.login ?? 'ghost'
          let commit = c.originalCommit?.oid ?? null
          return {
            id: c.databaseId,
            author: login.slice(0, 100),
            isBot: c.author?.__typename === 'Bot' || login.endsWith('[bot]'),
            body: c.body,
            commit: commit && SHA.test(commit) ? commit : null,
          }
        }),
      })
    }
    if (!threads.pageInfo.hasNextPage) break
    after = threads.pageInfo.endCursor
  }
  return open
}

/**
 * The input of a resolve job at `head`: the open threads that no resolve answered at this head yet,
 * the first MAX_RESOLVE_THREADS of them, with their comments cleaned as the model reads them.
 */
export async function readResolveInput(github: GitHub, fullName: string, pr: number, head: string): Promise<ResolveInput> {
  let marker = markerResolve(head)
  let open = await readOpenThreads(github, fullName, pr)
  // A thread that a resolve already answered at this head waits for a new push.
  let waiting: ResolveThread[] = open
    .filter((t) => !t.comments.some((c) => c.body.includes(marker)))
    .map((t) => ({ ...t, comments: t.comments.map((c) => ({ ...c, body: cleanBody(c.body) })) }))
  return { threads: waiting.slice(0, MAX_RESOLVE_THREADS), open: open.length, waiting: waiting.length }
}
