import { LEVELS, type Level } from '@sakuga-review/protocol'
import type { Handle } from 'remix/component'

import type { DashboardRunner, DashboardScreen, DayStats, FailedJob, FailureBanner, QueueJob, QueueStall, RecentReview, RunnerCounts } from '../dashboard/store.ts'
import { QUEUE_STALL_MINUTES } from '../publish/queued.ts'
import { agoOrDate, agoShort, clock, duration, elapsed, hour, hourSeconds, plural, usdPrecise, weekday } from './format.ts'
import { ExternalIcon } from './icons.tsx'
import type { OrgCostsDetail } from '../db/costs.ts'
import type { OrgCaps } from '../org-settings/model.ts'
import { pageRoutes as routes, pullRoutes } from '../routes.ts'
import { jobReason, reasonSentence, TechDetails, type Reason } from './reasons.tsx'
import { countsText, runnerState, runnerStateLabel } from './runners.tsx'
import { Shell, type PageFrame } from './shell.tsx'
import { PRECISION_DAYS, PRECISION_MIN, type PrecisionReport } from '../findings/precision.ts'
import { findingsHref } from './findings.tsx'
import { PrecisionValue, precisionCounts, shortName } from './precision.tsx'

/** The page asks the server again this often, while it is on screen (public/assets/dashboard.js). */
export const REFRESH_SECONDS = 10

/** What the dashboard says after « Relancer », from `?notice=`. */
export const DASHBOARD_NOTICES = {
  retried: 'Review relancée. Le job est en file.',
  already: 'Une review de ce niveau est déjà en file ou en cours sur ce commit.',
  stale: 'Un push plus récent a remplacé ce commit. Sa review suit le nouveau commit.',
  closed: 'La PR est fermée sur GitHub, donc rien n’est relancé.',
  capped: 'Le plafond de coût de l’organisation est atteint, donc rien n’est relancé. Un admin le change dans Réglages.',
  github_failed: 'GitHub n’a pas répondu et rien n’est relancé. Réessayez dans un instant.',
  dismissed: 'Échec masqué. Il reste compté dans « Échecs sur 7 jours ».',
  dismiss_missing: 'Rien n’est masqué. Cet échec est déjà masqué, ou il a changé depuis votre dernier affichage.',
  missing: 'Rien n’est relancé. Ce job a changé depuis votre dernier affichage, ou son repo n’est plus activé. Relancez-le depuis la liste ci-dessous, ou activez son repo sur l’écran Repos.',
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
  APPROVE: { text: 'Approuvée', tag: 'tag-ok' },
  COMMENT: { text: 'Commentaire', tag: 'tag-warn' },
  REQUEST_CHANGES: { text: 'Changements demandés', tag: 'tag-alert' },
}

const CAP_TEXT: Record<CapState, string> = {
  none: 'Pas de plafond',
  ok: 'Sous le seuil d’alerte',
  alert: 'Seuil d’alerte atteint',
  reached: 'Plafond atteint',
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
  /** `https://github.com`, or the GitHub Enterprise Server: the links « Voir la PR ». */
  githubUrl: string
  notice?: DashboardNotice | null
  /** KENTO_PROVIDER_API_KEY is set: a trusted runner gets the key of the service without a provider. */
  serviceKey?: boolean
  /** The page of the installation of the App on GitHub, where an owner picks the repositories. */
  installationUrl?: string | null
  /** REV-18. The precision of the org over 30 days; null without the Findings screen. */
  precision?: PrecisionReport | null
}

/** One step of the list « Mise en route » (REV-26). */
export interface SetupStep {
  key: 'app' | 'provider' | 'runner' | 'repo' | 'review'
  title: string
  state: 'done' | 'wait' | 'todo'
  /** What is true now, in one sentence. */
  text: string
  /** Where the step is done. An admin gets it as a link; a member reads « Demandez à un admin ». */
  action: { label: string; href: string; external?: boolean } | null
}

const SETUP_STATE: Record<SetupStep['state'], { text: string; status: string }> = {
  done: { text: 'Fait', status: 'status-online' },
  wait: { text: 'En cours', status: 'status-wait' },
  todo: { text: 'À faire', status: 'status-stale' },
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
  let install = options.installationUrl ? { label: 'Ouvrir l’installation sur GitHub', href: options.installationUrl, external: true } : null
  return [
    setup.suspended
      ? {
          key: 'app',
          title: 'Installer l’App GitHub',
          state: 'todo',
          text: 'L’installation est suspendue sur GitHub, et aucun push ne crée de job. Un propriétaire de l’organisation la réactive.',
          action: install,
        }
      : {
          key: 'app',
          title: 'Installer l’App GitHub',
          state: 'done',
          text: 'L’App est installée sur l’organisation. Elle ne voit que les repos choisis sur GitHub.',
          action: install ? { ...install, label: 'Choisir les repos sur GitHub' } : null,
        },
    setup.providers > 0
      ? {
          key: 'provider',
          title: 'Ajouter un provider',
          state: 'done',
          text: setup.providers === 1 ? '1 provider dans Réglages.' : `${setup.providers} providers dans Réglages.`,
          action: { label: 'Voir les providers', href: `${routes.settings.href()}#providers-title` },
        }
      : options.serviceKey
        ? {
            key: 'provider',
            title: 'Ajouter un provider',
            state: 'done',
            text: 'Aucun provider. Un runner de confiance reçoit la clé du service. Ajoutez le vôtre pour payer vos propres reviews.',
            action: { label: 'Ajouter un provider', href: `${routes.settings.href()}#nouveau-provider` },
          }
        : {
            key: 'provider',
            title: 'Ajouter un provider',
            state: 'todo',
            text: 'Aucun provider, et pas de clé du service. Un runner n’a pas de modèle à appeler.',
            action: { label: 'Ajouter un provider', href: `${routes.settings.href()}#nouveau-provider` },
          },
    online > 0
      ? {
          key: 'runner',
          title: 'Enregistrer un runner',
          state: 'done',
          text: online === 1 ? '1 runner en ligne.' : `${online} runners en ligne.`,
          action: { label: 'Voir les runners', href: routes.runners.href() },
        }
      : registered > 0 || setup.pendingRegistrations > 0
        ? {
            key: 'runner',
            title: 'Enregistrer un runner',
            state: 'wait',
            text:
              registered > 0
                ? 'Un runner est enregistré, mais aucun n’est en ligne. Les jobs l’attendent en file.'
                : 'Un token d’enregistrement attend son runner.',
            action: { label: 'Voir les runners', href: routes.runners.href() },
          }
        : {
            key: 'runner',
            title: 'Enregistrer un runner',
            state: 'todo',
            text: 'Aucun runner. Les jobs attendraient en file.',
            action: { label: 'Créer un runner', href: routes.runners.href() },
          },
    setup.enabledRepos > 0
      ? {
          key: 'repo',
          title: 'Activer un repo',
          state: 'done',
          text: setup.enabledRepos === 1 ? '1 repo activé.' : `${setup.enabledRepos} repos activés.`,
          action: { label: 'Voir les repos', href: routes.repos.href() },
        }
      : {
          key: 'repo',
          title: 'Activer un repo',
          state: 'todo',
          text: 'Aucun repo activé. Un push ne crée aucun job.',
          action: { label: 'Activer un repo', href: routes.repos.href() },
        },
    jobs > 0
      ? {
          key: 'review',
          title: 'Obtenir la première review',
          state: 'wait',
          text:
            queue.runningCount > 0
              ? 'En attente de la première review. Un runner fait le job.'
              : 'En attente de la première review. Le job est en file, et un runner en ligne le prendra.',
          action: null,
        }
      : {
          key: 'review',
          title: 'Obtenir la première review',
          state: 'todo',
          text: 'Ouvrez une pull request, ou poussez sur une PR ouverte, dans un repo activé.',
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
    let admin = frame.viewer?.role === 'admin'
    let csrf = frame.csrfToken ?? ''
    let org = frame.viewer?.org.login ?? ''
    let steps = setupSteps(screen, { serviceKey: serviceKey ?? false, installationUrl: installationUrl ?? null })
    return (
      <Shell frame={frame} section="dashboard" title="Tableau de bord">
        <div class="dashboard" id="dashboard-live" data-refresh={String(REFRESH_SECONDS)}>
          <p class="dash-updated">
            <span data-updated={screen.now.toISOString()}>Mis à jour à {hourSeconds(screen.now)}</span>
            {' · '}
            <a href={routes.home.href()}>Actualiser</a>
          </p>

          {notice ? (
            <div class={`banner ${notice === 'retried' ? 'banner-ok' : 'banner-info'}`} role="status">
              <p>{DASHBOARD_NOTICES[notice]}</p>
            </div>
          ) : null}

          {steps ? <SetupSection steps={steps} admin={admin} /> : null}

          <TodoSection screen={screen} admin={admin} csrf={csrf} githubUrl={githubUrl} />

          <Kpis screen={screen} precision={precision ?? null} />

          <WeekSection week={screen.week} />

          <div class="dash-main">
            <RecentSection recent={screen.recent} now={screen.now} org={org} />
            <div class="dash-side">
              <QueueRunnersSection queue={screen.queue} runners={screen.runners} counts={screen.runnerCounts} now={screen.now} githubUrl={githubUrl} />
              <CostSection costs={screen.costs} caps={screen.caps} />
            </div>
          </div>

          <div class="dash-grid">
            <FailuresSection failures={screen.failures} now={screen.now} githubUrl={githubUrl} admin={admin} csrf={csrf} />
            <DashPrecision precision={precision ?? null} org={org} />
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
            Mise en route
          </h2>
          <span class="hint">
            {done} {plural(done, 'étape')} sur {steps.length}
          </span>
        </div>
        <p class="hint setup-lead">
          {admin
            ? 'Ce qu’il faut pour obtenir la première review. Cette liste disparaît quand elle est publiée.'
            : 'Ce qu’il faut pour obtenir la première review. Un admin de l’organisation fait ces étapes ; cette liste disparaît quand la première review est publiée.'}
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
                {step.state !== 'done' && step.action && !admin ? <p class="hint">Demandez à un admin de l’organisation.</p> : null}
              </div>
              {step.action && (admin || step.state === 'done') ? (
                <a
                  class={`button button-small ${step.state === 'todo' && admin ? 'button-primary' : ''}`}
                  href={step.action.href}
                  {...(step.action.external ? { rel: 'noreferrer', target: '_blank' } : {})}
                >
                  {step.action.label}
                  {step.action.external ? (
                    <>
                      <ExternalIcon />
                      <span class="visually-hidden">(GitHub, nouvel onglet)</span>
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
  let jobs = stall.count === 1 ? '1 job attend' : `${stall.count} jobs attendent`
  let title = `${jobs} en file depuis plus de ${QUEUE_STALL_MINUTES} min (le plus ancien depuis ${elapsed(stall.since, now)})`
  if (online === 0) {
    let cause = stall.lastRunnerSeenAt
      ? `Aucun runner en ligne depuis ${elapsed(stall.lastRunnerSeenAt, now)} (dernier signal à ${clock(stall.lastRunnerSeenAt)}).`
      : 'Aucun runner n’a jamais appelé Kentō.'
    return { title, cause, action: 'Démarrez un runner, voir l’écran Runners. Les jobs partiront seuls dès son premier appel.' }
  }
  let cause =
    online === 1
      ? '1 runner est en ligne, mais il ne prend pas ces jobs : il est occupé, ou il ne peut pas appeler le provider de leur repo.'
      : `${online} runners sont en ligne, mais aucun ne prend ces jobs : ils sont occupés, ou ne peuvent pas appeler le provider de leur repo.`
  return { title, cause, action: 'Vérifiez leurs labels et leurs providers sur l’écran Runners, ou démarrez un runner de plus.' }
}

/**
 * REV-91. « À traiter »: what asks for a person now, one row each. The failure of the banner, the
 * queue that waits, a cost over the alert threshold, the runners with no signal, the repositories
 * still on review.yml. Each row: a mark and a word, what happened, then its actions.
 */
function TodoSection(handle: Handle<{ screen: DashboardScreen; admin: boolean; csrf: string; githubUrl: string }>) {
  return () => {
    let { screen, admin, csrf, githubUrl } = handle.props
    let { now } = screen
    let costs = [
      { id: 'day', usd: screen.costs.dayUsd, cap: screen.caps.dailyCapUsd, when: 'du jour' },
      { id: 'month', usd: screen.costs.monthUsd, cap: screen.caps.monthlyCapUsd, when: 'du mois' },
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
    return (
      <section class="dash-todo" aria-labelledby="todo-title">
        <h2 id="todo-title" class="section-title">
          À traiter <span class="count">{count}</span>
        </h2>
        {count === 0 ? (
          <p class="card todo-empty hint">Rien à traiter : aucun échec en cours, la file avance et les runners répondent.</p>
        ) : (
          <ul class="card todo-list">
            {screen.stall ? <StallItem stall={screen.stall} online={screen.runnerCounts.online} now={now} /> : null}
            {screen.banner ? <FailureItem banner={screen.banner} admin={admin} csrf={csrf} githubUrl={githubUrl} now={now} /> : null}
            {costs.map((cost) => (
              <li>
                <section class="todo" aria-labelledby={`todo-cost-${cost.id}`}>
                <span class="todo-kind">
                  <span class="status status-cost">Coût</span>
                </span>
                <div class="todo-body">
                  <h3 id={`todo-cost-${cost.id}`} class="todo-title">
                    {cost.state === 'reached' ? `Plafond ${cost.when} atteint` : `Seuil d’alerte ${cost.when} atteint`}
                  </h3>
                  <p class="todo-meter">
                    {/* A limit of 0 is reached at once (capState): no share of it, no bar. */}
                    {cost.cap! > 0 ? <Bar parts={[{ pct: (cost.usd / cost.cap!) * 100, tone: 'kuchiba' }]} /> : null}
                    <span class="mono">
                      {usdPrecise(cost.usd)} sur {usdPrecise(cost.cap!)}
                      {cost.cap! > 0 ? ` · ${Math.round((cost.usd / cost.cap!) * 100)} %` : ''}
                    </span>
                  </p>
                </div>
                <div class="todo-actions">
                  <a class="button" href={`${routes.settings.href()}#plafond`}>
                    {admin ? 'Modifier le plafond' : 'Voir le plafond'}
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
                        {silent[0]!.lastSeenAt ? `ne donne plus de signal depuis ${elapsed(silent[0]!.lastSeenAt, now)}` : 'n’a jamais donné de signal'}
                      </h3>
                      <p class="hint">
                        {silent[0]!.running === 0
                          ? 'Aucun job ne lui est confié. Il repasse en ligne à son prochain signal.'
                          : `${silent[0]!.running} ${plural(silent[0]!.running, 'job')} en cours : sans signal, ${silent[0]!.running === 1 ? 'il repart' : 'ils repartent'} en file.`}
                      </p>
                    </>
                  ) : (
                    <>
                      <h3 id="todo-runners" class="todo-title">
                        {silentCount === 1 ? '1 runner ne donne plus de signal' : `${silentCount} runners ne donnent plus de signal`}
                      </h3>
                      <p class="hint">
                        {/* The store bounds the list of runners: the silent ones may not be in it. */}
                        {silent.length > 0
                          ? `${silent
                              .slice(0, 3)
                              .map((runner) => runner.name)
                              .join(', ')}${silentCount > Math.min(3, silent.length) ? ` et ${silentCount - Math.min(3, silent.length)} de plus` : ''}. `
                          : ''}
                        Un runner repasse en ligne à son prochain signal.
                      </p>
                    </>
                  )}
                </div>
                <div class="todo-actions">
                  <a class="button" href={routes.runners.href()}>
                    Voir les runners
                  </a>
                </div>
                </section>
              </li>
            ) : null}
            {screen.workflowRepos.length > 0 ? (
              <li>
                <section class="todo dash-workflow" aria-labelledby="todo-workflow">
                <span class="todo-kind">
                  <span class="status status-switch">Bascule</span>
                </span>
                <div class="todo-body">
                  <h3 id="todo-workflow" class="todo-title">
                    {screen.workflowRepos.length === 1 ? '1 repo est encore sur' : `${screen.workflowRepos.length} repos sont encore sur`}{' '}
                    <code>review.yml</code>
                  </h3>
                  <p class="hint">{screen.workflowRepos.join(', ')}. Leurs findings ne sont pas suivis ici.</p>
                </div>
                <div class="todo-actions">
                  <a class="button" href={routes.repos.href()}>
                    Voir les repos
                  </a>
                </div>
                </section>
              </li>
            ) : null}
          </ul>
        )}
      </section>
    )
  }
}

/** REV-52, in « À traiter »: jobs wait for more than QUEUE_STALL_MINUTES, the probable cause and what to do. */
function StallItem(handle: Handle<{ stall: QueueStall; online: number; now: Date }>) {
  return () => {
    let { stall, online, now } = handle.props
    let text = stallText(stall, online, now)
    return (
      <li>
        <section class="todo dash-stall" role="alert" aria-labelledby="todo-stall">
        <span class="todo-kind">
          <span class="status status-wait">File</span>
        </span>
        <div class="todo-body">
          <h3 id="todo-stall" class="todo-title">
            {text.title}
          </h3>
          <p class="hint">{text.cause}</p>
          <p class="hint">
            {text.action} Les PR concernées portent un commentaire de Kentō.
          </p>
        </div>
        <div class="todo-actions">
          <a class="button" href={routes.runners.href()}>
            Voir les runners
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
          <span class="status status-alert">Échec</span>
        </span>
        <div class="todo-body">
          <h3 id={`todo-failure-${banner.id}`} class="todo-title">
            La review {banner.level} de <span class="mono">{banner.repo}#{banner.prNumber}</span> a échoué
          </h3>
          <p class="hint">
            Raison : {reason.text}. {reason.action}{' '}
            {banner.previous
              ? `La review précédente (${banner.previous.score}/5, publiée le ${clock(banner.previous.publishedAt)}) reste publiée sur la PR.`
              : 'Aucune review n’est encore publiée sur cette PR.'}
          </p>
          <TechDetails raw={reason.raw} />
          {banner.retry ? (
            <p class="hint">
              <strong>
                Relance en {banner.retry.level} {banner.retry.state === 'queued' ? 'en file' : 'en cours'}
              </strong>
              . Cette ligne disparaît quand sa review est publiée.
            </p>
          ) : null}
          {admin && !banner.retry ? (
            <p class="hint">L’estimation est la moyenne des dernières reviews de ce niveau sur ce repo.</p>
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
                    <button class={`button ${level === banner.level ? 'button-primary' : ''}`} type="submit">
                      Relancer en {LEVEL_LABEL[level]}
                      <span class="dash-estimate">{estimate === null ? ' · coût inconnu' : ` · ≈ ${usdPrecise(estimate)}`}</span>
                    </button>
                  </form>
                )
              })
            : null}
          <a class="button button-ghost" href={prUrl(githubUrl, banner.repo, banner.prNumber)}>
            Voir la PR
          </a>
          {admin ? <DismissForm id={banner.id} csrf={csrf} label={`Masquer l’échec de ${banner.repo}#${banner.prNumber}`} ghost /> : null}
        </div>
        </section>
      </li>
    )
  }
}

/** REV-91. Five numbers in one band: the reviews and failures of the week, the cost of the month, the precision, the queue. */
function Kpis(handle: Handle<{ screen: DashboardScreen; precision: PrecisionReport | null }>) {
  return () => {
    let { screen, precision } = handle.props
    let today = screen.week.at(-1)
    let weekPublished = screen.week.reduce((sum, day) => sum + total(day), 0)
    let weekFailed = screen.week.reduce((sum, day) => sum + day.failed, 0)
    let mean = weekMeanDuration(screen.week)
    let max = Math.max(1, ...screen.week.map(total))
    let month = screen.costs.monthUsd
    let cap = screen.caps.monthlyCapUsd
    let org = precision?.org ?? null
    return (
      <section class="dash-kpis card" aria-label="En bref">
        <div class="kpi">
          <span class="kpi-label">Reviews publiées · 7 j</span>
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
            {today ? total(today) : 0} aujourd’hui{mean !== null ? ` · ${duration(mean)} en moyenne` : ''}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Échecs · 7 j</span>
          <span class={`kpi-value ${weekFailed > 0 ? 'kpi-alert' : ''}`}>{weekFailed}</span>
          <span class="kpi-sub">{weekFailed === 0 ? 'aucun job en échec' : `${plural(weekFailed, 'job')} en échec`}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Coût du mois</span>
          <span class="kpi-value">{usdPrecise(month)}</span>
          {cap !== null && cap > 0 ? (
            <Bar parts={[{ pct: (month / cap) * 100, tone: 'ink' }]} />
          ) : null}
          <span class={`kpi-sub ${cap !== null && capState(month, cap, screen.caps.alertPct) === 'reached' ? 'kpi-alert' : ''}`}>
            {cap === null
              ? 'pas de plafond'
              : capState(month, cap, screen.caps.alertPct) === 'reached'
                ? `plafond atteint · sur ${usdPrecise(cap)}`
                : `sur ${usdPrecise(cap)} · alerte à ${screen.caps.alertPct} %`}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Précision · {PRECISION_DAYS} j</span>
          {/* The share needs closed findings: a rate with none would divide by 0. */}
          {org && org.rate !== null && org.closed > 0 ? (
            <>
              <span class="kpi-row">
                <span class="kpi-value">{Math.round(org.rate * 100)} %</span>
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
              <span class="kpi-value kpi-pending">{org && org.closed > 0 ? `n = ${org.closed} sur ${PRECISION_MIN}` : '—'}</span>
              <span class="kpi-sub">à partir de {PRECISION_MIN} findings clos</span>
            </>
          )}
        </div>
        <div class="kpi">
          <span class="kpi-label">File de jobs</span>
          <span class="kpi-value">
            {screen.queue.runningCount} · {screen.queue.queuedCount}
          </span>
          <span class="kpi-sub">en cours · en attente</span>
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

function Meter(handle: Handle<{ id: string; label: string; usd: number; cap: number | null; alertPct: number }>) {
  return () => {
    let { id, label, usd, cap, alertPct } = handle.props
    let state = capState(usd, cap, alertPct)
    return (
      <div class="dash-cost">
        <div class="dash-cost-head">
          <span class="dash-cost-label" id={`${id}-label`}>
            {label}
          </span>
          <span class={`status ${CAP_STATUS[state]}`}>{CAP_TEXT[state]}</span>
        </div>
        <p class="dash-cost-value">
          {usdPrecise(usd)}
          {cap !== null ? <span class="dash-cost-cap"> sur {usdPrecise(cap)}</span> : null}
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
            {usdPrecise(usd)} sur {usdPrecise(cap)}
          </meter>
        ) : null}
        {cap !== null ? <p class="hint">Alerte à {alertPct} % du plafond.</p> : null}
      </div>
    )
  }
}

function CostSection(handle: Handle<{ costs: OrgCostsDetail; caps: OrgCaps }>) {
  return () => {
    let { costs, caps } = handle.props
    return (
      <section class="dash-section card" aria-labelledby="cost-title">
        <h2 id="cost-title" class="section-title">
          Coût
        </h2>
        <div class="dash-costs">
          <Meter id="cost-day" label="Aujourd’hui (UTC)" usd={costs.dayUsd} cap={caps.dailyCapUsd} alertPct={caps.alertPct} />
          <Meter id="cost-month" label="Ce mois-ci (UTC)" usd={costs.monthUsd} cap={caps.monthlyCapUsd} alertPct={caps.alertPct} />
        </div>
        {caps.dailyCapUsd === null && caps.monthlyCapUsd === null ? (
          <p class="hint">
            Aucun plafond pour l’organisation. Un admin le fixe dans <a href={routes.settings.href()}>Réglages</a>.
          </p>
        ) : null}
        {costs.monthByProvider.length > 0 ? (
          <table class="dash-table">
            <caption class="visually-hidden">Coût par provider</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" class="num">
                  Aujourd’hui
                </th>
                <th scope="col" class="num">
                  Ce mois
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
          <p class="hint">Aucune dépense ce mois-ci.</p>
        )}
        {costs.monthUnknown > 0 ? (
          <p class="hint">
            {costs.monthUnknown === 1 ? '1 review ou résolution' : `${costs.monthUnknown} reviews ou résolutions`} du mois sans coût
            connu, comptées 0 $.
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
        <summary>Reviews publiées · 7 jours, jour par jour</summary>
        <table class="dash-table">
          <caption class="visually-hidden">Reviews publiées par jour (UTC), par niveau, échecs et durée moyenne</caption>
          <thead>
            <tr>
              <th scope="col">Jour</th>
              <th scope="col">Publiées</th>
              <th scope="col" class="num">
                Échecs
              </th>
              <th scope="col" class="num">
                Durée moy.
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
            Dernières reviews
          </h2>
          <a href={routes.findings.href()}>Tous les findings</a>
        </div>
        {recent.length === 0 ? (
          <div class="empty">
            <p>Aucune review pour l’instant. Activez un repo dans <a href={routes.repos.href()}>Repos</a>, et son prochain push en lancera une.</p>
          </div>
        ) : (
          <div class="card dash-recent-card">
            <table class="dash-reviews">
              <caption class="visually-hidden">Dernières reviews</caption>
              <thead>
                <tr>
                  <th scope="col">Pull request</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Niveau</th>
                  <th scope="col" class="num">
                    Score
                  </th>
                  <th scope="col" class="num">
                    Findings
                  </th>
                  <th scope="col" class="num">
                    Coût
                  </th>
                  <th scope="col" class="num">
                    Durée
                  </th>
                  <th scope="col" class="num">
                    Quand
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
                        {review.publishedAt ? null : <span class="status status-stale">Non publiée</span>}
                      </td>
                      <td class="mono" data-label="Niveau">
                        {review.level}
                      </td>
                      <td class="num mono" data-label="Score">
                        {review.score}/5
                      </td>
                      <td class="num mono" data-label="Findings">
                        {review.findings}
                        <span class="dash-unit"> {plural(review.findings, 'finding')}</span>
                      </td>
                      <td class="num mono" data-label="Coût">
                        {review.costUsd === null ? 'inconnu' : usdPrecise(review.costUsd)}
                      </td>
                      <td class="num mono" data-label="Durée">
                        {review.durationMs === null ? '—' : duration(review.durationMs)}
                      </td>
                      <td class="num mono" data-label="Quand">
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
          <span class="tag">{job.kind === 'resolve' ? 'résolution' : job.level}</span>
        </div>
        <p class="hint">
          {running ? (
            <>
              Sur <span class="mono">{job.runnerName}</span> depuis{' '}
              <time dateTime={job.startedAt!.toISOString()}>{elapsed(job.startedAt!, now)}</time> · tentative{' '}
              {job.attempts} ·{' '}
              <span title="Sans signal du runner avant cette heure, le job repart en file.">
                réservé jusqu’à <time dateTime={job.leaseExpiresAt!.toISOString()}>{hour(job.leaseExpiresAt!)}</time>
              </span>
              {job.runnerSeenAt ? (
                <>
                  {' '}
                  · dernier signal <time dateTime={job.runnerSeenAt.toISOString()}>{agoShort(job.runnerSeenAt, now)}</time>
                </>
              ) : null}
            </>
          ) : (
            <>
              En file <time dateTime={job.createdAt.toISOString()}>depuis {elapsed(job.createdAt, now)}</time>
              {job.attempts > 0 ? ` · ${job.attempts} ${plural(job.attempts, 'tentative')} déjà` : ''}
              {waiting ? (
                <>
                  {' '}
                  · reprise à <time dateTime={job.notBefore!.toISOString()}>{hourSeconds(job.notBefore!)}</time>
                </>
              ) : null}
            </>
          )}
        </p>
      </li>
    )
  }
}

/** REV-91. The jobs running then waiting, and the runners, in one panel beside the last reviews. */
function QueueRunnersSection(
  handle: Handle<{ queue: DashboardScreen['queue']; runners: DashboardRunner[]; counts: RunnerCounts; now: Date; githubUrl: string }>,
) {
  return () => {
    let { queue, runners, counts, now, githubUrl } = handle.props
    let total = counts.online + counts.late + counts.offline
    let more = total - runners.length
    return (
      <section class="dash-section" aria-labelledby="queue-title">
        <div class="dash-section-head">
          <h2 id="queue-title" class="section-title">
            File et runners
          </h2>
          <a href={routes.runners.href()}>
            Runners<span class="visually-hidden"> : gérer les runners</span>
          </a>
        </div>
        <div class="card dash-queue">
          <h3 class="dash-subtitle">
            En cours <span class="count">{queue.runningCount}</span>
          </h3>
          {queue.running.length === 0 ? (
            <p class="hint">Aucun job en cours.</p>
          ) : (
            <ul class="dash-jobs">
              {queue.running.map((job) => (
                <QueueItem job={job} now={now} githubUrl={githubUrl} />
              ))}
            </ul>
          )}
          <h3 class="dash-subtitle">
            En attente <span class="count">{queue.queuedCount}</span>
          </h3>
          {queue.queued.length === 0 ? (
            <p class="hint">Aucun job en attente.</p>
          ) : (
            <ul class="dash-jobs">
              {queue.queued.map((job) => (
                <QueueItem job={job} now={now} githubUrl={githubUrl} />
              ))}
            </ul>
          )}
          {queue.queuedCount > queue.queued.length ? <p class="hint">et {queue.queuedCount - queue.queued.length} de plus.</p> : null}
          <section class="dash-runners" aria-labelledby="dash-runners-title">
            <h3 id="dash-runners-title" class="dash-subtitle">
              Runners
            </h3>
            {total === 0 ? (
              <p class="hint">Aucun runner. Les jobs attendent en file. Créez-en un dans Runners.</p>
            ) : (
              <>
                <p class="runner-counts">{countsText(counts)}</p>
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
                          {runner.orgId === null ? <span class="tag">Runner du service</span> : null}
                        </div>
                        <p class="hint">
                          {runner.running === 0 ? 'Aucun job en cours' : `${runner.running} ${plural(runner.running, 'job')} en cours`} · dernier
                          signal{' '}
                          {runner.lastSeenAt ? <time dateTime={runner.lastSeenAt.toISOString()}>{agoShort(runner.lastSeenAt, now)}</time> : 'jamais'}
                        </p>
                      </li>
                    )
                  })}
                </ul>
                {more > 0 ? (
                  <p class="hint">
                    <a href={routes.runners.href()}>
                      et {more} de plus<span class="visually-hidden"> sur l’écran Runners</span>
                    </a>
                  </p>
                ) : null}
              </>
            )}
          </section>
        </div>
      </section>
    )
  }
}

/**
 * REV-59. « Masquer »: the failure leaves the banner and the list, for every member. The counts of
 * the week keep it. A failure of a pull request closed since shows nowhere.
 */
function DismissForm(handle: Handle<{ id: string; csrf: string; label: string; small?: boolean; ghost?: boolean }>) {
  return () => {
    let { id, csrf, label, small, ghost } = handle.props
    return (
      <form method="post" action={routes.jobDismiss.href({ id })}>
        <input type="hidden" name="_csrf" value={csrf} />
        <button class={`button ${small ? 'button-small' : ''} ${ghost ? 'button-ghost' : ''}`} type="submit" aria-label={label}>
          Masquer
        </button>
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
          Échecs récents
        </h2>
        {failures.length === 0 ? (
          <p class="hint">Aucun échec à traiter sur 7 jours.</p>
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
                  <span class="tag">{job.kind === 'resolve' ? 'résolution' : job.level}</span>
                  {job.finishedAt ? (
                    <time class="hint" dateTime={job.finishedAt.toISOString()}>
                      {agoOrDate(job.finishedAt, now)}
                    </time>
                  ) : null}
                </div>
                <p class="hint">
                  {job.attempts} {plural(job.attempts, 'tentative')} · {reasonSentence(reason)}
                </p>
                <TechDetails raw={reason.raw} />
                {admin ? <DismissForm id={job.id} csrf={csrf} label={`Masquer l’échec de ${job.repo}#${job.prNumber}`} small /> : null}
              </li>
              )
            })}
          </ul>
        )}
      </section>
    )
  }
}

/** REV-18. The precision of the org over 30 days and of its repositories with the most closed findings. */
function DashPrecision(handle: Handle<{ precision: PrecisionReport | null; org: string }>) {
  return () => {
    let { precision, org } = handle.props
    return (
      <section class="dash-section" aria-labelledby="precision-title">
        <h2 id="precision-title" class="section-title">
          Précision par repo
        </h2>
        {!precision || precision.org.closed === 0 ? (
          <div class="empty">
            <p>
              Aucun finding clos sur {PRECISION_DAYS} jours. La part des findings qu’un push corrige s’affichera ici à partir de {PRECISION_MIN}{' '}
              findings clos.
            </p>
          </div>
        ) : (
          <div class="card precision-card">
            <p class="precision-headline">
              <PrecisionValue precision={precision.org} large />
              <span class="hint">
                sur {PRECISION_DAYS} jours, toute l’org · {precisionCounts(precision.org)}
              </span>
            </p>
            <ul class="precision-list">
              {precision.repos.slice(0, 5).map((repo) => {
                return (
                  <li class="precision-row">
                    <a class="precision-name" href={findingsHref({ view: 'closed', repoId: repo.id })} title={repo.fullName}>
                      {shortName(repo.fullName, org)}
                    </a>
                    <span class="precision-figures">
                      <PrecisionValue precision={repo} />
                      <span class="hint precision-n" aria-hidden="true">
                        {repo.closed} clos
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
            <p class="hint">
              <a href={routes.findings.href()}>Voir les findings et la précision par règle</a>
            </p>
          </div>
        )}
      </section>
    )
  }
}
