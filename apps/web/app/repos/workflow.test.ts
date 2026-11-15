import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { detectWorkflow, isWorkflowFile } from './workflow.ts'

const CALLER = `name: Sakuga Review
on:
  pull_request:
  issue_comment:
permissions: {}
jobs:
  review:
    uses: sakuga-software/sakuga-review/.github/workflows/review.yml@stable
    secrets:
      PR_AGENT_APP_PRIVATE_KEY: \${{ secrets.PR_AGENT_APP_PRIVATE_KEY }}
`

const REUSABLE = `name: Sakuga Review
on:
  workflow_call:
    inputs:
      trusted_bots:
        type: string
permissions: {}
jobs:
  sakuga_review:
    steps:
      - run: node settings/review/sakuga-review.ts --repo-dir repo
`

describe('the review workflow of a repository', () => {
  it('a caller of review.yml is `reusable`, with its ref', () => {
    assert.deepEqual(detectWorkflow([{ path: '.github/workflows/sakuga-review.yml', text: CALLER }]), {
      mode: 'reusable',
      path: '.github/workflows/sakuga-review.yml',
      ref: 'stable',
    })
    let pinned = CALLER.replace('review.yml@stable', "review.yml@0123456789abcdef0123456789abcdef01234567' # v5")
    assert.equal(detectWorkflow([{ path: '.github/workflows/x.yaml', text: pinned }]).ref, '0123456789abcdef0123456789abcdef01234567')
  })

  it('a copy of the job of review.yml is `copy`; review.yml itself (workflow_call) is neither', () => {
    assert.deepEqual(detectWorkflow([{ path: '.github/workflows/review.yml', text: REUSABLE }]), { mode: 'none', path: null, ref: null })
    let copy = REUSABLE.replace(/on:\n  workflow_call:[\s\S]*?\n(?=\S)/, 'on:\n  pull_request:\n')
    assert.doesNotMatch(copy, /workflow_call:/)
    assert.deepEqual(detectWorkflow([{ path: '.github/workflows/sakuga-review.yml', text: copy }]), {
      mode: 'copy',
      path: '.github/workflows/sakuga-review.yml',
      ref: null,
    })
  })

  it('a caller wins over a copy, and other workflows give `none`', () => {
    let files = [
      { path: '.github/workflows/a-copy.yml', text: 'on: pull_request\njobs:\n  r:\n    steps:\n      - run: node review/sakuga-review.ts\n' },
      { path: '.github/workflows/z-call.yml', text: 'jobs:\n  review:\n    uses: sakuga-software/sakuga-review/.github/workflows/review.yml@stable\n' },
    ]
    assert.equal(detectWorkflow(files).mode, 'reusable')
    assert.equal(detectWorkflow([{ path: '.github/workflows/ci.yml', text: 'on: push\njobs: {}\n' }]).mode, 'none')
    assert.equal(detectWorkflow([]).mode, 'none')
  })

  it('reads .yml and .yaml files only', () => {
    assert.ok(isWorkflowFile('ci.yml'))
    assert.ok(isWorkflowFile('ci.YAML'))
    assert.equal(isWorkflowFile('README.md'), false)
  })
})
