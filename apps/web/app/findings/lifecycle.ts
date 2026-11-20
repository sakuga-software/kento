// REV-16. How the findings of a new review meet the findings that the pull request already has.
//
// A finding of the review is the same finding as a stored one when, in this order:
// 1. it has the same fingerprint (the path, the rule or the title, and the code around its line);
// 2. it has the same key (the path and the title), when its code changed but its title did not;
// 3. REV-99. it names the stored finding in `follows`: the runner linked it to an earlier finding
//    (the model said so, or it sits near it on its file with a word of its title);
// 4. an open thread of the bot sits a few lines away on the same file: two models word one defect
//    differently.
//
// Then:
// - a finding found again keeps its status and its thread: no new comment;
// - a `dismissed` or `wontfix` finding found again gets no comment, and the review leaves it out;
// - a `fixed` or `stale` finding found again is `open` again (`reopened`), on its open thread when
//   it still has one;
// - REV-99. a finding that follows a stored one goes in the thread of that one, whatever its state:
//   Kentō answers in it (publish.ts) and opens no new thread. A `fixed` one is `open` again. A
//   `dismissed` or `wontfix` one is `open` again too: the runner keeps such a finding only when its
//   file changed since, or when it is more severe;
// - an open or stale finding not found again is `fixed` when its file changed since the review that last
//   found it (publish.ts asks GitHub).
//
// This module is pure: publish.ts reads GitHub and ledger.ts the database.
import { findingKey } from '@kento-review/engine/findings'
import { fingerprint } from '@kento-review/engine/fingerprint'
import type { ReviewFinding } from '@kento-review/protocol'

import type { FindingEventType, FindingStatus } from './store.ts'

/** A thread of the bot on the pull request, as publish.ts reads it on GitHub. */
export type BotThread = {
  id: string
  resolved: boolean
  path: string
  /** The line of the thread at the head, or null when its line is gone. */
  line: number | null
  key: string
  commit: string | undefined
  commentId: number
  /** The bot already answered in the thread that its finding is gone. */
  answered: boolean
  /** REV-99. The markers of the replies of the bot to a finding that follows this one (`kento:variant`). */
  variants?: string[]
  /** REV-96. The thread holds the hint of `reject` already. */
  hinted?: boolean
  /** REV-96. A reply of a person in the thread names `@kento-review reject` already. */
  namesReject?: boolean
  /** REV-96. The logins of the people who replied in the thread, without the bots. */
  repliers?: string[]
  /** The first comment of the thread, for a thread that has no finding in the database yet. */
  body: string
}

/** A finding of the pull request, as the database holds it. `id` null: not in the database yet. */
export type StoredFinding = {
  id: string | null
  /** Empty for a thread of an earlier release: it matches by its key or its position only. */
  fingerprint: string
  key: string
  ruleId: string | null
  path: string
  line: number
  title: string
  severity: 'critical' | 'major' | 'minor'
  category: string
  confidence: number
  status: FindingStatus
  statusReason: string | null
  /**
   * The status that the database held when the review read it, or null for a finding not in the
   * database yet. The write changes the status only if it is still this one: a person, or the close
   * of the pull request, may change it while the review is published.
   */
  loadedStatus: FindingStatus | null
  /** The head of the last review that found it. */
  lastSeenSha: string
  githubCommentId: number | null
  githubThreadId: string | null
}

export type FindingEventDraft = { type: FindingEventType; actor: string; reason?: string | null }

/** A finding of the review and what the pull request already knows of it. */
export type Match = {
  finding: ReviewFinding
  /** The stored finding that it is, or null for a new finding. */
  stored: StoredFinding | null
  /** The open thread that already carries it: no new comment. */
  carrier: BotThread | null
  /** `dismissed` or `wontfix`: no comment, and the review leaves it out. */
  suppressed: boolean
  /** It was `fixed` or `stale`: it is `open` again. */
  reopened: boolean
  /**
   * REV-99. The finding names the stored one in `follows`: the thread of the stored one, open,
   * resolved or answered as gone, where Kentō answers instead of opening a new thread. Null when the
   * finding is not a follower, or when the stored one has no thread.
   */
  followIn?: BotThread | null
  /** REV-99. The finding names the stored one in `follows`. */
  followed?: boolean
}

/** An open thread of the bot a few lines away on the same file already carries a finding. */
export const NEAR_THREAD_LINES = 3

/** The fingerprint of a finding: the one of the runner, or one without the code for an earlier runner. */
export function fingerprintOf(finding: ReviewFinding): string {
  return finding.fingerprint ?? fingerprint(finding, null)
}

const clean = (path: string) => path.replace(/^\/+/, '')

/** The thread of a stored finding while it is open and the bot did not answer it as gone. */
export function liveThread(stored: StoredFinding, threads: readonly BotThread[]): BotThread | null {
  if (stored.githubCommentId === null) return null
  return threads.find((t) => t.commentId === stored.githubCommentId && !t.resolved && !t.answered) ?? null
}

const BADGE_SEVERITY: Record<string, StoredFinding['severity']> = { P0: 'critical', P1: 'major', P2: 'minor' }

// The badge of a security finding: its alt in an image, or its text in backquotes.
const SECURITY_BADGE = /alt="security"|`security`/

/**
 * The open threads of the bot that no stored finding holds: a review of an earlier release opened
 * them. They become findings, read from their comment: the title in bold, the priority badge.
 */
export function adoptThreads(stored: readonly StoredFinding[], threads: readonly BotThread[]): StoredFinding[] {
  let held = new Set(stored.flatMap((s) => (s.githubCommentId === null ? [] : [s.githubCommentId])))
  return threads
    .filter((t) => !t.resolved && !t.answered && !held.has(t.commentId))
    .map((t) => ({
      id: null,
      fingerprint: '',
      key: t.key,
      ruleId: null,
      path: t.path,
      line: t.line ?? 0,
      title: (/\*\*(.+?)\*\*/.exec(t.body)?.[1] ?? '').slice(0, 1000),
      severity: BADGE_SEVERITY[/alt="(P[012])"/.exec(t.body)?.[1] ?? ''] ?? 'minor',
      category: SECURITY_BADGE.test(t.body) ? 'security' : 'bug',
      // The comment does not give the confidence. 70 is the confidence of a sure finding.
      confidence: 70,
      status: 'open',
      statusReason: null,
      loadedStatus: null,
      lastSeenSha: t.commit ?? '',
      githubCommentId: t.commentId,
      githubThreadId: t.id,
    }))
}

// When two stored findings could match, a decision of a person wins, then an open finding.
const STATUS_ORDER: readonly FindingStatus[] = ['dismissed', 'wontfix', 'open', 'fixed', 'stale']

/**
 * Pairs each finding of the review with a stored finding, at most one each. `stored` holds the
 * findings of the database and the adopted threads.
 */
export function matchFindings(
  findings: readonly ReviewFinding[],
  stored: readonly StoredFinding[],
  threads: readonly BotThread[],
): { matches: Match[]; unmatched: StoredFinding[] } {
  let candidates = [...stored].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
  let taken = new Set<StoredFinding>()
  let pairs = new Map<ReviewFinding, StoredFinding>()
  let pass = (test: (f: ReviewFinding, s: StoredFinding) => boolean) => {
    for (let f of findings) {
      if (pairs.has(f)) continue
      let hit = candidates.find((s) => !taken.has(s) && test(f, s))
      if (hit) {
        pairs.set(f, hit)
        taken.add(hit)
      }
    }
  }
  pass((f, s) => s.fingerprint !== '' && s.fingerprint === fingerprintOf(f))
  pass((f, s) => s.key === findingKey(f))
  // REV-99. The runner linked the finding to this earlier one.
  let followers = new Set<ReviewFinding>()
  pass((f, s) => {
    if (!f.follows || s.key !== f.follows) return false
    followers.add(f)
    return true
  })
  pass((f, s) => {
    let thread = s.status === 'open' || s.status === 'stale' ? liveThread(s, threads) : null
    let line = f.anchor
    return thread !== null && thread.path === clean(f.path) && thread.line !== null && line !== null && Math.abs(thread.line - line) <= NEAR_THREAD_LINES
  })

  let matches = findings.map((finding): Match => {
    let s = pairs.get(finding) ?? null
    if (s && followers.has(finding)) {
      // REV-99. A follower goes in the thread of the stored finding, whatever its state.
      let thread = s.githubCommentId === null ? null : (threads.find((t) => t.commentId === s.githubCommentId) ?? null)
      return { finding, stored: s, carrier: thread, suppressed: false, reopened: s.status !== 'open', followIn: thread, followed: true }
    }
    let suppressed = s !== null && (s.status === 'dismissed' || s.status === 'wontfix')
    return {
      finding,
      stored: s,
      // The open thread of a finding still carries it, whatever its status: a `stale` finding of a
      // reopened pull request keeps its thread. A `fixed` one has none: its thread was resolved or
      // answered as gone.
      carrier: s && !suppressed ? liveThread(s, threads) : null,
      suppressed,
      reopened: s !== null && (s.status === 'fixed' || s.status === 'stale'),
    }
  })
  return { matches, unmatched: stored.filter((s) => !taken.has(s)) }
}
