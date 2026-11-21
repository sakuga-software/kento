// KNT-150. The table keeps only the hash of a session token (app/auth/better-auth.ts,
// `hashSessionTokens`), and a session row read other than by its token comes back with no token:
// that is enforced by the adapter (test/db/auth.test.ts) and by the router, which serves no path of
// the API of Better Auth (app/ui/pages.test.ts). This scan is a second line: it fails as soon as the
// code of the service calls an API that lists or revokes sessions, or reaches the handler of Better
// Auth in another way than the one callback.
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
  return files.map((path) => ({ path: path.slice(ROOT.length), code: withoutComments(readFileSync(path, 'utf8')) }))
}

/** The code without its comments: a comment may name an API that the code never calls. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('the surface of Better Auth in the service', () => {
  let files = sources()

  it('finds the code of the service', () => {
    assert.ok(files.length > 50, String(files.length))
    assert.ok(files.some((f) => f.path === 'app/auth/better-auth.ts'))
  })

  it('never lists the sessions of a user, nor revokes a session by a token it listed', () => {
    // Every name, called or not: an alias or a call by a string key still names it. The calls of
    // Better Auth and of its plugins (admin, multi-session) that list or revoke sessions.
    let names =
      /\b(listSessions|listUserSessions|listDeviceSessions|revokeSession|revokeSessions|revokeOtherSessions|revokeUserSession|revokeUserSessions|revokeDeviceSession|setActiveSession|deleteSessions)\b/
    let found = files.filter((f) => names.test(f.code)).map((f) => f.path)
    assert.deepEqual(found, [])
    // No call of the API by a computed name: `auth.api[name](…)`.
    assert.deepEqual(files.filter((f) => /\.api\s*\[/.test(f.code)).map((f) => f.path), [])
  })

  it('hands one request only to the handler of Better Auth: the callback of GitHub', () => {
    // `.handler` named once, called or not (an alias counts), and no adapter that mounts the API.
    let handlers = files.flatMap((f) => [...f.code.matchAll(/\.handler\b|\[\s*['"`]handler['"`]\s*\]/g)].map(() => f.path))
    assert.deepEqual(handlers, ['app/ui/controllers/auth.tsx'])
    let mounts = files.filter((f) => /\btoNodeHandler\b|better-auth\/(node|integrations)|\bfromNodeHeaders\b/.test(f.code)).map((f) => f.path)
    assert.deepEqual(mounts, [])
    let auth = files.find((f) => f.path === 'app/ui/controllers/auth.tsx')!.code
    assert.match(auth, /new URL\(`\$\{AUTH_BASE_PATH\}\/callback\/github\$\{context\.url\.search\}`, auth\.publicUrl\)/)
    // No route of the service points at the base path of Better Auth.
    let routes = readFileSync(join(ROOT, 'app/routes.ts'), 'utf8')
    assert.doesNotMatch(routes, /\/api\/auth/)
  })
})
