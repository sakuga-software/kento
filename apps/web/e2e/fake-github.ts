// A fake GitHub for the tests in a browser: the OAuth pages of a GitHub App, `/user`, the
// installation tokens and the memberships of one org. Never used outside of the tests.
//
//   node --import remix/node-tsx e2e/fake-github.ts   (FAKE_GITHUB_PORT, 3499 by default)
import { createHash } from 'node:crypto'
import * as http from 'node:http'

export const FAKE_ORG = { installationId: 4242, accountId: 9000, login: 'sakuga-software' }

/**
 * KNT-150. A second account with the App, where GitHub counts nobody: its members come from an
 * invitation in Kentō (e2e/orgs.spec.ts).
 */
export const SECOND_ORG = { installationId: 9150, accountId: 9151, login: 'globex' }

/** The webhook secret of the server of the tests: e2e/config.spec.ts signs its events with it. */
export const E2E_WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789abcdef'

/** The accounts of the fake, and their role in the org: `null` is not a member. */
export const ACCOUNTS: Record<string, { id: number; name: string; role: 'admin' | 'member' | null }> = {
  octocat: { id: 101, name: 'Alex Martin', role: 'admin' },
  camille: { id: 102, name: 'Camille', role: 'member' },
  stranger: { id: 103, name: 'Someone Else', role: null },
  // KNT-150: counted nowhere on GitHub, and invited in Kentō by the tests of the members.
  visitor: { id: 104, name: 'Visitor', role: null },
}

/** A repository name of 80 characters (REV-25). */
export const LONG_REPO_NAME = 'sakuga-review-very-long-repository-name-for-monorepo-tooling-and-shared-settings'

/** The repositories of the installation, for the check of the Repos screen. */
export const FAKE_REPOS = [
  { id: 7001, full_name: 'sakuga-software/orchard', private: true, default_branch: 'main' },
  { id: 7002, full_name: 'sakuga-software/fruitback', private: false, default_branch: 'main' },
  { id: 7003, full_name: 'sakuga-software/garden', private: true, default_branch: 'main' },
  // REV-25: a name of 80 characters, for the width of the Repos table.
  { id: 7004, full_name: `sakuga-software/${LONG_REPO_NAME}`, private: true, default_branch: 'main' },
]

/** The workflow files of each repository: orchard calls review.yml@stable, fruitback holds a copy. */
const WORKFLOWS: Record<string, Record<string, string>> = {
  'sakuga-software/orchard': {
    'sakuga-review.yml': 'on: pull_request\njobs:\n  review:\n    uses: sakuga-software/sakuga-review/.github/workflows/review.yml@stable\n',
    'ci.yml': 'on: push\njobs: {}\n',
  },
  'sakuga-software/fruitback': {
    'sakuga-review.yml': 'on: pull_request\njobs:\n  r:\n    steps:\n      - run: node review/sakuga-review.ts\n',
  },
}

/** The open pull requests that a retry of the dashboard reads (e2e/dashboard.spec.ts): `owner/name#number` → head. */
export const FAKE_PULLS: Record<string, string> = {
  'sakuga-software/dash-e2e#41': 'c'.repeat(40),
  'sakuga-software/orchard#142': 'd'.repeat(40),
  // REV-21: a pull request of a person that touches a migration.
  'sakuga-software/orchard#43': 'a43'.padStart(40, '0'),
}

/** REV-21. The files that a pull request changes, for the paths of the config and of the assignment rules. */
const FAKE_PULL_FILES: Record<string, string[]> = {
  'sakuga-software/orchard#42': ['src/agent.ts'],
  'sakuga-software/orchard#43': ['src/sessions.ts', 'db/migrations/0007_sessions.sql'],
  'sakuga-software/orchard#44': ['README.md'],
}

/** REV-17. The title, the author and the branches of a pull request, for the header of its screen. */
const FAKE_PULL_DETAILS: Record<string, { title: string; user: { login: string }; head: { ref: string } }> = {
  'sakuga-software/orchard#142': { title: 'Sessions: expiry and rotation of the keys', user: { login: 'camille' }, head: { ref: 'feat/session-expiry' } },
  'sakuga-software/orchard#43': { title: 'Sessions: table and index', user: { login: 'camille' }, head: { ref: 'feat/sessions-table' } },
}

/** Lines of the files of orchard, by number, for the code of a finding (REV-17). */
const FAKE_SOURCE: Record<number, string> = {
  44: 'export function createSession(user: User) {',
  45: '  let token = sign({ sub: user.id })',
  46: '  sessions.set(token, user)',
  47: "  return { token, expiresAt: null } // no expiry",
  48: '}',
}

let codes = new Map<string, { login: string; challenge: string; redirectUri: string }>()

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  let chunks: Buffer[] = []
  for await (let chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString()
}

let checkRuns: object[] = []
/** REV-18. The replies posted in the threads of findings, oldest first. */
const replies: { repo: string; pr: number; commentId: number; body: string }[] = []

let server = http.createServer(async (request, response) => {
  let url = new URL(request.url ?? '/', 'http://fake-github')
  if (url.pathname === '/healthz') return json(response, 200, { ok: true })

  if (request.method === 'GET' && url.pathname === '/login/oauth/authorize') {
    let redirectUri = url.searchParams.get('redirect_uri') ?? ''
    let state = url.searchParams.get('state') ?? ''
    let challenge = url.searchParams.get('code_challenge') ?? ''
    let links = Object.keys(ACCOUNTS)
      .map((login) => {
        let code = `code-${login}-${Math.random().toString(36).slice(2)}`
        codes.set(code, { login, challenge, redirectUri })
        let back = new URL(redirectUri)
        back.searchParams.set('code', code)
        back.searchParams.set('state', state)
        return `<li><a href="${back.href}">Authorize as ${login}</a></li>`
      })
      .join('')
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!DOCTYPE html><html lang="en"><title>Fake GitHub</title><main><h1>Fake GitHub</h1><ul>${links}</ul></main></html>`)
    return
  }

  if (request.method === 'POST' && url.pathname === '/login/oauth/access_token') {
    let body = JSON.parse(await readBody(request)) as { code: string; code_verifier: string; redirect_uri: string; client_secret: string }
    let entry = codes.get(body.code)
    codes.delete(body.code)
    let challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url')
    if (!entry || entry.challenge !== challenge || entry.redirectUri !== body.redirect_uri || body.client_secret !== 'e2e-client-secret') {
      return json(response, 200, { error: 'bad_verification_code' })
    }
    return json(response, 200, { access_token: `ghu_${entry.login}`, token_type: 'bearer' })
  }

  // KNT-150: the account of a login, for an invitation.
  let user = /^\/users\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'GET' && user) {
    let login = decodeURIComponent(user[1]!).toLowerCase()
    let account = ACCOUNTS[login]
    return account ? json(response, 200, { id: account.id, login, type: 'User' }) : json(response, 404, { message: 'Not Found' })
  }

  if (request.method === 'GET' && url.pathname === '/user') {
    let login = (request.headers.authorization ?? '').replace('Bearer ghu_', '')
    let account = ACCOUNTS[login]
    if (!account) return json(response, 401, { message: 'Bad credentials' })
    return json(response, 200, { id: account.id, login, name: account.name, avatar_url: null })
  }

  if (request.method === 'POST' && url.pathname === `/app/installations/${FAKE_ORG.installationId}/access_tokens`) {
    return json(response, 201, { token: 'ghs_members', expires_at: new Date(Date.now() + 3600_000).toISOString() })
  }
  if (request.method === 'POST' && url.pathname === `/app/installations/${SECOND_ORG.installationId}/access_tokens`) {
    return json(response, 201, { token: 'ghs_second', expires_at: new Date(Date.now() + 3600_000).toISOString() })
  }

  if (request.method === 'GET' && url.pathname === '/installation/repositories') {
    if (request.headers.authorization !== 'Bearer ghs_members') return json(response, 401, { message: 'Bad credentials' })
    return json(response, 200, { total_count: FAKE_REPOS.length, repositories: FAKE_REPOS })
  }

  let contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/\.github\/workflows(?:\/([^/]+))?$/.exec(url.pathname)
  if (request.method === 'GET' && contents) {
    let files = WORKFLOWS[contents[1]!]
    if (!files) return json(response, 404, { message: 'Not Found' })
    if (!contents[2]) {
      return json(
        response,
        200,
        Object.keys(files).map((name) => ({ type: 'file', name, path: `.github/workflows/${name}` })),
      )
    }
    let text = files[contents[2]]
    if (text === undefined) return json(response, 404, { message: 'Not Found' })
    return json(response, 200, { encoding: 'base64', content: Buffer.from(text).toString('base64') })
  }

  // REV-17: a file of orchard at any commit, for the code of a finding. Line N reads `// line N`,
  // with the code of orchard #142 around its findings.
  let source = /^\/repos\/sakuga-software\/orchard\/contents\/(src\/.+)$/.exec(url.pathname)
  if (request.method === 'GET' && source) {
    if (request.headers.authorization !== 'Bearer ghs_members') return json(response, 401, { message: 'Bad credentials' })
    let lines = Array.from({ length: 120 }, (_, i) => FAKE_SOURCE[i + 1] ?? `// line ${i + 1}`)
    return json(response, 200, { encoding: 'base64', content: Buffer.from(lines.join('\n')).toString('base64') })
  }

  let pullFiles = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/.exec(url.pathname)
  if (request.method === 'GET' && pullFiles) {
    if (request.headers.authorization !== 'Bearer ghs_members') return json(response, 401, { message: 'Bad credentials' })
    let known = FAKE_PULL_FILES[`${pullFiles[1]}#${pullFiles[2]}`]
    // Another pull request: as before REV-21, GitHub does not answer, and the paths filter nothing.
    if (!known) return json(response, 404, { message: 'Not Found' })
    // One page: the service stops when a page holds fewer files than it asked for.
    let names = url.searchParams.get('page') === '1' ? known : []
    return json(response, 200, names.map((filename) => ({ filename, status: 'modified' })))
  }

  let pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url.pathname)
  if (request.method === 'GET' && pull) {
    if (request.headers.authorization !== 'Bearer ghs_members') return json(response, 401, { message: 'Bad credentials' })
    let head = FAKE_PULLS[`${pull[1]}#${pull[2]}`]
    if (!head) return json(response, 404, { message: 'Not Found' })
    let details = FAKE_PULL_DETAILS[`${pull[1]}#${pull[2]}`]
    return json(response, 200, {
      number: Number(pull[2]),
      state: 'open',
      ...details,
      head: { sha: head, ...details?.head },
      base: { ref: 'main' },
    })
  }
  // REV-13: the App and its installation, read with the JWT of the App by the settings screen.
  if (request.method === 'GET' && url.pathname === '/app') {
    return json(response, 200, { slug: 'kento-review', name: 'Kentō Review', html_url: 'https://github.com/apps/kento-review', owner: { login: FAKE_ORG.login, type: 'Organization' } })
  }
  if (request.method === 'GET' && url.pathname === `/app/installations/${FAKE_ORG.installationId}`) {
    return json(response, 200, {
      permissions: { contents: 'read', pull_requests: 'write', issues: 'write', checks: 'write', members: 'read', metadata: 'read' },
      events: ['pull_request', 'issue_comment'],
      repository_selection: 'all',
      suspended_at: null,
      html_url: `https://github.com/organizations/${FAKE_ORG.login}/settings/installations/${FAKE_ORG.installationId}`,
      account: { id: FAKE_ORG.accountId, login: FAKE_ORG.login, type: 'Organization' },
    })
  }
  // KNT-150: the type of the account of the second installation, for the move of an installation.
  if (request.method === 'GET' && url.pathname === `/app/installations/${SECOND_ORG.installationId}`) {
    return json(response, 200, { id: SECOND_ORG.installationId, suspended_at: null, account: { id: SECOND_ORG.accountId, login: SECOND_ORG.login, type: 'Organization' } })
  }
  if (request.method === 'GET' && url.pathname === '/app/hook/config') {
    return json(response, 200, { url: `${process.env.KENTO_URL ?? 'http://127.0.0.1:3488'}/webhooks/github`, content_type: 'json', insecure_ssl: '0' })
  }
  // The check runs that the service posts ("Kentō · cap"), and a route for the tests to read them.
  let checkRun = /^\/repos\/([^/]+\/[^/]+)\/check-runs$/.exec(url.pathname)
  if (request.method === 'POST' && checkRun) {
    checkRuns.push({ repo: checkRun[1]!, ...(JSON.parse(await readBody(request)) as object) })
    return json(response, 201, { id: checkRuns.length })
  }
  if (request.method === 'GET' && url.pathname === '/_test/check-runs') return json(response, 200, checkRuns)
  // REV-18: the replies in the threads of findings ("Mark dismissed"), and a route for the tests to read them.
  let reply = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(url.pathname)
  if (request.method === 'POST' && reply) {
    if (request.headers.authorization !== 'Bearer ghs_members') return json(response, 401, { message: 'Bad credentials' })
    let { body } = JSON.parse(await readBody(request)) as { body: string }
    replies.push({ repo: reply[1]!, pr: Number(reply[2]), commentId: Number(reply[3]), body })
    return json(response, 201, { id: 5_000_000 + replies.length })
  }
  if (request.method === 'GET' && url.pathname === '/_test/replies') return json(response, 200, replies)

  let membership = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'GET' && membership) {
    if (request.headers.authorization === 'Bearer ghs_second' && membership[1] === SECOND_ORG.login) {
      return json(response, 404, { message: 'Not Found' })
    }
    if (request.headers.authorization !== 'Bearer ghs_members' || membership[1] !== FAKE_ORG.login) {
      return json(response, 403, { message: 'Forbidden' })
    }
    let role = ACCOUNTS[membership[2]!]?.role
    if (!role) return json(response, 404, { message: 'Not Found' })
    return json(response, 200, { state: 'active', role })
  }

  json(response, 404, { message: 'Not Found' })
})

if (process.argv[1]?.endsWith('fake-github.ts')) {
  let port = Number(process.env.FAKE_GITHUB_PORT ?? 3499)
  server.listen(port, '127.0.0.1', () => console.log(`fake GitHub on http://127.0.0.1:${port}`))
}
