import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { reopenText } from './reply.ts'

describe('the reply of the bot after "Reopen"', () => {
  it('names the person', () => {
    assert.equal(reopenText('octocat'), 'Finding reopened by @octocat on Kentō. The next review reports it again if it is still there.')
  })
})
