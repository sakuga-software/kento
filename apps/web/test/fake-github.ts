// A fake GitHub for the tests of the publisher: the REST routes and the GraphQL queries that it
// calls, on one repository, in memory. It answers through a `fetch` function, so the code under test
// runs unchanged. No network.

export const BOT = 'kento-review[bot]'

type Comment = {
  id: number
  reviewId: number | null
  path: string
  /** REV-103. Null for a comment at the level of the file. */
  line: number | null
  startLine?: number
  body: string
  commit: string
  author: string
  inReplyTo: number | null
}

type Review = { id: number; user: string; state: string; commitId: string; body: string; comments: number }

export interface FakeGitHubOptions {
  owner?: string
  name?: string
  pr?: number
  head: string
  /** The subject of each commit. */
  commits?: Record<string, string>
  /** The GitHub id of the repository. */
  repoId?: number
}

export function createFakeGitHub(options: FakeGitHubOptions) {
  let owner = options.owner ?? 'sakuga-software'
  let name = options.name ?? 'sakuga-review'
  let repo = `/repos/${owner}/${name}`
  let nextId = 1000

  let state = {
    pr: {
      number: options.pr ?? 28,
      state: 'open',
      head: options.head,
      body: 'The description of the PR.',
      labels: [] as string[],
      /** The repository of the head: another id for a fork, null for a deleted fork. */
      headRepoId: (options.repoId ?? 3001) as number | null,
      baseRef: 'main',
      /** REV-107. The author of the pull request. */
      author: { login: 'camille', type: 'User' },
    },
    /** The permission of each login on the repository, as `collaborators/:login/permission` gives it. Missing: 404. */
    permissions: new Map<string, string>(),
    /** The author of each comment of a person on the pull request, as `issues/comments/:id` gives it. Missing: 404. */
    commentAuthors: new Map<number, string>(),
    /** REV-16. The reactions of people on the review comments: comment id → `{ content, login }`. */
    reviewReactions: new Map<number, { content: string; login: string }[]>(),
    /** REV-107. The reactions of people on the comments of the pull request: comment id → reactions. */
    issueReactions: new Map<number, { id: number; content: string; login: string; type: string; created_at: string }[]>(),
    /** The reactions of the App on the comments of the pull request: `commentId:content`. */
    reactions: new Set<string>(),
    /** REV-93. The reactions of the App on the review comments (the replies of a thread): `commentId:content`. */
    reviewCommentReactions: new Set<string>(),
    /** The next comments of the pull request answer 502, as during an outage of GitHub. */
    failIssueComments: 0,
    /** REV-52. The next edits of a comment of the pull request answer 502. */
    failIssueCommentEdits: 0,
    /** REV-52. The next deletions of a comment of the pull request answer 502. */
    failIssueCommentDeletes: 0,
    /** REV-89. The next edits of the description of the pull request answer 502. */
    failPullEdits: 0,
    /** REV-89. The next lists of the reviews of the pull request answer 502. */
    failReviewLists: 0,
    /** The comments of the pull request (not of a review). */
    issueComments: [] as { id: number; body: string; author: string }[],
    reviews: [] as Review[],
    /** REV-94. The next dismissal answers 422, as when the review was dismissed meanwhile. */
    dismissRefused: false,
    /** REV-94. The next dismissals of reviews answer 502, as during an outage of GitHub. */
    failDismissals: 0,
    /** REV-94. The next lists of the review comments of the pull request answer 502. */
    failCommentLists: 0,
    /** REV-94. The dismissals of reviews, with their message. */
    dismissals: [] as { reviewId: number; message: string }[],
    comments: [] as Comment[],
    resolved: new Set<number>(),
    repoLabels: new Set<string>(),
    /** The description of each label that the App created. */
    labelDescriptions: new Map<string, string>(),
    checkRuns: [] as { name: string; head_sha: string; conclusion: string; output: { title: string; summary: string }; token: string; app?: string }[],
    commits: { ...options.commits } as Record<string, string>,
    /** `from...to` → the answer of the compare API. A missing entry answers 404, a status `error` 500. */
    compare: new Map<string, { status: string; files: (string | { filename: string; patch?: string })[] }>(),
    /** The tokens that the App can mint, by permission. A permission outside the list answers 422. */
    appPermissions: new Set(['contents', 'pull_requests', 'issues', 'checks']),
    tokens: [] as { installationId: number; repositoryIds: number[]; permissions: Record<string, string>; token: string }[],
    /** The `expires_at` of the tokens that the fake mints. */
    tokenExpiresAt: '2030-01-01T00:00:00Z',
    /** The tokens that GraphQL refuses with a 401, as for a token that GitHub revoked. */
    revokedTokens: new Set<string>(),
    /** REV-16. Runs while GitHub takes a review: what a person does meanwhile. */
    onReview: null as null | (() => Promise<void>),
    /** The review API answers 502, as during an outage of GitHub. */
    failReviews: false,
    /** The review API refuses the inline comments (a line outside the diff). */
    refuseInline: false,
    /** REV-103. The files that the pull request changes: GitHub refuses a comment on another file. Null: every file. */
    prFiles: null as Set<string> | null,
    /** The comments whose replies answer 404, as for a comment deleted on GitHub meanwhile. */
    deletedComments: new Set<number>(),
    /** GitHub refuses `resolveReviewThread` to an App without `contents: write`. */
    canResolve: false,
    /** The permissions that the App has only in read: a token that asks to write them answers 422. */
    readOnly: new Set<string>(),
    /** `resolveReviewThread` asks for a token minted with `contents: write`, as GitHub does. */
    resolveNeedsWrite: false,
    /** GitHub gives the `originalCommit` of a review comment only to a token that can read the contents. */
    commitNeedsContents: true,
    calls: [] as { method: string; path: string; token: string }[],
    /** The body of each request that writes, as JSON: what the bot posts on GitHub. */
    sent: [] as string[],
  }

  /** A comment of a person or of the bot, as an earlier review left it. */
  function addThread(input: { path: string; line: number; body: string; commit: string; author?: string }): number {
    let id = nextId++
    state.comments.push({ id, reviewId: null, author: input.author ?? BOT, inReplyTo: null, ...input })
    return id
  }

  function threadsOf() {
    let tops = state.comments.filter((c) => c.inReplyTo === null)
    return tops.map((top) => ({
      id: `PRRT_${top.id}`,
      isResolved: state.resolved.has(top.id),
      path: top.path,
      line: top.line,
      comments: {
        nodes: [top, ...state.comments.filter((c) => c.inReplyTo === top.id)].map((c) => ({
          databaseId: c.id,
          body: c.body,
          // GraphQL names an App without `[bot]`.
          author: { login: c.author.replace(/\[bot\]$/, '') },
          commit: { oid: c.commit },
        })),
      },
    }))
  }

  let json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status })

  let reactionIds = new Map<string, number>()

  async function handle(method: string, url: URL, body: any, token: string): Promise<Response> {
    let path = url.pathname
    state.calls.push({ method, path: path + url.search, token })
    if (method !== 'GET' && body !== undefined && body !== null) state.sent.push(JSON.stringify(body))
    let m: RegExpExecArray | null

    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === 'POST') {
      let permissions: Record<string, string> = body.permissions
      for (let key of Object.keys(permissions)) {
        if (!state.appPermissions.has(key) || (permissions[key] === 'write' && state.readOnly.has(key))) {
          return json(422, { message: `The permissions requested are not granted to this installation.` })
        }
      }
      let issued = `ghs_fake_${Object.keys(permissions).sort().join('_')}_${nextId++}`
      state.tokens.push({ installationId: Number(m[1]), repositoryIds: body.repository_ids, permissions, token: issued })
      return json(201, { token: issued, expires_at: state.tokenExpiresAt })
    }

    if (path === '/graphql') {
      if (state.revokedTokens.has(token)) return json(401, { message: 'Bad credentials' })
      if (body.query.includes('unresolveReviewThread')) {
        let minted = state.tokens.find((t) => t.token === token)
        if (!state.canResolve || (state.resolveNeedsWrite && minted?.permissions.contents !== 'write')) {
          return json(200, { errors: [{ message: 'Resource not accessible by integration' }] })
        }
        state.resolved.delete(Number(String(body.variables.id).replace('PRRT_', '')))
        return json(200, { data: { unresolveReviewThread: { thread: { id: body.variables.id } } } })
      }
      if (body.query.includes('resolveReviewThread')) {
        let minted = state.tokens.find((t) => t.token === token)
        if (!state.canResolve || (state.resolveNeedsWrite && minted?.permissions.contents !== 'write')) {
          return json(200, { errors: [{ message: 'Resource not accessible by integration' }] })
        }
        state.resolved.add(Number(String(body.variables.id).replace('PRRT_', '')))
        return json(200, { data: { resolveReviewThread: { thread: { id: body.variables.id } } } })
      }
      if (body.query.includes('opener:')) {
        let minted = state.tokens.find((t) => t.token === token)
        if (state.commitNeedsContents && minted && !minted.permissions.contents) {
          return json(200, { errors: [{ type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'reviewThreads', 'nodes', 0, 'opener', 'nodes', 0, 'originalCommit'], message: 'Resource not accessible by integration' }] })
        }
        // The query of a resolve: the first comment and the newest ones, with the type of the author.
        let nodes = threadsOf().map((t) => {
          let comments = t.comments.nodes.map((c) => {
            let author = state.comments.find((x) => x.id === c.databaseId)!.author
            return {
              databaseId: c.databaseId,
              body: c.body,
              author: { login: c.author.login, __typename: author.endsWith('[bot]') ? 'Bot' : 'User' },
              originalCommit: c.commit,
            }
          })
          return { id: t.id, isResolved: t.isResolved, path: t.path, line: t.line, originalLine: t.line, opener: { nodes: comments.slice(0, 1) }, recent: { nodes: comments.slice(-29) } }
        })
        return json(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } })
      }
      return json(200, {
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threadsOf() } } } },
      })
    }

    if (!path.startsWith(repo)) return json(404, { message: 'Not Found' })
    let rest = path.slice(repo.length)
    let prPath = `/pulls/${state.pr.number}`

    if (rest === prPath && method === 'GET') {
      return json(200, {
        number: state.pr.number,
        state: state.pr.state,
        head: { sha: state.pr.head, repo: state.pr.headRepoId === null ? null : { id: state.pr.headRepoId } },
        base: { ref: state.pr.baseRef },
        body: state.pr.body,
        user: state.pr.author,
      })
    }
    if ((m = /^\/collaborators\/([^/]+)\/permission$/.exec(rest)) && method === 'GET') {
      let permission = state.permissions.get(decodeURIComponent(m[1]!))
      return permission === undefined
        ? json(404, { message: 'Not Found' })
        : json(200, { permission: permission === 'maintain' ? 'write' : permission === 'triage' ? 'read' : permission, role_name: permission })
    }
    if ((m = /^\/issues\/comments\/(\d+)$/.exec(rest)) && method === 'GET') {
      let author = state.commentAuthors.get(Number(m[1]))
      return author === undefined ? json(404, { message: 'Not Found' }) : json(200, { id: Number(m[1]), user: { login: author } })
    }
    if ((m = /^\/issues\/comments\/(\d+)\/reactions$/.exec(rest)) && method === 'GET') {
      let perPage = Number(url.searchParams.get('per_page') ?? 30)
      let page = Number(url.searchParams.get('page') ?? 1)
      let list = (state.issueReactions.get(Number(m[1])) ?? []).slice((page - 1) * perPage, page * perPage)
      return json(200, list.map((r) => ({ id: r.id, content: r.content, created_at: r.created_at, user: { login: r.login, type: r.type } })))
    }
    if ((m = /^\/issues\/comments\/(\d+)\/reactions$/.exec(rest)) && method === 'POST') {
      if (!token.includes('issues')) return json(403, { message: 'Resource not accessible by integration' })
      let key = `${m[1]}:${body.content}`
      let id = reactionIds.get(key) ?? nextId++
      reactionIds.set(key, id)
      if (state.reactions.has(key)) return json(200, { id, content: body.content })
      state.reactions.add(key)
      return json(201, { id, content: body.content })
    }
    if ((m = /^\/issues\/comments\/(\d+)\/reactions\/(\d+)$/.exec(rest)) && method === 'DELETE') {
      let key = [...reactionIds].find(([k, id]) => k.startsWith(`${m![1]}:`) && id === Number(m![2]))?.[0]
      if (!key || !state.reactions.has(key)) return json(404, { message: 'Not Found' })
      state.reactions.delete(key)
      return json(204, null)
    }
    if (rest === `/issues/${state.pr.number}/comments` && method === 'GET') {
      let perPage = Number(url.searchParams.get('per_page') ?? 30)
      let page = Number(url.searchParams.get('page') ?? 1)
      let list = state.issueComments.slice((page - 1) * perPage, page * perPage)
      return json(200, list.map((c) => ({ id: c.id, body: c.body, user: { login: c.author } })))
    }
    if ((m = /^\/issues\/comments\/(\d+)$/.exec(rest)) && method === 'DELETE') {
      if (!token.includes('issues')) return json(403, { message: 'Resource not accessible by integration' })
      if (state.failIssueCommentDeletes > 0) {
        state.failIssueCommentDeletes--
        return json(502, { message: 'Bad Gateway' })
      }
      let index = state.issueComments.findIndex((c) => c.id === Number(m![1]))
      if (index < 0) return json(404, { message: 'Not Found' })
      state.issueComments.splice(index, 1)
      return json(204, null)
    }
    if ((m = /^\/issues\/comments\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      if (!token.includes('issues')) return json(403, { message: 'Resource not accessible by integration' })
      if (state.failIssueCommentEdits > 0) {
        state.failIssueCommentEdits--
        return json(502, { message: 'Bad Gateway' })
      }
      let comment = state.issueComments.find((c) => c.id === Number(m![1]))
      if (!comment) return json(404, { message: 'Not Found' })
      comment.body = body.body
      return json(200, { id: comment.id })
    }
    if (rest === `/issues/${state.pr.number}/comments` && method === 'POST') {
      if (!token.includes('issues')) return json(403, { message: 'Resource not accessible by integration' })
      if (state.failIssueComments > 0) {
        state.failIssueComments--
        return json(502, { message: 'Bad Gateway' })
      }
      let id = nextId++
      state.issueComments.push({ id, body: body.body, author: BOT })
      return json(201, { id })
    }
    if (rest === prPath && method === 'PATCH') {
      if (state.failPullEdits > 0) {
        state.failPullEdits--
        return json(502, { message: 'Bad Gateway' })
      }
      state.pr.body = body.body
      return json(200, {})
    }
    if ((m = /^\/pulls\/comments\/(\d+)\/reactions$/.exec(rest)) && method === 'POST') {
      if (!token.includes('pull_requests')) return json(403, { message: 'Resource not accessible by integration' })
      let key = `${m[1]}:${body.content}`
      let id = reactionIds.get(`review:${key}`) ?? nextId++
      reactionIds.set(`review:${key}`, id)
      if (state.reviewCommentReactions.has(key)) return json(200, { id, content: body.content })
      state.reviewCommentReactions.add(key)
      return json(201, { id, content: body.content })
    }
    if ((m = /^\/pulls\/comments\/(\d+)\/reactions\/(\d+)$/.exec(rest)) && method === 'DELETE') {
      let key = [...reactionIds].find(([k, id]) => k.startsWith(`review:${m![1]}:`) && id === Number(m![2]))?.[0]?.slice('review:'.length)
      if (!key || !state.reviewCommentReactions.has(key)) return json(404, { message: 'Not Found' })
      state.reviewCommentReactions.delete(key)
      return json(204, null)
    }
    if ((m = /^\/pulls\/comments\/(\d+)\/reactions$/.exec(rest)) && method === 'GET') {
      let id = Number(m[1])
      if (!state.comments.some((c) => c.id === id) || state.deletedComments.has(id)) return json(404, { message: 'Not Found' })
      let content = url.searchParams.get('content')
      return json(
        200,
        (state.reviewReactions.get(id) ?? [])
          .filter((r) => !content || r.content === content)
          .map((r) => ({ content: r.content, user: { login: r.login, type: r.login.endsWith('[bot]') ? 'Bot' : 'User' } })),
      )
    }
    if (rest === `${prPath}/comments` && method === 'GET') {
      if (state.failCommentLists > 0) {
        state.failCommentLists--
        return json(502, { message: 'Bad Gateway' })
      }
      let perPage = Number(url.searchParams.get('per_page') ?? 30)
      let page = Number(url.searchParams.get('page') ?? 1)
      let list = state.comments.slice((page - 1) * perPage, page * perPage)
      return json(200, list.map((c) => ({ id: c.id, body: c.body, path: c.path, line: c.line, in_reply_to_id: c.inReplyTo ?? undefined, user: { login: c.author } })))
    }
    if (rest === `${prPath}/comments` && method === 'POST') {
      // REV-103. Only a comment at the level of the file: the publisher posts a line in a review.
      if (body.subject_type !== 'file' || !body.commit_id) return json(422, { message: 'fake GitHub: only a file comment' })
      if (state.prFiles && !state.prFiles.has(body.path)) return json(422, { message: 'Path could not be resolved' })
      let id = nextId++
      state.comments.push({ id, reviewId: null, path: body.path, line: null, body: body.body, commit: body.commit_id, author: BOT, inReplyTo: null })
      return json(201, { id })
    }
    if ((m = /^\/pulls\/\d+\/comments\/(\d+)\/replies$/.exec(rest)) && method === 'POST') {
      let parent = state.comments.find((c) => c.id === Number(m![1]))
      if (!parent || state.deletedComments.has(parent.id)) return json(404, { message: 'Not Found' })
      let id = nextId++
      state.comments.push({ id, reviewId: null, path: parent.path, line: parent.line, body: body.body, commit: state.pr.head, author: BOT, inReplyTo: parent.id })
      return json(201, { id })
    }
    if (rest === `${prPath}/reviews` && method === 'POST') {
      if (state.failReviews) return json(502, { message: 'Bad Gateway' })
      if (body.comments.length && state.refuseInline) return json(422, { message: 'Line could not be resolved' })
      if (state.onReview) await state.onReview()
      let id = nextId++
      let reviewState = { REQUEST_CHANGES: 'CHANGES_REQUESTED', APPROVE: 'APPROVED', COMMENT: 'COMMENTED' }[body.event as string]!
      state.reviews.push({ id, user: BOT, state: reviewState, commitId: body.commit_id, body: body.body, comments: body.comments.length })
      for (let c of body.comments) {
        state.comments.push({
          id: nextId++,
          reviewId: id,
          path: c.path,
          line: c.line,
          startLine: c.start_line,
          body: c.body,
          commit: body.commit_id,
          author: BOT,
          inReplyTo: null,
        })
      }
      return json(200, { id, state: reviewState })
    }
    if (rest === `${prPath}/reviews` && method === 'GET') {
      if (state.failReviewLists > 0) {
        state.failReviewLists--
        return json(502, { message: 'Bad Gateway' })
      }
      // GitHub pages the list: 30 per page by default, 100 at most.
      let perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100)
      let page = Number(url.searchParams.get('page') ?? 1)
      return json(
        200,
        state.reviews
          .slice((page - 1) * perPage, page * perPage)
          .map((r) => ({ id: r.id, state: r.state, user: { login: r.user }, body: r.body, commit_id: r.commitId })),
      )
    }
    if ((m = /^\/pulls\/\d+\/reviews\/(\d+)\/dismissals$/.exec(rest)) && method === 'PUT') {
      let review = state.reviews.find((r) => r.id === Number(m![1]))
      if (!review) return json(404, { message: 'Not Found' })
      // GitHub refuses to dismiss a review that is not a CHANGES_REQUESTED or an APPROVED any more.
      if (state.dismissRefused) return json(422, { message: 'Can not dismiss a dismissed pull request review' })
      if (state.failDismissals > 0) {
        state.failDismissals--
        return json(502, { message: 'Bad Gateway' })
      }
      review.state = 'DISMISSED'
      state.dismissals.push({ reviewId: review.id, message: body?.message ?? '' })
      return json(200, {})
    }
    if ((m = /^\/pulls\/\d+\/reviews\/(\d+)\/comments$/.exec(rest)) && method === 'GET') {
      return json(200, state.comments.filter((c) => c.reviewId === Number(m![1])).map((c) => ({ id: c.id, body: c.body, path: c.path, line: c.line })))
    }
    if ((m = /^\/commits\/([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
      let subject = state.commits[m[1]!]
      return subject === undefined ? json(404, { message: 'No commit found' }) : json(200, { sha: m[1], commit: { message: `${subject}\n\nBody.` } })
    }
    if ((m = /^\/compare\/([0-9a-f]+\.\.\.[0-9a-f]+)$/.exec(rest)) && method === 'GET') {
      let out = state.compare.get(m[1]!)
      if (out?.status === 'error') return json(500, { message: 'Server Error' })
      return out ? json(200, { status: out.status, files: out.files.map((f) => (typeof f === 'string' ? { filename: f } : f)) }) : json(404, { message: 'Not Found' })
    }
    if ((m = /^\/labels\/(.+)$/.exec(rest)) && method === 'GET') {
      let label = decodeURIComponent(m[1]!)
      return state.repoLabels.has(label) ? json(200, { name: label, description: state.labelDescriptions.get(label) ?? '' }) : json(404, { message: 'Not Found' })
    }
    if ((m = /^\/labels\/(.+)$/.exec(rest)) && method === 'PATCH') {
      let label = decodeURIComponent(m[1]!)
      if (!state.repoLabels.has(label)) return json(404, { message: 'Not Found' })
      if (body.description !== undefined) state.labelDescriptions.set(label, body.description)
      return json(200, { name: label, description: state.labelDescriptions.get(label) ?? '' })
    }
    if (rest === '/labels' && method === 'POST') {
      state.repoLabels.add(body.name)
      state.labelDescriptions.set(body.name, body.description ?? '')
      return json(201, { name: body.name })
    }
    if (rest === `/issues/${state.pr.number}/labels` && method === 'GET') {
      return json(200, state.pr.labels.map((label) => ({ name: label })))
    }
    if (rest === `/issues/${state.pr.number}/labels` && method === 'POST') {
      for (let label of body.labels) if (!state.pr.labels.includes(label)) state.pr.labels.push(label)
      return json(200, state.pr.labels.map((label) => ({ name: label })))
    }
    if ((m = /^\/issues\/\d+\/labels\/(.+)$/.exec(rest)) && method === 'DELETE') {
      let label = decodeURIComponent(m[1]!)
      state.pr.labels = state.pr.labels.filter((l) => l !== label)
      return json(200, [])
    }
    if ((m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest)) && method === 'GET') {
      let name = url.searchParams.get('check_name')
      let runs = state.checkRuns.filter((c) => c.head_sha === m![1] && (name === null || c.name === name))
      // A check posted with an installation token is of the App; one added by a test names its own.
      return json(200, { check_runs: runs.map((c) => ({ ...c, app: { slug: c.app ?? BOT.replace(/\[bot\]$/, '') } })) })
    }
    if (rest === '/check-runs' && method === 'POST') {
      if (!token.includes('checks')) return json(403, { message: 'Resource not accessible by integration' })
      state.checkRuns.push({ ...body, token })
      return json(201, { id: nextId++ })
    }
    return json(404, { message: `fake GitHub: no route for ${method} ${path}` })
  }

  let fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = new URL(String(input instanceof Request ? input.url : input))
    let method = init.method ?? 'GET'
    let body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined
    let headers = new Headers(init.headers)
    let token = (headers.get('Authorization') ?? '').replace(/^Bearer /, '')
    return handle(method, url, body, token)
  }) as typeof globalThis.fetch

  /** A review that an earlier run left on the pull request. */
  function addReview(input: { user?: string; state: string; commitId?: string }): number {
    let id = nextId++
    state.reviews.push({ id, user: input.user ?? BOT, state: input.state, commitId: input.commitId ?? options.head, body: 'Earlier review.', comments: 0 })
    return id
  }

  return {
    apiUrl: 'https://api.github.test',
    addReview,
    fetch,
    state,
    addThread,
    /** A person puts a reaction on a review comment (`-1` is 👎). */
    react: (commentId: number, login: string, content = '-1') =>
      state.reviewReactions.set(commentId, [...(state.reviewReactions.get(commentId) ?? []), { content, login }]),
    /** The bot comments that start a thread. */
    botThreads: () => state.comments.filter((c) => c.inReplyTo === null && c.author === BOT),
    repliesTo: (id: number) => state.comments.filter((c) => c.inReplyTo === id),
  }
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>
