// KNT-150. The table keeps only the hash of a session token (app/auth/better-auth.ts,
// `hashSessionTokens`): a session listed by user carries the hash, not a token. That is safe while
// Kentō never lists sessions nor revokes one by a listed token, and while the HTTP API of Better
// Auth, which offers those calls, is not mounted. This scan fails as soon as one of them appears in
// the code of the service.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The source files of the service: app/ (without the tests) and server.ts. */
function sources(): { path: string; code: string }[] {
  let files: string[] = [join(ROOT, 'server.ts')]
  let walk = (dir: string) => {
    for (let name of readdirSync(dir)) {
      let path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.startsWith('test-helpers')) files.push(path)
    }
  }
  walk(join(ROOT, 'app'))
  return files.map((path) => ({ path: path.slice(ROOT.length), code: readFileSync(path, 'utf8') }))
}

describe('the surface of Better Auth in the service', () => {
  let files = sources()

  it('finds the code of the service', () => {
    assert.ok(files.length > 50, String(files.length))
    assert.ok(files.some((f) => f.path === 'app/auth/better-auth.ts'))
  })

  it('never lists the sessions of a user, nor revokes a session by a token it listed', () => {
    let calls = /\b(listSessions|revokeSession|revokeSessions|revokeOtherSessions|deleteSessions)\s*\(/
    let found = files.filter((f) => calls.test(f.code)).map((f) => f.path)
    assert.deepEqual(found, [])
  })

  it('hands one request only to the handler of Better Auth: the callback of GitHub', () => {
    let handlers = files.flatMap((f) => [...f.code.matchAll(/\.handler\(/g)].map(() => f.path))
    assert.deepEqual(handlers, ['app/ui/controllers/auth.tsx'])
    let auth = files.find((f) => f.path === 'app/ui/controllers/auth.tsx')!.code
    assert.match(auth, /new URL\(`\$\{AUTH_BASE_PATH\}\/callback\/github\$\{context\.url\.search\}`, auth\.publicUrl\)/)
    // No route of the service points at the base path of Better Auth.
    let routes = readFileSync(join(ROOT, 'app/routes.ts'), 'utf8')
    assert.doesNotMatch(routes, /\/api\/auth/)
  })
})
