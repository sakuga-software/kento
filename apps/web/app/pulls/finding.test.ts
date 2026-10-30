import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createReadCode } from './finding.ts'

const TARGET = { repoId: 'r', fullName: 'sakuga-software/orchard', prNumber: 142, installationId: 11, githubRepoId: 7001 }

function setup(answer: (url: string) => Response) {
  let calls: string[] = []
  let minted: string[] = []
  let read = createReadCode({
    apiUrl: 'https://api.github.test',
    mintInstallationToken: async (target) => {
      minted.push(JSON.stringify(target.permissions))
      return { token: 'ghs_x', expiresAt: new Date() } as never
    },
    fetch: (async (url: string) => {
      calls.push(String(url))
      return answer(String(url))
    }) as typeof fetch,
  })
  return { read, calls, minted }
}

const file = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')

describe('createReadCode', () => {
  it('reads the lines around the line of a finding at its commit, with contents: read only, once', async () => {
    let { read, calls, minted } = setup(() => Response.json({ encoding: 'base64', content: Buffer.from(file).toString('base64') }))
    let excerpt = await read(TARGET, { path: 'src/a b.ts', sha: 'abc', line: 47 })
    assert.deepEqual(excerpt, { kind: 'lines', excerpt: { start: 43, lines: ['line 43', 'line 44', 'line 45', 'line 46', 'line 47', 'line 48', 'line 49', 'line 50', 'line 51'] } })
    assert.deepEqual(calls, ['https://api.github.test/repos/sakuga-software/orchard/contents/src/a%20b.ts?ref=abc'])
    assert.deepEqual(minted, ['{"contents":"read"}'])
    await read(TARGET, { path: 'src/a b.ts', sha: 'abc', line: 47 })
    assert.equal(calls.length, 1)
  })

  it('reads a file once per commit and path, and cuts the lines of each finding from it', async () => {
    let { read, calls, minted } = setup(() => Response.json({ encoding: 'base64', content: Buffer.from(file).toString('base64') }))
    await read(TARGET, { path: 'src/a.ts', sha: 'abc', line: 47 })
    let other = await read(TARGET, { path: 'src/a.ts', sha: 'abc', line: 3 })
    assert.deepEqual(other.kind === 'lines' && other.excerpt.lines[0], 'line 1')
    assert.equal(calls.length, 1)
    assert.equal(minted.length, 1)
    await read(TARGET, { path: 'src/a.ts', sha: 'def', line: 3 })
    assert.equal(calls.length, 2)
  })

  it('keeps no failure of GitHub: the next read asks again', async () => {
    let n = 0
    let { read, calls } = setup(() => (n++ === 0 ? new Response('{}', { status: 502 }) : Response.json({ encoding: 'base64', content: Buffer.from(file).toString('base64') })))
    await assert.rejects(() => read(TARGET, { path: 'x', sha: 's', line: 3 }))
    assert.equal((await read(TARGET, { path: 'x', sha: 's', line: 3 })).kind, 'lines')
    assert.equal(calls.length, 2)
  })

  it('cuts the lines of a file with CRLF ends without their carriage return', async () => {
    let { read } = setup(() => Response.json({ encoding: 'base64', content: Buffer.from('a\r\nb\r\nc').toString('base64') }))
    assert.deepEqual(await read(TARGET, { path: 'x', sha: 's', line: 2 }), { kind: 'lines', excerpt: { start: 1, lines: ['a', 'b', 'c'] } })
  })

  it('shows the start of the file for a finding with no line', async () => {
    let { read } = setup(() => Response.json({ encoding: 'base64', content: Buffer.from(file).toString('base64') }))
    let excerpt = await read(TARGET, { path: 'x', sha: 's', line: 0 })
    assert.deepEqual(excerpt.kind === 'lines' && [excerpt.excerpt.start, excerpt.excerpt.lines.length], [1, 9])
  })

  it('keeps to the first and the last line of the file', async () => {
    let { read } = setup(() => Response.json({ encoding: 'base64', content: Buffer.from('a\nb\nc').toString('base64') }))
    assert.deepEqual(await read(TARGET, { path: 'x', sha: 's', line: 1 }), { kind: 'lines', excerpt: { start: 1, lines: ['a', 'b', 'c'] } })
  })

  it('tells a file that is not at that commit from a file that has no such line', async () => {
    let gone = setup(() => new Response('{"message":"Not Found"}', { status: 404 }))
    assert.deepEqual(await gone.read(TARGET, { path: 'gone.ts', sha: 's', line: 3 }), { kind: 'missing' })
    let short = setup(() => Response.json({ encoding: 'base64', content: Buffer.from('a\nb').toString('base64') }))
    assert.deepEqual(await short.read(TARGET, { path: 'x', sha: 's', line: 40 }), { kind: 'short', length: 2 })
    let empty = setup(() => Response.json({ encoding: 'base64', content: '' }))
    assert.deepEqual(await empty.read(TARGET, { path: 'x', sha: 's', line: 3 }), { kind: 'empty' })
    let directory = setup(() => Response.json([{ type: 'file', name: 'a.ts' }]))
    assert.deepEqual(await directory.read(TARGET, { path: 'src', sha: 's', line: 3 }), { kind: 'unreadable' })
    let large = setup(() => Response.json({ encoding: 'none', content: '' }))
    assert.deepEqual(await large.read(TARGET, { path: 'big.json', sha: 's', line: 3 }), { kind: 'unreadable' })
  })
})
