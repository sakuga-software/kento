import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { Db } from './client.ts'
import { createWebhookStore, isOrgAllowed, type StoreCommand } from './webhook-store.ts'

const installation = { githubInstallationId: 9001, githubAccountId: 9002, login: 'Stranger-Org' }
const repository = { githubRepoId: 9003, fullName: 'stranger-org/app' }

// A store that fails on the first read of the database: the gate must answer before it.
const noDatabase = new Proxy({}, { get: () => { throw new Error('the database was read') } }) as Db

describe('KENTO_ALLOWED_ORGS in the webhook store', () => {
  it('serves every account without a list, and compares the logins in lowercase', () => {
    assert.equal(isOrgAllowed(null, 'Stranger-Org'), true)
    assert.equal(isOrgAllowed(undefined, 'Stranger-Org'), true)
    assert.equal(isOrgAllowed(new Set(['stranger-org']), 'Stranger-Org'), true)
    assert.equal(isOrgAllowed(new Set(['sakuga-software']), 'Stranger-Org'), false)
  })

  it('writes nothing for an installation or a push of an account that is not allowed', async () => {
    let apply = createWebhookStore(noDatabase, { allowedOrgs: new Set(['sakuga-software']) })
    let commands: StoreCommand[] = [
      { type: 'upsert_installation', installation, repositories: [repository], suspended: false },
      { type: 'add_repositories', installation, repositories: [repository] },
      {
        type: 'enqueue_review',
        action: 'opened',
        installation,
        repository,
        prNumber: 1,
        headSha: 'a'.repeat(40),
        baseRef: 'main',
        author: null,
        labels: [],
      },
    ]
    // The gate reads only the type and the installation. The type checker makes sure that each command has them.
    commands.push(
      { type: 'comment_command', installation } as unknown as StoreCommand,
      { type: 'feedback_reply', installation } as unknown as StoreCommand,
    )
    for (let command of commands) {
      assert.deepEqual(await apply(command, 'delivery-1'), { outcome: 'skipped', reason: 'organization is not allowed' })
    }
  })

  it('still applies a removal of an account that is not allowed', async () => {
    let apply = createWebhookStore(noDatabase, { allowedOrgs: new Set(['sakuga-software']) })
    await assert.rejects(() => apply({ type: 'delete_installation', installation }, 'delivery-2'), /the database was read/)
  })
})
