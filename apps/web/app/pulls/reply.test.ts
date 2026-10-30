import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { reopenText } from './reply.ts'

describe('the reply of the bot after « Rouvrir »', () => {
  it('names the person', () => {
    assert.equal(reopenText('alex'), 'Finding rouvert par @alex sur Kentō. La prochaine review le signalera de nouveau s’il est toujours là.')
  })
})
