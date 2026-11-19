import * as assert from 'remix/assert'
import { createSession } from 'remix/session'
import { after, before, beforeEach, describe, it } from 'remix/test'

import {
  createPostgresSessionStorage,
  PENDING_SIGN_IN_TTL_MS,
  SESSION_TTL_MS,
  sessionIdHash,
} from '../../app/auth/session-storage.ts'
import { createAuthStore } from '../../app/auth/store.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createTestDatabase } from './helpers.ts'

describe('sessions and people in Postgres', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let clock = { now: Date.parse('2026-10-28T12:00:00Z') }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 2 })
  })

  after(async () => {
    await database.close()
    await test.drop()
  })

  beforeEach(async () => {
    clock.now = Date.parse('2026-10-28T12:00:00Z')
    await database.sql`truncate sessions, memberships, users, orgs cascade`
  })

  async function insertOrg(login: string, installationId: number, suspended = false) {
    let [row] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login, suspended_at)
      values (${installationId}, ${installationId + 1000}, ${login}, ${suspended ? new Date().toISOString() : null})
      returning id
    `
    return row!.id
  }

  async function rows() {
    return database.sql<{ id_hash: string; user_id: string | null; data: unknown; expires_at: string }[]>`
      select id_hash, user_id, data, expires_at from sessions
    `
  }

  describe('the session storage', () => {
    it('keeps nothing for a visit: no row, no cookie', async () => {
      let storage = createPostgresSessionStorage(database.sql, { now: () => clock.now })
      let session = await storage.read(null)
      session.set('_csrf', 'token')

      assert.equal(await storage.save(session), null)
      assert.equal((await rows()).length, 0)
    })

    it('keeps a sign-in on its way for ten minutes, under the hash of its id only', async () => {
      let storage = createPostgresSessionStorage(database.sql, { now: () => clock.now })
      let session = await storage.read(null)
      session.set('__auth', { provider: 'github', state: 's', codeVerifier: 'v' })

      let cookie = await storage.save(session)

      assert.equal(cookie, session.id)
      let [row] = await rows()
      assert.equal(row!.id_hash, sessionIdHash(session.id))
      assert.ok(!JSON.stringify(row).includes(session.id), 'the id itself is not in the table')
      assert.equal(row!.user_id, null)
      assert.equal(new Date(row!.expires_at).getTime(), clock.now + PENDING_SIGN_IN_TTL_MS)

      let again = await storage.read(cookie)
      assert.deepEqual(again.get('__auth'), { provider: 'github', state: 's', codeVerifier: 'v' })
    })

    it('keeps a signed-in session seven days from the sign-in, with its user, then forgets it', async () => {
      let store = createAuthStore(database.sql)
      let user = await store.upsertUser({ id: 1, login: 'octocat', name: null, avatarUrl: null })
      let storage = createPostgresSessionStorage(database.sql, { now: () => clock.now })
      let session = await storage.read(null)
      session.set('auth', { userId: user.id, signedInAt: clock.now })
      let cookie = (await storage.save(session))!

      let [row] = await rows()
      assert.equal(row!.user_id, user.id)
      assert.equal(new Date(row!.expires_at).getTime(), clock.now + SESSION_TTL_MS)

      clock.now += SESSION_TTL_MS
      let expired = await storage.read(cookie)
      assert.equal(expired.get('auth'), undefined)
      assert.notEqual(expired.id, cookie)

      assert.equal(await storage.sweep(), 1)
      assert.equal((await rows()).length, 0)
    })

    it('deletes the row of the old id when the sign-in gives a new one, and at sign-out', async () => {
      let store = createAuthStore(database.sql)
      let user = await store.upsertUser({ id: 1, login: 'octocat', name: null, avatarUrl: null })
      let storage = createPostgresSessionStorage(database.sql, { now: () => clock.now })
      let pending = await storage.read(null)
      pending.set('__auth', { provider: 'github', state: 's', codeVerifier: 'v' })
      let first = (await storage.save(pending))!

      let session = await storage.read(first)
      session.unset('__auth')
      session.regenerateId(true)
      session.set('auth', { userId: user.id, signedInAt: clock.now })
      let second = (await storage.save(session))!

      assert.notEqual(second, first)
      assert.deepEqual((await rows()).map((r) => r.id_hash), [sessionIdHash(second)])
      assert.equal((await storage.read(first)).get('auth'), undefined)

      let signedIn = await storage.read(second)
      signedIn.destroy()
      assert.equal(await storage.save(signedIn), '')
      assert.equal((await rows()).length, 0)
    })

    it('deletes a stored session that no longer holds a sign-in, and clears its cookie', async () => {
      let storage = createPostgresSessionStorage(database.sql, { now: () => clock.now })
      let pending = createSession()
      pending.set('__auth', { provider: 'github', state: 's', codeVerifier: 'v' })
      let cookie = (await storage.save(pending))!

      let session = await storage.read(cookie)
      session.unset('__auth')

      assert.equal(await storage.save(session), '')
      assert.equal((await rows()).length, 0)
    })

    it('reads nothing from a cookie that is not in the table', async () => {
      let storage = createPostgresSessionStorage(database.sql, { now: () => clock.now })
      let session = await storage.read('00000000-0000-4000-8000-000000000000')
      assert.notEqual(session.id, '00000000-0000-4000-8000-000000000000')
    })
  })

  describe('the store of people', () => {
    it('creates a user once per GitHub account, and follows a new login', async () => {
      let store = createAuthStore(database.sql)
      let first = await store.upsertUser({ id: 77, login: 'old-login', name: 'Octocat', avatarUrl: null })
      let second = await store.upsertUser({ id: 77, login: 'new-login', name: 'Octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/77' })

      assert.equal(second.id, first.id)
      assert.deepEqual(await store.findUser(first.id), {
        id: first.id,
        githubId: 77,
        login: 'new-login',
        name: 'Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/77',
      })
    })

    it('lists the memberships in the orgs that are not suspended, and forgets a deleted user everywhere', async () => {
      let store = createAuthStore(database.sql)
      let active = await insertOrg('sakuga-software', 11)
      let suspended = await insertOrg('orchard', 12, true)
      let user = await store.upsertUser({ id: 1, login: 'octocat', name: null, avatarUrl: null })
      await store.saveMembership(user.id, active, 'admin')
      await store.saveMembership(user.id, suspended, 'member')
      await store.saveMembership(user.id, active, 'member')

      let memberships = await store.memberships(user.id)
      assert.deepEqual(
        memberships.map((m) => [m.org.login, m.role, m.org.githubInstallationId]),
        [['sakuga-software', 'member', 11]],
      )
      assert.deepEqual((await store.activeOrgs()).map((o) => o.login), ['sakuga-software'])

      let storage = createPostgresSessionStorage(database.sql, { now: () => clock.now })
      let session = createSession()
      session.set('auth', { userId: user.id, signedInAt: clock.now })
      await storage.save(session)

      await database.sql`delete from users where id = ${user.id}`
      assert.equal((await rows()).length, 0)
      let [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from memberships`
      assert.equal(count!.n, 0)
    })
  })
})
