import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import * as net from 'node:net'
import { fileURLToPath } from 'node:url'

import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createTestDatabase, insertOrg } from './helpers.ts'

const appDir = fileURLToPath(new URL('../../', import.meta.url))

async function freePort(): Promise<number> {
  let server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface Started {
  child: ChildProcess
  output: () => string
  exit: Promise<number | null>
}

// Starts `pnpm start` as in the container: `node --import remix/node-tsx server.ts`.
function start(env: Record<string, string>): Started {
  let child = spawn(process.execPath, ['--import', 'remix/node-tsx', 'server.ts'], {
    cwd: appDir,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.on('data', (chunk) => (output += chunk))
  child.stderr!.on('data', (chunk) => (output += chunk))
  let exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, output: () => output, exit }
}

async function waitForHealthz(port: number, started: Started): Promise<Response> {
  let deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (started.child.exitCode !== null) {
      throw new Error(`server exited with ${started.child.exitCode}:\n${started.output()}`)
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/healthz`)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw new Error(`server did not answer in 20 s:\n${started.output()}`)
}

async function stop(started: Started): Promise<number | null> {
  started.child.kill('SIGTERM')
  return started.exit
}

describe('server', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>

  before(async () => {
    test = await createTestDatabase()
  })

  after(async () => {
    await test?.drop()
  })

  it('migrates at startup, serves /healthz, and keeps the data across a restart', async () => {
    let port = await freePort()
    let env = { DATABASE_URL: test.url, PORT: String(port), HOST: '127.0.0.1', APP_COMMIT: 'abc1234' }

    let first = start(env)
    try {
      let response = await waitForHealthz(port, first)
      let body = await response.json()
      assert.equal(response.status, 200, first.output())
      assert.equal(body.status, 'ok')
      assert.equal(body.commit, 'abc1234')
      assert.equal(body.database.migrations, 34)
      assert.match(first.output(), /"event":"startup.migrations_applied"/)
    } finally {
      assert.equal(await stop(first), 0, first.output())
    }

    let sql = postgres(test.url, { max: 1 })
    await insertOrg(sql, 'kept', 1, 2)

    let second = start(env)
    try {
      let response = await waitForHealthz(port, second)
      assert.equal(response.status, 200, second.output())
      let [row] = await sql<{ logins: string[] }[]>`select array_agg(name) as logins from orgs`
      assert.deepEqual(row!.logins, ['kept'])
    } finally {
      await sql.end()
      assert.equal(await stop(second), 0, second.output())
    }
  })

  it('KNT-150: limits the starts of a sign-in by client, through the address that server.ts gives and the trusted proxy', async () => {
    let port = await freePort()
    let { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    let started = start({
      DATABASE_URL: test.url,
      PORT: String(port),
      HOST: '127.0.0.1',
      GITHUB_API_URL: 'http://127.0.0.1:9',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      GITHUB_APP_CLIENT_ID: 'Iv-server-test',
      GITHUB_APP_CLIENT_SECRET: 'server-test-client-secret',
      KENTO_PUBLIC_URL: `http://127.0.0.1:${port}`,
      KENTO_SESSION_SECRET: 'server-test-session-secret-0123456789',
      // One proxy in front (as Traefik), and a low limit.
      KENTO_TRUSTED_PROXY_HOPS: '1',
      KENTO_SIGN_IN_LIMIT: '3',
    })
    try {
      await waitForHealthz(port, started)
      let startFrom = async (forwarded: string) =>
        (await fetch(`http://127.0.0.1:${port}/login/github`, { headers: { 'X-Forwarded-For': forwarded }, redirect: 'manual' })).status
      let codes: number[] = []
      for (let n = 0; n < 4; n++) codes.push(await startFrom('198.51.100.1'))
      assert.deepEqual(codes, [303, 303, 303, 429], started.output())
      // The client writes its own entry first: the proxy's entry, the last one, is the client.
      assert.equal(await startFrom('203.0.113.9, 198.51.100.1'), 429)
      // Another client behind the same proxy, the same socket, has its own limit.
      assert.equal(await startFrom('198.51.100.2'), 303)
      assert.equal(await startFrom('203.0.113.9, 198.51.100.3'), 303)
    } finally {
      await stop(started)
    }
  })

  it('stops before listening when DATABASE_URL is missing', async () => {
    let started = start({ PORT: String(await freePort()) })
    assert.equal(await started.exit, 1)
    assert.match(started.output(), /"event":"startup.config_invalid".*DATABASE_URL is required/)
  })

  it('stops before listening when the database cannot be migrated', async () => {
    let port = await freePort()
    let started = start({ DATABASE_URL: `postgres://kento:x@127.0.0.1:${await freePort()}/none`, PORT: String(port) })
    assert.equal(await started.exit, 1)
    assert.match(started.output(), /"event":"startup.migrations_failed"/)
    assert.doesNotMatch(started.output(), /startup.listening/)
  })
})
