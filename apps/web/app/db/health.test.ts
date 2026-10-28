import * as net from 'node:net'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createDatabase } from './client.ts'
import { createDatabaseCheck } from './health.ts'

// A port where nothing listens: the connection is refused at once.
async function closedPort(): Promise<number> {
  let server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

// A port that accepts the connection and never answers.
async function silentPort(): Promise<{ port: number; connections(): number; close(): Promise<void> }> {
  let sockets = new Set<net.Socket>()
  let accepted = 0
  let server = net.createServer((socket) => {
    accepted++
    sockets.add(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let { port } = server.address() as net.AddressInfo
  return {
    port,
    connections: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (let socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

describe('createDatabaseCheck', () => {
  it('reports the error code, never the address or the password', async () => {
    let port = await closedPort()
    let database = createDatabase(`postgres://kento:hunter2@127.0.0.1:${port}/kento`, { max: 1 })
    try {
      let health = await createDatabaseCheck(database.sql)()
      assert.equal(health.status, 'error')
      let body = JSON.stringify(health)
      assert.match(body, /ECONNREFUSED/)
      assert.doesNotMatch(body, /hunter2|127\.0\.0\.1/)
    } finally {
      await database.close()
    }
  })

  it('fails after the timeout when the database never answers', async () => {
    let silent = await silentPort()
    let database = createDatabase(`postgres://kento:hunter2@127.0.0.1:${silent.port}/kento`, {
      max: 1,
    })
    try {
      let health = await createDatabaseCheck(database.sql, 200)()
      assert.equal(health.status, 'error')
      assert.ok(health.status === 'error' && health.error === 'timeout')
      assert.ok(health.latencyMs < 1500, `took ${health.latencyMs} ms`)
    } finally {
      await silent.close()
      await database.sql.end({ timeout: 0 })
    }
  })

  it('keeps one health query in flight while the database does not answer', async () => {
    let silent = await silentPort()
    let database = createDatabase(`postgres://kento:hunter2@127.0.0.1:${silent.port}/kento`, {
      max: 5,
    })
    try {
      let check = createDatabaseCheck(database.sql, 100)
      for (let i = 0; i < 3; i++) {
        let health = await check()
        assert.ok(health.status === 'error' && health.error === 'timeout')
      }
      // Three checks timed out, and the pool opened a single connection for them.
      assert.equal(silent.connections(), 1)
    } finally {
      await silent.close()
      await database.sql.end({ timeout: 0 })
    }
  })
})
