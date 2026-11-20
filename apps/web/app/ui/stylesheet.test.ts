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

  it('runs view transitions between pages only without reduced motion, and keeps the bar still (KNT-145)', () => {
    assert.match(CSS, /@media \(prefers-reduced-motion: no-preference\) \{\n {2}@view-transition \{\n {4}navigation: auto;\n {2}\}\n\}/)
    assert.equal(CSS.match(/@view-transition\b/g)?.length, 1, 'no @view-transition outside of the media query')
    assert.match(CSS, /^\.bar \{[^}]*\n {2}view-transition-name: bar;/m)
    assert.match(CSS, /::view-transition-group\(bar\),\n::view-transition-old\(bar\),\n::view-transition-new\(bar\) \{\n {2}animation: none;/)
    assert.match(CSS, /::view-transition-group\(root\) \{\n {2}animation-duration: 150ms;/)
  })
})
