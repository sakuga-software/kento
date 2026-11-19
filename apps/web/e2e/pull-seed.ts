// REV-17. A pull request with four reviews, for the screen of a pull request in a browser
// (e2e/pull.spec.ts) and for its pictures: orchard #142.
//
// - A "The session token never expires": posted by R1, moved from line 42 to 47 by R2 with no
//   new comment, found again by R3 and R4. Open.
// - B "API key written to the logs": posted by R1, fixed by R2.
// - C "List with no stable key": posted by R1, found again by R2, dismissed by camille (False positive)
//   before R3. R3 and R4 leave it out.
// - D "SQL query built by concatenation": posted by R2, absent from R3 (its file did not
//   change), kept by octocat (wontfix) before R4.
import { findingKey } from '@sakuga-review/engine/findings'
import type postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'

export const PULL_REPO = { githubRepoId: 7001, fullName: 'sakuga-software/orchard' }
export const PULL_NUMBER = 142

type Seeded = { orgId: string; repoId: string; findings: Record<'A' | 'B' | 'C' | 'D', string>; reviews: string[] }

const FINDINGS = {
  A: { path: 'src/auth/session.ts', title: 'The session token never expires', severity: 'major', fingerprint: 'a1a1a1a1a1a1a1a1', comment: 914201 },
  B: { path: 'src/api/keys.ts', title: 'API key written to the logs', severity: 'critical', fingerprint: 'b2b2b2b2b2b2b2b2', comment: 914202 },
  C: { path: 'src/ui/list.tsx', title: 'List with no stable key', severity: 'minor', fingerprint: 'c3c3c3c3c3c3c3c3', comment: 914203 },
  D: { path: 'src/db/query.ts', title: 'SQL query built by concatenation', severity: 'major', fingerprint: 'd4d4d4d4d4d4d4d4', comment: 914204 },
} as const
type Name = keyof typeof FINDINGS

function resultFinding(name: Name, line: number) {
  let f = FINDINGS[name]
  return {
    path: f.path,
    start_line: line,
    line,
    severity: f.severity,
    category: name === 'B' || name === 'D' ? 'security' : 'bug',
    confidence: 88,
    title: f.title,
    scenario: `Scenario of ${name}.`,
    fix: `Fix of ${name}.`,
    suggestion: '',
    anchor: line,
    blocking: f.severity === 'critical',
    suggestion_range: null,
    fingerprint: f.fingerprint,
  }
}

/** Writes orchard #142 (and its org and repository) once; a second call changes nothing. */
export async function seedPull(sql: postgres.Sql, now = Date.now()): Promise<Seeded> {
  let [org] = await sql<{ id: string }[]>`
    insert into orgs (github_installation_id, github_account_id, login)
    values (${FAKE_ORG.installationId}, ${FAKE_ORG.accountId}, ${FAKE_ORG.login})
    on conflict (github_installation_id) do update set login = excluded.login
    returning id`
  let [repo] = await sql<{ id: string }[]>`
    insert into repos (org_id, github_repo_id, full_name, enabled)
    values (${org!.id}, ${PULL_REPO.githubRepoId}, ${PULL_REPO.fullName}, true)
    on conflict (github_repo_id) do update set enabled = true
    returning id`
  let repoId = repo!.id
  let existing = await sql<{ id: string; title: string }[]>`select id, title from findings where repo_id = ${repoId} and pr_number = ${PULL_NUMBER}`
  if (existing.length) {
    let ids = Object.fromEntries((Object.keys(FINDINGS) as Name[]).map((n) => [n, existing.find((e) => e.title === FINDINGS[n].title)!.id]))
    let reviews = await sql<{ id: string }[]>`select id from reviews where repo_id = ${repoId} and pr_number = ${PULL_NUMBER} order by created_at`
    return { orgId: org!.id, repoId, findings: ids as Seeded['findings'], reviews: reviews.map((r) => r.id) }
  }

  let minutes = (m: number) => new Date(now - m * 60_000).toISOString()
  let plan = [
    { level: 'lite', head: 'a'.repeat(40), at: 180, score: 2, cost: 0.0042, model: 'claude-haiku-4-5', found: [['A', 42], ['B', 88], ['C', 12]] },
    { level: 'balanced', head: 'b'.repeat(40), at: 120, score: 3, cost: 0.118, model: 'claude-sonnet-4-5', found: [['A', 47], ['C', 12], ['D', 30]] },
    { level: 'heavy', head: 'c'.repeat(40), at: 60, score: 4, cost: 0.41, model: 'claude-opus-4-1', found: [['A', 47], ['C', 12]] },
    { level: 'lite', head: 'd'.repeat(40), at: 10, score: 4, cost: 0.0039, model: 'claude-haiku-4-5', found: [['A', 47]] },
  ] as const
  let reviews: string[] = []
  for (let p of plan) {
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, created_at, started_at, finished_at, attempts)
      values (${repoId}, 'review', ${p.level}, 'done', ${PULL_NUMBER}, ${p.head}, 'main', ${minutes(p.at + 3)}, ${minutes(p.at + 2)}, ${minutes(p.at)}, 1)
      returning id`
    let result = { level: p.level, head: p.head, score: p.score, findings: p.found.map(([n, line]) => resultFinding(n, line)) }
    let [review] = await sql<{ id: string }[]>`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at, created_at)
      values (${job!.id}, ${repoId}, ${PULL_NUMBER}, ${p.head}, ${p.score}, ${p.model}, ${p.cost}, ${JSON.stringify(result)}::text::jsonb, ${minutes(p.at)}, ${minutes(p.at + 1)})
      returning id`
    reviews.push(review!.id)
  }

  let ids = {} as Record<Name, string>
  let insert = async (name: Name, line: number, status: string, reason: string | null, first: number, last: number, createdAt: number) => {
    let f = FINDINGS[name]
    let [row] = await sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        status_reason, first_review_id, last_review_id, first_seen_sha, last_seen_sha, github_comment_id, github_thread_id, created_at)
      values (${repoId}, ${PULL_NUMBER}, ${f.fingerprint}, ${findingKey({ path: f.path, title: f.title } as never)}, ${f.path}, ${line},
        ${f.title}, ${f.severity}, ${name === 'B' || name === 'D' ? 'security' : 'bug'}, 88, ${status}, ${reason},
        ${reviews[first]!}, ${reviews[last]!}, ${plan[first]!.head}, ${plan[last]!.head}, ${f.comment}, ${`PRRT_${name}`}, ${minutes(createdAt)})
      returning id`
    ids[name] = row!.id
  }
  await insert('A', 47, 'open', null, 0, 3, 180.5)
  await insert('B', 88, 'fixed', null, 0, 0, 180.4)
  await insert('C', 12, 'dismissed', 'False positive', 0, 2, 180.3)
  await insert('D', 30, 'wontfix', 'Off topic for this PR', 1, 1, 120.5)

  let event = async (name: Name, review: number | null, type: string, actor: string, reason: string | null, at: number) => {
    await sql`
      insert into finding_events (finding_id, review_id, type, actor, reason, created_at)
      values (${ids[name]}, ${review === null ? null : reviews[review]!}, ${type}, ${actor}, ${reason}, ${minutes(at)})`
  }
  await event('A', 0, 'opened', 'kento', null, 180.5)
  await event('B', 0, 'opened', 'kento', null, 180.4)
  await event('C', 0, 'opened', 'kento', null, 180.3)
  await event('B', 1, 'fixed', 'kento', null, 120.4)
  await event('D', 1, 'opened', 'kento', null, 120.5)
  await event('C', null, 'dismissed', 'camille', 'False positive', 90)
  await event('D', null, 'wontfix', 'octocat', 'Off topic for this PR', 30)
  return { orgId: org!.id, repoId, findings: ids, reviews }
}
