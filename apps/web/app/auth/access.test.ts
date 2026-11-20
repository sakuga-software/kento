import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { orgRole } from './access.ts'
import type { GitHubRole, LookupRole } from './github.ts'
import type { OrgRow } from './store.ts'

// KNT-150. An org can hold several installations: GitHub gives a role in each of their accounts.
const ORG: OrgRow = {
  id: 'org-1',
  name: 'acme',
  installations: [
    { id: 'installation-1', githubInstallationId: 11, githubAccountId: 900, login: 'acme' },
    { id: 'installation-2', githubInstallationId: 12, githubAccountId: 901, login: 'acme-labs' },
  ],
}
const PERSON = { githubId: 1, login: 'octocat' }

function lookup(answers: Record<string, GitHubRole | null | 'error'>): { lookupRole: LookupRole; asked: string[] } {
  let asked: string[] = []
  return {
    asked,
    lookupRole: async (installation) => {
      asked.push(installation.login)
      let answer = answers[installation.login] ?? null
      if (answer === 'error') throw new Error('GitHub answered 502')
      return answer
    },
  }
}

describe('the role of a person in an org of several installations', () => {
  it('is the highest role that an account gives', async () => {
    assert.equal(await orgRole(lookup({ acme: 'member', 'acme-labs': 'admin' }).lookupRole, ORG, PERSON), 'admin')
    assert.equal(await orgRole(lookup({ acme: null, 'acme-labs': 'member' }).lookupRole, ORG, PERSON), 'member')
  })

  it('asks no further account once one gives admin', async () => {
    let { lookupRole, asked } = lookup({ acme: 'admin', 'acme-labs': 'member' })
    assert.equal(await orgRole(lookupRole, ORG, PERSON), 'admin')
    assert.deepEqual(asked, ['acme'])
  })

  it('is null when every account says that the person is not a member', async () => {
    assert.equal(await orgRole(lookup({}).lookupRole, ORG, PERSON), null)
  })

  it('keeps the role that one account gives while GitHub fails for another', async () => {
    assert.equal(await orgRole(lookup({ acme: 'error', 'acme-labs': 'member' }).lookupRole, ORG, PERSON), 'member')
  })

  it('throws for an org with no installation: nobody to ask, so the answer is unknown', async () => {
    await assert.rejects(orgRole(lookup({}).lookupRole, { ...ORG, installations: [] }, PERSON), /no installation/)
  })

  it('throws when GitHub fails and no account gives a role: the answer is unknown, not "no access"', async () => {
    await assert.rejects(orgRole(lookup({ acme: 'error', 'acme-labs': null }).lookupRole, ORG, PERSON), /502/)
  })
})
