// The publication of a review on GitHub, as review/sakuga-review.ts posts it from the Action: the
// review with its inline comments, the replies on the threads of a finding that is gone, the
// dismissal of the previous REQUEST_CHANGES, the block of the description, the label `review: N/5`
// and the check « Sakuga Review ». The format is the same, so that the scripts that read a review
// (score, level, badges P1/P2) read this one too.
//
// The web service has no checkout. The runner computed where each finding anchors; a call to the
// compare API of GitHub replaces the git diff that tells whether a file changed since a thread.
// The web service imports the two modules that render a review, not the whole engine: it never
// reads a checkout or calls a model.
import {
  findingKey,
  isBlocking,
  score,
  SEVERITY_ORDER,
  verdict,
  type Answer,
  type Finding,
  type Usage,
} from '@sakuga-review/engine/findings'
import {
  descriptionBlock,
  FINDING_KEY,
  inlineBody,
  MARKER_GONE,
  REVIEW_COUNT,
  reviewBody,
  withBlock,
  type Link,
  type Poster,
} from '@sakuga-review/engine/render'
import type { ReviewFinding, ReviewPayload } from '@sakuga-review/protocol'

import type { FindingsLedger, LedgerEntry } from '../findings/ledger.ts'
import {
  adoptThreads,
  fingerprintOf,
  liveThread,
  matchFindings,
  type BotThread,
  type FindingEventDraft,
  type Match,
  type StoredFinding,
} from '../findings/lifecycle.ts'
import { REACTION_REASON, thumbsDownBy } from '../findings/reactions.ts'
import { KENTO_ACTOR } from '../findings/store.ts'
import { COMMAND_NAMES } from '../github/comment-command.ts'
import { resolveReviewThread, reviewThreadPages } from '../github/graphql.ts'
import { GitHubError, type GitHub } from './github.ts'

/** The name of the check run, as the job of review.yml names it. */
export const CHECK_NAME = 'Sakuga Review'
/** The service that posts the review, in its footer. */
export const BY = 'Kentō'
/** Kentō, and the mention that asks it for another review. */
const POSTER: Poster = { by: BY, handle: `@${COMMAND_NAMES[0]}` }

// Each inline comment is a thread that a person must resolve, so only the sure findings get one.
const INLINE_CONFIDENCE = 70
const MAX_INLINE = 5

const SCORE_COLOUR = ['', 'b60205', 'd93f0b', 'fbca04', 'a2d9a5', '0e8a16']
const LABEL_PREFIX = 'review: '

export interface PublishTarget {
  owner: string
  name: string
  pr: number
  /** The login of the App on GitHub, `kento-review[bot]`. */
  botLogin: string
  /** `https://github.com`: the links of the description. */
  webUrl: string
}

export interface PublishOutcome {
  reviewId: number
  state: string
  inline: number
  resolved: number
  score: number
  /** REV-16. The open findings that this review shows fixed. */
  fixed: number
  /** REV-16. The findings found again that a person dismissed or kept: the review leaves them out. */
  suppressed: number
}

type InlineComment = {
  path: string
  line: number
  start_line?: number
  side: 'RIGHT'
  start_side?: 'RIGHT'
  body: string
}

/** The answer of the engine, rebuilt from the review that the runner sent. */
export function answerOf(review: ReviewPayload): Answer {
  return {
    // The runner sends the score that the reader sees. `score()` gives it back: it rounds and caps a
    // score that is already from 1 to 5, and a blocking finding has already capped it at 2.
    confidence_score: review.score,
    risk: review.risk,
    summary: review.summary,
    diagram: review.diagram ?? '',
    findings: review.findings,
    not_reviewed: review.notReviewed,
    deeper_review: { recommended: review.deeperReview !== null, reason: review.deeperReview ?? '' },
  }
}

/** The anchor of a finding, as the runner computed it from the changed lines of the checkout. */
export const anchorOf = (finding: Finding): number | null => (finding as ReviewFinding).anchor ?? null

export function usageOf(review: ReviewPayload): Usage {
  return {
    model: review.model,
    ...(review.provider ? { provider: review.provider } : {}),
    ...(review.costUsd !== null ? { cost: review.costUsd } : {}),
    // REV-11: a model without a price counts 0, and the cost line says that the cost is not known.
    ...(review.costSource ? { cost_source: review.costSource } : {}),
  }
}

/**
 * Publishes the review. Every step before the review itself can throw: nothing is posted yet, and the
 * caller can try again. The write of the findings (REV-16) can throw too, before the review is
 * marked: the next try finds the review by its marker and writes them again. The steps after it
 * (dismissal, description, label, check) are logged when they fail and do not throw: the review is
 * on GitHub, and a second one would repeat it.
 */
export async function publishReview(
  github: GitHub,
  target: PublishTarget,
  review: ReviewPayload,
  options: {
    /** A client whose token can write the checks, or null when the App cannot. */
    checks?: GitHub | null
    /**
     * A unique id of the stored review, written in a hidden comment of the review body. A review of
     * the bot that already carries it is not posted again.
     */
    marker?: string
    /** Called once the review is on GitHub, before the steps that follow it. */
    onPosted?: (reviewId: number) => Promise<void>
    /**
     * REV-16. The findings of the pull request in the database. Without it, the findings live in the
     * threads of the bot only, as before the table.
     */
    findings?: FindingsLedger
    warn?: (event: string, fields: Record<string, unknown>) => void
  } = {},
): Promise<PublishOutcome> {
  let { owner, name, pr } = target
  let warn = options.warn ?? (() => {})
  let repo = `/repos/${owner}/${name}`
  let usage = usageOf(review)
  let level = review.level
  let head = review.head
  let threads = await botThreads(github, target)
  let threadUrl = (commentId: number) => `${target.webUrl}/${owner}/${name}/pull/${pr}#discussion_r${commentId}`

  // REV-16. The findings of the pull request: those of the database, and the open threads of an
  // earlier release that the database does not hold yet.
  let ledger = options.findings ?? null
  let known = ledger ? await ledger.load() : []
  let stored = [...known, ...adoptThreads(known, threads)]
  // A 👎 of a person on the comment of an open finding dismisses it before the review: GitHub sends
  // no webhook for a reaction. An error leaves the finding open.
  let reacted = new Map<StoredFinding, string>()
  let writers = new Map<string, boolean>()
  if (ledger) {
    for (let s of stored) {
      if (s.status !== 'open' || s.githubCommentId === null) continue
      try {
        let login = await thumbsDownBy(github, `${owner}/${name}`, s.githubCommentId, writers)
        if (!login) continue
        reacted.set(s, login)
        s.status = 'dismissed'
        s.statusReason = REACTION_REASON
      } catch (error) {
        warn('publish.reaction_failed', { finding: s.id, error: String(error) })
      }
    }
  }
  let { matches, unmatched } = matchFindings(review.findings, stored, threads)
  // A finding that a person dismissed or kept gets no comment, and the review leaves it out.
  let shown = matches.filter((m) => !m.suppressed)
  let matchOf = new Map<Finding, Match>(shown.map((m) => [m.finding as Finding, m]))
  let answer: Answer = { ...answerOf(review), findings: shown.map((m) => m.finding) }

  let ordered = [...answer.findings].sort(
    (a, b) =>
      Number(isBlocking(b, anchorOf)) - Number(isBlocking(a, anchorOf)) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.confidence - a.confidence,
  )
  let inline: Finding[] = []
  let comments: InlineComment[] = []
  for (let f of ordered) {
    // A finding that an open thread already carries is not posted again.
    if (matchOf.get(f)?.carrier) continue
    let line = anchorOf(f)
    if (line === null || f.confidence < INLINE_CONFIDENCE || inline.length >= MAX_INLINE) continue
    let range = line === f.line ? (f as ReviewFinding).suggestion_range : null
    let comment: InlineComment = { path: f.path.replace(/^\/+/, ''), line, side: 'RIGHT', body: inlineBody(f, range !== null) }
    if (range && range[0] < range[1]) Object.assign(comment, { start_line: range[0], start_side: 'RIGHT' })
    inline.push(f)
    comments.push(comment)
  }

  // An open finding that this review did not find again is fixed only when its file changed since
  // the review that last found it: the same code can be read twice, and a model can miss a finding.
  // A finding whose commit a force-push removed stays open: nothing tells what changed since.
  // The threads to close are found before the review, for its note on a force-push; they are closed
  // only once the review is on GitHub, so that a review that fails to post closes nothing.
  let changedSince = filesChangedSince(github, repo, head)
  let fixed: StoredFinding[] = []
  let toClose: BotThread[] = []
  let gone = 0
  // An error on one finding (the compare API) leaves it open and never stops the review.
  for (let s of unmatched) {
    // A stale finding of a reopened pull request is fixed the same way, and its thread closed.
    if (s.status !== 'open' && s.status !== 'stale') continue
    let thread = liveThread(s, threads)
    try {
      let changed = await changedSince(s.lastSeenSha || undefined, s.path)
      if (changed === null && thread) gone++
      if (changed) {
        fixed.push(s)
        if (thread) toClose.push(thread)
      }
    } catch (error) {
      warn('publish.thread_failed', { thread: thread?.id ?? null, finding: s.id, error: String(error) })
    }
  }

  let reviewsPath = `${repo}/pulls/${pr}/reviews`
  let marker = options.marker ? `\n\n<!-- kento:review ${options.marker} -->` : ''
  let body = reviewBody(answer, anchorOf, level, usage, POSTER) + goneNote(gone, review.base) + marker
  let event = verdict(answer, anchorOf, level)
  // A review that an earlier try posted, and could not mark (a restart, a lost connection): it is
  // not posted again. The steps after it run once more.
  let posted: { id: number; state: string } | undefined = marker
    ? (await listReviews(github, reviewsPath)).find((r) => r.user?.login === target.botLogin && r.body?.includes(marker.trim()))
    : undefined
  let alreadyPosted = posted !== undefined
  if (posted) {
    warn('publish.already_posted', { githubReviewId: posted.id })
  } else {
    try {
      posted = await github.rest('POST', reviewsPath, { commit_id: head, body, event, comments })
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422) || !comments.length) throw error
      // A line that the API refuses drops the inline comments, never the review.
      warn('publish.inline_refused', { error: String(error) })
      comments.length = 0
      inline.length = 0
      posted = await github.rest('POST', reviewsPath, { commit_id: head, body, event, comments: [] })
    }
  }
  let found = posted!
  let value = score(answer, anchorOf)

  // From here the review is on GitHub: a failure is logged, and the next step still runs.
  let step = async (stepName: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      warn('publish.step_failed', { step: stepName, error: String(error) })
    }
  }

  // REV-16. The comments and the findings are written before the review is marked as posted, and
  // their failure throws: the review stays unmarked, and the next try finds it by its marker, posts
  // nothing, and writes them again. A finding is never left out of the database by a lost write.
  //
  // The comment of each new finding of this review: by the key in its marker, and by its line when
  // two findings of one file share a title (and so a key).
  let newThreads = new Map<Finding, number>()
  if (inline.length) {
    let posted: { id: number; body: string; line?: number | null }[] =
      (await github.rest('GET', `${reviewsPath}/${found.id}/comments?per_page=100`)) ?? []
    let free = posted.flatMap((c) => {
      let key = FINDING_KEY.exec(c.body)?.[1]
      return key ? [{ id: c.id, key, line: c.line ?? null }] : []
    })
    for (let f of inline) {
      let key = findingKey(f)
      let hit = free.find((c) => c.key === key && c.line === anchorOf(f)) ?? free.find((c) => c.key === key)
      if (!hit) continue
      newThreads.set(f, hit.id)
      free.splice(free.indexOf(hit), 1)
    }
  }
  if (ledger) await ledger.save(ledgerEntries(matches, fixed, unmatched, newThreads, head, reacted))

  // The caller marks the review as posted. A failure there must not skip the description, the
  // label and the check of a review that is already on GitHub.
  let onPosted = options.onPosted
  if (onPosted) await step('mark', () => onPosted(found.id))

  // The threads of the findings that are gone. A failure on one thread (a comment deleted meanwhile)
  // leaves it open.
  let resolved = 0
  for (let t of toClose) {
    await step('thread', async () => {
      try {
        await resolveReviewThread(github, t.id)
      } catch (error) {
        // GitHub refuses this mutation to an App that cannot write the contents. The reply tells the
        // person who resolves the thread why it can go.
        warn('publish.thread_not_resolved', { thread: t.id, error: String(error) })
        await github.rest('POST', `${repo}/pulls/${pr}/comments/${t.commentId}/replies`, {
          body:
            `Ce constat n'apparaît plus au commit \`${head.slice(0, 9)}\`, et le fichier a changé depuis. ` +
            `Le fil peut être résolu.\n\n${MARKER_GONE}`,
        })
      }
      resolved++
    })
  }

  // A COMMENT does not lift an earlier REQUEST_CHANGES, so the review of the previous head would keep
  // the pull request blocked after its findings are fixed. The dismissal clears it.
  await step('dismiss', async () => {
    // GitHub lists the reviews oldest first, 100 at most per page: the previous one can be on a
    // later page.
    let previous = await listReviews(github, reviewsPath)
    for (let p of previous) {
      if (p.user?.login === target.botLogin && p.state === 'CHANGES_REQUESTED' && p.id !== found.id) {
        await github.rest('PUT', `${reviewsPath}/${p.id}/dismissals`, {
          message: 'Remplacée par la review du dernier commit.',
          event: 'DISMISS',
        })
      }
    }
  })

  await step('description', async () => {
    // Each finding links to its thread: a new comment of this review, or the open thread that carries it.
    let links: Link[] = ordered.map((f) => {
      let id = newThreads.get(f) ?? matchOf.get(f)?.carrier?.commentId
      return { finding: f, url: id ? threadUrl(id) : null }
    })
    let commit: { commit?: { message?: string } } = await github.rest('GET', `${repo}/commits/${head}`)
    let subject = (commit?.commit?.message ?? '').split('\n')[0]!.trim()
    // The block goes at the end of the description, read again just before the write: the author can
    // edit the description while the review runs.
    let prPath = `${repo}/pulls/${pr}`
    let current: string = (await github.rest('GET', prPath))?.body ?? ''
    let previousCount = Number(REVIEW_COUNT.exec(current)?.[1] ?? 0)
    // A review found again may already have written its block: that block counts it once.
    let counted = alreadyPosted && current.includes(`/commit/${head})`)
    let count = counted ? previousCount : previousCount + 1
    let block = descriptionBlock(answer, links, review.skipped, resolved, usage, anchorOf, {
      count,
      head,
      subject,
      commitUrl: `${target.webUrl}/${owner}/${name}/commit/${head}`,
      level,
      poster: POSTER,
    })
    await github.rest('PATCH', prPath, { body: withBlock(current, block) })
  })

  await step('label', () => setScoreLabel(github, repo, pr, value))

  if (options.checks) {
    let checks = options.checks
    await step('check', async () => {
      await checks.rest('POST', `${repo}/check-runs`, {
        name: CHECK_NAME,
        head_sha: head,
        status: 'completed',
        conclusion: 'success',
        details_url: `${target.webUrl}/${owner}/${name}/pull/${pr}`,
        output: { title: `Score de confiance : ${value}/5`, summary: body.slice(0, 60_000) },
      })
    })
  }

  return {
    reviewId: found.id,
    state: found.state,
    inline: alreadyPosted ? 0 : comments.length,
    resolved,
    score: value,
    fixed: fixed.length,
    suppressed: matches.length - shown.length,
  }
}

/**
 * The changes of a review to the findings of its pull request: each finding of the review (new,
 * found again, or open again), each open finding that it shows fixed, and the threads of an earlier
 * release that the database does not hold yet.
 */
export function ledgerEntries(
  matches: readonly Match[],
  fixed: readonly StoredFinding[],
  unmatched: readonly StoredFinding[],
  newThreads: ReadonlyMap<Finding, number>,
  head: string,
  /** The findings that a 👎 dismissed before this review, with the login of the person. */
  reacted: ReadonlyMap<StoredFinding, string> = new Map(),
): LedgerEntry[] {
  let entries: LedgerEntry[] = []
  let opened: FindingEventDraft = { type: 'opened', actor: KENTO_ACTOR }
  let byReaction = (s: StoredFinding | null): FindingEventDraft[] => {
    let login = s ? reacted.get(s) : undefined
    return login ? [{ type: 'dismissed', actor: login, reason: REACTION_REASON }] : []
  }
  for (let m of matches) {
    let f = m.finding
    let s = m.stored
    let key = findingKey(f)
    let comment = newThreads.get(f) ?? null
    let ruleId = (f as { rule_id?: string }).rule_id ?? s?.ruleId ?? null
    entries.push({
      id: s?.id ?? null,
      values: {
        fingerprint: fingerprintOf(f),
        key,
        ruleId,
        path: f.path.replace(/^\/+/, ''),
        line: f.anchor ?? f.line,
        title: f.title,
        severity: f.severity,
        category: f.category,
        confidence: f.confidence,
        status: s && !m.reopened ? s.status : 'open',
        statusReason: s && !m.reopened ? s.statusReason : null,
        loadedStatus: s?.loadedStatus ?? null,
        lastSeenSha: head,
        githubCommentId: comment ?? s?.githubCommentId ?? null,
        githubThreadId: comment ? null : (m.carrier?.id ?? s?.githubThreadId ?? null),
      },
      events: [
        ...(s === null || s.id === null ? [opened] : m.reopened ? [{ type: 'reopened', actor: KENTO_ACTOR } as const] : []),
        ...byReaction(s),
      ],
    })
  }
  let fixedSet = new Set(fixed)
  for (let s of fixed) {
    let { id, ...values } = s
    entries.push({
      id,
      values: { ...values, status: 'fixed' },
      events: [...(id === null ? [opened] : []), { type: 'fixed', actor: KENTO_ACTOR }],
    })
  }
  for (let s of unmatched) {
    if (fixedSet.has(s) || (s.id !== null && !reacted.has(s))) continue
    let { id, ...values } = s
    entries.push({ id, values, events: [...(id === null ? [opened] : []), ...byReaction(s)] })
  }
  return entries
}

/**
 * The note of a review when a force-push removed the commit of open threads: their diff starts at
 * the merge base, and they stay open.
 */
function goneNote(gone: number, base: string): string {
  if (!gone) return ''
  let threads = gone > 1 ? `${gone} fils ouverts` : 'un fil ouvert'
  return (
    `\n\n> [!NOTE]\n> Un force-push a retiré de l'historique le commit relu par ${threads}. ` +
    `Le diff depuis ce commit est impossible : cette review relit toute la PR depuis la base \`${base.slice(0, 9)}\`, ` +
    `et ${gone > 1 ? 'ces fils restent ouverts' : 'ce fil reste ouvert'}.`
  )
}

// GitHub lists at most this many files in a comparison.
const COMPARE_MAX_FILES = 300

/**
 * Whether a file changed between the commit of a thread and the head, from the compare API: the
 * same answer as `fileChangedSince` of the engine on a checkout.
 *
 * - null: the commit is not in the history of the head (a force-push removed it, or GitHub no longer
 *   has it). Nobody can tell what changed since the comment.
 * - false: the file did not change, or GitHub lists too many files to tell. A thread stays open
 *   when the answer is not sure.
 */
function filesChangedSince(github: GitHub, repo: string, head: string) {
  let cache = new Map<string, Promise<{ ancestor: boolean; files: Set<string> } | null>>()
  let compare = (commit: string) => {
    let hit = cache.get(commit)
    if (hit) return hit
    let promise = (async () => {
      try {
        let out: { status: string; files?: { filename: string; previous_filename?: string }[] } = await github.rest(
          'GET',
          `${repo}/compare/${commit}...${head}?per_page=${COMPARE_MAX_FILES}`,
        )
        let files = out.files ?? []
        return {
          // `ahead` or `identical`: the commit is an ancestor of the head. `diverged` or `behind`: not.
          ancestor: out.status === 'ahead' || out.status === 'identical',
          // GitHub lists at most COMPARE_MAX_FILES files: a file past the list reads as unchanged.
          files: new Set(files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])])),
        }
      } catch (error) {
        // GitHub answers 404 for a commit that it does not have.
        if (error instanceof GitHubError && error.status === 404) return null
        throw error
      }
    })()
    cache.set(commit, promise)
    return promise
  }
  return async (commit: string | undefined, path: string): Promise<boolean | null> => {
    if (!commit) return false
    let out = await compare(commit)
    if (!out || !out.ancestor) return null
    return out.files.has(path)
  }
}

type ListedReview = { id: number; state: string; body: string | null; user: { login: string } | null }

/** Every review of the pull request. GitHub lists them oldest first, 100 at most per page. */
async function listReviews(github: GitHub, reviewsPath: string): Promise<ListedReview[]> {
  let reviews: ListedReview[] = []
  for (let page = 1; ; page++) {
    let batch: ListedReview[] = (await github.rest('GET', `${reviewsPath}?per_page=100&page=${page}`)) ?? []
    reviews.push(...batch)
    if (batch.length < 100) return reviews
  }
}

type ThreadNode = {
  id: string
  isResolved: boolean
  path: string
  line: number | null
  comments: { nodes: { databaseId: number; body: string; author: { login: string } | null; commit: { oid: string } | null }[] }
}

/** The review threads that the bot opened on the pull request. */
async function botThreads(github: GitHub, target: PublishTarget): Promise<BotThread[]> {
  // GraphQL gives the login of an App without `[bot]`.
  let logins = new Set([target.botLogin, target.botLogin.replace(/\[bot\]$/, '')])
  let threads: BotThread[] = []
  let fields = 'id isResolved path line comments(first: 50) { nodes { databaseId body author { login } commit { oid } } }'
  for await (let nodes of reviewThreadPages<ThreadNode>(github, target, fields)) {
    for (let node of nodes) {
      let first = node.comments.nodes[0]
      if (!first || !logins.has(first.author?.login ?? '')) continue
      let key = FINDING_KEY.exec(first.body)
      if (!key) continue
      threads.push({
        id: node.id,
        resolved: node.isResolved,
        path: node.path,
        line: node.line ?? null,
        key: key[1]!,
        commit: first.commit?.oid,
        commentId: first.databaseId,
        body: first.body,
        // A later comment of the bot in the thread is its reply that the finding is gone.
        answered: node.comments.nodes.slice(1).some((c) => c.body.includes(MARKER_GONE) || logins.has(c.author?.login ?? '')),
      })
    }
  }
  return threads
}

/** One label `review: N/5` on the pull request, created on the first use in a repository. */
async function setScoreLabel(github: GitHub, repo: string, pr: number, value: number) {
  let label = `${LABEL_PREFIX}${value}/5`
  try {
    await github.rest('GET', `${repo}/labels/${encodeURIComponent(label)}`)
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error
    await github.rest('POST', `${repo}/labels`, {
      name: label,
      color: SCORE_COLOUR[value],
      description: `Score de confiance de ${BY} (5 : prête à fusionner)`,
    })
  }
  let current: { name: string }[] = (await github.rest('GET', `${repo}/issues/${pr}/labels`)) ?? []
  for (let old of current) {
    if (old.name.startsWith(LABEL_PREFIX) && old.name !== label) {
      await github.rest('DELETE', `${repo}/issues/${pr}/labels/${encodeURIComponent(old.name)}`)
    }
  }
  await github.rest('POST', `${repo}/issues/${pr}/labels`, { labels: [label] })
}
