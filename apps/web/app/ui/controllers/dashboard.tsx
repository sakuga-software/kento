// REV-14. The dashboard: a member reads it; an admin can also retry the last failure.
import { createAction } from 'remix/router'

import { UUID } from '@sakuga-review/protocol'

import type { ReadPullRequest } from '../../dashboard/github.ts'
import type { RetryOutcome } from '../../dashboard/store.ts'
import { errorMessage, log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { DASHBOARD_NOTICES, DashboardPage, type DashboardNotice } from '../dashboard.tsx'
import { forbidden, installationUrl, PlaceholderPage, redirect, signedOf, type UiKit } from './kit.tsx'

export function dashboardActions(kit: UiKit) {
  let { deps } = kit
  return {
    home: createAction(pageRoutes.home, async (context) => {
      let signed = signedOf(context)
      let page = kit.page(context)
      let dashboard = deps.dashboard
      if (!dashboard) return context.render(<PlaceholderPage frame={page} section="dashboard" />)
      let [screen, precision] = await Promise.all([
        dashboard.store.screen(signed.membership.org.id),
        deps.findings?.store.precision(signed.membership.org.id) ?? null,
      ])
      let notice = context.url.searchParams.get('notice')
      return context.render(
        <DashboardPage
          frame={page}
          screen={screen}
          githubUrl={dashboard.githubUrl}
          notice={notice !== null && notice in DASHBOARD_NOTICES ? (notice as DashboardNotice) : null}
          serviceKey={dashboard.serviceKey ?? false}
          installationUrl={installationUrl(dashboard.githubUrl, signed.membership.org)}
          precision={precision}
        />,
      )
    }),

    // cop() and csrf() of the session layer ran before.
    jobRetry: createAction(pageRoutes.jobRetry, async (context) => {
      let signed = signedOf(context)
      let dashboard = deps.dashboard
      if (!dashboard || signed.membership.role !== 'admin') {
        log('warn', 'dashboard.retry_refused', { login: signed.user.login, org: signed.membership.org.login, reason: 'not an admin' })
        return forbidden()
      }
      let level = context.get(FormData)?.get('level')
      if (level !== 'lite' && level !== 'balanced' && level !== 'heavy') return kit.errorPage(context, 400, 'form', 'dashboard')
      let id = context.params.id
      let orgId = signed.membership.org.id
      let outcome: RetryOutcome | { kind: 'github_failed' }
      let target = UUID.test(id) ? await dashboard.store.retryTarget(orgId, id) : null
      if (!target) {
        outcome = { kind: 'not_found' }
      } else {
        let now: Awaited<ReturnType<ReadPullRequest>> | null = null
        try {
          now = dashboard.readPullRequest ? await dashboard.readPullRequest(target) : null
        } catch (error) {
          log('warn', 'dashboard.retry_github_failed', { failedJobId: id, repo: target.fullName, pr: target.prNumber, error: errorMessage(error) })
        }
        outcome =
          dashboard.readPullRequest && !now
            ? { kind: 'github_failed' }
            : now && !now.open
              ? { kind: 'closed' }
              : await dashboard.store.retry(orgId, id, level, now?.headSha ?? null)
      }
      log('info', 'dashboard.retry', {
        login: signed.user.login,
        org: signed.membership.org.login,
        failedJobId: id,
        reviewLevel: level,
        outcome: outcome.kind,
        ...('jobId' in outcome ? { jobId: outcome.jobId } : {}),
      })
      let notice: DashboardNotice = outcome.kind === 'queued' ? 'retried' : outcome.kind === 'not_found' ? 'missing' : outcome.kind
      return redirect(`${pageRoutes.home.href()}?notice=${notice}`)
    }),
  }
}
