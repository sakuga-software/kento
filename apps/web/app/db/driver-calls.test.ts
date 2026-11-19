// postgres.js 4 removed `sql.array()`: a call throws ARRAY_REMOVED at run time. Its type still
// compiles (it returns `never`), so neither tsc nor oxlint refuses it. This test does.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

const WEB = fileURLToPath(new URL('../../', import.meta.url))
const FOLDERS = ['app', 'test', 'e2e', 'scripts']
const SELF = fileURLToPath(import.meta.url)

/** `sql.array(`, `tx.array(`, `input.sql.array(`. A column of drizzle, `text('x').array()`, has a `)` before it. */
export const ARRAY_CALL = /(?<![\w$)\]])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.array\(/

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    let path = join(folder, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('calls of the database driver', () => {
  it('never call sql.array(): pass the array as it is, with a cast (`${ids}::uuid[]`)', () => {
    let found = FOLDERS.flatMap((folder) =>
      sources(join(WEB, folder))
        .filter((path) => path !== SELF)
        .flatMap((path) =>
          readFileSync(path, 'utf8')
            .split('\n')
            .flatMap((line, i) => (ARRAY_CALL.test(line) ? [`${relative(WEB, path)}:${i + 1}`] : [])),
        ),
    )
    assert.deepEqual(found, [])
  })

  it('finds a call of sql.array() and leaves a column of drizzle alone', () => {
    for (let line of ['and id = any(${sql.array(ids)}::uuid[])', 'set x = ${tx.array(next)}::text[]', 'key = any(${input.sql.array(keys)})']) {
      assert.ok(ARRAY_CALL.test(line), line)
    }
    for (let line of ["labels: text('labels').array().notNull()", 'let xs = Array.from(ys)', 'rows.map((r) => r.id)']) {
      assert.ok(!ARRAY_CALL.test(line), line)
    }
  })
})
