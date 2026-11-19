import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { initials } from './shell.tsx'

describe('the initials of the avatar (REV-91)', () => {
  it('takes the first letter of the first and the last word of the name', () => {
    assert.equal(initials({ login: 'octocat', name: 'Alex Martin' }), 'AM')
    assert.equal(initials({ login: 'camille', name: 'Camille de la Tour' }), 'CT')
  })

  it('takes the first two letters of a single name, else of the login', () => {
    assert.equal(initials({ login: 'octocat', name: 'Mona' }), 'MO')
    assert.equal(initials({ login: 'camille', name: null }), 'CA')
    assert.equal(initials({ login: 'camille', name: '   ' }), 'CA')
  })

  it('keeps a character outside the BMP whole, never half of a surrogate pair', () => {
    assert.equal(initials({ login: 'x', name: '𝒜lice 𝒵oé' }), '𝒜𝒵')
    assert.equal(initials({ login: 'x', name: '🦊' }), '🦊')
    assert.equal(initials({ login: '𝒜bc', name: null }), '𝒜B')
  })
})
