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

  it('runs view transitions between pages only without reduced motion, and keeps the bar still (KNT-145)', () => {
    let block = CSS.match(/^@media \(prefers-reduced-motion: no-preference\) \{\n([\s\S]*?)\n\}$/m)?.[1] ?? ''
    assert.match(block, /^ {2}@view-transition \{\n {4}navigation: auto;\n {2}\}/)
    assert.match(block, /\n {2}::view-transition-group\(root\) \{\n {4}animation-duration: 150ms;/)
    assert.match(block, /\n {2}::view-transition-group\(bar\),\n {2}::view-transition-old\(bar\),\n {2}::view-transition-new\(bar\) \{\n {4}animation: none;/)
    assert.match(block, /\n {2}\.bar \{\n {4}view-transition-name: bar;\n {2}\}/)
    // Nothing of the transitions outside of that query.
    let outside = CSS.replace(block, '')
    assert.doesNotMatch(outside, /@view-transition|::view-transition|view-transition-name/)
  })
})
