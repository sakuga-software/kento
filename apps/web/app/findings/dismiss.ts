// REV-18. A person sets findings to `dismissed` (with a reason) or `wontfix`, from the Findings
// screen (several at once) or from the screen of a pull request (REV-17, one at a time). Each change
// is one event with the person's login (store.ts), then one reply in the thread of the finding on
// GitHub, posted as the replies of a resolve job are (resolve/publish.ts).
import { isOneOf, UUID } from '@kento-review/protocol'
import type postgres from 'postgres'

import type { MintInstallationToken } from '../github/installation-token.ts'
import { createGitHub } from '../publish/github.ts'
import { REASON_MAX, setFindingStatus, type FindingStatus } from './store.ts'

/** The reasons that the dialog offers. "Other" takes a reason of the person. */
export const DISMISS_REASONS = ['False positive', 'Off topic', 'Already known', 'Style, not a defect'] as const

/** The value of "Other" in the form: the reason is then the field `other`. */
export const OTHER_REASON = 'other'

/** The most findings of one form: two pages of the screen. */
export const BULK_MAX = 100

export type BulkStatus = 'dismissed' | 'wontfix'

export type StatusForm =
  | { ok: true; ids: string[]; status: BulkStatus; reason: string | null }
  | { ok: false; error: 'none' | 'too_many' | 'status' | 'reason' | 'reason_long' }

/**
 * Reads a form of findings: `ids` (one per finding), `status` (`dismissed` or `wontfix`), `reason`
 * (one of DISMISS_REASONS, or OTHER_REASON with `other`). A dismissal needs a reason; a wontfix takes
 * one if given.
 */
export function readStatusForm(form: FormData | null | undefined): StatusForm {
  let ids = [...new Set((form?.getAll('ids') ?? []).map(String).filter((id) => UUID.test(id)))]
  if (ids.length === 0) return { ok: false, error: 'none' }
  if (ids.length > BULK_MAX) return { ok: false, error: 'too_many' }
  let status = form?.get('status')
  if (status !== 'dismissed' && status !== 'wontfix') return { ok: false, error: 'status' }
  let choice = String(form?.get('reason') ?? '').trim()
  let reason = choice === OTHER_REASON ? String(form?.get('other') ?? '').trim() : choice
  if (reason && choice !== OTHER_REASON && !isOneOf(DISMISS_REASONS, reason)) return { ok: false, error: 'reason' }
  if (reason.length > REASON_MAX) return { ok: false, error: 'reason_long' }
  if (status === 'dismissed' && !reason) return { ok: false, error: 'reason' }
  return { ok: true, ids, status, reason: reason || null }
}

/** The reply in the thread of a finding that a person set aside. */
export function replyText(status: BulkStatus, reason: string | null, login: string): string {
  let what = status === 'dismissed' ? 'dismissed' : "kept as is (won't fix)"
  let why = reason ? ` Reason: "${reason}".` : ''
  return `Finding ${what} by @${login} on Kentō.${why} The next reviews will not comment on it again.`
}

/** The thread of a finding on GitHub. */
export interface ThreadTarget {
  installationId: number
  githubRepoId: number
  fullName: string
  prNumber: number
  commentId: number
}

/** Posts a reply in the thread of a finding. Throws on a refusal of GitHub. */
export type ThreadReplier = (target: ThreadTarget, body: string) => Promise<void>

/** A reply needs `pull_requests: write` on the repository of the finding, and nothing else. */
export function createThreadReplier(deps: { mintInstallationToken: MintInstallationToken; apiUrl: string; fetch?: typeof globalThis.fetch }): ThreadReplier {
  return async (target, body) => {
    let token = await deps.mintInstallationToken({
      installationId: target.installationId,
      githubRepoId: target.githubRepoId,
      permissions: { pull_requests: 'write' },
    })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
    await github.rest('POST', `/repos/${target.fullName}/pulls/${target.prNumber}/comments/${target.commentId}/replies`, { body })
  }
}

export interface StatusOutcome {
  /** Findings whose status changed. */
  changed: number
  /** Findings that already had this status and this reason: no event, no reply. */
  unchanged: number
  /** Findings that a push fixed: a person does not set them aside, or the precision would lose them. */
  fixed: number
  /** Ids that are no finding of the org. */
  missing: number
  /** Findings that the database could not change (an error); the others went on. */
  failed: number
  /** Replies posted on GitHub. */
  replied: number
  /** Replies that GitHub refused, or that could not be sent (no App): the status changed anyway. */
  unreplied: number
}

type Thread = { id: string; status: FindingStatus; prNumber: number; commentId: number | null; fullName: string; githubRepoId: string; installationId: string }

/**
 * Sets the status of findings of an org, one at a time: one event with the login of the person, then
 * at once the reply in the thread of the finding when it has one. A finding fixed by a push is left as
 * it is. An error on one finding, in the database or on GitHub, does not stop the others, and each
 * change keeps its reply: nothing is left changed without its answer.
 */
export async function applyStatus(
  sql: postgres.Sql,
  reply: ThreadReplier | null,
  input: { orgId: string; ids: string[]; status: BulkStatus; reason: string | null; actor: string },
  warn: (event: string, fields: Record<string, unknown>) => void = () => {},
): Promise<StatusOutcome> {
  let outcome: StatusOutcome = { changed: 0, unchanged: 0, fixed: 0, missing: 0, failed: 0, replied: 0, unreplied: 0 }
  let threads = new Map(
    (
      await sql<Thread[]>`
        select findings.id, findings.status, findings.pr_number as "prNumber", findings.github_comment_id::float8 as "commentId",
          repos.full_name as "fullName", repos.github_repo_id::text as "githubRepoId", installations.github_installation_id::text as "installationId"
        from findings
        join repos on repos.id = findings.repo_id
        join installations on installations.id = repos.installation_id
        where findings.id = any(${input.ids}::uuid[]) and repos.org_id = ${input.orgId}`
    ).map((t) => [t.id, t]),
  )
  let body = replyText(input.status, input.reason, input.actor)
  for (let id of input.ids) {
    let thread = threads.get(id)
    if (!thread) {
      outcome.missing++
      continue
    }
    if (thread.status === 'fixed') {
      outcome.fixed++
      continue
    }
    let result
    try {
      result = await setFindingStatus(sql, { orgId: input.orgId, findingId: id, status: input.status, reason: input.reason, actor: input.actor })
    } catch (error) {
      outcome.failed++
      warn('findings.status_failed', { findingId: id, error: String(error).slice(0, 300) })
      continue
    }
    if (result.outcome === 'unchanged') outcome.unchanged++
    else if (result.outcome === 'not_found') outcome.missing++
    else if (result.outcome === 'invalid') outcome.failed++
    if (result.outcome !== 'changed') continue
    outcome.changed++
    if (thread.commentId === null) continue
    if (!reply) {
      outcome.unreplied++
      continue
    }
    try {
      await reply(
        {
          installationId: Number(thread.installationId),
          githubRepoId: Number(thread.githubRepoId),
          fullName: thread.fullName,
          prNumber: thread.prNumber,
          commentId: Number(thread.commentId),
        },
        body,
      )
      outcome.replied++
    } catch (error) {
      outcome.unreplied++
      warn('findings.reply_failed', { findingId: id, repo: thread.fullName, pr: thread.prNumber, error: String(error).slice(0, 300) })
    }
  }
  return outcome
}
