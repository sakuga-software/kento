// REV-16. A 👎 of a person on the comment of a finding dismisses it. GitHub sends no webhook for a
// reaction: the publisher reads the reactions of the open findings before each review, and a sweep
// reads them again every few minutes (sweepReactions, run by the publisher).
import type postgres from 'postgres'

import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { WRITERS } from '../github/permissions.ts'
import { errorMessage, log } from '../log.ts'
import { createGitHub, GitHubError, type GitHub } from '../publish/github.ts'

/** The reason of a finding dismissed by a 👎: the person gave none. */
export const REACTION_REASON = 'no reason, GitHub reaction'

/** The open findings that one sweep reads, the least recently read first. */
export const SWEEP_BATCH = 50

/** Read the reactions of the review comments. */
const SWEEP_PERMISSIONS: TokenPermissions = { pull_requests: 'read' }

type Reaction = { content: string; user: { login: string; type?: string } | null }

/**
 * Whether a login can write to the repository, read once per login in `cache`. A 404 means the login
 * is not a collaborator. Any other error throws: the finding then stays open, and the next read
 * tries again.
 */
export async function canWrite(github: GitHub, fullName: string, login: string, cache: Map<string, boolean> = new Map()): Promise<boolean> {
  let known = cache.get(login)
  if (known !== undefined) return known
  let writer = false
  try {
    let out: { permission?: string; role_name?: string } = await github.rest(
      'GET',
      `/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`,
    )
    writer = WRITERS.has(out.permission ?? '') || WRITERS.has(out.role_name ?? '')
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error
  }
  cache.set(login, writer)
  return writer
}

/**
 * The login of the first person who can write to the repository and put 👎 on a review comment, or
 * null. On a public repository anyone can react: the 👎 of a person without write access, and the 👎
 * of a bot, do not count, as for the commands. `writers` keeps the permissions read in one run.
 * GitHub answers 404 for a comment deleted meanwhile: null too, and logged. The endpoint needs
 * `pull_requests: read` (« List reactions for a pull request review comment »).
 */
export async function thumbsDownBy(
  github: GitHub,
  fullName: string,
  commentId: number,
  writers: Map<string, boolean> = new Map(),
): Promise<string | null> {
  let reactions: Reaction[]
  try {
    reactions = (await github.rest('GET', `/repos/${fullName}/pulls/comments/${commentId}/reactions?content=-1&per_page=100`)) ?? []
  } catch (error) {
    // A comment deleted meanwhile, or a token that cannot see it: logged, so that a 👎 missed for a
    // lack of permission is never silent. GitHub answers 403 for a missing permission: it throws.
    if (error instanceof GitHubError && error.status === 404) {
      log('warn', 'findings.reaction_comment_missing', { repo: fullName, commentId })
      return null
    }
    throw error
  }
  for (let r of reactions) {
    let login = r.user?.login
    if (r.content !== '-1' || !login || r.user?.type === 'Bot' || login.endsWith('[bot]')) continue
    if (await canWrite(github, fullName, login, writers)) return login
  }
  return null
}

type Due = {
  id: string
  commentId: number
  fullName: string
  githubRepoId: string | number
  installationId: string | number
}

/**
 * Reads the 👎 of the open findings that have a comment, SWEEP_BATCH at most, the least recently
 * read first. A 👎 dismisses the finding, with no review in its event. A failure on one repository
 * (its token, GitHub) is logged, and the sweep goes on with the next one.
 */
export async function sweepReactions(
  sql: postgres.Sql,
  deps: { mintInstallationToken: MintInstallationToken; apiUrl: string; fetch?: typeof globalThis.fetch },
  limit = SWEEP_BATCH,
): Promise<{ checked: number; dismissed: number }> {
  let due = await sql<Due[]>`
    select findings.id, findings.github_comment_id::float8 as "commentId", repos.full_name as "fullName",
      repos.github_repo_id as "githubRepoId", orgs.github_installation_id as "installationId"
    from findings
    join repos on repos.id = findings.repo_id
    join orgs on orgs.id = repos.org_id
    where findings.status = 'open' and findings.github_comment_id is not null and orgs.suspended_at is null
    order by findings.reactions_checked_at nulls first, findings.created_at
    limit ${limit}`
  let byRepo = Map.groupBy(due, (d) => `${d.installationId}/${d.githubRepoId}`)
  let checked = 0
  let dismissed = 0
  for (let rows of byRepo.values()) {
    let first = rows[0]!
    let github: GitHub
    try {
      let token = await deps.mintInstallationToken({
        installationId: Number(first.installationId),
        githubRepoId: Number(first.githubRepoId),
        permissions: SWEEP_PERMISSIONS,
      })
      github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
    } catch (error) {
      log('warn', 'findings.reaction_sweep_failed', { repo: first.fullName, error: errorMessage(error) })
      // Read last next time, so that one repository never holds the others back.
      await sql`update findings set reactions_checked_at = now() where id = any(${sql.array(rows.map((r) => r.id))}::uuid[])`
      continue
    }
    let writers = new Map<string, boolean>()
    for (let row of rows) {
      let login: string | null = null
      try {
        login = await thumbsDownBy(github, row.fullName, Number(row.commentId), writers)
      } catch (error) {
        log('warn', 'findings.reaction_read_failed', { findingId: row.id, repo: row.fullName, error: errorMessage(error) })
      }
      checked++
      if (login && (await dismissByReaction(sql, row.id, login, null))) {
        dismissed++
        log('info', 'findings.dismissed_by_reaction', { findingId: row.id, repo: row.fullName, actor: login })
      } else {
        await sql`update findings set reactions_checked_at = now() where id = ${row.id}`
      }
    }
  }
  return { checked, dismissed }
}

/** Dismisses an open finding for a 👎 of `login`, with its event. False: it was no longer open. */
export async function dismissByReaction(sql: postgres.Sql, findingId: string, login: string, reviewId: string | null): Promise<boolean> {
  return sql.begin(async (tx) => {
    let [row] = await tx<{ id: string }[]>`
      update findings set status = 'dismissed', status_reason = ${REACTION_REASON}, reactions_checked_at = now(), updated_at = now()
      where id = ${findingId} and status = 'open'
      returning id`
    if (!row) return false
    await tx`
      insert into finding_events (finding_id, review_id, type, actor, reason)
      values (${findingId}, ${reviewId}, 'dismissed', ${login}, ${REACTION_REASON})`
    return true
  })
}
