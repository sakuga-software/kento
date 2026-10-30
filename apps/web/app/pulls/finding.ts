// REV-17. The detail of one finding: where it comes from (a pass of the model or a rule), the last
// review that found it (its model, its scenario and its fix), the code around its line on GitHub, and
// the history of its status. Every read takes the org of the session.
import { findingKey } from '@sakuga-review/engine/findings'
import type { Level } from '@sakuga-review/protocol'
import type postgres from 'postgres'

import type { MintInstallationToken } from '../github/installation-token.ts'
import { decodeCursor, encodeCursor, cursorAt, UUID, type FindingEventType, type FindingStatus, type Page } from '../findings/store.ts'
import { fetchWithin, SCREEN_GITHUB_TIMEOUT_MS } from '../github/fetch.ts'
import { createGitHub } from '../publish/github.ts'
import type { PullTarget } from './store.ts'

/** The events of a page of the history. */
export const HISTORY_PAGE = 20
/** The lines of code shown above and under the line of a finding. */
export const CODE_CONTEXT = 4
export interface FindingDetail {
  id: string
  target: PullTarget
  title: string
  path: string
  line: number
  severity: 'critical' | 'major' | 'minor'
  category: string
  confidence: number
  status: FindingStatus
  statusReason: string | null
  /** The rule that the finding applies, or null for a finding of the pass of the model. */
  rule: { id: string; title: string | null } | null
  fingerprint: string
  firstSeenSha: string
  lastSeenSha: string
  githubCommentId: number | null
  /** The last review that found it, and what its result says of it. Null once that review is removed. */
  review: { id: string; number: number; level: Level; model: string; headSha: string; scenario: string; fix: string; suggestion: string } | null
}

export interface HistoryEvent {
  id: string
  type: FindingEventType
  actor: string
  reason: string | null
  /** The R number of the review that wrote it, or null for a person or the sweep. */
  review: number | null
  createdAt: Date
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value))
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** The finding `id` of the org, or null. */
export async function readFindingDetail(sql: postgres.Sql, orgId: string, id: string): Promise<FindingDetail | null> {
  if (!UUID.test(id)) return null
  let [row] = await sql<
    {
      id: string
      repoId: string
      fullName: string
      prNumber: number
      installationId: string
      githubRepoId: string
      title: string
      path: string
      line: number
      severity: FindingDetail['severity']
      category: string
      confidence: number
      status: FindingStatus
      statusReason: string | null
      ruleId: string | null
      ruleTitle: string | null
      fingerprint: string
      key: string
      firstSeenSha: string
      lastSeenSha: string
      githubCommentId: number | null
      lastReviewId: string | null
    }[]
  >`
    select f.id, f.repo_id as "repoId", repos.full_name as "fullName", f.pr_number as "prNumber",
      orgs.github_installation_id::text as "installationId", repos.github_repo_id::text as "githubRepoId",
      f.title, f.path, f.line, f.severity, f.category, f.confidence, f.status, f.status_reason as "statusReason",
      f.rule_id as "ruleId", rules.title as "ruleTitle", f.fingerprint, f.key,
      f.first_seen_sha as "firstSeenSha", f.last_seen_sha as "lastSeenSha",
      f.github_comment_id::float8 as "githubCommentId", f.last_review_id as "lastReviewId"
    from findings f
    join repos on repos.id = f.repo_id
    join orgs on orgs.id = repos.org_id
    left join rules on rules.id = f.rule_id and rules.org_id = repos.org_id
    where f.id = ${id} and repos.org_id = ${orgId}`
  if (!row) return null

  let review: FindingDetail['review'] = null
  if (row.lastReviewId) {
    let [r] = await sql<{ id: string; number: number; level: Level; model: string; headSha: string }[]>`
      select r.id, j.level, r.model, r.head_sha as "headSha",
        (select count(*)::int from reviews e
          where e.repo_id = r.repo_id and e.pr_number = r.pr_number and (e.created_at, e.id) <= (r.created_at, r.id)) as number
      from reviews r join jobs j on j.id = r.job_id
      where r.id = ${row.lastReviewId}`
    // The finding in the result of that review only: its fingerprint, else its key.
    let found = await sql<{ fingerprint: string | null; path: unknown; title: unknown; scenario: unknown; fix: unknown; suggestion: unknown }[]>`
      select f->>'fingerprint' as fingerprint, f->'path' as path, f->'title' as title, f->'scenario' as scenario,
        f->'fix' as fix, f->'suggestion' as suggestion
      from reviews r
      cross join lateral jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) f
      where r.id = ${row.lastReviewId}`
    let hit =
      found.find((f) => row.fingerprint !== '' && f.fingerprint === row.fingerprint) ??
      found.find((f) => typeof f.path === 'string' && typeof f.title === 'string' && findingKey({ path: f.path, title: f.title } as never) === row.key)
    if (r) review = { ...r, scenario: text(hit?.scenario), fix: text(hit?.fix), suggestion: text(hit?.suggestion) }
  }

  return {
    id: row.id,
    target: {
      repoId: row.repoId,
      fullName: row.fullName,
      prNumber: row.prNumber,
      installationId: Number(row.installationId),
      githubRepoId: Number(row.githubRepoId),
    },
    title: row.title,
    path: row.path,
    line: row.line,
    severity: row.severity,
    category: row.category,
    confidence: row.confidence,
    status: row.status,
    statusReason: row.statusReason,
    rule: row.ruleId ? { id: row.ruleId, title: row.ruleTitle } : null,
    fingerprint: row.fingerprint,
    firstSeenSha: row.firstSeenSha,
    lastSeenSha: row.lastSeenSha,
    githubCommentId: row.githubCommentId === null ? null : Number(row.githubCommentId),
    review,
  }
}

/** A page of the history of a finding of the org, oldest first, with the R number of each review. */
export async function readFindingHistory(
  sql: postgres.Sql,
  input: { orgId: string; findingId: string; cursor?: string | null },
): Promise<Page<HistoryEvent>> {
  if (!UUID.test(input.findingId)) return { items: [], nextCursor: null }
  let cursor = decodeCursor(input.cursor)
  let rows = await sql<(HistoryEvent & { cursorAt: string })[]>`
    select e.id, e.type, e.actor, e.reason, e.created_at as "createdAt",
      ${sql.unsafe(cursorAt('e.created_at'))} as "cursorAt",
      case when r.id is null then null else (select count(*)::int from reviews x
        where x.repo_id = r.repo_id and x.pr_number = r.pr_number and (x.created_at, x.id) <= (r.created_at, r.id)) end as review
    from finding_events e
    join findings f on f.id = e.finding_id
    join repos on repos.id = f.repo_id
    left join reviews r on r.id = e.review_id
    where e.finding_id = ${input.findingId} and repos.org_id = ${input.orgId}
      ${cursor ? sql`and (e.created_at, e.id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
    order by e.created_at, e.id
    limit ${HISTORY_PAGE + 1}`
  let kept = rows.slice(0, HISTORY_PAGE)
  let last = kept.at(-1)
  return {
    items: kept.map((r) => ({ id: r.id, type: r.type, actor: r.actor, reason: r.reason, review: r.review, createdAt: toDate(r.createdAt) })),
    nextCursor: rows.length > HISTORY_PAGE && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
  }
}

/** A few lines of a file at a commit, numbered from `start`. */
export interface CodeExcerpt {
  start: number
  lines: string[]
}

/**
 * The code of a finding: its lines, or why there are none. `missing`: the file is not at that commit
 * (a force-push removed the commit, or a rename); `short`: the file has no such line; `empty`: the file
 * is empty at that commit; `unreadable`: the
 * path is a directory, or GitHub gives no content for it (a file over 1 MB).
 */
export type CodeRead = { kind: 'lines'; excerpt: CodeExcerpt } | { kind: 'missing' } | { kind: 'short'; length: number } | { kind: 'empty' } | { kind: 'unreadable' }

export type ReadCode = (target: PullTarget, input: { path: string; sha: string; line: number }) => Promise<CodeRead>

/**
 * Reads the lines around `line` of a file at a commit on GitHub, with a token `contents: read` for
 * the repository only.
 */
/** The files whose text the service keeps, by commit and path. A file of GitHub is at most 1 MB. */
const CODE_CACHE_FILES = 32

/** The lines around `line` of the text of a file, or why there are none. */
export function excerptOf(text: string, line: number): CodeRead {
  if (text === '') return { kind: 'empty' }
  let all = text.split('\n')
  // A finding with no line (a thread of an earlier release, with no anchor) shows the start of its file.
  let at = line >= 1 ? line : CODE_CONTEXT + 1
  if (at > all.length) return { kind: 'short', length: all.length }
  let start = Math.max(1, at - CODE_CONTEXT)
  let end = Math.min(all.length, at + CODE_CONTEXT)
  return { kind: 'lines', excerpt: { start, lines: all.slice(start - 1, end) } }
}

export function createReadCode(deps: { mintInstallationToken: MintInstallationToken; apiUrl: string; fetch?: typeof globalThis.fetch }): ReadCode {
  // The text of a file at a commit never changes: it is kept by commit and path, and each finding of
  // the file cuts its own lines from it. A file that cannot be read is kept as such. A failure of
  // GitHub throws, and is never kept.
  let cache = new Map<string, string | { kind: 'missing' | 'unreadable' }>()
  return async (target, input) => {
    let key = `${target.githubRepoId}:${input.sha}:${input.path}`
    let hit = cache.get(key)
    if (hit !== undefined) return typeof hit === 'string' ? excerptOf(hit, input.line) : hit
    let token = await deps.mintInstallationToken({ installationId: target.installationId, githubRepoId: target.githubRepoId, permissions: { contents: 'read' } })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: fetchWithin(SCREEN_GITHUB_TIMEOUT_MS, deps.fetch) })
    let path = input.path.split('/').map(encodeURIComponent).join('/')
    let read: string | { kind: 'missing' | 'unreadable' }
    try {
      let file: { content?: unknown; encoding?: unknown } = await github.rest(
        'GET',
        `/repos/${target.fullName}/contents/${path}?ref=${encodeURIComponent(input.sha)}`,
      )
      // A directory gives a list; a file over 1 MB gives no content (`encoding: none`).
      read = typeof file.content === 'string' && file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : { kind: 'unreadable' }
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
      read = { kind: 'missing' }
    }
    if (cache.size >= CODE_CACHE_FILES) cache.delete(cache.keys().next().value!)
    cache.set(key, read)
    return typeof read === 'string' ? excerptOf(read, input.line) : read
  }
}
