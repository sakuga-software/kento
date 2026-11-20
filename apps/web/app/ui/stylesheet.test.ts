// REV-91. Rules of public/assets/kento.css that the redesign replaced: gone, not left behind.
import { readFileSync } from 'node:fs'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const CSS = readFileSync(new URL('../../public/assets/kento.css', import.meta.url), 'utf8')

describe('the stylesheet', () => {
  it('widens the settings for the sidebar only, and keeps 760 px without it (KNT-149)', () => {
    assert.match(CSS, /^\.content:has\(> \.settings-layout\) > \* \{\n {2}width: 100%;\n {2}max-width: 760px;/m)
    assert.match(CSS, /^\.content:has\(> \.settings-layout-nav\) > \* \{\n {2}max-width: 1020px;/m)
  })

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

  it('keeps the bar of a navigation still under reduced motion, and leaves its delay to the script (KNT-144)', () => {
    let rule = CSS.match(/^\.nav-progress \{\n([^}]*)\}/m)?.[1] ?? ''
    assert.match(rule, /\n {2}animation: nav-progress 12s [^;]* forwards;/)
    // No delay in CSS: `animation: none` would drop it under reduced motion. progress.js waits 120 ms.
    assert.doesNotMatch(rule, /animation:[^;]*\d+m?s[^;]*\d+m?s/)
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.nav-progress \{\n {4}animation: none;\n {2}\}\n\}/)
  })
})
