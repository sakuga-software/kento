import { randomUUID } from 'node:crypto'

import type postgres from 'postgres'

import type { ProviderKind } from '@sakuga-review/protocol'

import type { ProviderModels } from '../db/schema.ts'
import { last4, providerAad, SecretsError, type SecretBox } from './secrets.ts'

/** A provider as the screen sees it: never its key, only the last 4 characters. */
export interface ProviderView {
  id: string
  orgId: string
  kind: ProviderKind
  label: string
  baseUrl: string | null
  keyLast4: string | null
  keySetAt: Date | null
  runnerHeld: boolean
  isDefault: boolean
  models: ProviderModels
  lastOkAt: Date | null
  refusedAt: Date | null
  refusedStatus: number | null
  refusedMessage: string | null
  createdAt: Date
}

export interface NewProvider {
  orgId: string
  userId: string | null
  kind: ProviderKind
  label: string
  baseUrl: string | null
  /** Null: the runner holds the key, or the server (Ollama). */
  apiKey: string | null
  models: ProviderModels
}

export interface ProvidersStore {
  /** The providers of an org, the default one first. */
  list(orgId: string): Promise<ProviderView[]>
  /** Adds a provider. The first provider of an org becomes its default. Throws a SecretsError without a master key. */
  add(input: NewProvider): Promise<ProviderView>
  /** Replaces the key, and forgets the state of the old one. False when the provider is not of the org, or holds no key. */
  replaceKey(orgId: string, id: string, apiKey: string): Promise<ProviderView | null>
  /** Makes it the provider of the jobs of the org. */
  setDefault(orgId: string, id: string): Promise<ProviderView | null>
  /** Removes it; its jobs keep running with the key they got. Null when it is not of the org. */
  remove(orgId: string, id: string): Promise<ProviderView | null>
  /** The provider and its key in clear, to test it from the screen. Null when it is not of the org. */
  withKey(orgId: string, id: string): Promise<{ provider: ProviderView; apiKey: string | null } | null>
  /**
   * The provider answered a call: valid, and no refusal any more. `keySetAt`: the key that the call
   * used, as `withKey` read it; a key replaced since keeps its own state.
   */
  recordOk(id: string, keySetAt: Date | null): Promise<void>
  /** The provider refused the key: the first refusal since the last call that worked stays. Same `keySetAt`. */
  recordRefused(id: string, status: number, message: string, keySetAt: Date | null): Promise<void>
}

const COLUMNS = (sql: postgres.Sql) => sql`
  id, org_id as "orgId", kind, label, base_url as "baseUrl", key_last4 as "keyLast4", key_set_at as "keySetAt",
  runner_held as "runnerHeld", is_default as "isDefault", models, last_ok_at as "lastOkAt", refused_at as "refusedAt",
  refused_status as "refusedStatus", refused_message as "refusedMessage", created_at as "createdAt"`

type Row = Omit<ProviderView, 'keySetAt' | 'lastOkAt' | 'refusedAt' | 'createdAt'> & {
  keySetAt: Date | string | null
  lastOkAt: Date | string | null
  refusedAt: Date | string | null
  createdAt: Date | string
}

function view(row: Row): ProviderView {
  let date = (value: Date | string | null) => (value === null ? null : new Date(value))
  return {
    ...row,
    keySetAt: date(row.keySetAt),
    lastOkAt: date(row.lastOkAt),
    refusedAt: date(row.refusedAt),
    createdAt: new Date(row.createdAt),
    refusedStatus: row.refusedStatus === null ? null : Number(row.refusedStatus),
  }
}

/**
 * The message of a refusal as the screen shows it: short, one line, and without a long token. A
 * provider may quote a part of the key in its error (`Incorrect API key provided: sk-…abcd`).
 */
export function refusalMessage(message: string): string {
  return message
    .replace(/[A-Za-z0-9_*.+/=-]{16,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `box` is null when KENTO_SECRETS_KEY is not set: a key can then be neither stored nor read. */
export function createProvidersStore(sql: postgres.Sql, box: SecretBox | null): ProvidersStore {
  function needBox(): SecretBox {
    if (!box) throw new SecretsError('KENTO_SECRETS_KEY is not set: the service cannot store a key')
    return box
  }

  return {
    async list(orgId) {
      let rows = await sql<Row[]>`
        select ${COLUMNS(sql)} from providers where org_id = ${orgId}
        order by is_default desc, created_at, id`
      return rows.map(view)
    },

    async add(input) {
      let id = randomUUID()
      let ciphertext = input.apiKey === null ? null : needBox().encrypt(input.apiKey, providerAad({ id, orgId: input.orgId }))
      return sql.begin(async (tx) => {
        // The lock of the org orders two adds: only one of them can be the first provider.
        await tx`select 1 from orgs where id = ${input.orgId} for update`
        let [first] = await tx<{ count: number }[]>`
          select count(*)::int as count from providers where org_id = ${input.orgId} and is_default`
        let count = first?.count ?? 0
        let [row] = await tx<Row[]>`
          insert into providers (id, org_id, kind, label, base_url, key_ciphertext, key_last4, key_set_at, runner_held,
            is_default, models, created_by)
          values (${id}, ${input.orgId}, ${input.kind}, ${input.label}, ${input.baseUrl}, ${ciphertext},
            ${input.apiKey === null ? null : last4(input.apiKey)}, case when ${input.apiKey !== null}::boolean then now() end,
            ${input.apiKey === null}, ${count === 0}, ${JSON.stringify(input.models)}::jsonb, ${input.userId})
          returning ${COLUMNS(sql)}`
        return view(row!)
      })
    },

    async replaceKey(orgId, id, apiKey) {
      // An id from a URL: one that is not a uuid is a provider that does not exist, not a 500.
      if (!UUID.test(id)) return null
      let ciphertext = needBox().encrypt(apiKey, providerAad({ id, orgId }))
      let [row] = await sql<Row[]>`
        update providers set key_ciphertext = ${ciphertext}, key_last4 = ${last4(apiKey)}, key_set_at = now(),
          last_ok_at = null, refused_at = null, refused_status = null, refused_message = null, updated_at = now()
        where id = ${id} and org_id = ${orgId} and not runner_held
        returning ${COLUMNS(sql)}`
      return row ? view(row) : null
    },

    async setDefault(orgId, id) {
      // An id from a URL: one that is not a uuid is a provider that does not exist, not a 500.
      if (!UUID.test(id)) return null
      return sql.begin(async (tx) => {
        let [target] = await tx<{ id: string }[]>`select id from providers where id = ${id} and org_id = ${orgId} for update`
        if (!target) return null
        await tx`update providers set is_default = false, updated_at = now() where org_id = ${orgId} and is_default and id <> ${id}`
        let [row] = await tx<Row[]>`
          update providers set is_default = true, updated_at = now() where id = ${id}
          returning ${COLUMNS(sql)}`
        return view(row!)
      })
    },

    // The removal of the default provider makes the oldest one left the default: the jobs of the
    // org never fall back to the key of the service while the org still has a provider.
    async remove(orgId, id) {
      // An id from a URL: one that is not a uuid is a provider that does not exist, not a 500.
      if (!UUID.test(id)) return null
      return sql.begin(async (tx) => {
        await tx`select 1 from orgs where id = ${orgId} for update`
        let [row] = await tx<Row[]>`
          delete from providers where id = ${id} and org_id = ${orgId}
          returning ${COLUMNS(sql)}`
        if (!row) return null
        if (row.isDefault) {
          await tx`
            update providers set is_default = true, updated_at = now()
            where id = (select id from providers where org_id = ${orgId} order by created_at, id limit 1)`
        }
        return view(row)
      })
    },

    async withKey(orgId, id) {
      // An id from a URL: one that is not a uuid is a provider that does not exist, not a 500.
      if (!UUID.test(id)) return null
      let [row] = await sql<(Row & { keyCiphertext: string | null })[]>`
        select ${COLUMNS(sql)}, key_ciphertext as "keyCiphertext" from providers where id = ${id} and org_id = ${orgId}`
      if (!row) return null
      let { keyCiphertext, ...rest } = row
      let apiKey = keyCiphertext === null ? null : needBox().decrypt(keyCiphertext, providerAad({ id, orgId }))
      return { provider: view(rest), apiKey }
    },

    async recordOk(id, keySetAt) {
      await sql`
        update providers set last_ok_at = now(), refused_at = null, refused_status = null, refused_message = null
        where id = ${id} and date_trunc('milliseconds', key_set_at) is not distinct from ${keySetAt ? keySetAt.toISOString() : null}::timestamptz`
    },

    async recordRefused(id, status, message, keySetAt) {
      await sql`
        update providers set refused_at = coalesce(refused_at, now()), refused_status = ${status},
          refused_message = ${refusalMessage(message)}
        where id = ${id} and date_trunc('milliseconds', key_set_at) is not distinct from ${keySetAt ? keySetAt.toISOString() : null}::timestamptz`
    },
  }
}
