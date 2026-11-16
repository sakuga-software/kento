// REV-100. A new finding on code that an earlier review already read, not critical, gets no thread
// and does not ask for changes: the block lists it under "To consider (code already reviewed)", and the
// database keeps it. A critical one keeps its thread and blocks. The finding is the one of dojo#91.
import type { ReviewFinding, ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { BOT, createFakeGitHub } from '../../test/fake-github.ts'
import type { FindingsLedger, LedgerEntry } from '../findings/ledger.ts'
import type { StoredFinding } from '../findings/lifecycle.ts'
import { createGitHub } from './github.ts'
import { publishReview } from './publish.ts'

const HEAD1 = '1'.repeat(40)
const HEAD2 = '2'.repeat(40)
const SETTINGS = 'apps/app/src/routes/investigations/id/settings/page.tsx'

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: SETTINGS,
    start_line: 33,
    line: 33,
    severity: 'major',
    category: 'contract',
    confidence: 90,
    title: 'STUDIO_HOST is neither in .env.example nor documented',
    scenario: 'The page reads process.env.STUDIO_HOST, which .env.example lacks.',
    fix: 'Add STUDIO_HOST to .env.example.',
    suggestion: '',
    anchor: 33,
    blocking: false,
    suggestion_range: null,
    seen: true,
    ...overrides,
  }
}

function payload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    level: 'lite',
    base: 'a'.repeat(40),
    head: HEAD2,
    score: 4,
    verdict: 'APPROVE',
    model: 'm',
    provider: null,
    costUsd: 0.01,
    promptTokens: 1,
    completionTokens: 1,
    summary: 'Summary.',
    risk: 'Risk.',
    diagram: null,
    deeperReview: null,
    findings: [finding()],
    notReviewed: [],
    skipped: [],
    ...overrides,
  }
}

function setup() {
  let fake = createFakeGitHub({ head: HEAD2, commits: { [HEAD1]: 'feat', [HEAD2]: 'fix' } })
  let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake_issues_pull_requests_1', fetch: fake.fetch })
  let target = { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com' }
  let rows: StoredFinding[] = []
  let ledger: FindingsLedger = {
    async load() {
      return rows.map((r) => ({ ...r, loadedStatus: r.status }))
    },
    async save(entries: LedgerEntry[]) {
      for (let e of entries) if (e.id === null) rows.push({ ...e.values, id: `row-${rows.length + 1}` })
    },
  }
  let publish = (review: ReviewPayload) => publishReview(github, target, review, { findings: ledger })
  return { fake, publish, rows }
}

describe('a new finding on code already read (REV-100)', () => {
  it('gets no thread, does not ask for changes, is listed apart, and stays a finding', async () => {
    let { fake, publish, rows } = setup()
    let outcome = await publish(payload())
    assert.equal(outcome.inline, 0)
    assert.equal(outcome.score, 4)
    assert.equal(fake.botThreads().length, 0)
    assert.equal(fake.state.reviews.at(-1)!.state, 'APPROVED')
    assert.match(fake.state.pr.body, /<h3>To consider \(code already reviewed\)<\/h3>[\s\S]*STUDIO_HOST is neither in \.env\.example nor documented/)
    assert.doesNotMatch(fake.state.pr.body, /<h3>Findings<\/h3>/)
    assert.deepEqual(rows.map((r) => [r.title, r.status]), [['STUDIO_HOST is neither in .env.example nor documented', 'open']])
  })

  it('guard: a critical finding on code already read keeps its thread and asks for changes', async () => {
    let { fake, publish } = setup()
    let critical = finding({ severity: 'critical', title: 'The session token goes into STUDIO_HOST', blocking: true })
    let outcome = await publish(payload({ score: 2, verdict: 'REQUEST_CHANGES', findings: [critical] }))
    assert.equal(outcome.inline, 1)
    assert.equal(fake.state.reviews.at(-1)!.state, 'CHANGES_REQUESTED')
    assert.match(fake.state.pr.body, /<h3>Findings<\/h3>/)
  })

  it('guard: the same P1 on code that changed keeps its thread and asks for changes', async () => {
    let { fake, publish } = setup()
    let outcome = await publish(payload({ score: 2, verdict: 'REQUEST_CHANGES', findings: [finding({ seen: undefined, blocking: true })] }))
    assert.equal(outcome.inline, 1)
    assert.equal(fake.state.reviews.at(-1)!.state, 'CHANGES_REQUESTED')
  })
})
