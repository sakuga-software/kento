import { LEVELS, type Level } from '@sakuga-review/protocol'
import type { Handle } from 'remix/component'

import type { DashboardRunner, DashboardScreen, DayStats, FailedJob, FailureBanner, QueueJob, RecentReview } from '../dashboard/store.ts'
import type { OrgCostsDetail } from '../org-settings/costs.ts'
import type { OrgCaps } from '../org-settings/model.ts'
import { pageRoutes as routes } from '../routes.ts'
import { ago, runnerState, type RunnerState } from './runners.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** The page asks the server again this often, while it is on screen (public/assets/dashboard.js). */
export const REFRESH_SECONDS = 10

/** What the dashboard says after « Relancer », from `?notice=`. */
export const DASHBOARD_NOTICES = {
  retried: 'Review relancée : le job est en file.',
  already: 'Une review de ce niveau est déjà en file ou en cours sur ce commit.',
  stale: 'Un push plus récent a remplacé ce commit : sa review suit le nouveau commit.',
  closed: 'La PR est fermée sur GitHub : rien n’est relancé.',
  capped: 'Le plafond de coût de l’organisation est atteint : rien n’est relancé. Un admin le change dans Réglages.',
  github_failed: 'GitHub n’a pas répondu : rien n’est relancé, réessayez dans un instant.',
  missing: 'Ce job n’existe plus, n’a pas échoué, ou son repo n’est plus activé.',
} as const
export type DashboardNotice = keyof typeof DASHBOARD_NOTICES

const USD = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const USD_SMALL = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 3, maximumFractionDigits: 3 })
const CLOCK = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' })
const SECONDS = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Paris' })
const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** « 0,12 $ »; under one dollar and above zero, three decimals: « 0,004 $ ». */
export function money(usd: number): string {
  return usd > 0 && usd < 0.1 ? USD_SMALL.format(usd) : USD.format(usd)
}

/** « 42 s », « 3 min 05 s ». */
export function duration(ms: number): string {
  let seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  let minutes = Math.floor(seconds / 60)
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
}

/**
 * The reason of a failure, in words. The service writes « lease expired N times » and « the provider
 * « X » refused its key (401): … »; any other reason is the text of the runner, quoted.
 */
export function failureText(job: Pick<FailedJob, 'reason' | 'runnerName'>): string {
  let reason = job.reason?.trim() ?? ''
  if (!reason) return 'aucune raison enregistrée'
  let lease = /^lease expired (\d+) times?$/.exec(reason)
  if (lease) {
    let n = Number(lease[1])
    let times = n === 1 ? 'une fois' : n === 2 ? 'deux fois' : n === 3 ? 'trois fois' : `${n} fois`
    return `le bail a expiré ${times}${job.runnerName ? ` sur ${job.runnerName}` : ''}`
  }
  let refused = /^the provider « (.+) » refused its key \((\d{3})\)/.exec(reason)
  if (refused) return `le provider « ${refused[1]} » a refusé sa clé (${refused[2]})`
  return `« ${reason.length > 300 ? `${reason.slice(0, 300)}…` : reason} »`
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

const RUNNER_TEXT: Record<RunnerState, string> = {
  online: 'En ligne',
  idle: 'Inactif',
  stale: 'Dernier signal ancien',
  revoked: 'Révoqué',
}

export interface DashboardPageProps {
  frame: PageFrame
  screen: DashboardScreen
  /** `https://github.com`, or the GitHub Enterprise Server: the links « Voir la PR ». */
  githubUrl: string
  notice?: DashboardNotice | null
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
    let { frame, screen, githubUrl, notice } = handle.props
    let admin = frame.viewer?.role === 'admin'
    let csrf = frame.csrfToken ?? ''
    let today = screen.week.at(-1)
    let weekPublished = screen.week.reduce((sum, day) => sum + total(day), 0)
    let weekFailed = screen.week.reduce((sum, day) => sum + day.failed, 0)
    return (
      <Shell frame={frame} section="dashboard" title="Tableau de bord" lead="Ce qui tourne, ce qui a échoué, et ce que ça coûte.">
        <div class="dashboard" id="dashboard-live" data-refresh={String(REFRESH_SECONDS)}>
          <p class="dash-updated hint">
            <span data-updated={screen.now.toISOString()}>Mis à jour à {SECONDS.format(screen.now)}</span>
            {' · '}
            <a href={routes.home.href()}>Actualiser</a>
          </p>

          {notice ? (
            <div class={`banner ${notice === 'retried' ? 'banner-ok' : 'banner-info'}`} role="status">
              <p>{DASHBOARD_NOTICES[notice]}</p>
            </div>
          ) : null}

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

          <RecentSection recent={screen.recent} githubUrl={githubUrl} now={screen.now} />

          <div class="dash-grid">
            <QueueSection queue={screen.queue} now={screen.now} githubUrl={githubUrl} />
            <RunnersSection runners={screen.runners} now={screen.now} />
          </div>

          <div class="dash-grid">
            <FailuresSection failures={screen.failures} now={screen.now} githubUrl={githubUrl} />
            <section class="dash-section" aria-labelledby="precision-title">
              <h2 id="precision-title" class="section-title">
                Précision par repo
              </h2>
              <div class="empty">
                <p>La part des findings confirmés, par repo, s’affichera ici à partir de 10 findings clos (M4).</p>
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
                ({screen.workflowRepos.join(', ')}) : leurs findings ne sont pas suivis ici. <a href={routes.repos.href()}>Voir les repos</a>
              </p>
            </div>
          ) : null}
        </div>
        <script src={`/assets/dashboard.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script>
      </Shell>
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
    return (
      <section class="banner banner-alert dash-failure" aria-labelledby="failure-title">
        <div class="banner-confirm-body">
          <h2 id="failure-title" class="banner-confirm-title">
            La review {banner.level} de <span class="mono">{banner.repo}#{banner.prNumber}</span> a échoué
          </h2>
          <p>Raison : {failureText(banner)}.</p>
          <p>
            {banner.previous
              ? `La review précédente (${banner.previous.score}/5, publiée le ${CLOCK.format(banner.previous.publishedAt)}) reste publiée sur la PR.`
              : 'Aucune review n’est encore publiée sur cette PR.'}
          </p>
          {banner.retry ? (
            <p>
              <strong>
                Relance en {banner.retry.level} {banner.retry.state === 'queued' ? 'en file' : 'en cours'}
              </strong>{' '}
              : ce bandeau disparaît quand sa review est publiée.
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
                        <span class="dash-estimate">{estimate === null ? ' · coût inconnu' : ` · ≈ ${money(estimate)}`}</span>
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
          {money(usd)}
          {cap !== null ? <span class="dash-cost-cap"> sur {money(cap)}</span> : null}
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
            {money(usd)} sur {money(cap)}
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
            Aucun plafond pour l’organisation : un admin le fixe dans <a href={routes.settings.href()}>Réglages</a>.
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
                  <td class="num">{money(costs.dayByProvider.find((p) => p.providerId === provider.providerId && p.label === provider.label)?.usd ?? 0)}</td>
                  <td class="num">{money(provider.usd)}</td>
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
            connu : comptées 0 $.
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
                <title>{`${DAY.format(new Date(`${day.day}T00:00:00Z`))} : ${n} publiée${n > 1 ? 's' : ''}`}</title>
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
                  <th scope="row">{DAY.format(new Date(`${day.day}T00:00:00Z`))}</th>
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

function RecentSection(handle: Handle<{ recent: RecentReview[]; githubUrl: string; now: Date }>) {
  return () => {
    let { recent, githubUrl, now } = handle.props
    return (
      <section class="dash-section" aria-labelledby="recent-title">
        <h2 id="recent-title" class="section-title">
          Dernières reviews
        </h2>
        {recent.length === 0 ? (
          <div class="empty">
            <p>Aucune review pour l’instant. Activez un repo dans <a href={routes.repos.href()}>Repos</a> : son prochain push en lance une.</p>
          </div>
        ) : (
          <ul class="dash-reviews">
            {recent.map((review) => {
              let verdict = review.verdict ? VERDICT_LABEL[review.verdict] : undefined
              return (
                <li class="dash-review">
                  <div class="dash-review-head">
                    <a class="mono dash-review-pr" href={prUrl(githubUrl, review.repo, review.prNumber)}>
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
                      <dd>{review.costUsd === null ? 'inconnu' : money(review.costUsd)}</dd>
                    </div>
                    <div>
                      <dt>Durée</dt>
                      <dd>{review.durationMs === null ? '—' : duration(review.durationMs)}</dd>
                    </div>
                    <div>
                      <dt>Date</dt>
                      <dd>
                        <time dateTime={review.createdAt.toISOString()} title={CLOCK.format(review.createdAt)}>
                          {ago(review.createdAt, now)}
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
              <time dateTime={job.startedAt!.toISOString()}>{ago(job.startedAt!, now).replace('il y a ', '')}</time> · tentative{' '}
              {job.attempts} · bail jusqu’à <time dateTime={job.leaseExpiresAt!.toISOString()}>{SECONDS.format(job.leaseExpiresAt!)}</time>
              {job.runnerSeenAt ? (
                <>
                  {' '}
                  · dernier signal <time dateTime={job.runnerSeenAt.toISOString()}>{ago(job.runnerSeenAt, now)}</time>
                </>
              ) : null}
            </>
          ) : (
            <>
              En file <time dateTime={job.createdAt.toISOString()}>{ago(job.createdAt, now).replace('il y a ', 'depuis ')}</time>
              {job.attempts > 0 ? ` · ${job.attempts} tentative${job.attempts > 1 ? 's' : ''} déjà` : ''}
              {waiting ? (
                <>
                  {' '}
                  · reprise à <time dateTime={job.notBefore!.toISOString()}>{SECONDS.format(job.notBefore!)}</time>
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

function RunnersSection(handle: Handle<{ runners: DashboardRunner[]; now: Date }>) {
  return () => {
    let { runners, now } = handle.props
    let online = runners.filter((runner) => runnerState({ revokedAt: null, lastSeenAt: runner.lastSeenAt }, now) === 'online').length
    return (
      <section class="dash-section card" aria-labelledby="dash-runners-title">
        <div class="dash-section-head">
          <h2 id="dash-runners-title" class="section-title">
            Runners <span class="count">{online} en ligne</span>
          </h2>
          <a class="button button-small" href={routes.runners.href()}>
            Gérer<span class="visually-hidden"> les runners</span>
          </a>
        </div>
        {runners.length === 0 ? (
          <p class="hint">Aucun runner : les jobs attendent en file. Créez-en un dans Runners.</p>
        ) : (
          <ul class="dash-jobs">
            {runners.map((runner) => {
              let state = runnerState({ revokedAt: null, lastSeenAt: runner.lastSeenAt }, now)
              return (
                <li class="dash-job">
                  <div class="dash-review-head">
                    <span class="mono">{runner.name}</span>
                    <span class={`status status-${state}`}>{RUNNER_TEXT[state]}</span>
                    {runner.orgId === null ? <span class="tag">Runner du service</span> : null}
                  </div>
                  <p class="hint">
                    {runner.running === 0 ? 'Aucun job en cours' : `${runner.running} job${runner.running > 1 ? 's' : ''} en cours`} · dernier
                    signal{' '}
                    {runner.lastSeenAt ? <time dateTime={runner.lastSeenAt.toISOString()}>{ago(runner.lastSeenAt, now)}</time> : 'jamais'}
                  </p>
                </li>
              )
            })}
          </ul>
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
            {failures.map((job) => (
              <li class="dash-job">
                <div class="dash-review-head">
                  <a class="mono" href={prUrl(githubUrl, job.repo, job.prNumber)}>
                    {job.repo}#{job.prNumber}
                  </a>
                  <span class="tag">{job.kind === 'resolve' ? 'résolution' : job.level}</span>
                  {job.finishedAt ? (
                    <time class="hint" dateTime={job.finishedAt.toISOString()}>
                      {ago(job.finishedAt, now)}
                    </time>
                  ) : null}
                </div>
                <p class="hint">
                  {failureText(job)} · {job.attempts} tentative{job.attempts > 1 ? 's' : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }
}
