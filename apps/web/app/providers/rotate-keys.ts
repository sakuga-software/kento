// Encrypts again, under KENTO_SECRETS_KEY, every key of a provider that an earlier master key
// encrypted (KENTO_SECRETS_PREVIOUS_KEYS). Run it in the container of the service after a rotation:
//
//   node app/providers/rotate-keys.ts            # counts the rows to rotate, writes nothing
//   node app/providers/rotate-keys.ts --apply    # rotates them
//
// It prints counts and ids only, never a key. Each row is rotated in its own statement, guarded by
// its old ciphertext: a key replaced on the screen in the meantime is left as it is.
import postgres from 'postgres'

import { createSecretBox, providerAad, readMasterKeys } from './secrets.ts'

let apply = process.argv.includes('--apply')
let keys = readMasterKeys(process.env)
if (!keys) {
  console.error('KENTO_SECRETS_KEY is not set')
  process.exit(1)
}
let databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
let box = createSecretBox(keys.current, keys.previous)
let sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })

try {
  let rows = await sql<{ id: string; orgId: string; keyCiphertext: string }[]>`
    select id, org_id as "orgId", key_ciphertext as "keyCiphertext" from providers where key_ciphertext is not null`
  let stale = rows.filter((row) => box.isStale(row.keyCiphertext))
  console.log(`master key ${box.keyId}: ${rows.length} keys, ${stale.length} to rotate`)
  let rotated = 0
  let failed = 0
  for (let row of stale) {
    let aad = providerAad(row)
    let plaintext: string
    try {
      plaintext = box.decrypt(row.keyCiphertext, aad)
    } catch (error) {
      failed++
      console.error(`provider ${row.id}: ${(error as Error).message}`)
      continue
    }
    if (!apply) continue
    let done = await sql`
      update providers set key_ciphertext = ${box.encrypt(plaintext, aad)}, updated_at = now()
      where id = ${row.id} and key_ciphertext = ${row.keyCiphertext}`
    rotated += done.count
  }
  console.log(apply ? `rotated ${rotated}, failed ${failed}` : `dry run: ${stale.length - failed} can be rotated, ${failed} cannot; add --apply`)
  process.exitCode = failed > 0 ? 1 : 0
} finally {
  await sql.end({ timeout: 5 })
}
