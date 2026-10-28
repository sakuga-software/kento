/** An error answer of the GitHub API. The message holds the method, the path and the start of the body. */
export class GitHubError extends Error {
  override name = 'GitHubError'
  readonly status: number
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} answered ${status}: ${body.slice(0, 300)}`)
    this.status = status
  }
}

/** The REST and GraphQL API of GitHub, with one installation token. */
export interface GitHub {
  rest<T = any>(method: string, path: string, payload?: unknown): Promise<T>
  graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T>
}

export function createGitHub(options: { apiUrl: string; token: string; fetch?: typeof globalThis.fetch }): GitHub {
  let apiUrl = options.apiUrl.replace(/\/+$/, '')
  let doFetch = options.fetch ?? globalThis.fetch

  async function rest(method: string, path: string, payload?: unknown) {
    let response = await doFetch(apiUrl + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'kento-web',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    })
    let text = await response.text()
    if (!response.ok) throw new GitHubError(method, path, response.status, text)
    return text ? JSON.parse(text) : null
  }

  return {
    rest,
    async graphql(query, variables) {
      let out = await rest('POST', '/graphql', { query, variables })
      if (out?.errors) throw new Error(`GraphQL: ${JSON.stringify(out.errors).slice(0, 300)}`)
      return out.data
    },
  }
}
