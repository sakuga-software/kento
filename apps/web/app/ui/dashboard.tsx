import { LEVELS, type Level } from '@kento-review/protocol'
import type { Handle } from 'remix/component'

import type { DashboardScreen, DayStats, FailedJob, FailureBanner, QueueCardView, QueueJob, QueueStall, RecentReview, RunnerCounts } from '../dashboard/store.ts'
import { QUEUE_STALL_MINUTES } from '../publish/queued.ts'
import { Button, buttonClass } from './controls.tsx'
import { agoOrDate, agoShort, clock, duration, elapsed, hour, hourSeconds, plural, usdPrecise, weekday } from './format.ts'
import { ExternalIcon } from './icons.tsx'
import type { OrgCostsDetail } from '../db/costs.ts'
import type { OrgCaps } from '../org-settings/model.ts'
import { costRoutes, pageRoutes as routes, pullRoutes } from '../routes.ts'
import { jobReason, reasonSentence, TechDetails, type Reason } from './reasons.tsx'
import { countsText, runnerState, runnerStateLabel } from './runners.tsx'
import { Shell, type PageFrame } from './shell.tsx'
import { PRECISION_DAYS, PRECISION_MIN, PRECISION_WINDOWS, type PrecisionReport, type PrecisionWindow } from '../findings/precision.ts'
import { findingsHref } from './findings.tsx'
import { PrecisionValue, precisionCounts, shortName } from './precision.tsx'
import { TableChart } from './public/chart.tsx'
import { LiveQueue, QUEUE_CARD_ID } from './public/live-queue.tsx'
import { Score } from './score.tsx'

/** The page asks the server again this often, while it is on screen (public/assets/dashboard.js). */
export const REFRESH_SECONDS = 10

/** What the dashboard says after "Retry", from `?notice=`. */
export const DASHBOARD_NOTICES = {
  retried: 'Review started again. The job is queued.',
  already: 'A review of this level is already queued or in progress on this commit.',
  stale: 'A more recent push replaced this commit. Its review follows the new commit.',
  closed: 'The pull request is closed on GitHub, so nothing starts again.',
  capped: 'The organization reached its cost cap, so nothing starts again. An admin changes it in Settings.',
  github_failed: 'GitHub did not answer, and nothing starts again. Try again in a moment.',
  dismissed: 'Failure hidden. It still counts in "Failures · 7 d".',
  dismiss_missing: 'Nothing is hidden. This failure is already hidden, or it changed since you loaded the page.',
  missing: 'Nothing starts again. This job changed since you loaded the page, or its repo is no longer enabled. Retry it from the list below, or enable its repo on the Repos screen.',
} as const
export type DashboardNotice = keyof typeof DASHBOARD_NOTICES


/** The reason of a failure, in words, with what to do (app/ui/reasons.tsx). */
export function failureText(job: Pick<FailedJob, 'reason' | 'runnerName'>): Reason {
  return jobReason(job.reason, job.runnerName)
}

export type CapState = 'none' | 'ok' | 'alert' | 'reached'

/**
 * Where a spend stands against its limit and the alert threshold of the org. As at the enqueue
 * (app/org-settings/model.ts), a limit is reached at its value, and a limit of 0 is reached at once.
 */
export function capState(usd: number, cap: number | null, alertPct: number): CapState {
  if (cap === null) return 'none'
  if (usd >= cap) return 'reached'
  if (usd >= (cap * alertPct) / 100) return 'alert'
  return 'ok'
}

const LEVEL_LABEL: Record<Level, string> = { lite: 'lite', balanced: 'balanced', heavy: 'heavy' }

/** The verdict of a review: a word on a badge, pine, fallen leaf or vermilion (REV-91). */
export const VERDICT_LABEL: Record<string, { text: string; tag: string }> = {
  APPROVE: { text: 'Approved', tag: 'tag-ok' },
  COMMENT: { text: 'Comment', tag: 'tag-warn' },
  REQUEST_CHANGES: { text: 'Changes requested', tag: 'tag-alert' },
}

const CAP_TEXT: Record<CapState, string> = {
  none: 'No cap',
  ok: 'Under the alert threshold',
  alert: 'Alert threshold reached',
  reached: 'Cap reached',
}
/** KNT-190. The section "Costs and cap" of the settings, where an admin sets the caps. */
export const CAP_SETTINGS_HREF = `${routes.settings.href()}#cap`

/** KNT-190. "No cap": a link to the caps for who can set them (as the settings decide), plain text for the others. */
function NoCap(handle: Handle<{ admin: boolean; text: string }>) {
  return () =>
    handle.props.admin ? (
      <a href={CAP_SETTINGS_HREF}>
        {handle.props.text}
        <span class="visually-hidden">: set a cap in the settings</span>
      </a>
    ) : (
      handle.props.text
    )
}

const CAP_STATUS: Record<CapState, string> = {
  none: 'status-stale',
  ok: 'status-online',
  alert: 'status-wait',
  reached: 'status-alert',
}

export interface DashboardPageProps {
  frame: PageFrame
  screen: DashboardScreen
  /** `https://github.com`, or the GitHub Enterprise Server: the links "Open the PR". */
  githubUrl: string
  notice?: DashboardNotice | null
  /** KENTO_PROVIDER_API_KEY is set: a trusted runner of the service gets the key of the service without a provider. */
  serviceKey?: boolean
  /** The page of the installation of the App on GitHub, where an owner picks the repositories. */
  installationUrl?: string | null
  /** REV-18. The precision of the org over 30 days (or `precisionDays`); null without the Findings screen. */
  precision?: PrecisionReport | null
  /** KNT-191. The window of the precision, from `?precision=`. Default 30. */
  precisionDays?: PrecisionWindow
  /** KNT-191, Fable P2-2 of #65: false when the asset server cannot serve the charts. Default true. */
  charts?: boolean
}

/** One step of the list "Getting started" (REV-26). */
export interface SetupStep {
  key: 'app' | 'provider' | 'runner' | 'repo' | 'review'
  title: string
  state: 'done' | 'wait' | 'todo'
  /** What is true now, in one sentence. */
  text: string
  /** Where the step is done. An admin gets it as a link; a member reads "Ask an admin". */
  action: { label: string; href: string; external?: boolean } | null
}

const SETUP_STATE: Record<SetupStep['state'], { text: string; status: string }> = {
  done: { text: 'Done', status: 'status-online' },
  wait: { text: 'In progress', status: 'status-wait' },
  todo: { text: 'To do', status: 'status-stale' },
}

/**
 * REV-26. The steps to the first review, each from the state of the org: the App, a provider (or
 * the key of the service), a runner online, a repository enabled, then a pull request. Null once a
 * review of the org is published: the list is gone for good.
 */
export function setupSteps(
  screen: Pick<DashboardScreen, 'setup' | 'runnerCounts' | 'queue'>,
  options: { serviceKey: boolean; installationUrl: string | null },
): SetupStep[] | null {
  let { setup, runnerCounts, queue } = screen
  if (setup.published) return null
  let online = runnerCounts.online
  let registered = runnerCounts.online + runnerCounts.late + runnerCounts.offline
  let jobs = queue.runningCount + queue.queuedCount
  let install = options.installationUrl ? { label: 'Open the installation on GitHub', href: options.installationUrl, external: true } : null
  return [
    setup.suspended
      ? {
          key: 'app',
          title: 'Install the GitHub App',
          state: 'todo',
          text: 'The installation is suspended on GitHub, and no push creates a job. An owner of the organization enables it again.',
          action: install,
        }
      : {
          key: 'app',
          title: 'Install the GitHub App',
          state: 'done',
          text: 'The App is installed on the organization. It sees only the repos chosen on GitHub.',
          action: install ? { ...install, label: 'Choose the repos on GitHub' } : null,
        },
    setup.providers > 0
      ? {
          key: 'provider',
          title: 'Add a provider',
          state: 'done',
          text: setup.providers === 1 ? '1 provider in Settings.' : `${setup.providers} providers in Settings.`,
          action: { label: 'See the providers', href: `${routes.settings.href()}#providers-title` },
        }
      : options.serviceKey && setup.serviceRunners > 0
        ? {
            key: 'provider',
            title: 'Add a provider',
            state: 'done',
            text: 'No provider. The runners of the service review with the key of the service. A runner of your organization needs its own OpenRouter key. Add a provider to pay for your own reviews.',
            action: { label: 'Add a provider', href: `${routes.settings.href()}#new-provider` },
          }
        : options.serviceKey
          ? {
              key: 'provider',
              title: 'Add a provider',
              state: 'todo',
              // REV-130: the key of the service never goes to a runner of an org.
              text: 'No provider. The key of the service goes only to a runner of the service, and there is none. A runner of your organization needs its own OpenRouter key, or add a provider.',
              action: { label: 'Add a provider', href: `${routes.settings.href()}#new-provider` },
            }
          : {
            key: 'provider',
            title: 'Add a provider',
            state: 'todo',
            text: 'No provider, and no key of the service. A runner has no model to call.',
            action: { label: 'Add a provider', href: `${routes.settings.href()}#new-provider` },
          },
    online > 0
      ? {
          key: 'runner',
          title: 'Register a runner',
          state: 'done',
          text: online === 1 ? '1 runner online.' : `${online} runners online.`,
          action: { label: 'See the runners', href: routes.runners.href() },
        }
      : registered > 0 || setup.pendingRegistrations > 0
        ? {
            key: 'runner',
            title: 'Register a runner',
            state: 'wait',
            text:
              registered > 0
                ? 'A runner is registered, but none is online. The jobs wait for it in the queue.'
                : 'A registration token waits for its runner.',
            action: { label: 'See the runners', href: routes.runners.href() },
          }
        : {
            key: 'runner',
            title: 'Register a runner',
            state: 'todo',
            text: 'No runner. The jobs would wait in the queue.',
            action: { label: 'Create a runner', href: routes.runners.href() },
          },
    setup.enabledRepos > 0
      ? {
          key: 'repo',
          title: 'Enable a repo',
          state: 'done',
          text: setup.enabledRepos === 1 ? '1 repo enabled.' : `${setup.enabledRepos} repos enabled.`,
          action: { label: 'See the repos', href: routes.repos.href() },
        }
      : {
          key: 'repo',
          title: 'Enable a repo',
          state: 'todo',
          text: 'No repo enabled. A push creates no job.',
          action: { label: 'Enable a repo', href: routes.repos.href() },
        },
    jobs > 0
      ? {
          key: 'review',
          title: 'Get the first review',
          state: 'wait',
          text:
            queue.runningCount > 0
              ? 'Waiting for the first review. A runner does the job.'
              : 'Waiting for the first review. The job is queued, and a runner online will take it.',
          action: null,
        }
      : {
          key: 'review',
          title: 'Get the first review',
          state: 'todo',
          text: 'Open a pull request, or push to an open pull request, in an enabled repo.',
          action: null,
        },
  ]
}

function prUrl(githubUrl: string, repo: string, prNumber: number): string {
  let [owner, name] = repo.split('/')
  return `${githubUrl}/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/pull/${prNumber}`
}

function total(day: DayStats): number {
  return day.published.lite + day.published.balanced + day.published.heavy
}

/** The mean time of the reviews published over the days: each day weighs by its reviews. Null without one. */
export function weekMeanDuration(week: DayStats[]): number | null {
  let weighted = 0
  let count = 0
  for (let day of week) {
    if (day.meanDurationMs === null) continue
    weighted += day.meanDurationMs * total(day)
    count += total(day)
  }
  return count === 0 ? null : Math.round(weighted / count)
}

export function DashboardPage(handle: Handle<DashboardPageProps>) {
  return () => {
    let { frame, screen, githubUrl, notice, serviceKey, installationUrl, precision } = handle.props
    let precisionDays = handle.props.precisionDays ?? PRECISION_DAYS
    let admin = frame.viewer?.canEdit === true
    let csrf = frame.csrfToken ?? ''
    let org = frame.viewer?.org.name ?? ''
    let steps = setupSteps(screen, { serviceKey: serviceKey ?? false, installationUrl: installationUrl ?? null })
    return (
      <Shell
        frame={frame}
        section="dashboard"
        title="Dashboard"
        meta={
          // KNT-141: at the right of the title. Out of #dashboard-live, so a read every 10 s keeps it.
          <p class="dash-updated">
            <span data-updated={screen.now.toISOString()}>Updated at {hourSeconds(screen.now)}</span>
            {' · '}
            <a href={routes.home.href()}>Refresh</a>
          </p>
        }
      >
        <div class="dashboard" id="dashboard-live" data-refresh={String(REFRESH_SECONDS)}>
          {notice ? (
            <div class={`banner ${notice === 'retried' ? 'banner-ok' : 'banner-info'}`} role="status">
              <p>{DASHBOARD_NOTICES[notice]}</p>
            </div>
          ) : null}

          {steps ? <SetupSection steps={steps} admin={admin} /> : null}

          <TodoSection screen={screen} admin={admin} csrf={csrf} githubUrl={githubUrl} />

          <Kpis screen={screen} precision={precision ?? null} precisionDays={precisionDays} admin={admin} />

          <WeekSection week={screen.week} />

          <div class="dash-main">
            <RecentSection recent={screen.recent} now={screen.now} org={org} />
            <div class="dash-side">
              <QueueRunnersSection card={screen} githubUrl={githubUrl} orgId={frame.viewer?.org.id ?? ''} />
              <CostSection costs={screen.costs} caps={screen.caps} admin={admin} />
            </div>
          </div>

          <div class="dash-grid">
            <FailuresSection failures={screen.failures} now={screen.now} githubUrl={githubUrl} admin={admin} csrf={csrf} />
            <DashPrecision precision={precision ?? null} org={org} days={precisionDays} charts={handle.props.charts ?? true} />
          </div>
        </div>
        <script src={`/assets/dashboard.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script>
      </Shell>
    )
  }
}

function SetupSection(handle: Handle<{ steps: SetupStep[]; admin: boolean }>) {
  return () => {
    let { steps, admin } = handle.props
    let done = steps.filter((step) => step.state === 'done').length
    return (
      <section class="card setup" aria-labelledby="setup-title">
        <div class="dash-section-head">
          <h2 id="setup-title" class="section-title">
            Getting started
          </h2>
          <span class="hint">
            {done} of {steps.length} {plural(steps.length, 'step')}
          </span>
        </div>
        <p class="hint setup-lead">
          {admin
            ? 'What it takes to get the first review. This list goes away when the review is published.'
            : 'What it takes to get the first review. An admin of the organization does these steps. This list goes away when the first review is published.'}
        </p>
        <ol class="setup-steps">
          {steps.map((step, index) => (
            <li class={`setup-step setup-${step.state}`} id={`setup-${step.key}`}>
              <span class="setup-index" aria-hidden="true">
                {index + 1}
              </span>
              <div class="setup-body">
                <div class="dash-review-head">
                  <h3 class="setup-title">{step.title}</h3>
                  <span class={`status ${SETUP_STATE[step.state].status}`}>{SETUP_STATE[step.state].text}</span>
                </div>
                <p class="hint">{step.text}</p>
                {step.state !== 'done' && step.action && !admin ? <p class="hint">Ask an admin of the organization.</p> : null}
              </div>
              {step.action && (admin || step.state === 'done') ? (
                <a
                  class={buttonClass(step.state === 'todo' && admin ? 'primary' : 'outline', 'sm')}
                  href={step.action.href}
                  {...(step.action.external ? { rel: 'noreferrer', target: '_blank' } : {})}
                >
                  {step.action.label}
                  {step.action.external ? (
                    <>
                      <ExternalIcon />
                      <span class="visually-hidden">(GitHub, new tab)</span>
                    </>
                  ) : null}
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    )
  }
}

/**
 * REV-52. Jobs wait for more than QUEUE_STALL_MINUTES: the probable cause, and what to do. The pull
 * requests of these jobs get a comment of the publisher too (app/publish/queued.ts).
 */
export function stallText(stall: QueueStall, online: number, now: Date): { title: string; cause: string; action: string } {
  let jobs = stall.count === 1 ? '1 job has waited' : `${stall.count} jobs have waited`
  let title = `${jobs} in the queue for more than ${QUEUE_STALL_MINUTES} min (the oldest for ${elapsed(stall.since, now)})`
  if (online === 0) {
    let cause = stall.lastRunnerSeenAt
      ? `No runner online for ${elapsed(stall.lastRunnerSeenAt, now)} (last signal at ${clock(stall.lastRunnerSeenAt)}).`
      : 'No runner ever called Kentō.'
    return { title, cause, action: 'Start a runner, see the Runners screen. The jobs leave the queue at its first call.' }
  }
  if (stall.serviceKeyJobs > 0 && stall.serviceRunnersOnline === 0) {
    // REV-130: a job with no provider waits for a runner with an OpenRouter key: a runner of the
    // service, which gets the key of the service, or a runner with its own key. While a trusted
    // runner of the service is online, the jobs only wait for it to be free: the cause below.
    let which =
      stall.serviceKeyJobs === stall.count
        ? stall.count === 1 ? 'This job has' : 'These jobs have'
        : `${stall.serviceKeyJobs} of these jobs ${stall.serviceKeyJobs === 1 ? 'has' : 'have'}`
    return {
      title,
      cause: `${which} no provider: ${stall.serviceKeyJobs === 1 ? 'it waits' : 'they wait'} for a runner with an OpenRouter key. The key of the service goes only to a runner of the service, never to a runner of your organization.`,
      action: 'Give your runner its own OpenRouter key (PROVIDER_KIND=openrouter and PROVIDER_API_KEY), or add a provider in Settings.',
    }
  }
  let cause =
    online === 1
      ? '1 runner is online, but it does not take these jobs. It is busy, or it cannot call the provider of their repo.'
      : `${online} runners are online, but none takes these jobs. They are busy, or they cannot call the provider of their repo.`
  return { title, cause, action: 'Check their labels and their providers on the Runners screen, or start one more runner.' }
}

/**
 * REV-91. "To do": what asks for a person now, one row each. The failure of the banner, the
 * queue that waits, a cost over the alert threshold, the runners with no signal, the repositories
 * still on review.yml. Each row: a mark and a word, what happened, then its actions.
 */
function TodoSection(handle: Handle<{ screen: DashboardScreen; admin: boolean; csrf: string; githubUrl: string }>) {
  return () => {
    let { screen, admin, csrf, githubUrl } = handle.props
    let { now } = screen
    let costs = [
      { id: 'day', usd: screen.costs.dayUsd, cap: screen.caps.dailyCapUsd, when: 'daily' },
      { id: 'month', usd: screen.costs.monthUsd, cap: screen.caps.monthlyCapUsd, when: 'monthly' },
    ]
      .map((cost) => ({ ...cost, state: capState(cost.usd, cost.cap, screen.caps.alertPct) }))
      .filter((cost) => cost.state === 'alert' || cost.state === 'reached')
    let silent = screen.runners.filter((runner) => {
      let state = runnerState({ revokedAt: null, lastSeenAt: runner.lastSeenAt }, now)
      return state === 'late' || state === 'offline'
    })
    let silentCount = screen.runnerCounts.late + screen.runnerCounts.offline
    let count =
      (screen.banner ? 1 : 0) + (screen.stall ? 1 : 0) + costs.length + (silentCount > 0 ? 1 : 0) + (screen.workflowRepos.length > 0 ? 1 : 0)
    // KNT-193: nothing to do, no section. Its count shows nowhere else.
    if (count === 0) return null
    return (
      <section class="dash-todo" aria-labelledby="todo-title">
        <h2 id="todo-title" class="section-title">
          To do <span class="count">{count}</span>
        </h2>
        <ul class="card todo-list">
          {screen.stall ? <StallItem stall={screen.stall} online={screen.runnerCounts.online} now={now} /> : null}
          {screen.banner ? <FailureItem banner={screen.banner} admin={admin} csrf={csrf} githubUrl={githubUrl} now={now} /> : null}
          {costs.map((cost) => (
            <li>
              <section class="todo" aria-labelledby={`todo-cost-${cost.id}`}>
              <span class="todo-kind">
                <span class="status status-cost">Cost</span>
              </span>
              <div class="todo-body">
                <h3 id={`todo-cost-${cost.id}`} class="todo-title">
                  {cost.state === 'reached' ? `The ${cost.when} cap is reached` : `The ${cost.when} alert threshold is reached`}
                </h3>
                <p class="todo-meter">
                  {/* A limit of 0 is reached at once (capState): no share of it, no bar. */}
                  {cost.cap! > 0 ? <Bar parts={[{ pct: (cost.usd / cost.cap!) * 100, tone: 'kuchiba' }]} /> : null}
                  <span class="mono">
                    {usdPrecise(cost.usd)} of {usdPrecise(cost.cap!)}
                    {cost.cap! > 0 ? ` · ${Math.round((cost.usd / cost.cap!) * 100)}%` : ''}
                  </span>
                </p>
              </div>
              <div class="todo-actions">
                <a class={buttonClass()} href={CAP_SETTINGS_HREF}>
                  {admin ? 'Change the cap' : 'See the cap'}
                </a>
              </div>
              </section>
            </li>
          ))}
          {silentCount > 0 ? (
            <li>
              <section class="todo" aria-labelledby="todo-runners">
              <span class="todo-kind">
                <span class="status status-late">Runner</span>
              </span>
              <div class="todo-body">
                {silentCount === 1 && silent.length === 1 ? (
                  <>
                    <h3 id="todo-runners" class="todo-title">
                      <code>{silent[0]!.name}</code>{' '}
                      {silent[0]!.lastSeenAt ? `has given no signal for ${elapsed(silent[0]!.lastSeenAt, now)}` : 'never gave a signal'}
                    </h3>
                    <p class="hint">
                      {silent[0]!.running === 0
                        ? 'It has no job. It is online again at its next signal.'
                        : `${silent[0]!.running} ${plural(silent[0]!.running, 'job')} in progress. Without a signal, ${silent[0]!.running === 1 ? 'it goes' : 'they go'} back to the queue.`}
                    </p>
                  </>
                ) : (
                  <>
                    <h3 id="todo-runners" class="todo-title">
                      {silentCount === 1 ? '1 runner gives no signal' : `${silentCount} runners give no signal`}
                    </h3>
                    <p class="hint">
                      {/* The store bounds the list of runners: the silent ones can be absent from it. */}
                      {silent.length > 0
                        ? `${silent
                            .slice(0, 3)
                            .map((runner) => runner.name)
                            .join(', ')}${silentCount > Math.min(3, silent.length) ? ` and ${silentCount - Math.min(3, silent.length)} more` : ''}. `
                        : ''}
                      A runner is online again at its next signal.
                    </p>
                  </>
                )}
              </div>
              <div class="todo-actions">
                <a class={buttonClass()} href={routes.runners.href()}>
                  See the runners
                </a>
              </div>
              </section>
            </li>
          ) : null}
          {screen.workflowRepos.length > 0 ? (
            <li>
              <section class="todo dash-workflow" aria-labelledby="todo-workflow">
              <span class="todo-kind">
                <span class="status status-switch">Switch</span>
              </span>
              <div class="todo-body">
                <h3 id="todo-workflow" class="todo-title">
                  {screen.workflowRepos.length === 1 ? '1 repo is still on' : `${screen.workflowRepos.length} repos are still on`}{' '}
                  <code>review.yml</code>
                </h3>
                <p class="hint">{screen.workflowRepos.join(', ')}. Kentō does not track their findings here.</p>
              </div>
              <div class="todo-actions">
                {/* KNT-179: the filter of the repos that still hold review.yml. */}
                <a class={buttonClass()} href={`${routes.repos.href()}?filter=switching`}>
                  See the repos
                </a>
              </div>
              </section>
            </li>
          ) : null}
        </ul>
      </section>
    )
  }
}

/** REV-52, in "To do": jobs wait for more than QUEUE_STALL_MINUTES, the probable cause and what to do. */
function StallItem(handle: Handle<{ stall: QueueStall; online: number; now: Date }>) {
  return () => {
    let { stall, online, now } = handle.props
    let text = stallText(stall, online, now)
    return (
      <li>
        <section class="todo dash-stall" role="alert" aria-labelledby="todo-stall">
        <span class="todo-kind">
          <span class="status status-wait">Queue</span>
        </span>
        <div class="todo-body">
          <h3 id="todo-stall" class="todo-title">
            {text.title}
          </h3>
          <p class="hint">{text.cause}</p>
          <p class="hint">
            {text.action} Kentō commented on the pull requests of these jobs.
          </p>
        </div>
        <div class="todo-actions">
          <a class={buttonClass()} href={routes.runners.href()}>
            See the runners
          </a>
        </div>
        </section>
      </li>
    )
  }
}

function FailureItem(handle: Handle<{ banner: FailureBanner; admin: boolean; csrf: string; githubUrl: string; now: Date }>) {
  return () => {
    let { banner, admin, csrf, githubUrl, now } = handle.props
    let reason = failureText(banner)
    return (
      <li>
        <section class="todo todo-wide dash-failure" aria-labelledby={`todo-failure-${banner.id}`}>
        <span class="todo-kind">
          <span class="status status-alert">Failure</span>
        </span>
        <div class="todo-body">
          <h3 id={`todo-failure-${banner.id}`} class="todo-title">
            The {banner.level} review of <span class="mono">{banner.repo}#{banner.prNumber}</span> failed
          </h3>
          <p class="hint">
            Reason: {reason.text}. {reason.action}{' '}
            {banner.previous
              ? `The previous review (${banner.previous.score}/5, published on ${clock(banner.previous.publishedAt)}) stays on the pull request.`
              : 'No review is published on this pull request yet.'}
          </p>
          <TechDetails raw={reason.raw} />
          {banner.retry ? (
            <p class="hint">
              <strong>
                Retry at {banner.retry.level} {banner.retry.state === 'queued' ? 'queued' : 'in progress'}
              </strong>
              . This row goes away when its review is published.
            </p>
          ) : null}
          {admin && !banner.retry ? (
            <p class="hint">The estimate is the mean of the last reviews of this level on this repo.</p>
          ) : null}
        </div>
        <div class="todo-actions">
          {banner.finishedAt ? (
            <time class="todo-when mono" dateTime={banner.finishedAt.toISOString()}>
              {agoOrDate(banner.finishedAt, now)}
            </time>
          ) : null}
          {admin && !banner.retry
            ? LEVELS.map((level) => {
                let estimate = banner.estimates[level]
                return (
                  <form class="todo-retry" method="post" action={routes.jobRetry.href({ id: banner.id })}>
                    <input type="hidden" name="_csrf" value={csrf} />
                    <input type="hidden" name="level" value={level} />
                    <Button variant={level === banner.level ? 'primary' : 'outline'} type="submit">
                      Run again at {LEVEL_LABEL[level]}
                      <span class="dash-estimate">{estimate === null ? ' · unknown cost' : ` · ≈ ${usdPrecise(estimate)}`}</span>
                    </Button>
                  </form>
                )
              })
            : null}
          <a class={buttonClass('ghost')} href={prUrl(githubUrl, banner.repo, banner.prNumber)}>
            Open the PR
          </a>
          {admin ? <DismissForm id={banner.id} csrf={csrf} label={`Hide the failure of ${banner.repo}#${banner.prNumber}`} ghost /> : null}
        </div>
        </section>
      </li>
    )
  }
}

/** REV-91. Five numbers in one band: the reviews and failures of the week, the cost of the month, the precision, the queue. */
function Kpis(handle: Handle<{ screen: DashboardScreen; precision: PrecisionReport | null; precisionDays: PrecisionWindow; admin: boolean }>) {
  return () => {
    let { screen, precision, precisionDays, admin } = handle.props
    let today = screen.week.at(-1)
    let weekPublished = screen.week.reduce((sum, day) => sum + total(day), 0)
    let weekFailed = screen.week.reduce((sum, day) => sum + day.failed, 0)
    let mean = weekMeanDuration(screen.week)
    let max = Math.max(1, ...screen.week.map(total))
    let month = screen.costs.monthUsd
    let cap = screen.caps.monthlyCapUsd
    let org = precision?.org ?? null
    return (
      <section class="dash-kpis card" aria-label="At a glance">
        <div class="kpi">
          <span class="kpi-label">Published reviews · 7 d</span>
          <span class="kpi-row">
            <span class="kpi-value">{weekPublished}</span>
            <svg class="kpi-bars" viewBox="0 0 76 28" aria-hidden="true" focusable="false">
              {screen.week.map((day, i) => {
                let h = total(day) === 0 ? 2 : Math.max(4, Math.round((total(day) / max) * 28))
                return <rect class={i === screen.week.length - 1 ? 'kpi-bar-today' : 'kpi-bar'} x={i * 11} y={28 - h} width={8} height={h} />
              })}
            </svg>
          </span>
          <span class="kpi-sub">
            {today ? total(today) : 0} today{mean !== null ? ` · ${duration(mean)} on average` : ''}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Failures · 7 d</span>
          <span class={`kpi-value ${weekFailed > 0 ? 'kpi-alert' : ''}`}>{weekFailed}</span>
          <span class="kpi-sub">{weekFailed === 0 ? 'no failed job' : `failed ${plural(weekFailed, 'job')}`}</span>
        </div>
        {/* KNT-188: the whole tile opens the Costs screen (the link stretches over it, kento.css). */}
        <div class="kpi kpi-linked">
          <a class="kpi-label kpi-link" href={costRoutes.costs.href()}>
            Cost of the month<span class="visually-hidden">: see the costs</span>
          </a>
          <span class="kpi-value">{usdPrecise(month)}</span>
          {cap !== null && cap > 0 ? (
            <Bar parts={[{ pct: (month / cap) * 100, tone: 'ink' }]} />
          ) : null}
          <span class={`kpi-sub${cap !== null && capState(month, cap, screen.caps.alertPct) === 'reached' ? ' kpi-alert' : ''}`}>
            {cap === null ? (
              <NoCap admin={admin} text="no cap" />
            ) : capState(month, cap, screen.caps.alertPct) === 'reached' ? (
              `cap reached · of ${usdPrecise(cap)}`
            ) : (
              `of ${usdPrecise(cap)} · alert at ${screen.caps.alertPct}%`
            )}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Precision · {precisionDays} d</span>
          {/* The share needs closed findings: a rate with none would divide by 0. */}
          {org && org.rate !== null && org.closed > 0 ? (
            <>
              <span class="kpi-row">
                <span class="kpi-value">{Math.round(org.rate * 100)}%</span>
                <span class="kpi-sub">n = {org.closed}</span>
              </span>
              <Bar
                parts={[
                  { pct: (org.fixed / org.closed) * 100, tone: 'matsu' },
                  { pct: (org.dismissed / org.closed) * 100, tone: 'kuchiba' },
                ]}
              />
              <span class="kpi-sub">{precisionCounts(org)}</span>
            </>
          ) : (
            <>
              <span class="kpi-value kpi-pending">{org && org.closed > 0 ? `n = ${org.closed} of ${PRECISION_MIN}` : '—'}</span>
              <span class="kpi-sub">from {PRECISION_MIN} closed findings</span>
            </>
          )}
        </div>
        <div class="kpi">
          <span class="kpi-label">Job queue</span>
          <span class="kpi-value">
            {screen.queue.runningCount} · {screen.queue.queuedCount}
          </span>
          <span class="kpi-sub">in progress · waiting</span>
        </div>
      </section>
    )
  }
}

/** A bar of 0 to 100 %, in SVG: the policy of the screens allows no inline style. The text beside it holds the numbers. */
function Bar(handle: Handle<{ parts: { pct: number; tone: 'ink' | 'matsu' | 'kuchiba' }[] }>) {
  return () => {
    let x = 0
    return (
      <svg class="dash-gauge" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect class="dash-gauge-track" width={100} height={8} />
        {handle.props.parts.map((part) => {
          let width = Math.max(0, Math.min(100 - x, part.pct))
          let rect = <rect class={`dash-gauge-fill dash-gauge-${part.tone}`} x={x} width={width} height={8} />
          x += width
          return rect
        })}
      </svg>
    )
  }
}

function Meter(handle: Handle<{ id: string; label: string; usd: number; cap: number | null; alertPct: number; admin: boolean }>) {
  return () => {
    let { id, label, usd, cap, alertPct, admin } = handle.props
    let state = capState(usd, cap, alertPct)
    return (
      <div class="dash-cost">
        <div class="dash-cost-head">
          <span class="dash-cost-label" id={`${id}-label`}>
            {label}
          </span>
          <span class={`status ${CAP_STATUS[state]}`}>{state === 'none' ? <NoCap admin={admin} text={CAP_TEXT.none} /> : CAP_TEXT[state]}</span>
        </div>
        <p class="dash-cost-value">
          {usdPrecise(usd)}
          {cap !== null ? <span class="dash-cost-cap"> of {usdPrecise(cap)}</span> : null}
        </p>
        {cap !== null && cap > 0 ? (
          <meter
            class="dash-meter"
            aria-labelledby={`${id}-label`}
            min={0}
            max={cap}
            low={(cap * alertPct) / 100}
            high={cap * 0.999}
            optimum={0}
            value={Math.min(usd, cap)}
          >
            {usdPrecise(usd)} of {usdPrecise(cap)}
          </meter>
        ) : null}
        {cap !== null ? <p class="hint">Alert at {alertPct}% of the cap.</p> : null}
      </div>
    )
  }
}

function CostSection(handle: Handle<{ costs: OrgCostsDetail; caps: OrgCaps; admin: boolean }>) {
  return () => {
    let { costs, caps, admin } = handle.props
    return (
      <section class="dash-section card" aria-labelledby="cost-title">
        <h2 id="cost-title" class="section-title">
          Cost
        </h2>
        <div class="dash-costs">
          <Meter id="cost-day" label="Today (UTC)" usd={costs.dayUsd} cap={caps.dailyCapUsd} alertPct={caps.alertPct} admin={admin} />
          <Meter id="cost-month" label="This month (UTC)" usd={costs.monthUsd} cap={caps.monthlyCapUsd} alertPct={caps.alertPct} admin={admin} />
        </div>
        {/* An admin already has "No cap" as a link to the caps (KNT-190): the hint is for a member. */}
        {!admin && caps.dailyCapUsd === null && caps.monthlyCapUsd === null ? (
          <p class="hint">
            The organization has no cap. An admin sets it in <a href={CAP_SETTINGS_HREF}>Settings</a>.
          </p>
        ) : null}
        {costs.monthByProvider.length > 0 ? (
          <table class="dash-table">
            <caption class="visually-hidden">Cost by provider</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" class="num">
                  Today
                </th>
                <th scope="col" class="num">
                  This month
                </th>
              </tr>
            </thead>
            <tbody>
              {costs.monthByProvider.map((provider) => (
                <tr>
                  <th scope="row">{provider.label}</th>
                  <td class="num">{usdPrecise(costs.dayByProvider.find((p) => p.providerId === provider.providerId && p.label === provider.label)?.usd ?? 0)}</td>
                  <td class="num">{usdPrecise(provider.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="hint">No spend this month.</p>
        )}
        {costs.monthUnknown > 0 ? (
          <p class="hint">
            {costs.monthUnknown === 1 ? '1 review or resolution' : `${costs.monthUnknown} reviews or resolutions`} of the month with no known
            cost, counted as $0.
          </p>
        ) : null}
      </section>
    )
  }
}

/** The days of the week, folded under the numbers of the band: every number of the chart, per day. */
function WeekSection(handle: Handle<{ week: DayStats[] }>) {
  return () => {
    let { week } = handle.props
    return (
      <details class="dash-week">
        <summary>Published reviews · 7 days, day by day</summary>
        <table class="dash-table">
          <caption class="visually-hidden">Published reviews by day (UTC), by level, failures and mean duration</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Published</th>
              <th scope="col" class="num">
                Failures
              </th>
              <th scope="col" class="num">
                Mean duration
              </th>
            </tr>
          </thead>
          <tbody>
            {[...week].reverse().map((day) => (
              <tr>
                <th scope="row">{weekday(day.day)}</th>
                <td>
                  <strong>{total(day)}</strong>
                  {total(day) > 0 ? (
                    <span class="hint">
                      {' '}
                      ({LEVELS.filter((level) => day.published[level] > 0)
                        .map((level) => `${day.published[level]} ${level}`)
                        .join(', ')}
                      )
                    </span>
                  ) : null}
                </td>
                <td class="num">{day.failed}</td>
                <td class="num">{day.meanDurationMs === null ? '—' : duration(day.meanDurationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    )
  }
}

/** REV-91. The last reviews in one dense table; under 760 px each row is a card (kento.css). */
function RecentSection(handle: Handle<{ recent: RecentReview[]; now: Date; org: string }>) {
  return () => {
    let { recent, now, org } = handle.props
    return (
      <section class="dash-section dash-recent" aria-labelledby="recent-title">
        <div class="dash-section-head">
          <h2 id="recent-title" class="section-title">
            Latest reviews
          </h2>
          <a href={routes.findings.href()}>All findings</a>
        </div>
        {recent.length === 0 ? (
          <div class="empty">
            <p>No review yet. Enable a repo in <a href={routes.repos.href()}>Repos</a>, and its next push starts one.</p>
          </div>
        ) : (
          <div class="card dash-recent-card">
            <table class="dash-reviews">
              <caption class="visually-hidden">Latest reviews</caption>
              <thead>
                <tr>
                  <th scope="col">Pull request</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Level</th>
                  <th scope="col" class="num">
                    Score
                  </th>
                  <th scope="col" class="num">
                    Findings
                  </th>
                  <th scope="col" class="num">
                    Cost
                  </th>
                  <th scope="col" class="num">
                    Duration
                  </th>
                  <th scope="col" class="num">
                    When
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((review) => {
                  let verdict = review.verdict ? VERDICT_LABEL[review.verdict] : undefined
                  return (
                    <tr>
                      <th scope="row" class="dash-review-pr">
                        <a href={pullRoutes.pull.href({ id: review.repoId, number: String(review.prNumber) })} title={`${review.repo}#${review.prNumber}`}>
                          {shortName(review.repo, org)} #{review.prNumber}
                        </a>
                      </th>
                      <td class="dash-review-verdict">
                        {verdict ? <span class={`tag ${verdict.tag}`}>{verdict.text}</span> : null}
                        {review.publishedAt ? null : <span class="status status-stale">Not published</span>}
                      </td>
                      <td class="mono" data-label="Level">
                        {review.level}
                      </td>
                      <td class="num mono" data-label="Score">
                        {/* KNT-187: the score drawn as on the Repos screen. */}
                        <Score value={review.score} />
                      </td>
                      <td class="num mono" data-label="Findings">
                        {review.findings}
                        <span class="dash-unit"> {plural(review.findings, 'finding')}</span>
                      </td>
                      <td class="num mono" data-label="Cost">
                        {review.costUsd === null ? 'unknown' : usdPrecise(review.costUsd)}
                      </td>
                      <td class="num mono" data-label="Duration">
                        {review.durationMs === null ? '—' : duration(review.durationMs)}
                      </td>
                      <td class="num mono" data-label="When">
                        <time dateTime={review.createdAt.toISOString()} title={clock(review.createdAt)}>
                          {agoOrDate(review.createdAt, now)}
                        </time>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    )
  }
}

function QueueItem(handle: Handle<{ job: QueueJob; now: Date; githubUrl: string }>) {
  return () => {
    let { job, now, githubUrl } = handle.props
    let running = job.startedAt !== null && job.runnerName !== null && job.leaseExpiresAt !== null
    let waiting = job.notBefore !== null && job.notBefore > now
    return (
      <li class="dash-job">
        <div class="dash-job-head">
          <span class={`status ${running ? 'status-running' : 'status-wait'}`}>
            <a href={prUrl(githubUrl, job.repo, job.prNumber)}>
              {job.repo}#{job.prNumber}
            </a>
          </span>
          <span class="tag">{job.kind === 'resolve' ? 'resolution' : job.level}</span>
        </div>
        <p class="hint">
          {running ? (
            <>
              On <span class="mono">{job.runnerName}</span> for{' '}
              <time dateTime={job.startedAt!.toISOString()}>{elapsed(job.startedAt!, now)}</time> · attempt{' '}
              {job.attempts} ·{' '}
              <span title="Without a signal of the runner before this hour, the job goes back to the queue.">
                held until <time dateTime={job.leaseExpiresAt!.toISOString()}>{hour(job.leaseExpiresAt!)}</time>
              </span>
              {job.runnerSeenAt ? (
                <>
                  {' '}
                  · last signal <time dateTime={job.runnerSeenAt.toISOString()}>{agoShort(job.runnerSeenAt, now)}</time>
                </>
              ) : null}
            </>
          ) : (
            <>
              Queued <time dateTime={job.createdAt.toISOString()}>for {elapsed(job.createdAt, now)}</time>
              {job.attempts > 0 ? ` · ${job.attempts} ${plural(job.attempts, 'attempt')} already` : ''}
              {waiting ? (
                <>
                  {' '}
                  · resumes at <time dateTime={job.notBefore!.toISOString()}>{hourSeconds(job.notBefore!)}</time>
                </>
              ) : null}
            </>
          )}
        </p>
      </li>
    )
  }
}

/** KNT-189. "2 ready / 3 online": the online runners that run no job, of the online ones. */
export function readyText(counts: Pick<RunnerCounts, 'ready' | 'online'>): string {
  return `${counts.ready} ready / ${counts.online} online`
}

/**
 * REV-91. The jobs running then waiting, and the runners, in one panel beside the last reviews.
 * KNT-189: `LiveQueue` keeps the card up to date in the browser (`data-live-queue`, and
 * public/assets/dashboard.js keeps this section when it reads the page again).
 */
function QueueRunnersSection(handle: Handle<{ card: QueueCardView; githubUrl: string; orgId: string }>) {
  return () => {
    let { card, githubUrl, orgId } = handle.props
    return (
      // data-org: a card of the stream for another org reloads the page (live-queue.tsx).
      <section class="dash-section" aria-labelledby="queue-title" data-live-queue="" data-org={orgId}>
        <div class="dash-section-head">
          <h2 id="queue-title" class="section-title">
            Queue and runners
          </h2>
          <LiveQueue />
          <a href={routes.runners.href()}>
            Runners<span class="visually-hidden">: manage the runners</span>
          </a>
        </div>
        <QueueCard card={card} githubUrl={githubUrl} />
      </section>
    )
  }
}

/** KNT-189. The card of the queue and of the runners: the page renders it, and the live stream sends it again. */
export function QueueCard(handle: Handle<{ card: QueueCardView; githubUrl: string }>) {
  return () => {
    let { card, githubUrl } = handle.props
    let { queue, runners, runnerCounts: counts, now } = card
    let total = counts.online + counts.late + counts.offline
    let more = total - runners.length
    return (
      <div class="card dash-queue" id={QUEUE_CARD_ID}>
        <h3 class="dash-subtitle">
          In progress <span class="count">{queue.runningCount}</span>
        </h3>
        {queue.running.length === 0 ? (
          <p class="hint">No job in progress.</p>
        ) : (
          <ul class="dash-jobs">
            {queue.running.map((job) => (
              <QueueItem job={job} now={now} githubUrl={githubUrl} />
            ))}
          </ul>
        )}
        <h3 class="dash-subtitle">
          Waiting <span class="count">{queue.queuedCount}</span>
        </h3>
        {queue.queued.length === 0 ? (
          <p class="hint">No job waiting.</p>
        ) : (
          <ul class="dash-jobs">
            {queue.queued.map((job) => (
              <QueueItem job={job} now={now} githubUrl={githubUrl} />
            ))}
          </ul>
        )}
        {queue.queuedCount > queue.queued.length ? <p class="hint">and {queue.queuedCount - queue.queued.length} more.</p> : null}
        <section class="dash-runners" aria-labelledby="dash-runners-title">
          <h3 id="dash-runners-title" class="dash-subtitle">
            Runners
            {total === 0 ? null : (
              <span class="runner-ready" data-ready={String(counts.ready)} title="Online and with no job in progress: the next job starts at once.">
                {readyText(counts)}
              </span>
            )}
          </h3>
          {total === 0 ? (
            <p class="hint">No runner. The jobs wait in the queue. Create one in Runners.</p>
          ) : (
            <>
              {/* KNT-189: "N online" alone would repeat the count beside the title. */}
              {counts.late + counts.offline > 0 ? <p class="runner-counts">{countsText(counts)}</p> : null}
              {/* REV-37: those that work first, then the first offline ones; the store bounds the list. */}
              <ul class="dash-jobs">
                {runners.map((runner) => {
                  let seen = { revokedAt: null, lastSeenAt: runner.lastSeenAt }
                  let state = runnerState(seen, now)
                  return (
                    <li class="dash-job">
                      <div class="dash-job-head">
                        <span class="mono">{runner.name}</span>
                        <span class={`status status-${state}`}>{runnerStateLabel(seen, now)}</span>
                        {runner.orgId === null ? <span class="tag">Runner of the service</span> : null}
                      </div>
                      <p class="hint">
                        {runner.running > 0
                          ? `${runner.running} ${plural(runner.running, 'job')} in progress`
                          : runner.busy
                            ? 'Busy with a job of another organization'
                            : 'No job in progress'}{' '}
                        · last signal{' '}
                        {runner.lastSeenAt ? <time dateTime={runner.lastSeenAt.toISOString()}>{agoShort(runner.lastSeenAt, now)}</time> : 'never'}
                      </p>
                    </li>
                  )
                })}
              </ul>
              {more > 0 ? (
                <p class="hint">
                  <a href={routes.runners.href()}>
                    and {more} more<span class="visually-hidden"> on the Runners screen</span>
                  </a>
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    )
  }
}

/**
 * REV-59. "Hide": the failure leaves the banner and the list, for every member. The counts of
 * the week keep it. A failure of a pull request closed since shows nowhere.
 */
function DismissForm(handle: Handle<{ id: string; csrf: string; label: string; small?: boolean; ghost?: boolean }>) {
  return () => {
    let { id, csrf, label, small, ghost } = handle.props
    return (
      <form method="post" action={routes.jobDismiss.href({ id })}>
        <input type="hidden" name="_csrf" value={csrf} />
        <Button variant={ghost ? 'ghost' : 'outline'} size={small ? 'sm' : 'md'} type="submit" aria-label={label}>
          Hide
        </Button>
      </form>
    )
  }
}

function FailuresSection(handle: Handle<{ failures: FailedJob[]; now: Date; githubUrl: string; admin: boolean; csrf: string }>) {
  return () => {
    let { failures, now, githubUrl, admin, csrf } = handle.props
    return (
      <section class="dash-section card" aria-labelledby="failures-title">
        <h2 id="failures-title" class="section-title">
          Recent failures
        </h2>
        {failures.length === 0 ? (
          <p class="hint">No failure to handle over 7 days.</p>
        ) : (
          <ul class="dash-jobs">
            {failures.map((job) => {
              let reason = failureText(job)
              return (
              <li class="dash-job">
                <div class="dash-review-head">
                  <a class="mono" href={prUrl(githubUrl, job.repo, job.prNumber)}>
                    {job.repo}#{job.prNumber}
                  </a>
                  <span class="tag">{job.kind === 'resolve' ? 'resolution' : job.level}</span>
                  {job.finishedAt ? (
                    <time class="hint" dateTime={job.finishedAt.toISOString()}>
                      {agoOrDate(job.finishedAt, now)}
                    </time>
                  ) : null}
                </div>
                <p class="hint">
                  {job.attempts} {plural(job.attempts, 'attempt')} · {reasonSentence(reason)}
                </p>
                <TechDetails raw={reason.raw} />
                {admin ? <DismissForm id={job.id} csrf={csrf} label={`Hide the failure of ${job.repo}#${job.prNumber}`} small /> : null}
              </li>
              )
            })}
          </ul>
        )}
      </section>
    )
  }
}

/** KNT-191, KNT-195. The window of the precision of a query: 7, or 30 (the default) for none or any other value. */
export function readPrecisionWindow(value: string | null): PrecisionWindow {
  return value === '7' ? 7 : PRECISION_DAYS
}

/** The dashboard at a window of the precision, back at its section: 30 days has no query. */
export function precisionHref(days: PrecisionWindow): string {
  return `${routes.home.href()}${days === PRECISION_DAYS ? '' : `?precision=${days}`}#precision-title`
}

/**
 * KNT-191. A short key of the numbers of the precision: public/assets/dashboard.js keeps the block,
 * and its chart, while the key of the page that it reads again is the same.
 */
export function precisionKey(precision: PrecisionReport, days: number): string {
  let text = [days, precision.org.fixed, precision.org.dismissed, ...precision.repos.map((r) => `${r.id}:${r.fixed}:${r.dismissed}`)].join('|')
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

/**
 * REV-18. The precision of the org over 30 days (or 7, KNT-191) and of its repositories with the most
 * closed findings: a chart in the browser (KNT-191), above the list that stays without JavaScript.
 */
function DashPrecision(handle: Handle<{ precision: PrecisionReport | null; org: string; days: PrecisionWindow; charts: boolean }>) {
  return () => {
    let { precision, org, days, charts } = handle.props
    return (
      <section class="dash-section" aria-labelledby="precision-title">
        <div class="dash-section-head">
          <h2 id="precision-title" class="section-title">
            Precision by repo
          </h2>
          <nav class="period-links precision-windows" aria-label="Window of the precision">
            {PRECISION_WINDOWS.map((window) => (
              <a href={precisionHref(window)} aria-current={window === days ? 'page' : undefined}>
                {window} days
              </a>
            ))}
          </nav>
        </div>
        {!precision || precision.org.closed === 0 ? (
          <div class="empty">
            <p>
              No closed finding over {days} days. The share of the findings that a push fixes shows here from {PRECISION_MIN} closed
              findings.
            </p>
          </div>
        ) : (
          <div class="card precision-card" id="precision-block" data-keep={precisionKey(precision, days)}>
            <p class="precision-headline">
              <PrecisionValue precision={precision.org} large />
              <span class="hint">
                over {days} days, whole org · {precisionCounts(precision.org)}
              </span>
            </p>
            {charts ? <TableChart table="precision-list" kind="bars" unit="pct" tone="matsu" /> : null}
            <ul class="precision-list" id="precision-list" data-series="Precision" aria-label={`Precision by repo, over ${days} days`}>
              {precision.repos.map((repo) => {
                return (
                  // data-label and data-value: what the chart reads (app/ui/public/chart-draw.ts).
                  <li
                    class="precision-row"
                    data-label={shortName(repo.fullName, org)}
                    data-value={repo.rate === null ? '' : String(Math.round(repo.rate * 1000) / 10)}
                  >
                    <a class="precision-name" href={findingsHref({ view: 'closed', repoId: repo.id })} title={repo.fullName}>
                      {shortName(repo.fullName, org)}
                    </a>
                    <span class="precision-figures">
                      <PrecisionValue precision={repo} />
                      <span class="hint precision-n" aria-hidden="true">
                        {repo.closed} closed
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
            {precision.repoCount > precision.repos.length ? (
              <p class="hint">
                and {precision.repoCount - precision.repos.length} more {plural(precision.repoCount - precision.repos.length, 'repo')} with fewer
                closed findings.
              </p>
            ) : null}
            <p class="hint">
              <a href={routes.findings.href()}>See the findings and the precision by rule</a>
            </p>
          </div>
        )}
      </section>
    )
  }
}
