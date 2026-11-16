import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { currentUrl } from './legacy-urls.ts'

const url = (path: string) => new URL(path, 'https://review.sakuga.dev')

describe('currentUrl (REV-115)', () => {
  it('gives each old key and value of a query its name of today, in the same order', () => {
    assert.equal(
      currentUrl(url('/repos/r/pulls/12?statut=open&statut=fixed&avant=c1&suite=c2')),
      '/repos/r/pulls/12?status=open&status=fixed&before=c1&after=c2',
    )
    assert.equal(currentUrl(url('/findings/f?fait=dismissed&github=posted&historique=h')), '/findings/f?done=dismissed&github=posted&history=h')
    assert.equal(currentUrl(url('/findings?status=all&type=a-considerer&vue=precision')), '/findings?status=all&type=to-consider&view=precision')
    assert.equal(currentUrl(url('/feedback?auteur=agent')), '/feedback?author=agent')
    assert.equal(currentUrl(url('/repos/r/pulls/12?relance=queued')), '/repos/r/pulls/12?rerun=queued')
  })

  it('leaves a URL with the names of today', () => {
    assert.equal(currentUrl(url('/findings?status=all&type=to-consider&view=precision')), null)
    assert.equal(currentUrl(url('/settings')), null)
  })

  it('leaves a key on a screen that never wrote it, and a path below a screen', () => {
    assert.equal(currentUrl(url('/repos?vue=x&fait=y')), null)
    assert.equal(currentUrl(url('/findings?fait=y')), null)
    assert.equal(currentUrl(url('/findings/f/dismiss?fait=y')), null)
    assert.equal(currentUrl(url('/api/runner/claim?suite=1')), null)
  })
})
