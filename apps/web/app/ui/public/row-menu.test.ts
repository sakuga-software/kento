// KNT-163. The menu "…" makes the URL of the findings of its row itself, from its id only. This
// file sits in a public/ folder on purpose: app/assets.test.ts checks that the asset server never
// serves it (`denyFiles`).
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { findingsHref } from '../findings.tsx'
import { repoFindingsHref } from './row-menu.tsx'

describe('the menu "…" of a row', () => {
  it('links to the same findings as the Findings screen', () => {
    let id = '00000000-0000-4000-8000-000000000001'
    assert.equal(repoFindingsHref(id), findingsHref({ repoId: id }))
  })
})
