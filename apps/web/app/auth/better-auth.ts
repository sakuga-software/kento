// KNT-150. The sign-in and the sessions of the screens, with Better Auth.
//
// - Its HTTP API is not mounted: only the callback of GitHub reaches `auth.handler` (see
//   app/ui/controllers/auth.tsx). Every other call is a server call (`auth.api.*`) from a
//   controller of Kentō, behind its own CSRF check.
// - GitHub is the only sign-in, with the user authorization of the GitHub App (generic OAuth, so that
//   the addresses of a GitHub Enterprise Server or of a fake GitHub work too).
// - The table keeps the SHA-256 of a session token, never the token (`hashSessionTokens`).
// - Kentō keeps no token of GitHub: the account rows never hold one.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { genericOAuth } from 'better-auth/plugins'

import type { Db } from '../db/client.ts'
import { accounts, sessions, users, verifications } from '../db/schema.ts'
import { errorMessage, log } from '../log.ts'
import { saveSignInRoles, decideSignIn, type SignInDecision } from './access.ts'
import type { GitHubOAuth, GitHubProfile, LookupRole } from './github.ts'
import type { AuthStore } from './store.ts'

/** A signed-in session lasts this long from the sign-in, whatever happens in between. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A GitHub sign-in that started and did not come back is forgotten after this. */
export const PENDING_SIGN_IN_TTL_MS = 10 * 60 * 1000

/** Where Better Auth thinks that its API is. Only the callback of GitHub is ever sent there. */
export const AUTH_BASE_PATH = '/api/auth'

/** The e-mail that Better Auth needs for a GitHub account. RFC 2606: `.invalid` is never routed. */
export function githubEmail(githubId: number): string {
  return `${githubId}@users.github.invalid`
}

/** The key of a session token in the table. The token itself is only in the cookie. */
export function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * What one sign-in learned on its way, for the callback route that started it: the profile that
 * GitHub gave, and the decision of Kentō. Each callback runs in its own scope.
 */
export interface SignInScope {
  profile: GitHubProfile | null
  decision: SignInDecision | null
}

export const signInScope = new AsyncLocalStorage<SignInScope>()

/** Where Better Auth keeps its rows: Postgres in the service, memory in the tests of the routes. */
export type AuthDatabase = (options: BetterAuthOptions) => Adapter

/** The tables of Kentō, under the names of the models of Better Auth. */
export function postgresAuthDatabase(db: Db): AuthDatabase {
  return drizzleAdapter(db, { provider: 'pg', schema: { users, accounts, sessions, verifications } })
}

export interface KentoAuthOptions {
  database: AuthDatabase
  publicUrl: URL
  /** The first secret of KENTO_SESSION_SECRET: it signs the cookie and the OAuth state. */
  secret: string
  github: GitHubOAuth
  store: AuthStore
  lookupRole: LookupRole
  now?: () => number
}

/** The Better Auth of Kentō. */
export function createKentoAuth(options: KentoAuthOptions) {
  let { github, store, lookupRole } = options
  let now = options.now ?? Date.now
  let secure = options.publicUrl.protocol === 'https:'

  let config = {
    appName: 'Kentō',
    baseURL: options.publicUrl.origin,
    basePath: AUTH_BASE_PATH,
    secret: options.secret,
    trustedOrigins: [options.publicUrl.origin],
    telemetry: { enabled: false },
    logger: {
      // The message, and the message of an error that comes with it: never the other arguments,
      // which can hold a row or a request.
      log(level: 'debug' | 'info' | 'success' | 'warn' | 'error', message: string, ...args: unknown[]) {
        if (level !== 'warn' && level !== 'error') return
        let error = args.find((arg) => arg instanceof Error)
        log(level, 'auth.better_auth', { message, ...(error ? { error: errorMessage(error) } : {}) })
      },
    },
    database: (adapterOptions: BetterAuthOptions) => hashSessionTokens(options.database(adapterOptions)),
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: secure,
      cookies: { session_token: { name: 'kento_session' } },
      // The state of a sign-in lives in `verifications`, under a cookie of its own.
      cookiePrefix: 'kento',
    },
    user: {
      modelName: 'users',
      // Better Auth's `name` is the login: it is what Kentō shows of a person. The name on GitHub,
      // which an account may not have, is `githubName`.
      fields: { name: 'login', image: 'avatarUrl' },
      additionalFields: {
        // Set by the hooks of the user from the profile of the sign-in, never from a request (the
        // column is not null).
        githubId: { type: 'number', required: false, input: false },
        githubName: { type: 'string', required: false, input: false, fieldName: 'name' },
      },
      // The gate of the sign-in: GitHub counts the person in an org of the App. Anyone else is
      // refused before a row is written.
      async validateUserInfo(data: { user: Record<string, unknown> }) {
        let scope = signInScope.getStore()
        let profile = scope?.profile
        // The identity that Better Auth checks is the one that this sign-in read on GitHub.
        if (!scope || !profile || data.user.email !== githubEmail(profile.id)) return { error: 'failed' }
        let decision = await decideSignIn(store, lookupRole, profile)
        scope.decision = decision
        if (decision.kind === 'allowed') return
        log('info', 'auth.sign_in_refused', { login: profile.login, reason: decision.kind })
        return { error: decision.kind === 'refused' ? 'not_member' : 'failed' }
      },
    },
    account: {
      modelName: 'accounts',
      storeStateStrategy: 'database',
      accountLinking: { enabled: false },
    },
    session: {
      modelName: 'sessions',
      fields: { token: 'tokenHash' },
      expiresIn: SESSION_TTL_MS / 1000,
      // 7 days from the sign-in, whatever happens in between.
      disableSessionRefresh: true,
      additionalFields: {
        activeOrganizationId: { type: 'string', required: false, input: false },
      },
    },
    verification: { modelName: 'verifications' },
    databaseHooks: {
      user: {
        // The GitHub id and name of the person, from the profile that this sign-in read.
        create: { before: async (user: Record<string, unknown>) => withProfile(user) },
        update: { before: async (user: Record<string, unknown>) => withProfile(user) },
      },
      account: {
        create: { before: async (account: Record<string, unknown>) => ({ data: withoutTokens(account) }) },
        update: { before: async (account: Record<string, unknown>) => ({ data: withoutTokens(account) }) },
      },
      session: {
        create: { before: (session: Record<string, unknown>) => beforeSessionCreate(store, session, signInScope.getStore(), now()) },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'github',
            name: 'GitHub',
            clientId: github.clientId,
            clientSecret: github.clientSecret,
            authorizationUrl: github.authorizationUrl,
            tokenUrl: github.tokenUrl,
            // The callback URL of the GitHub App, as its settings already hold it.
            redirectURI: github.redirectUri.href,
            pkce: true,
            // A GitHub App takes its permissions from its settings, not from scopes.
            scopes: [],
            authorizationUrlParams: { allow_signup: 'false' },
            accountSubject: ({ profile }: { profile: Record<string, unknown> }) => String(profile.id),
            // The redirect_uri of the exchange must be the one of the authorization: the callback URL
            // of the App, not the path of Better Auth that it passes here.
            getToken: ({ code, codeVerifier }: { code: string; codeVerifier?: string }) =>
              github.exchangeCode({ code, codeVerifier: codeVerifier ?? null, redirectUri: github.redirectUri.href }),
            async getUserInfo(tokens: { accessToken?: string }) {
              if (!tokens.accessToken) return null
              let profile: GitHubProfile
              try {
                profile = await github.readProfile(tokens.accessToken)
              } catch (error) {
                log('warn', 'auth.sign_in_failed', { error: errorMessage(error) })
                return null
              }
              let scope = signInScope.getStore()
              if (scope) scope.profile = profile
              return {
                id: String(profile.id),
                email: githubEmail(profile.id),
                emailVerified: false,
                name: profile.login,
                image: profile.avatarUrl ?? undefined,
              }
            },
            // The login, the name and the avatar follow GitHub at each sign-in.
            overrideUserInfo: true,
          },
        ],
      }),
    ],
  } satisfies BetterAuthOptions

  return betterAuth(config as BetterAuthOptions)
}

export type KentoAuth = ReturnType<typeof createKentoAuth>

/**
 * The hook of Better Auth before it writes a session. Better Auth writes no row when it answers
 * `false` (`if (result === false) return null` in better-auth/dist/db/with-hooks.mjs), and merges
 * `data` into the row otherwise.
 *
 * A session is written only for a sign-in that Kentō allowed, in its scope: anything else (no scope,
 * no decision, a user that is gone, no org to show) gets no session. The roles of the sign-in are
 * saved, the org on screen is the first one where the person is an admin, else the first one, and
 * the session ends 7 days after the sign-in on the clock of Kentō.
 */
export async function beforeSessionCreate(
  store: AuthStore,
  session: Record<string, unknown>,
  scope: SignInScope | undefined,
  now: number,
): Promise<false | { data: Record<string, unknown> }> {
  let decision = scope?.decision
  if (decision?.kind !== 'allowed' || typeof session.userId !== 'string') return false
  let first = decision.roles.find((r) => r.role === 'admin') ?? decision.roles[0]
  if (!first) return false
  let user = await store.findUser(session.userId)
  if (!user) return false
  await saveSignInRoles(store, user, decision.roles, decision.unconfirmed)
  await store.touchSignIn(user.id)
  log('info', 'auth.signed_in', { login: user.login, orgs: decision.roles.map((r) => `${r.org.name}:${r.role}`) })
  return { data: { ...session, activeOrganizationId: first.org.id, expiresAt: new Date(now + SESSION_TTL_MS) } }
}

/**
 * The GitHub fields of a user that Better Auth writes, from the profile of the sign-in in progress.
 * A write outside of a sign-in (there is none today) changes nothing of them.
 */
function withProfile(user: Record<string, unknown>) {
  let profile = signInScope.getStore()?.profile
  if (!profile) return { data: user }
  return { data: { ...user, githubId: profile.id, githubName: profile.name } }
}

/**
 * The columns of an account that could hold a secret of GitHub. Kentō writes none of them. Better
 * Auth merges the answer of a hook into the row, so each one is set to null, not left out.
 */
function withoutTokens(account: Record<string, unknown>): Record<string, unknown> {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    password: null,
  }
}

type Adapter = ReturnType<ReturnType<typeof drizzleAdapter>>
type Where = NonNullable<Parameters<Adapter['findMany']>[0]['where']>[number]

/**
 * Better Auth writes the token of a session as it is, and finds a session by it. This adapter
 * stores and looks up its SHA-256 instead, and gives the token back to Better Auth where it reads
 * a row it found by token, or wrote.
 *
 * A session listed by user carries the hash, which is not a token: Kentō never lists sessions or
 * revokes one by a listed token (`listSessions`, `revokeSession`, `revokeOtherSessions`; its HTTP
 * API is not mounted). Kentō ends a session by its id (`AuthStore.deleteSession`), and Better Auth
 * ends the sessions of a user by `userId`, which this adapter passes as it is.
 */
export function hashSessionTokens(adapter: Adapter): Adapter {
  let isSession = (model: string) => model === 'session' || model === 'sessions'
  function hashWhere(model: string, where: Where[]): Where[]
  function hashWhere(model: string, where: Where[] | undefined): Where[] | undefined
  function hashWhere(model: string, where: Where[] | undefined) {
    if (!where || !isSession(model)) return where
    return where.map((w): Where =>
      w.field !== 'token'
        ? w
        : { ...w, value: Array.isArray(w.value) ? w.value.map((v) => sessionTokenHash(String(v))) : sessionTokenHash(String(w.value)) },
    )
  }
  let tokenOf = (where: Where[] | undefined) => {
    let found = where?.find((w) => w.field === 'token' && (w.operator === undefined || w.operator === 'eq'))
    return typeof found?.value === 'string' ? found.value : null
  }
  let restore = <T>(row: T, token: string | null): T =>
    row && token !== null && typeof row === 'object' ? ({ ...row, token } as T) : row
  let hashData = (model: string, data: Record<string, unknown>) =>
    isSession(model) && typeof data.token === 'string' ? { ...data, token: sessionTokenHash(data.token) } : data

  let wrapped: Adapter = {
    ...adapter,
    async create<T extends Record<string, unknown>, R = T>(input: Parameters<Adapter['create']>[0]): Promise<R> {
      let data = input.data as Record<string, unknown>
      let row = await adapter.create<T, R>({ ...input, data: hashData(input.model, data) as Omit<T, 'id'> })
      return isSession(input.model) && typeof data.token === 'string' ? restore(row, data.token) : row
    },
    async findOne<T>(input: Parameters<Adapter['findOne']>[0]): Promise<T | null> {
      let row = await adapter.findOne<T>({ ...input, where: hashWhere(input.model, input.where) })
      return isSession(input.model) ? restore(row, tokenOf(input.where)) : row
    },
    findMany: (input) => adapter.findMany({ ...input, where: hashWhere(input.model, input.where) }),
    count: (input) => adapter.count({ ...input, where: hashWhere(input.model, input.where) }),
    async update<T>(input: Parameters<Adapter['update']>[0]): Promise<T | null> {
      let row = await adapter.update<T>({ ...input, where: hashWhere(input.model, input.where), update: hashData(input.model, input.update) })
      return isSession(input.model) ? restore(row, tokenOf(input.where)) : row
    },
    updateMany: (input) => adapter.updateMany({ ...input, where: hashWhere(input.model, input.where), update: hashData(input.model, input.update) }),
    delete: (input) => adapter.delete({ ...input, where: hashWhere(input.model, input.where) }),
    deleteMany: (input) => adapter.deleteMany({ ...input, where: hashWhere(input.model, input.where) }),
    consumeOne: (input) => adapter.consumeOne({ ...input, where: hashWhere(input.model, input.where) }),
    transaction: (callback) => adapter.transaction((trx) => callback(hashSessionTokens(trx as Adapter))),
  }
  return wrapped
}
