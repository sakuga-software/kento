// REV-91. Rules of public/assets/kento.css that the redesign replaced: gone, not left behind.
import { readFileSync } from 'node:fs'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const CSS = readFileSync(new URL('../../public/assets/kento.css', import.meta.url), 'utf8')

describe('the stylesheet', () => {
  it('has no rule of .list-filters, and one rule for the count of a filter (REV-91)', () => {
    // The filters of Repos and Findings are .segmented-links now.
    assert.doesNotMatch(CSS, /\.list-filters\b/)
    assert.equal(CSS.match(/^\.list-filter-count \{/gm)?.length, 1)
    assert.match(CSS, /^\.list-filter-count \{\n {2}color: inherit;/m)
  })

  it('has no rule left for the theme switch of the foot (KNT-142)', () => {
    assert.doesNotMatch(CSS, /\.footer-settings\b/)
    assert.match(CSS, /^\.js form\[data-theme-switch\] \.button \{\n {2}display: none;/m)
  })
})
