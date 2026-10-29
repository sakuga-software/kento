import type { Handle } from 'remix/component'

import { CLAIM_WAIT_SECONDS, HEARTBEAT_SECONDS, LEASE_SECONDS, MAX_ATTEMPTS, MAX_BODY_BYTES, RUNNER_TOKEN_PREFIX } from '@sakuga-review/protocol'

import { REGISTRATION_TTL_MINUTES, type RegistrationView, type RunnersScreen, type RunnerView } from '../runner/admin.ts'
import { RETRY_BACKOFF_SECONDS } from '../runner/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Shell, type PageFrame } from './shell.tsx'

/** A runner whose last call is this recent is « En ligne »: it long-polls a claim every 30 s. */
export const ONLINE_SECONDS = 3 * CLAIM_WAIT_SECONDS
/** After this, its last call is « ancien ». */
export const STALE_SECONDS = 24 * 60 * 60

export const RUNNER_IMAGE = 'ghcr.io/sakuga-software/kento-runner'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

const NAME = /^[A-Za-z0-9._-]{1,100}$/
const LABEL = /^[A-Za-z0-9._-]{1,64}$/

/** The form « Nouveau runner », as typed, and what is wrong with it. */
export interface RegistrationForm {
  name: string
  labels: string
  keyMode: 'app' | 'runner'
}

export type RegistrationInput = { name: string; labels: string[]; trusted: boolean }

/** Checks the form « Nouveau runner ». Returns the input, or a message per field. */
export function readRegistrationForm(form: FormData | undefined): {
  values: RegistrationForm
  input: RegistrationInput | null
  errors: Partial<Record<'name' | 'labels' | 'keyMode', string>>
} {
  let name = String(form?.get('name') ?? '').trim()
  let labelsText = String(form?.get('labels') ?? '').trim()
  let keyModeValue = form?.get('keyMode')
  let keyMode: RegistrationForm['keyMode'] = keyModeValue === 'runner' ? 'runner' : 'app'
  let errors: Partial<Record<'name' | 'labels' | 'keyMode', string>> = {}
  if (!NAME.test(name)) errors.name = 'Lettres, chiffres, points, tirets ou soulignés, 100 au plus.'
  let labels = [...new Set(labelsText.split(/[\s,]+/).filter(Boolean))]
  if (labels.length > 20 || labels.some((label) => !LABEL.test(label))) {
    errors.labels = '20 labels au plus, séparés par des virgules ; chacun en lettres, chiffres, points, tirets ou soulignés.'
  }
  if (keyModeValue !== 'app' && keyModeValue !== 'runner') errors.keyMode = 'Choisissez où est la clé du modèle.'
  let values = { name, labels: labelsText, keyMode }
  let ok = Object.keys(errors).length === 0
  return { values, input: ok ? { name, labels, trusted: keyMode === 'app' } : null, errors }
}

/** The `docker run` that starts the runner of a registration token. */
export function dockerCommand(input: { kentoUrl: string; token: string; name: string; labels: string[]; trusted: boolean; version: string }): string {
  let lines = [
    'docker run -d --name kento-runner --restart unless-stopped',
    `-e KENTO_URL=${input.kentoUrl}`,
    `-e KENTO_REGISTRATION_TOKEN=${input.token}`,
    `-e KENTO_RUNNER_NAME=${input.name}`,
    `-e KENTO_RUNNER_LABELS=${input.labels.join(',')}`,
    '-e PROVIDER_KIND=openrouter',
    `-e PROVIDER_BASE_URL=${OPENROUTER_BASE_URL}`,
    ...(input.trusted ? [] : ['-e PROVIDER_API_KEY=<votre clé OpenRouter>']),
    '-v kento-runner-state:/var/lib/kento-runner',
    '--tmpfs /tmp:rw,size=2g --read-only --cap-drop ALL --security-opt no-new-privileges',
    `${RUNNER_IMAGE}:${input.version}`,
  ]
  return lines.join(' \\\n  ')
}

export type RunnerState = 'revoked' | 'online' | 'idle' | 'stale'

/** The state of a runner from its last call, as the screen shows it. */
export function runnerState(runner: Pick<RunnerView, 'revokedAt' | 'lastSeenAt'>, now: Date): RunnerState {
  if (runner.revokedAt) return 'revoked'
  if (!runner.lastSeenAt) return 'stale'
  let age = (now.getTime() - runner.lastSeenAt.getTime()) / 1000
  if (age <= ONLINE_SECONDS) return 'online'
  if (age <= STALE_SECONDS) return 'idle'
  return 'stale'
}

const STATE_LABELS: Record<RunnerState, string> = {
  revoked: 'Révoqué',
  online: 'En ligne',
  idle: 'Inactif',
  stale: 'Dernier signal ancien',
}

/** The release that a runner should run, when `version` is older than it. Null when up to date or unknown. */
export function newerVersion(version: string | null, latest: string): string | null {
  let parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null
  let have = version ? parse(version) : null
  let want = parse(latest)
  if (!have || !want) return null
  for (let i = 0; i < 3; i++) {
    if (have[i]! < want[i]!) return latest
    if (have[i]! > want[i]!) return null
  }
  return null
}

/** « il y a 12 s », « il y a 5 min », « il y a 3 h », « il y a 2 j ». */
export function ago(date: Date, now: Date): string {
  let seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000))
  if (seconds < 60) return `il y a ${seconds} s`
  let minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `il y a ${minutes} min`
  let hours = Math.floor(minutes / 60)
  if (hours < 48) return `il y a ${hours} h`
  return `il y a ${Math.floor(hours / 24)} j`
}

const CLOCK = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' })
const HOUR = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })

/** What the screen says after a form, from `?notice=`. */
export const RUNNER_NOTICES = {
  revoked: 'Runner révoqué. Son token ne marche plus, et son job en cours est reparti en file.',
  trusted: 'Le runner reçoit maintenant la clé de l’app quand il n’a pas la sienne.',
  untrusted: 'Le runner ne reçoit plus la clé de l’app.',
  discarded: 'Token d’enregistrement annulé.',
  missing: 'Ce runner ou ce token n’existe plus, ou a déjà changé.',
} as const
export type RunnerNotice = keyof typeof RUNNER_NOTICES

/** A token just made: shown on this response only, never stored in clear. */
export interface CreatedRegistration {
  name: string
  labels: string[]
  trusted: boolean
  token: string
  expiresAt: Date
}

export interface RunnersPageProps {
  frame: PageFrame
  screen: RunnersScreen
  /** The release of the service: the runner image of the same release is the one to run. */
  version: string
  /** `https://review.sakuga.dev`, as the runner reaches it. */
  kentoUrl: string
  created?: CreatedRegistration | null
  form?: { values: RegistrationForm; errors: Partial<Record<'name' | 'labels' | 'keyMode', string>> } | null
  notice?: RunnerNotice | null
}

export function RunnersPage(handle: Handle<RunnersPageProps>) {
  return () => {
    let { frame, screen, version, kentoUrl, created, form, notice } = handle.props
    let admin = frame.viewer?.role === 'admin'
    let csrf = frame.csrfToken ?? ''
    let host = new URL(kentoUrl).host
    let active = screen.runners.filter((runner) => !runner.revokedAt)
    let revoked = screen.runners.filter((runner) => runner.revokedAt)
    return (
      <Shell
        frame={frame}
        section="runners"
        title="Runners"
        lead="Les machines qui font les reviews."
        actions={
          <a class="button button-primary" href="#nouveau-runner">
            Nouveau runner
          </a>
        }
      >
        {notice ? (
          <div class={`banner ${notice === 'missing' ? 'banner-alert' : 'banner-info'}`} role="status">
            <p>{RUNNER_NOTICES[notice]}</p>
          </div>
        ) : null}

        {created ? <CreatedToken created={created} kentoUrl={kentoUrl} version={version} /> : null}

        {screen.registrations.length > 0 ? (
          <section class="runner-section" aria-labelledby="pending-title">
            <h2 id="pending-title" class="section-title">
              Tokens en attente
            </h2>
            <ul class="runner-list">
              {screen.registrations.map((registration) => (
                <PendingRegistration registration={registration} now={screen.now} admin={admin} csrf={csrf} host={host} />
              ))}
            </ul>
          </section>
        ) : null}

        <section class="runner-section" aria-labelledby="runners-title">
          <h2 id="runners-title" class="section-title">
            Runners actifs <span class="count">{active.length}</span>
          </h2>
          {active.length === 0 ? (
            <div class="empty">
              <p>Aucun runner. Créez un token avec « Nouveau runner », puis lancez la commande sur la machine.</p>
            </div>
          ) : (
            <ul class="runner-list">
              {active.map((runner) => (
                <RunnerItem runner={runner} now={screen.now} version={version} admin={admin} csrf={csrf} />
              ))}
            </ul>
          )}
        </section>

        {revoked.length > 0 ? (
          <section class="runner-section" aria-labelledby="revoked-title">
            <h2 id="revoked-title" class="section-title">
              Révoqués <span class="count">{revoked.length}</span>
            </h2>
            <ul class="runner-list">
              {revoked.map((runner) => (
                <RunnerItem runner={runner} now={screen.now} version={version} admin={false} csrf={csrf} />
              ))}
            </ul>
          </section>
        ) : null}

        <div class="runner-facts">
          <ProtocolFacts version={version} />
          <LeaseFacts />
        </div>

        {admin ? <NewRunnerForm csrf={csrf} form={form ?? null} /> : null}
        <script src={`/assets/runners.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script>
      </Shell>
    )
  }
}

function CreatedToken(handle: Handle<{ created: CreatedRegistration; kentoUrl: string; version: string }>) {
  return () => {
    let { created, kentoUrl, version } = handle.props
    let command = dockerCommand({ kentoUrl, version, ...created })
    return (
      <section class="card token-card" aria-labelledby="token-title">
        <h2 id="token-title" class="section-title">
          Token de {created.name}
        </h2>
        <div class="banner banner-alert" role="status">
          <p>
            <strong>Copiez-le maintenant :</strong> il ne sera plus affiché. Il sert une fois, jusqu’à{' '}
            <time dateTime={created.expiresAt.toISOString()}>{HOUR.format(created.expiresAt)}</time>.
          </p>
        </div>
        <p class="hint">
          Lancez cette commande sur la machine du runner. Il apparaît ici dès qu’il s’enregistre.
          {created.trusted ? null : ' Mettez votre clé OpenRouter à la place de <votre clé OpenRouter>.'}
        </p>
        <div class="copy-block">
          <label class="field-label" for="docker-command">
            Commande docker run
          </label>
          <textarea id="docker-command" class="mono command" readOnly rows={command.split('\n').length} spellCheck={false} value={command}></textarea>
          <button class="button" type="button" data-copy="docker-command" hidden>
            Copier la commande
          </button>
          <span class="copy-status" role="status" aria-live="polite"></span>
        </div>
      </section>
    )
  }
}

function PendingRegistration(handle: Handle<{ registration: RegistrationView; now: Date; admin: boolean; csrf: string; host: string }>) {
  return () => {
    let { registration, now, admin, csrf, host } = handle.props
    let expired = registration.expiresAt <= now
    return (
      <li class={`runner ${expired ? 'runner-expired' : ''}`}>
        <div class="runner-head">
          <h3 class="runner-name mono">{registration.name}</h3>
          <span class={`status ${expired ? 'status-alert' : 'status-wait'}`}>{expired ? 'Token expiré' : 'En attente du runner'}</span>
        </div>
        <Labels labels={registration.labels} />
        <p class="hint">
          {expired ? (
            <>
              Le token a expiré à <time dateTime={registration.expiresAt.toISOString()}>{CLOCK.format(registration.expiresAt)}</time>{' '}
              sans qu’aucun runner ne s’enregistre. Vérifiez que le conteneur atteint {host} en HTTPS sortant, puis
              créez un nouveau token.
            </>
          ) : (
            <>
              Valable jusqu’à <time dateTime={registration.expiresAt.toISOString()}>{HOUR.format(registration.expiresAt)}</time>.{' '}
              {registration.trusted ? 'Clé de l’app.' : 'Clé du runner.'}
            </>
          )}
        </p>
        {admin ? (
          <div class="runner-actions">
            <form method="post" action={routes.runnerRenew.href({ id: registration.id })}>
              <input type="hidden" name="_csrf" value={csrf} />
              <button class={`button ${expired ? 'button-primary' : ''}`} type="submit">
                Nouveau token
              </button>
            </form>
            <form method="post" action={routes.runnerDiscard.href({ id: registration.id })}>
              <input type="hidden" name="_csrf" value={csrf} />
              <button class="button button-ghost" type="submit">
                Annuler le token
              </button>
            </form>
          </div>
        ) : null}
      </li>
    )
  }
}

function RunnerItem(handle: Handle<{ runner: RunnerView; now: Date; version: string; admin: boolean; csrf: string }>) {
  return () => {
    let { runner, now, version, admin, csrf } = handle.props
    let state = runnerState(runner, now)
    let newer = state === 'revoked' ? null : newerVersion(runner.version, version)
    let service = runner.orgId === null
    let manage = admin && !service && state !== 'revoked'
    return (
      <li class={`runner runner-${state}`}>
        <div class="runner-head">
          <h3 class="runner-name mono">{runner.name}</h3>
          <span class={`status status-${state}`}>{STATE_LABELS[state]}</span>
          {service ? <span class="tag">Runner du service</span> : null}
        </div>
        <Labels labels={runner.labels} />
        <dl class="runner-facts-list">
          <div>
            <dt>Clé du modèle</dt>
            <dd>{runner.trusted ? 'Clé de l’app (de confiance)' : 'Clé du runner'}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>
              <span class="mono">{runner.version ?? '—'}</span>
              {newer ? <span class="status status-idle">{newer} disponible</span> : null}
            </dd>
          </div>
          <div>
            <dt>Dernier signal</dt>
            <dd>
              {runner.lastSeenAt ? (
                <time dateTime={runner.lastSeenAt.toISOString()} title={CLOCK.format(runner.lastSeenAt)}>
                  {ago(runner.lastSeenAt, now)}
                </time>
              ) : (
                'jamais'
              )}
            </dd>
          </div>
          <div>
            <dt>Job en cours</dt>
            <dd>
              {runner.currentJob ? (
                <span>
                  <span class="mono">
                    {runner.currentJob.repo}#{runner.currentJob.prNumber}
                  </span>{' '}
                  · {runner.currentJob.kind === 'resolve' ? 'résolution' : 'review'}
                </span>
              ) : (
                'aucun'
              )}
            </dd>
          </div>
          <div>
            <dt>Jobs sur 24 h</dt>
            <dd>{runner.jobs24h}</dd>
          </div>
          {runner.revokedAt ? (
            <div>
              <dt>Révoqué</dt>
              <dd>
                <time dateTime={runner.revokedAt.toISOString()}>{CLOCK.format(runner.revokedAt)}</time>
              </dd>
            </div>
          ) : null}
        </dl>
        {service && state !== 'revoked' ? (
          <p class="hint">Enregistré par la variable d’environnement du service : l’opérateur le gère (DEPLOY.md).</p>
        ) : null}
        {manage ? (
          <div class="runner-actions">
            <form method="post" action={routes.runnerTrust.href({ id: runner.id })}>
              <input type="hidden" name="_csrf" value={csrf} />
              <input type="hidden" name="trusted" value={runner.trusted ? 'false' : 'true'} />
              <button class="button" type="submit">
                {runner.trusted ? 'Retirer la confiance' : 'Marquer de confiance'}
              </button>
            </form>
            <details class="confirm">
              <summary class="button button-danger">Révoquer…</summary>
              <div class="confirm-body">
                <p>
                  Le token de <strong class="mono">{runner.name}</strong> cessera de marcher à son prochain appel, et son
                  job en cours repartira en file pour un autre runner. Pour le remettre en service, il faudra un nouveau
                  token.
                </p>
                <form method="post" action={routes.runnerRevoke.href({ id: runner.id })}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <button class="button button-danger-solid" type="submit">
                    Révoquer {runner.name}
                  </button>
                </form>
              </div>
            </details>
          </div>
        ) : null}
      </li>
    )
  }
}

function Labels(handle: Handle<{ labels: string[] }>) {
  return () => {
    let { labels } = handle.props
    if (labels.length === 0) return <p class="labels labels-none">Aucun label</p>
    return (
      <ul class="labels" aria-label="Labels">
        {labels.map((label) => (
          <li class="tag mono">{label}</li>
        ))}
      </ul>
    )
  }
}

function ProtocolFacts(handle: Handle<{ version: string }>) {
  return () => (
    <section class="card facts" aria-labelledby="protocol-title">
      <h2 id="protocol-title" class="section-title">
        Protocole
      </h2>
      <dl>
        <div>
          <dt>Image</dt>
          <dd class="mono">
            {RUNNER_IMAGE}:{handle.props.version}
          </dd>
        </div>
        <div>
          <dt>Attente d’un claim</dt>
          <dd>{CLAIM_WAIT_SECONDS} s</dd>
        </div>
        <div>
          <dt>Heartbeat</dt>
          <dd>toutes les {HEARTBEAT_SECONDS} s</dd>
        </div>
        <div>
          <dt>Corps maximal</dt>
          <dd>{Math.round(MAX_BODY_BYTES / 1000)} ko</dd>
        </div>
        <div>
          <dt>Token du runner</dt>
          <dd>
            <span class="mono">{RUNNER_TOKEN_PREFIX}…</span>, gardé en hash
          </dd>
        </div>
        <div>
          <dt>Token d’enregistrement</dt>
          <dd>un usage, {REGISTRATION_TTL_MINUTES} min</dd>
        </div>
      </dl>
    </section>
  )
}

function LeaseFacts(_handle: Handle<{}>) {
  return () => (
    <section class="card facts" aria-labelledby="lease-title">
      <h2 id="lease-title" class="section-title">
        Bail et tentatives
      </h2>
      <dl>
        <div>
          <dt>Bail</dt>
          <dd>{LEASE_SECONDS} s, prolongé à chaque heartbeat</dd>
        </div>
        <div>
          <dt>Tentatives</dt>
          <dd>{MAX_ATTEMPTS} au plus par job</dd>
        </div>
        <div>
          <dt>Attente avant une nouvelle tentative</dt>
          <dd>{RETRY_BACKOFF_SECONDS} s, puis le double</dd>
        </div>
        <div>
          <dt>Runner révoqué</dt>
          <dd>son job repart en file, sans compter de tentative</dd>
        </div>
      </dl>
    </section>
  )
}

function NewRunnerForm(handle: Handle<{ csrf: string; form: RunnersPageProps['form'] }>) {
  return () => {
    let { csrf, form } = handle.props
    let values = form?.values ?? { name: '', labels: '', keyMode: 'app' as const }
    let errors = form?.errors ?? {}
    return (
      <section class="card new-runner" id="nouveau-runner" aria-labelledby="new-runner-title" tabIndex={-1}>
        <h2 id="new-runner-title" class="section-title">
          Nouveau runner
        </h2>
        <p class="hint">
          Le nom, les labels et la clé sont figés dans le token : le runner ne peut pas les changer. Le token sert une
          fois, pendant {REGISTRATION_TTL_MINUTES} min.
        </p>
        <form method="post" action={routes.runnerNew.href()} noValidate>
          <input type="hidden" name="_csrf" value={csrf} />
          <div class="field">
            <label class="field-label" for="runner-name">
              Nom
            </label>
            <input
              class="input mono"
              id="runner-name"
              name="name"
              value={values.name}
              required
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.name ? 'true' : undefined}
              aria-describedby={errors.name ? 'runner-name-error' : 'runner-name-hint'}
            />
            {errors.name ? (
              <p class="field-error" id="runner-name-error">
                {errors.name}
              </p>
            ) : (
              <p class="field-hint" id="runner-name-hint">
                Par exemple mac-mini.
              </p>
            )}
          </div>
          <div class="field">
            <label class="field-label" for="runner-labels">
              Labels
            </label>
            <input
              class="input mono"
              id="runner-labels"
              name="labels"
              value={values.labels}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.labels ? 'true' : undefined}
              aria-describedby={errors.labels ? 'runner-labels-error' : 'runner-labels-hint'}
            />
            {errors.labels ? (
              <p class="field-error" id="runner-labels-error">
                {errors.labels}
              </p>
            ) : (
              <p class="field-hint" id="runner-labels-hint">
                Séparés par des virgules. Un repo dont le pool est l’un d’eux peut lui donner ses jobs.
              </p>
            )}
          </div>
          <fieldset class="field" aria-describedby={errors.keyMode ? 'runner-key-error' : undefined}>
            <legend class="field-label">Clé du modèle</legend>
            <label class="choice">
              <input type="radio" name="keyMode" value="app" checked={values.keyMode === 'app'} />
              <span>
                <strong>Clé de l’app</strong> — le runner est de confiance et reçoit la clé du service avec chaque job.
              </span>
            </label>
            <label class="choice">
              <input type="radio" name="keyMode" value="runner" checked={values.keyMode === 'runner'} />
              <span>
                <strong>Clé du runner</strong> — la machine a sa propre clé (PROVIDER_API_KEY) ; le service n’envoie
                jamais la sienne.
              </span>
            </label>
            {errors.keyMode ? (
              <p class="field-error" id="runner-key-error">
                {errors.keyMode}
              </p>
            ) : null}
          </fieldset>
          <button class="button button-primary" type="submit">
            Créer le token
          </button>
        </form>
      </section>
    )
  }
}
