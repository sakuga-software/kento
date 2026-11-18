// REV-112. The cases of the bench (eval/martian/run.ts) from the statuses of the findings:
//
// - a `dismissed` finding with a reason is a known false positive: a variant must not report it again;
// - a `fixed` or `wontfix` finding is a defect that a variant must find again (non-regression).
//
// These cases have the source `kento`: the findings come from Kentō itself, so they stay out of
// the independent recall of the `feedback` and `martian` cases.
import type postgres from 'postgres'

import { reasonOf } from './precision.ts'

export const KENTO_REVIEWER = 'kento-review[bot]'
/** The bench reads the defect of a golden comment in one sentence: a long scenario is cut. */
const SCENARIO_CHARS = 300

export interface CaseFinding {
  repo: string
  pr: number
  /** The last head where a review found the finding: the defect exists at this commit. */
  sha: string
  path: string
  line: number
  title: string
  scenario: string | null
  severity: string
  category: string
  status: 'fixed' | 'wontfix' | 'dismissed'
  reason: string | null
}

export interface BenchCase {
  source: 'kento'
  repo: string
  url: string
  owner: string
  name: string
  base: string
  head: string
  golden: { comment: string; severity: string; category: string; reviewers: string[] }[]
  false_positives: { comment: string; reviewer: string; reason: string }[]
}

const SEVERITY: Record<string, string> = { critical: 'High', major: 'Medium', minor: 'Low' }
/** The categories of Kentō in the words of the profiles of the bench (eval/martian/profiles.ts). */
const CATEGORY: Record<string, string> = { bug: 'bug', security: 'security', data: 'data', contract: 'api', test: 'test_gap' }

/** "sheet.ts:42 The title. The scenario.", as the defects of eval/internal/label.ts. */
export function caseComment(f: Pick<CaseFinding, 'path' | 'line' | 'title' | 'scenario'>): string {
  let file = f.path.split('/').pop()
  let scenario = f.scenario?.trim().slice(0, SCENARIO_CHARS)
  return [`${file}:${f.line} ${f.title.trim()}`, scenario].filter(Boolean).join('. ')
}

/**
 * The cases of the findings, one commit for each pull request: the commit with the most findings.
 * `baseOf` gives the base commit of a pull request, and is called once for each pull request. A pull
 * request without a base is left out, and does not count in `maxPerRepo`.
 */
export function benchCases(
  findings: CaseFinding[],
  baseOf: (repo: string, pr: number) => string | null,
  options: { maxPerRepo?: number } = {},
): { cases: BenchCase[]; withoutBase: number } {
  let byCommit = new Map<string, CaseFinding[]>()
  for (let f of findings) {
    if (f.status === 'dismissed' && !f.reason) continue
    let key = `${f.repo}#${f.pr}@${f.sha}`
    byCommit.set(key, [...(byCommit.get(key) ?? []), f])
  }
  let candidates = [...byCommit.values()].sort((a, b) => b.length - a.length || caseKey(a[0]!).localeCompare(caseKey(b[0]!)))
  let cases: BenchCase[] = []
  let taken = new Set<string>()
  let bases = new Map<string, string | null>()
  let perRepo = new Map<string, number>()
  for (let group of candidates) {
    let { repo, pr, sha } = group[0]!
    let prKey = `${repo}#${pr}`
    if (taken.has(prKey) || (perRepo.get(repo) ?? 0) >= (options.maxPerRepo ?? Infinity)) continue
    if (!bases.has(prKey)) bases.set(prKey, baseOf(repo, pr))
    let base = bases.get(prKey)
    if (!base) continue
    taken.add(prKey)
    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1)
    let [owner = '', name = repo] = repo.split('/')
    cases.push({
      source: 'kento',
      repo: name,
      url: `kento:${name}#${pr}@${sha.slice(0, 7)}`,
      owner,
      name,
      base,
      head: sha,
      golden: group
        .filter((f) => f.status !== 'dismissed')
        .map((f) => ({ comment: caseComment(f), severity: SEVERITY[f.severity] ?? f.severity, category: CATEGORY[f.category] ?? f.category, reviewers: [KENTO_REVIEWER] })),
      false_positives: group
        .filter((f) => f.status === 'dismissed')
        .map((f) => ({ comment: caseComment(f), reviewer: KENTO_REVIEWER, reason: f.reason! })),
    })
  }
  return { cases, withoutBase: [...bases.values()].filter((base) => !base).length }
}

function caseKey(f: CaseFinding): string {
  return `${f.repo}#${f.pr}@${f.sha}`
}

/**
 * The findings of every org that make a case: fixed, wontfix, or dismissed with a reason. The
 * scenario comes from the result of the last review that found the finding, by its fingerprint.
 */
export async function caseFindings(sql: postgres.Sql, since: Date): Promise<CaseFinding[]> {
  let rows = await sql<CaseFinding[]>`
    select repos.full_name as repo, findings.pr_number as pr, findings.last_seen_sha as sha, findings.path, findings.line,
      findings.title, scenario.text as scenario, findings.severity, findings.category, findings.status::text as status,
      ${reasonOf(sql, 'findings.status_reason')} as reason
    from findings
    join repos on repos.id = findings.repo_id
    left join reviews on reviews.id = findings.last_review_id
    left join lateral (
      select f->>'scenario' as text
      from jsonb_array_elements(case when jsonb_typeof(reviews.result->'findings') = 'array' then reviews.result->'findings' else '[]'::jsonb end) f
      where f->>'fingerprint' = findings.fingerprint
      limit 1
    ) scenario on true
    where findings.updated_at >= ${since.toISOString()}::timestamptz
      and (findings.status in ('fixed', 'wontfix')
        or (findings.status = 'dismissed' and ${reasonOf(sql, 'findings.status_reason')} is not null))
    order by repos.full_name, findings.pr_number, findings.path, findings.line, findings.id`
  return rows.map((r) => ({ ...r, pr: Number(r.pr), line: Number(r.line) }))
}
