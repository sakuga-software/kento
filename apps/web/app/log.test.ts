import * as assert from 'remix/assert'
import { afterEach, beforeEach, describe, it } from 'remix/test'

import { log } from './log.ts'

let lines: { stream: 'stdout' | 'stderr'; line: string }[] = []
let restore: (() => void) | undefined

beforeEach(() => {
  lines = []
  let stdout = process.stdout.write.bind(process.stdout)
  let stderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: unknown) => lines.push({ stream: 'stdout', line: String(chunk) }) > 0) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => lines.push({ stream: 'stderr', line: String(chunk) }) > 0) as typeof process.stderr.write
  restore = () => {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
})

afterEach(() => restore?.())

describe('log', () => {
  it('writes one JSON line, info on stdout and warn on stderr', () => {
    log('info', 'a.b', { jobId: 'j1' })
    log('warn', 'c.d')
    restore?.()
    assert.equal(lines.length, 2)
    assert.equal(lines[0]!.stream, 'stdout')
    assert.equal(lines[1]!.stream, 'stderr')
    assert.ok(lines[0]!.line.endsWith('\n'))
    let first = JSON.parse(lines[0]!.line)
    assert.equal(first.level, 'info')
    assert.equal(first.event, 'a.b')
    assert.equal(first.jobId, 'j1')
    assert.match(first.time, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('never lets a field replace the time, the level or the event of the line', () => {
    log('info', 'dashboard.retry', { level: 'heavy', event: 'other', time: 'yesterday' })
    restore?.()
    let line = JSON.parse(lines[0]!.line)
    assert.equal(line.level, 'info')
    assert.equal(line.event, 'dashboard.retry')
    assert.notEqual(line.time, 'yesterday')
  })
})

describe('errorMessage', () => {
  it('KNT-150: stops before the parameters of a failed query, which can hold a secret', async () => {
    let { errorMessage } = await import('./log.ts')
    let failed = new Error('Failed query: select * from "verifications" where "identifier" = $1\nparams: oauth-state-secret,verifier-secret', {
      cause: Object.assign(new Error('relation does not exist'), { code: '42P01' }),
    })
    let message = errorMessage(failed)
    assert.equal(message, 'Failed query: select * from "verifications" where "identifier" = $1 (42P01)')
    assert.doesNotMatch(message, /secret/)
    assert.equal(errorMessage(new Error('GitHub answered 502')), 'GitHub answered 502')
    assert.equal(errorMessage('plain'), 'plain')
  })
})
