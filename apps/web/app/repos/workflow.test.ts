import { readFileSync } from 'node:fs'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { detectWorkflow, isWorkflowFile } from './workflow.ts'

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')

describe('the review workflow of a repository', () => {
  it('a caller of review.yml is `reusable`, with its ref', () => {
    let caller = read('examples/sakuga-review.yml')
    assert.deepEqual(detectWorkflow([{ path: '.github/workflows/sakuga-review.yml', text: caller }]), {
      mode: 'reusable',
      path: '.github/workflows/sakuga-review.yml',
      ref: 'stable',
    })
    let pinned = caller.replace('review.yml@stable', "review.yml@0123456789abcdef0123456789abcdef01234567' # v5")
    assert.equal(detectWorkflow([{ path: '.github/workflows/x.yaml', text: pinned }]).ref, '0123456789abcdef0123456789abcdef01234567')
  })

  it('a copy of the job of review.yml is `copy`; review.yml itself (workflow_call) is neither', () => {
    let reusable = read('.github/workflows/review.yml')
    assert.deepEqual(detectWorkflow([{ path: '.github/workflows/review.yml', text: reusable }]), { mode: 'none', path: null, ref: null })
    let copy = reusable.replace(/on:\n  workflow_call:[\s\S]*?\n(?=\S)/, 'on:\n  pull_request:\n')
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
