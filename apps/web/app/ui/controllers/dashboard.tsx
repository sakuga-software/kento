// REV-14. The dashboard: a member reads it; an admin can also retry the last failure, or hide a failure (REV-59).
import { renderToString } from 'remix/component/server'
import { createAction } from 'remix/router'

import { canEdit } from '../../auth/access.ts'

import { UUID } from '@kento-review/protocol'

import type { ReadPullRequest } from '../../dashboard/github.ts'
import { createLiveHub } from '../../dashboard/live.ts'
import type { RetryOutcome } from '../../dashboard/store.ts'
import { errorMessage, log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { DASHBOARD_NOTICES, DashboardPage, QueueCard, type DashboardNotice } from '../dashboard.tsx'
import { forbidden, installationUrl, PlaceholderPage, redirect, signedOf, type UiKit } from './kit.tsx'

/** KNT-189. A quiet stream sends a comment this often, so that no proxy closes it. */
export const LIVE_HEARTBEAT_MS = 25_000
/** KNT-189. A stream ends after this; the browser opens another one, and the session and its org are checked again. */
export const LIVE_MAX_MS = 2 * 60_000
/** KNT-189. The streams that one session holds at once: a few tabs. */
export const LIVE_PER_SESSION = 4

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  // No buffer in a proxy that reads it (nginx): each event goes out at once.
  'X-Accel-Buffering': 'no',
}

export function dashboardActions(kit: UiKit) {
  let { deps } = kit
  let dashboard = deps.dashboard
  let live = dashboard?.live ?? {}
  // KNT-189. One read of the card per org and per tick, whatever the number of streams of the org.
  let hub = dashboard
    ? createLiveHub({
        intervalMs: live.intervalMs,
        async read(orgId) {
          let card = await dashboard.store.queueCard(orgId)
          return JSON.stringify({ html: await renderToString(<QueueCard card={card} githubUrl={dashboard.githubUrl} />) })
        },
      })
    : null
  live.closing?.addEventListener('abort', () => hub?.close(), { once: true })
  /** The open streams of each session. */
  let streams = new Map<string, number>()
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
      // The steps of "Getting started" open the first installation of the org.
      let firstInstallation = signed.membership.org.installations[0]
      return context.render(
        <DashboardPage
          frame={page}
          screen={screen}
          githubUrl={dashboard.githubUrl}
          notice={notice !== null && notice in DASHBOARD_NOTICES ? (notice as DashboardNotice) : null}
          serviceKey={dashboard.serviceKey ?? false}
          installationUrl={firstInstallation ? installationUrl(dashboard.githubUrl, firstInstallation) : null}
          precision={precision}
        />,
      )
    }),

    /**
     * KNT-189. The card "Queue and runners" of the org of the session, as server-sent events: an
     * event `queue` with the HTML of the card each time it changes, a comment as a heartbeat, and an
     * event `end` when the stream reaches its time. requireViewer ran before, as for the dashboard:
     * the org is the one of the session, never one that the request names.
     */
    dashboardLive: createAction(pageRoutes.dashboardLive, (context) => {
      let signed = signedOf(context)
      if (!hub || live.closing?.aborted) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      let sessionId = signed.sessionId
      let held = streams.get(sessionId) ?? 0
      if (held >= (live.perSession ?? LIVE_PER_SESSION)) {
        log('warn', 'dashboard.live_refused', { login: signed.user.login, org: signed.membership.org.name, reason: 'too many streams', streams: held })
        return new Response('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30' } })
      }
      streams.set(sessionId, held + 1)
      let orgId = signed.membership.org.id
      let source = hub
      let encoder = new TextEncoder()
      let finish = () => {}
      let body = new ReadableStream<Uint8Array>({
        start(controller) {
          let done = false
          let send = (text: string) => {
            if (done) return
            try {
              controller.enqueue(encoder.encode(text))
            } catch {
              finish()
            }
          }
          let unsubscribe = () => {}
          let heartbeat = setInterval(() => send(': ping\n\n'), live.heartbeatMs ?? LIVE_HEARTBEAT_MS)
          let limit = setTimeout(() => {
            send('event: end\ndata: {}\n\n')
            finish()
          }, live.maxMs ?? LIVE_MAX_MS)
          finish = () => {
            if (done) return
            done = true
            unsubscribe()
            clearInterval(heartbeat)
            clearTimeout(limit)
            context.request.signal.removeEventListener('abort', finish)
            live.closing?.removeEventListener('abort', finish)
            let left = (streams.get(sessionId) ?? 1) - 1
            if (left > 0) streams.set(sessionId, left)
            else streams.delete(sessionId)
            try {
              controller.close()
            } catch {
              // The client is gone: the stream is already closed.
            }
          }
          context.request.signal.addEventListener('abort', finish, { once: true })
          live.closing?.addEventListener('abort', finish, { once: true })
          // The source gives up when the database fails: the stream ends without `end`, so the browser
          // says "Retrying…" and waits, and the page re-read shows the card again.
          unsubscribe = source.subscribe(orgId, (payload) => send(`event: queue\ndata: ${payload}\n\n`), () => finish())
          if (context.request.signal.aborted) finish()
        },
        cancel() {
          finish()
        },
      })
      return new Response(body, { headers: STREAM_HEADERS })
    }),

    // cop() and csrf() of the session layer ran before.
    jobRetry: createAction(pageRoutes.jobRetry, async (context) => {
      let signed = signedOf(context)
      let dashboard = deps.dashboard
      if (!dashboard || !canEdit(signed.membership.role)) {
        log('warn', 'dashboard.retry_refused', { login: signed.user.login, org: signed.membership.org.name, reason: 'not an admin' })
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
        org: signed.membership.org.name,
        failedJobId: id,
        reviewLevel: level,
        outcome: outcome.kind,
        ...('jobId' in outcome ? { jobId: outcome.jobId } : {}),
      })
      let notice: DashboardNotice = outcome.kind === 'queued' ? 'retried' : outcome.kind === 'not_found' ? 'missing' : outcome.kind
      return redirect(`${pageRoutes.home.href()}?notice=${notice}`)
    }),

    // cop() and csrf() of the session layer ran before.
    jobDismiss: createAction(pageRoutes.jobDismiss, async (context) => {
      let signed = signedOf(context)
      let dashboard = deps.dashboard
      if (!dashboard || !canEdit(signed.membership.role)) {
        log('warn', 'dashboard.dismiss_refused', { login: signed.user.login, org: signed.membership.org.name, reason: 'not an admin' })
        return forbidden()
      }
      let id = context.params.id
      let dismissed = UUID.test(id) ? await dashboard.store.dismissFailure(signed.membership.org.id, id, signed.user.login) : false
      log('info', 'dashboard.dismiss', { login: signed.user.login, org: signed.membership.org.name, failedJobId: id, dismissed })
      let notice: DashboardNotice = dismissed ? 'dismissed' : 'dismiss_missing'
      return redirect(`${pageRoutes.home.href()}?notice=${notice}`)
    }),
  }
}
