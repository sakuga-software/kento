import { createHash } from 'node:crypto'

import type postgres from 'postgres'
import { createSession, type Session, type SessionStorage } from 'remix/session'

/** The stored form of a session of `remix/session`: its values, and its flash values. */
type SessionData = [Record<string, unknown>, Record<string, unknown>]

/** A signed-in session lasts this long from the sign-in, whatever happens in between. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A GitHub sign-in that started and did not come back is forgotten after this. */
export const PENDING_SIGN_IN_TTL_MS = 10 * 60 * 1000

/** The record that the sign-in writes in the session, under `auth`. */
export interface SessionAuth {
  userId: string
  /** Epoch milliseconds. The session ends `SESSION_TTL_MS` after it. */
  signedInAt: number
}

export function readSessionAuth(session: Session): SessionAuth | null {
  let value = session.get('auth') as Partial<SessionAuth> | undefined
  if (!value || typeof value.userId !== 'string' || typeof value.signedInAt !== 'number') return null
  return { userId: value.userId, signedInAt: value.signedInAt }
}

/** The key of a session id in the table: its SHA-256. The id itself is only in the cookie. */
export function sessionIdHash(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

/**
 * The sessions of the screens, in Postgres. A row holds a session that matters: a signed-in person
 * (`auth`), or a GitHub sign-in on its way (`__auth`, the OAuth transaction of `remix/auth`). Any
 * other visit, such as the sign-in page, writes nothing and sets no cookie.
 */
export function createPostgresSessionStorage(
  sql: postgres.Sql,
  options: { now?: () => number } = {},
): SessionStorage & { sweep(): Promise<number> } {
  let now = options.now ?? Date.now
  // The sessions that came from a row of the table, so that `save` deletes the row when the
  // session no longer holds anything that matters.
  let stored = new WeakSet<Session>()

  return {
    async read(cookie) {
      if (!cookie) return createSession()
      // drizzle shares this client and turns off its JSON and date conversions: dates go as ISO
      // strings, JSON as text cast to jsonb, and a jsonb comes back as an object or as its text.
      let [row] = await sql<{ data: SessionData | string }[]>`
        select data from sessions
        where id_hash = ${sessionIdHash(cookie)} and expires_at > ${new Date(now()).toISOString()}
      `
      if (!row) return createSession()
      let data = typeof row.data === 'string' ? (JSON.parse(row.data) as SessionData) : row.data
      let session = createSession(cookie, data)
      stored.add(session)
      return session
    },

    async save(session) {
      if (session.deleteId) {
        await sql`delete from sessions where id_hash = ${sessionIdHash(session.deleteId)}`
      }
      if (session.destroyed) {
        await sql`delete from sessions where id_hash = ${sessionIdHash(session.id)}`
        return ''
      }

      let auth = readSessionAuth(session)
      let pending = session.has('__auth')
      if (!auth && !pending) {
        if (stored.has(session) || session.deleteId) {
          await sql`delete from sessions where id_hash = ${sessionIdHash(session.id)}`
          return ''
        }
        return null
      }
      // `expires_at` is written when the session changes, and it never moves later: a sign-in on its
      // way ends 10 minutes after it started, a signed-in session 7 days after the sign-in.
      if (!session.dirty && stored.has(session)) return null

      let expiresAt = new Date(auth ? auth.signedInAt + SESSION_TTL_MS : now() + PENDING_SIGN_IN_TTL_MS)
      await sql`
        insert into sessions (id_hash, user_id, data, expires_at)
        values (${sessionIdHash(session.id)}, ${auth?.userId ?? null}, ${JSON.stringify(session.data)}::jsonb, ${expiresAt.toISOString()})
        on conflict (id_hash) do update
          set user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at, updated_at = now()
      `
      return session.id
    },

    /** Deletes the expired rows. The server calls it every hour. */
    async sweep() {
      let rows = await sql`delete from sessions where expires_at <= ${new Date(now()).toISOString()} returning 1`
      return rows.length
    },
  }
}
