// REV-112. The cases of the bench from the statuses of the findings in the production database:
// known false positives (dismissed with a reason) and non-regression cases (fixed, wontfix).
//
//   DATABASE_URL=... pnpm -F @kento/web bench:cases <out.json> [--weeks 12] [--max-per-repo 8]
//
// The connection is read-only. `gh` gives the base commit of each pull request. Run the cases with
// `node eval/martian/run.ts --subset <out.json>`: their source is `kento`, apart from the recall.
// The cases name private repositories: <out.json> must be outside this repository, or ignored by git.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { benchCases, caseFindings } from '../app/findings/bench-cases.ts'
import { workTreeOf, wouldTrack } from '../app/findings/bench-out.ts'
import { readOnlyDatabase, run, weeksAgo } from './read-only.ts'

let { values, positionals } = parseArgs({
  options: { weeks: { type: 'string', default: '12' }, 'max-per-repo': { type: 'string', default: '8' } },
  allowPositionals: true,
})
let [out] = positionals
if (!out) {
  console.error('Usage: bench-cases.ts <out.json> [--weeks 12] [--max-per-repo 8]')
  process.exit(2)
}
let root = workTreeOf(import.meta.dirname)
if (root && wouldTrack(out, root)) {
  console.error(`${out} is in the work tree of this repository, and git would track it. Write the cases outside it (the internal bench), or to a file that git ignores.`)
  process.exit(2)
}

function baseOf(repo: string, pr: number): string | null {
  try {
    return execFileSync('gh', ['api', `repos/${repo}/pulls/${pr}`, '--jq', '.base.sha'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

await run(async () => {
  let sql = readOnlyDatabase()
  try {
    let findings = await caseFindings(sql, weeksAgo(Number(values.weeks)))
    let { cases, withoutBase } = benchCases(findings, baseOf, { maxPerRepo: Number(values['max-per-repo']) })
    writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`)
    let golden = cases.reduce((n, c) => n + c.golden.length, 0)
    let known = cases.reduce((n, c) => n + c.false_positives.length, 0)
    console.log(
      `${findings.length} findings, ${cases.length} cases: ${golden} to find again, ${known} known false positives; ` +
        `${withoutBase} pull requests without a base`,
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
})
