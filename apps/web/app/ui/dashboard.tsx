import { LEVELS, type Level } from '@sakuga-review/protocol'
import type { Handle } from 'remix/component'

import type { DashboardRunner, DashboardScreen, DayStats, FailedJob, FailureBanner, QueueJob, RecentReview, RunnerCounts } from '../dashboard/store.ts'
import { agoOrDate, agoShort, clock, duration, elapsed, hour, hourSeconds, plural, usdPrecise, weekday } from './format.ts'
import { ExternalIcon } from './icons.tsx'
import type { OrgCostsDetail } from '../org-settings/costs.ts'
import type { OrgCaps } from '../org-settings/model.ts'
import { pageRoutes as routes, pullRoutes } from '../routes.ts'
import { jobReason, reasonSentence, TechDetails, type Reason } from './reasons.tsx'
import { countsText, runnerState, runnerStateLabel } from './runners.tsx'
import { Shell, type PageFrame } from './shell.tsx'

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

const VERDICT_LABEL: Record<string, { text: string; status: string }> = {
  APPROVE: { text: 'Approuvée', status: 'status-online' },
  COMMENT: { text: 'Commentaire', status: 'status-wait' },
  REQUEST_CHANGES: { text: 'Changements demandés', status: 'status-alert' },
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

export function DashboardPage(handle: Handle<DashboardPageProps>) {
  return () => {
    let { frame, screen, githubUrl, notice, serviceKey, installationUrl } = handle.props
    let admin = frame.viewer?.role === 'admin'
    let csrf = frame.csrfToken ?? ''
    let today = screen.week.at(-1)
    let weekPublished = screen.week.reduce((sum, day) => sum + total(day), 0)
    let weekFailed = screen.week.reduce((sum, day) => sum + day.failed, 0)
    let steps = setupSteps(screen, { serviceKey: serviceKey ?? false, installationUrl: installationUrl ?? null })
    return (
      <Shell frame={frame} section="dashboard" title="Tableau de bord" lead="Ce qui tourne, ce qui a échoué, et ce que ça coûte.">
        <div class="dashboard" id="dashboard-live" data-refresh={String(REFRESH_SECONDS)}>
          <p class="dash-updated hint">
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

          {screen.banner ? <FailureBannerView banner={screen.banner} admin={admin} csrf={csrf} githubUrl={githubUrl} /> : null}

          <section class="dash-tiles" aria-label="En bref">
            <Tile label="Reviews publiées aujourd’hui" value={String(today ? total(today) : 0)} />
            <Tile label="Reviews publiées sur 7 jours" value={String(weekPublished)} />
            <Tile label="Échecs sur 7 jours" value={String(weekFailed)} alert={weekFailed > 0} />
            <Tile label="File de jobs" value={`${screen.queue.runningCount} en cours · ${screen.queue.queuedCount} en attente`} />
          </section>

          <div class="dash-grid">
            <CostSection costs={screen.costs} caps={screen.caps} />
            <WeekSection week={screen.week} />
          </div>

          <RecentSection recent={screen.recent} now={screen.now} />

          <div class="dash-grid">
            <QueueSection queue={screen.queue} now={screen.now} githubUrl={githubUrl} />
            <RunnersSection runners={screen.runners} counts={screen.runnerCounts} now={screen.now} />
          </div>

          <div class="dash-grid">
            <FailuresSection failures={screen.failures} now={screen.now} githubUrl={githubUrl} />
            <section class="dash-section" aria-labelledby="precision-title">
              <h2 id="precision-title" class="section-title">
                Précision par repo
              </h2>
              <div class="empty">
                <p>Bientôt. La part des findings confirmés, par repo, s’affichera ici à partir de 10 findings clos.</p>
              </div>
            </section>
          </div>

          {screen.workflowRepos.length > 0 ? (
            <div class="banner banner-info dash-workflow" role="note">
              <p>
                <strong>
                  {screen.workflowRepos.length === 1 ? '1 repo est encore sur' : `${screen.workflowRepos.length} repos sont encore sur`}{' '}
                  <code>review.yml</code>
                </strong>{' '}
                ({screen.workflowRepos.join(', ')}). Leurs findings ne sont pas suivis ici. <a href={routes.repos.href()}>Voir les repos</a>
              </p>
            </div>
          ) : null}
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

function Tile(handle: Handle<{ label: string; value: string; alert?: boolean }>) {
  return () => {
    let { label, value, alert } = handle.props
    return (
      <div class={`dash-tile ${alert ? 'dash-tile-alert' : ''}`}>
        <span class="dash-tile-label">{label}</span>
        <span class="dash-tile-value">{value}</span>
      </div>
    )
  }
}

function FailureBannerView(handle: Handle<{ banner: FailureBanner; admin: boolean; csrf: string; githubUrl: string }>) {
  return () => {
    let { banner, admin, csrf, githubUrl } = handle.props
    let reason = failureText(banner)
    return (
      <section class="banner banner-alert dash-failure" aria-labelledby="failure-title">
        <div class="banner-confirm-body">
          <h2 id="failure-title" class="banner-confirm-title">
            La review {banner.level} de <span class="mono">{banner.repo}#{banner.prNumber}</span> a échoué
          </h2>
          <p>Raison : {reason.text}. {reason.action}</p>
          <TechDetails raw={reason.raw} />
          <p>
            {banner.previous
              ? `La review précédente (${banner.previous.score}/5, publiée le ${clock(banner.previous.publishedAt)}) reste publiée sur la PR.`
              : 'Aucune review n’est encore publiée sur cette PR.'}
          </p>
          {banner.retry ? (
            <p>
              <strong>
                Relance en {banner.retry.level} {banner.retry.state === 'queued' ? 'en file' : 'en cours'}
              </strong>
              . Ce bandeau disparaît quand sa review est publiée.
            </p>
          ) : null}
          <div class="banner-confirm-actions">
            <a class="button" href={prUrl(githubUrl, banner.repo, banner.prNumber)}>
              Voir la PR
            </a>
            {admin && !banner.retry
              ? LEVELS.map((level) => {
                  let estimate = banner.estimates[level]
                  return (
                    <form method="post" action={routes.jobRetry.href({ id: banner.id })}>
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
          </div>
          {admin && !banner.retry ? (
            <p class="hint">L’estimation est la moyenne des dernières reviews de ce niveau sur ce repo.</p>
          ) : null}
        </div>
      </section>
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

/** The bars of the week: one per day, the reviews published. The table under it holds every number. */
function WeekSection(handle: Handle<{ week: DayStats[] }>) {
  return () => {
    let { week } = handle.props
    let max = Math.max(1, ...week.map(total))
    let width = 280
    let height = 96
    let slot = width / Math.max(1, week.length)
    let bar = Math.max(4, slot - 8)
    return (
      <section class="dash-section card" aria-labelledby="week-title">
        <h2 id="week-title" class="section-title">
          Reviews publiées · 7 jours
        </h2>
        <svg class="dash-chart" viewBox={`0 0 ${width} ${height + 2}`} aria-hidden="true" focusable="false">
          <line class="dash-chart-base" x1={0} x2={width} y1={height + 1} y2={height + 1} />
          {week.map((day, i) => {
            let n = total(day)
            let h = n === 0 ? 0 : Math.max(4, Math.round((n / max) * height))
            return (
              <rect class="dash-bar" x={i * slot + (slot - bar) / 2} y={height - h} width={bar} height={h} rx={2}>
                <title>{`${weekday(day.day)} : ${n} ${plural(n, 'publiée')}`}</title>
              </rect>
            )
          })}
        </svg>
        <div class="dash-week">
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
        </div>
      </section>
    )
  }
}

function RecentSection(handle: Handle<{ recent: RecentReview[]; now: Date }>) {
  return () => {
    let { recent, now } = handle.props
    return (
      <section class="dash-section" aria-labelledby="recent-title">
        <h2 id="recent-title" class="section-title">
          Dernières reviews
        </h2>
        {recent.length === 0 ? (
          <div class="empty">
            <p>Aucune review pour l’instant. Activez un repo dans <a href={routes.repos.href()}>Repos</a>, et son prochain push en lancera une.</p>
          </div>
        ) : (
          <ul class="dash-reviews">
            {recent.map((review) => {
              let verdict = review.verdict ? VERDICT_LABEL[review.verdict] : undefined
              return (
                <li class="dash-review">
                  <div class="dash-review-head">
                    <a class="mono dash-review-pr" href={pullRoutes.pull.href({ id: review.repoId, number: String(review.prNumber) })}>
                      {review.repo}#{review.prNumber}
                    </a>
                    <span class="tag">{review.level}</span>
                    {verdict ? <span class={`status ${verdict.status}`}>{verdict.text}</span> : null}
                    {review.publishedAt ? null : <span class="status status-stale">Non publiée</span>}
                  </div>
                  <dl class="dash-facts">
                    <div>
                      <dt>Score</dt>
                      <dd>{review.score}/5</dd>
                    </div>
                    <div>
                      <dt>Findings</dt>
                      <dd>{review.findings}</dd>
                    </div>
                    <div>
                      <dt>Coût</dt>
                      <dd>{review.costUsd === null ? 'inconnu' : usdPrecise(review.costUsd)}</dd>
                    </div>
                    <div>
                      <dt>Durée</dt>
                      <dd>{review.durationMs === null ? '—' : duration(review.durationMs)}</dd>
                    </div>
                    <div>
                      <dt>Date</dt>
                      <dd>
                        <time dateTime={review.createdAt.toISOString()} title={clock(review.createdAt)}>
                          {agoOrDate(review.createdAt, now)}
                        </time>
                      </dd>
                    </div>
                    <div>
                      <dt>Config</dt>
                      <dd>
                        <a href={routes.repoConfig.href({ id: review.repoId })}>
                          Config<span class="visually-hidden"> de {review.repo}</span>
                        </a>
                      </dd>
                    </div>
                  </dl>
                </li>
              )
            })}
          </ul>
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
        <div class="dash-review-head">
          <a class="mono" href={prUrl(githubUrl, job.repo, job.prNumber)}>
            {job.repo}#{job.prNumber}
          </a>
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

function QueueSection(handle: Handle<{ queue: DashboardScreen['queue']; now: Date; githubUrl: string }>) {
  return () => {
    let { queue, now, githubUrl } = handle.props
    return (
      <section class="dash-section card" aria-labelledby="queue-title">
        <h2 id="queue-title" class="section-title">
          File de jobs
        </h2>
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
        {queue.queuedCount > queue.queued.length ? (
          <p class="hint">et {queue.queuedCount - queue.queued.length} de plus.</p>
        ) : null}
      </section>
    )
  }
}

function RunnersSection(handle: Handle<{ runners: DashboardRunner[]; counts: RunnerCounts; now: Date }>) {
  return () => {
    let { runners, counts, now } = handle.props
    let total = counts.online + counts.late + counts.offline
    let more = total - runners.length
    return (
      <section class="dash-section card" aria-labelledby="dash-runners-title">
        <div class="dash-section-head">
          <h2 id="dash-runners-title" class="section-title">
            Runners
          </h2>
          <a class="button button-small" href={routes.runners.href()}>
            Gérer<span class="visually-hidden"> les runners</span>
          </a>
        </div>
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
                    <div class="dash-review-head">
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
    )
  }
}

function FailuresSection(handle: Handle<{ failures: FailedJob[]; now: Date; githubUrl: string }>) {
  return () => {
    let { failures, now, githubUrl } = handle.props
    return (
      <section class="dash-section card" aria-labelledby="failures-title">
        <h2 id="failures-title" class="section-title">
          Échecs récents
        </h2>
        {failures.length === 0 ? (
          <p class="hint">Aucun job en échec sur 7 jours.</p>
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
              </li>
              )
            })}
          </ul>
        )}
      </section>
    )
  }
}
