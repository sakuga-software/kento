// REV-112. The weekly measures of the reviews, from the production database, in Markdown or JSON.
//
//   DATABASE_URL=... pnpm -F @kento/web measures [--weeks 12] [--json]
//
// The connection is read-only. app/findings/measures.ts gives the formulas.
import { parseArgs } from 'node:util'

import { measuresReport, renderMeasures } from '../app/findings/measures.ts'
import { readOnlyDatabase, run, weeksAgo } from './read-only.ts'

let { values } = parseArgs({ options: { weeks: { type: 'string', default: '12' }, json: { type: 'boolean', default: false } } })

await run(async () => {
  let sql = readOnlyDatabase()
  try {
    let report = await measuresReport(sql, weeksAgo(Number(values.weeks)))
    process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderMeasures(report))
  } finally {
    await sql.end({ timeout: 5 })
  }
})
