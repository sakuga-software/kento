import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { workTreeOf, wouldTrack } from './bench-out.ts'

describe('wouldTrack', () => {
  it('refuses a path of the work tree, and accepts an ignored file or a path outside it', () => {
    let dir = mkdtempSync(join(tmpdir(), 'bench-out-'))
    try {
      let root = join(dir, 'repo')
      mkdirSync(join(root, 'eval', 'internal'), { recursive: true })
      execFileSync('git', ['init', '-q', root])
      writeFileSync(join(root, '.gitignore'), 'private/\n')
      assert.equal(wouldTrack(join(root, 'eval', 'internal', 'subset-kento.json'), root), true)
      assert.equal(wouldTrack(join(root, 'eval', 'new-folder', 'cases.json'), root), true)
      assert.equal(wouldTrack(join(root, '..cases', 'subset-kento.json'), root), true)
      assert.equal(wouldTrack(join(root, 'private', 'subset-kento.json'), root), false)
      assert.equal(wouldTrack(join(dir, 'internal-bench', 'subset-kento.json'), root), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses the path that the README gave before REV-121, in this repository', () => {
    let root = workTreeOf(import.meta.dirname)
    assert.ok(root, 'the tests run in a git work tree')
    assert.equal(wouldTrack(join(root, 'eval', 'internal', 'subset-kento.json'), root), true)
  })
})

describe('workTreeOf', () => {
  it('gives null for a folder that no work tree holds', () => {
    let dir = mkdtempSync(join(tmpdir(), 'bench-out-'))
    try {
      assert.equal(workTreeOf(dir), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
