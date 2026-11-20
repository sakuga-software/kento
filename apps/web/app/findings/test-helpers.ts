// REV-18. A Findings screen store for the tests of the routes: fixed answers, and the calls it got.
import { precisionOf, type Precision, type PrecisionReport } from './precision.ts'
import type { FindingFacets, FindingQuery, FindingScreenPage, FindingsScreenStore } from './screen.ts'

export const EMPTY_PAGE: FindingScreenPage = {
  rows: [],
  counts: { open: 0, fixed: 0, dismissed: 0, wontfix: 0, stale: 0, closed: 0, all: 0 },
  matching: 0,
  offset: 0,
  page: 1,
  pages: 1,
}

export const EMPTY_REPORT: PrecisionReport = {
  org: precisionOf(0, 0),
  repos: [],
  repoCount: 0,
  rules: [],
  ruleCount: 0,
  reasons: [],
  reasonCount: 0,
  unreasoned: 0,
}

export function fakeFindingsScreenStore(
  answers: { page?: FindingScreenPage; facets?: FindingFacets; report?: PrecisionReport; precisions?: Record<string, Precision> } = {},
) {
  let lists: FindingQuery[] = []
  let store: FindingsScreenStore = {
    async list(_orgId, query = {}) {
      lists.push(query)
      return answers.page ?? EMPTY_PAGE
    },
    async facets() {
      return answers.facets ?? { repos: [], rules: [] }
    },
    async precision() {
      return answers.report ?? EMPTY_REPORT
    },
    async repoPrecisions(_orgId, repoIds) {
      return new Map(repoIds.flatMap((id) => (answers.precisions?.[id] ? [[id, answers.precisions[id]!] as const] : [])))
    },
  }
  return { store, lists }
}
