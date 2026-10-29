// A fake GitHub for the tests in a browser: the OAuth pages of a GitHub App, `/user`, the
// installation tokens and the memberships of one org. Never used outside of the tests.
//
//   node --import remix/node-tsx e2e/fake-github.ts   (FAKE_GITHUB_PORT, 3499 by default)
import { createHash } from 'node:crypto'
import * as http from 'node:http'

export const FAKE_ORG = { installationId: 4242, accountId: 9000, login: 'sakuga-software' }

/** The accounts of the fake, and their role in the org: `null` is not a member. */
export const ACCOUNTS: Record<string, { id: number; name: string; role: 'admin' | 'member' | null }> = {
  alex: { id: 101, name: 'Alex Martin', role: 'admin' },
  camille: { id: 102, name: 'Camille', role: 'member' },
  stranger: { id: 103, name: 'Someone Else', role: null },
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

  if (request.method === 'GET' && url.pathname === '/user') {
    let login = (request.headers.authorization ?? '').replace('Bearer ghu_', '')
    let account = ACCOUNTS[login]
    if (!account) return json(response, 401, { message: 'Bad credentials' })
    return json(response, 200, { id: account.id, login, name: account.name, avatar_url: null })
  }

  if (request.method === 'POST' && url.pathname === `/app/installations/${FAKE_ORG.installationId}/access_tokens`) {
    return json(response, 201, { token: 'ghs_members', expires_at: new Date(Date.now() + 3600_000).toISOString() })
  }

  let membership = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'GET' && membership) {
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
