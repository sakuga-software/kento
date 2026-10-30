// A fake GitHub for the tests of the publisher: the REST routes and the GraphQL queries that it
// calls, on one repository, in memory. It answers through a `fetch` function, so the code under test
// runs unchanged. No network.

export const BOT = 'kento-review[bot]'

type Comment = {
  id: number
  reviewId: number | null
  path: string
  line: number
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
      body: 'Description de la PR.',
      labels: [] as string[],
      /** The repository of the head: another id for a fork, null for a deleted fork. */
      headRepoId: (options.repoId ?? 3001) as number | null,
      baseRef: 'main',
    },
    /** The permission of each login on the repository, as `collaborators/:login/permission` gives it. Missing: 404. */
    permissions: new Map<string, string>(),
    /** The author of each comment of a person on the pull request, as `issues/comments/:id` gives it. Missing: 404. */
    commentAuthors: new Map<number, string>(),
    /** The reactions of the App on the comments of the pull request: `commentId:content`. */
    reactions: new Set<string>(),
    /** The next comments of the pull request answer 502, as during an outage of GitHub. */
    failIssueComments: 0,
    /** The comments of the pull request (not of a review). */
    issueComments: [] as { id: number; body: string; author: string }[],
    reviews: [] as Review[],
    comments: [] as Comment[],
    resolved: new Set<number>(),
    repoLabels: new Set<string>(),
    checkRuns: [] as { name: string; head_sha: string; conclusion: string; output: { title: string; summary: string }; token: string }[],
    commits: { ...options.commits } as Record<string, string>,
    /** `from...to` → the answer of the compare API. A missing entry answers 404, a status `error` 500. */
    compare: new Map<string, { status: string; files: string[] }>(),
    /** The tokens that the App can mint, by permission. A permission outside the list answers 422. */
    appPermissions: new Set(['contents', 'pull_requests', 'issues', 'checks']),
    tokens: [] as { installationId: number; repositoryIds: number[]; permissions: Record<string, string>; token: string }[],
    /** REV-16. Runs while GitHub takes a review: what a person does meanwhile. */
    onReview: null as null | (() => Promise<void>),
    /** The review API answers 502, as during an outage of GitHub. */
    failReviews: false,
    /** The review API refuses the inline comments (a line outside the diff). */
    refuseInline: false,
    /** The comments whose replies answer 404, as for a comment deleted on GitHub meanwhile. */
    deletedComments: new Set<number>(),
    /** GitHub refuses `resolveReviewThread` to an App without `contents: write`. */
    canResolve: false,
    /** The permissions that the App has only in read: a token that asks to write them answers 422. */
    readOnly: new Set<string>(),
    /** `resolveReviewThread` asks for a token minted with `contents: write`, as GitHub does. */
    resolveNeedsWrite: false,
    calls: [] as { method: string; path: string; token: string }[],
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
      return json(201, { token: issued, expires_at: '2030-01-01T00:00:00Z' })
    }

    if (path === '/graphql') {
      if (body.query.includes('resolveReviewThread')) {
        let minted = state.tokens.find((t) => t.token === token)
        if (!state.canResolve || (state.resolveNeedsWrite && minted?.permissions.contents !== 'write')) {
          return json(200, { errors: [{ message: 'Resource not accessible by integration' }] })
        }
        state.resolved.add(Number(String(body.variables.id).replace('PRRT_', '')))
        return json(200, { data: { resolveReviewThread: { thread: { id: body.variables.id } } } })
      }
      if (body.query.includes('opener:')) {
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
      state.pr.body = body.body
      return json(200, {})
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
      review.state = 'DISMISSED'
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
      return out ? json(200, { status: out.status, files: out.files.map((filename) => ({ filename })) }) : json(404, { message: 'Not Found' })
    }
    if ((m = /^\/labels\/(.+)$/.exec(rest)) && method === 'GET') {
      let label = decodeURIComponent(m[1]!)
      return state.repoLabels.has(label) ? json(200, { name: label }) : json(404, { message: 'Not Found' })
    }
    if (rest === '/labels' && method === 'POST') {
      state.repoLabels.add(body.name)
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
    /** The bot comments that start a thread. */
    botThreads: () => state.comments.filter((c) => c.inReplyTo === null && c.author === BOT),
    repliesTo: (id: number) => state.comments.filter((c) => c.inReplyTo === id),
  }
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>
