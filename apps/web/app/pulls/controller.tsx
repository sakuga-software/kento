// REV-17. The controller of the screen of a pull request. It sits in a file of its own, on the frame
// of the screens (`ScreenKit` of app/ui/pages.tsx): the session, the signed-in person, the 404 page.
import { createController } from 'remix/router'

import { InvalidCursorError } from '../findings/store.ts'
import { errorMessage, log } from '../log.ts'
import { pullRoutes } from '../routes.ts'
import type { ScreenKit } from '../ui/pages.tsx'
import { pullHref, PullPage, readPullQuery } from '../ui/pull.tsx'
import { FindingPage, findingHref } from '../ui/finding.tsx'
import { FINDING_NOTICES, FindingActions, FindingNoticeView, GITHUB_NOTICES, type FindingNotice, type GithubNotice } from '../ui/finding-actions.tsx'
import { readStatusForm, replyText, type ThreadReplier } from '../findings/dismiss.ts'
import { reopenText } from './reply.ts'
import type { CodeRead, ReadCode } from './finding.ts'
import type { PullHeader, ReadPullHeader } from './github.ts'
import type { PullsStore } from './store.ts'

/** The screen of a pull request (REV-17). Null: it answers 404. */
export interface PullsDependencies {
  store: PullsStore
  /** `https://github.com`, or the GitHub Enterprise Server. */
  githubUrl: string
  /** Reads the title, the author and the branches. Null without the GitHub App. */
  readHeader: ReadPullHeader | null
  /** Reads the code around the line of a finding. Null without the GitHub App. */
  readCode?: ReadCode | null
  /** Posts the reply of the bot in the thread of a finding (REV-18). Null without the GitHub App. */
  postReply?: ThreadReplier | null
  now?: () => number
}

const REPOS_EXIT = { href: '/repos', label: 'Voir les repos' }

type FormContext = { get(key: typeof FormData): FormData | undefined; params: { id: string } }

type Decision = { status: 'dismissed' | 'wontfix' | 'open'; reason: string | null }

/**
 * The decision of a form, or null for a form that the server cannot read. A dismissal reads the
 * fields of the dialog of REV-18 (`readStatusForm`: one of its reasons, or « Autre » with a reason),
 * for the finding of the address only.
 */
function readDecision(status: Decision['status'], id: string, form: FormData | undefined): Decision | null {
  if (status !== 'dismissed') return { status, reason: null }
  let read = readStatusForm(form)
  if (!read.ok || read.status !== 'dismissed' || read.ids.length !== 1 || read.ids[0] !== id) return null
  return { status, reason: read.reason }
}

export function createPullControllers(kit: ScreenKit, deps: PullsDependencies | null) {
  let now = deps?.now ?? Date.now

  /**
   * A member of the org decides on a finding (cop() and csrf() of the session ran before). The status
   * changes first; then the bot replies in the thread, once per change: a second post of the same
   * form changes nothing and posts nothing. A reply that GitHub refuses leaves the status changed,
   * and the screen says so.
   */
  async function decide(context: FormContext, status: Decision['status']) {
    let signed = kit.signed(context)
    if (!deps) return kit.errorPage(context, 404, 'page', 'repos', REPOS_EXIT)
    let id = context.params.id
    let decision = readDecision(status, id, context.get(FormData))
    if (!decision) return kit.errorPage(context, 400, 'form', 'repos')
    let finding = await deps.store.finding(signed.orgId, id)
    if (!finding) return kit.errorPage(context, 404, 'page', 'repos', REPOS_EXIT)
    // As on the Findings screen (REV-18): a finding that a push fixed is not set aside, or the precision
    // of the repository would lose it.
    if (finding.status === 'fixed' && status !== 'open') return kit.redirect(`${findingHref(id)}?fait=fixed`)
    let change = await deps.store.setStatus({ orgId: signed.orgId, findingId: id, status, reason: decision.reason, actor: signed.login })
    if (change.outcome === 'not_found') return kit.errorPage(context, 404, 'page', 'repos', REPOS_EXIT)
    if (change.outcome === 'invalid') return kit.errorPage(context, 400, 'form', 'repos')
    let github: GithubNotice | null = null
    if (change.outcome === 'changed') {
      if (finding.githubCommentId === null || !deps.postReply) {
        github = 'none'
      } else {
        // The status has changed: a refused reply is logged and shown, and the person gets the detail back.
        let body = status === 'open' ? reopenText(signed.login) : replyText(status, decision.reason, signed.login)
        try {
          await deps.postReply({ ...finding.target, commentId: finding.githubCommentId }, body)
          github = 'posted'
        } catch (error) {
          github = 'failed'
          log('warn', 'finding.reply_failed', { repo: finding.target.fullName, finding: id, error: errorMessage(error) })
        }
      }
    }
    log('info', 'finding.status', { login: signed.login, org: signed.orgLogin, finding: id, status, outcome: change.outcome, github })
    let notice: FindingNotice = change.outcome === 'changed' ? status : 'unchanged'
    return kit.redirect(`${findingHref(id)}?fait=${notice}${github ? `&github=${github}` : ''}`)
  }
  return createController(pullRoutes, {
    middleware: kit.middleware,
    actions: {
      async pull(context) {
        let signed = kit.signed(context)
        let prNumber = Number(context.params.number)
        let summary = deps && /^\d{1,9}$/.test(context.params.number) ? await deps.store.summary(signed.orgId, context.params.id, prNumber) : null
        if (!deps || !summary) return kit.errorPage(context, 404, 'page', 'repos', REPOS_EXIT)
        let query = readPullQuery(context.url.searchParams)
        let sheet
        try {
          sheet = await deps.store.sheet(summary.target, { reviewsCursor: query.reviews, rowsCursor: query.rows, statuses: query.statuses })
        } catch (error) {
          // A cursor of an old link, or one that a person changed: the first page again.
          if (!(error instanceof InvalidCursorError)) throw error
          return kit.redirect(pullHref(summary.target.repoId, prNumber, { statuses: query.statuses }))
        }
        let header: PullHeader | null = null
        if (deps.readHeader) {
          try {
            header = await deps.readHeader(summary.target)
          } catch (error) {
            log('warn', 'pull.header_failed', { repo: summary.target.fullName, pr: prNumber, error: errorMessage(error) })
          }
        }
        return context.render(
          <PullPage
            frame={kit.frame(context)}
            summary={summary}
            header={header}
            sheet={sheet}
            query={query}
            githubUrl={deps.githubUrl}
            now={new Date(now())}
          />,
        )
      },

      async finding(context) {
        let signed = kit.signed(context)
        let finding = deps ? await deps.store.finding(signed.orgId, context.params.id) : null
        if (!deps || !finding) return kit.errorPage(context, 404, 'page', 'repos', REPOS_EXIT)
        let cursor = context.url.searchParams.get('historique') || null
        let history
        try {
          history = await deps.store.history(signed.orgId, finding.id, cursor)
        } catch (error) {
          if (!(error instanceof InvalidCursorError)) throw error
          return kit.redirect(findingHref(finding.id))
        }
        let code: CodeRead | 'failed' | undefined = undefined
        if (deps.readCode) {
          try {
            code = await deps.readCode(finding.target, { path: finding.path, sha: finding.lastSeenSha, line: finding.line })
          } catch (error) {
            code = 'failed'
            log('warn', 'finding.code_failed', { repo: finding.target.fullName, finding: finding.id, error: errorMessage(error) })
          }
        }
        let page = kit.frame(context)
        let query = context.url.searchParams
        let fait = query.get('fait')
        let gh = query.get('github')
        let notice =
          fait !== null && fait in FINDING_NOTICES ? (
            <FindingNoticeView notice={fait as FindingNotice} github={gh !== null && gh in GITHUB_NOTICES ? (gh as GithubNotice) : null} />
          ) : null
        return context.render(
          <FindingPage
            frame={page}
            notice={notice}
            actions={<FindingActions finding={finding} csrf={page.csrfToken ?? ''} />}
            finding={finding}
            history={history}
            historyCursor={cursor}
            code={code}
            githubUrl={deps.githubUrl}
            now={new Date(now())}
          />,
        )
      },

      async findingDismiss(context) {
        return decide(context, 'dismissed')
      },
      async findingWontfix(context) {
        return decide(context, 'wontfix')
      },
      async findingReopen(context) {
        return decide(context, 'open')
      },
    },
  })
}
