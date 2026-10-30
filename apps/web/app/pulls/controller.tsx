// REV-17. The controller of the screen of a pull request. It sits in a file of its own, on the frame
// of the screens (`ScreenKit` of app/ui/pages.tsx): the session, the signed-in person, the 404 page.
import { createController } from 'remix/router'

import { InvalidCursorError } from '../findings/store.ts'
import { errorMessage, log } from '../log.ts'
import { pullRoutes } from '../routes.ts'
import type { ScreenKit } from '../ui/pages.tsx'
import { pullHref, PullPage, readPullQuery } from '../ui/pull.tsx'
import { FindingPage, findingHref } from '../ui/finding.tsx'
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
  now?: () => number
}

const REPOS_EXIT = { href: '/repos', label: 'Voir les repos' }

export function createPullControllers(kit: ScreenKit, deps: PullsDependencies | null) {
  let now = deps?.now ?? Date.now
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
        return context.render(
          <FindingPage
            frame={kit.frame(context)}
            finding={finding}
            history={history}
            historyCursor={cursor}
            code={code}
            githubUrl={deps.githubUrl}
            now={new Date(now())}
          />,
        )
      },
    },
  })
}
