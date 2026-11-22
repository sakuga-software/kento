// REV-14. The dashboard: a member reads it; an admin can also retry the last failure, or hide a failure (REV-59).
import { renderToString } from 'remix/component/server'
import { createAction } from 'remix/router'

import { canEdit } from '../../auth/access.ts'

import { UUID } from '@kento-review/protocol'

import type { ReadPullRequest } from '../../dashboard/github.ts'
import { createLiveHub } from '../../dashboard/live.ts'
import type { LiveEntry } from '../../dashboard/streams.ts'
import type { RetryOutcome } from '../../dashboard/store.ts'
import { errorMessage, log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { chartsAvailable } from '../../assets.ts'
import { PRECISION_DAYS } from '../../findings/precision.ts'
import { DASHBOARD_NOTICES, DashboardPage, QueueCard, readPrecisionWindow, type DashboardNotice } from '../dashboard.tsx'
import { forbidden, installationUrl, PlaceholderPage, redirect, signedOf, type UiKit } from './kit.tsx'

/** KNT-189. A quiet stream sends a comment this often, so that no proxy closes it. */
export const LIVE_HEARTBEAT_MS = 25_000
/** KNT-189. A stream ends after this; the browser opens another one. */
export const LIVE_MAX_MS = 2 * 60_000
/** KNT-189 (Fable P2-2 of #53). A stream checks this often that its session and its org are still valid. */
export const LIVE_RECHECK_MS = 20_000
/** KNT-189 (Fable P2-3 of #53). A client that reads nothing for this long loses its stream. */
export const LIVE_STALL_MS = 5_000
/** The bytes that a stream holds for a client that reads slowly. */
export const LIVE_HIGH_WATER = 64 * 1024
/** How often an ending stream looks whether its client read it out. */
const DRAIN_POLL_MS = 50

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  // No buffer in a proxy that reads it (nginx): each event goes out at once.
  'X-Accel-Buffering': 'no',
}

/** A short answer with no stream: the browser waits `retryAfter` seconds before it tries again. */
function noStream(status: 404 | 429 | 503, retryAfter?: number): Response {
  let headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  if (retryAfter) headers.set('Retry-After', String(retryAfter))
  let text = status === 404 ? 'Not Found' : status === 429 ? 'Too Many Requests' : 'Service Unavailable'
  return new Response(text, { status, headers })
}

/** KNT-189. Whether the cookie of a stream still names its session, of a member of its org (app/ui/controllers/auth.tsx). */
export type StillSigned = (headers: Headers, sessionId: string, orgId: string) => Promise<boolean | null>

export function dashboardActions(kit: UiKit, stillSigned: StillSigned) {
  let { deps } = kit
  let dashboard = deps.dashboard
  let live = dashboard?.live ?? {}
  // KNT-189. One read of the card per org and per tick, whatever the number of streams of the org.
  let hub = dashboard
    ? createLiveHub({
        intervalMs: live.intervalMs,
        async read(orgId) {
          let card = await dashboard.store.queueCard(orgId)
          // The key: the numbers of the card without the clock, so that only a change sends it (Fable P3-6).
          let { now: _now, ...numbers } = card
          return {
            key: JSON.stringify(numbers),
            // The org of the card: a page of another org reloads itself (Fable P3-1).
            payload: JSON.stringify({ org: orgId, html: await renderToString(<QueueCard card={card} githubUrl={dashboard.githubUrl} />) }),
          }
        },
      })
    : null
  let streams = kit.streams
  live.closing?.addEventListener(
    'abort',
    () => {
      streams.endAll('shutdown')
      hub?.close()
    },
    { once: true },
  )
  return {
    home: createAction(pageRoutes.home, async (context) => {
      let signed = signedOf(context)
      let page = kit.page(context)
      let dashboard = deps.dashboard
      if (!dashboard) return context.render(<PlaceholderPage frame={page} section="dashboard" />)
      // KNT-191, KNT-195: the window of the precision, `?precision=7`; 30 days has no query, and any
      // other value goes back to the URL without it.
      let asked = context.url.searchParams.get('precision')
      let precisionDays = readPrecisionWindow(asked)
      if (asked !== null && precisionDays === PRECISION_DAYS) {
        let url = new URL(context.url)
        url.searchParams.delete('precision')
        return redirect(`${url.pathname}${url.search}`)
      }
      let [screen, precision] = await Promise.all([
        dashboard.store.screen(signed.membership.org.id),
        deps.findings?.store.precision(signed.membership.org.id, precisionDays) ?? null,
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
          precisionDays={precisionDays}
          charts={dashboard.charts ?? chartsAvailable()}
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
      if (!hub) return noStream(404)
      // Fable P2-1 of #53: a server that shuts down asks the browser to come back, never to stop.
      if (live.closing?.aborted) return noStream(503, 5)
      let sessionId = signed.sessionId
      let admitted = streams.admit(sessionId)
      if (admitted !== 'ok') {
        // A fifth tab of a session is expected, not a fault (Fable P3-2): `info`.
        log(admitted === 'session' ? 'info' : 'warn', 'dashboard.live_refused', {
          login: signed.user.login,
          org: signed.membership.org.name,
          reason: admitted === 'session' ? 'too many streams of the session' : 'too many streams',
          streams: streams.size(),
        })
        return noStream(admitted === 'session' ? 429 : 503, 30)
      }
      let orgId = signed.membership.org.id
      let source = hub
      // The cookie of the request: each check of the session reads it again.
      let cookie = new Headers({ Cookie: context.headers.get('Cookie') ?? '' })
      let encoder = new TextEncoder()
      let highWater = live.highWaterMark ?? LIVE_HIGH_WATER
      let stallMs = live.stallMs ?? LIVE_STALL_MS
      let entry: LiveEntry = { sessionId, end: () => {} }
      let gone = () => {}
      streams.add(entry)
      let body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            /** `open` sends; `ending` waits for the client to read the rest; `closed` holds nothing. */
            let state: 'open' | 'ending' | 'closed' = 'open'
            let stalledSince: number | null = null
            let draining: ReturnType<typeof setInterval> | undefined
            let unsubscribe = () => {}
            let release = () => streams.remove(entry)
            let stop = () => {
              unsubscribe()
              clearInterval(heartbeat)
              clearInterval(watcher)
              clearInterval(recheck)
              clearTimeout(limit)
              clearInterval(draining)
              context.request.signal.removeEventListener('abort', gone)
            }
            // The client left (it closed the connection, or cancelled the body): nothing to hold.
            gone = () => {
              if (state === 'closed') return
              state = 'closed'
              stop()
              try {
                controller.close()
              } catch {
                // Already closed.
              }
              release()
            }
            // The client reads nothing: the stream fails, and the server closes the socket (Fable P2-3 of #53).
            let cut = (reason: string) => {
              if (state === 'closed') return
              state = 'closed'
              stop()
              log('info', 'dashboard.live_cut', { login: signed.user.login, reason })
              controller.error(new Error(`live stream cut: ${reason}`))
              release()
            }
            let full = () => controller.desiredSize !== null && controller.desiredSize <= 0
            let watch = () => {
              if (!full()) {
                stalledSince = null
                return
              }
              stalledSince ??= Date.now()
              if (Date.now() - stalledSince >= stallMs) cut('not read')
            }
            let send = (text: string) => {
              if (state !== 'open') return
              try {
                controller.enqueue(encoder.encode(text))
              } catch {
                gone()
                return
              }
              watch()
            }
            // The stream stops sending, with a last event or none, then holds its place until its client
            // has read it out; a client that does not is cut.
            let end = (last: string | null) => {
              if (state !== 'open') return
              if (last) send(last)
              if (state !== 'open') return
              state = 'ending'
              stop()
              let since = Date.now()
              let check = () => {
                if (state !== 'ending') return
                if (controller.desiredSize !== null && controller.desiredSize >= highWater) {
                  state = 'closed'
                  clearInterval(draining)
                  controller.close()
                  release()
                } else if (Date.now() - since >= stallMs) {
                  cut('not read at the end')
                }
              }
              draining = setInterval(check, DRAIN_POLL_MS)
              check()
            }
            // The sign-out, the switch of org, the end of the session or of the server: no event `end`,
            // so the browser connects again and the checks of requireViewer run again.
            entry.end = (reason) => {
              log('info', 'dashboard.live_ended', { login: signed.user.login, reason })
              end(null)
            }
            let heartbeat = setInterval(() => send(': ping\n\n'), live.heartbeatMs ?? LIVE_HEARTBEAT_MS)
            let watcher = setInterval(watch, Math.min(1000, stallMs))
            let limit = setTimeout(() => end('event: end\ndata: {}\n\n'), live.maxMs ?? LIVE_MAX_MS)
            let recheck = setInterval(() => {
              void stillSigned(cookie, sessionId, orgId).then((valid) => {
                if (valid !== false || state !== 'open') return
                log('info', 'dashboard.live_ended', { login: signed.user.login, reason: 'session or membership no longer valid' })
                end(null)
              })
            }, live.recheckMs ?? LIVE_RECHECK_MS)
            context.request.signal.addEventListener('abort', gone, { once: true })
            // The source gives up when the database fails: the stream ends without `end`, so the browser
            // says "Retrying…" and waits, and the page re-read shows the card again.
            unsubscribe = source.subscribe(orgId, (payload) => send(`event: queue\ndata: ${payload}\n\n`), () => end(null))
            if (context.request.signal.aborted) gone()
          },
          cancel() {
            gone()
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: highWater }),
      )
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
