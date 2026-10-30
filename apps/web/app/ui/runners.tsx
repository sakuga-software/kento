import type { Handle } from 'remix/component'

import { CLAIM_WAIT_SECONDS, HEARTBEAT_SECONDS, LEASE_SECONDS, MAX_ATTEMPTS, MAX_BODY_BYTES, RUNNER_TOKEN_PREFIX } from '@sakuga-review/protocol'

import { OFFLINE_SECONDS, ONLINE_SECONDS, REGISTRATION_TTL_MINUTES, SILENT_HOURS, type RegistrationView, type RunnersScreen, type RunnerView } from '../runner/admin.ts'
import { RETRY_BACKOFF_SECONDS } from '../runner/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { agoShort, clock, elapsed, hour } from './format.ts'
import { Shell, type PageFrame } from './shell.tsx'

// The dashboard store counts the runners by state in SQL with the same limits (REV-37).
export { OFFLINE_SECONDS, ONLINE_SECONDS } from '../runner/admin.ts'

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
  let keyMode: RegistrationForm['keyMode'] = keyModeValue === 'app' ? 'app' : 'runner'
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

/** The state of a runner from its last call. The name of each is also its class: `status-<state>`. */
export type RunnerState = 'revoked' | 'online' | 'late' | 'offline'

/** The state of a runner from its last call, as the screen shows it. */
export function runnerState(runner: Pick<RunnerView, 'revokedAt' | 'lastSeenAt'>, now: Date): RunnerState {
  if (runner.revokedAt) return 'revoked'
  if (!runner.lastSeenAt) return 'offline'
  let age = (now.getTime() - runner.lastSeenAt.getTime()) / 1000
  if (age <= ONLINE_SECONDS) return 'online'
  if (age <= OFFLINE_SECONDS) return 'late'
  return 'offline'
}

const STATE_LABELS: Record<RunnerState, string> = {
  revoked: 'Révoqué',
  online: 'En ligne',
  late: 'Signal en retard',
  offline: 'Hors ligne',
}

/** « En ligne », « Signal en retard », « Hors ligne depuis 3 j »: the word of the state of a runner. */
export function runnerStateLabel(runner: Pick<RunnerView, 'revokedAt' | 'lastSeenAt'>, now: Date): string {
  let state = runnerState(runner, now)
  if (state === 'offline' && runner.lastSeenAt) return `Hors ligne depuis ${elapsed(runner.lastSeenAt, now)}`
  return STATE_LABELS[state]
}

/** The order of the runners in service: a problem first, so that it is seen before the rest. */
const STATE_ORDER: Record<RunnerState, number> = { offline: 0, late: 1, online: 2, revoked: 3 }

/** The runners in service, those that went offline first, then late, then online; the same order otherwise. */
export function byState<T extends { lastSeenAt: Date | null; revokedAt?: Date | null }>(runners: T[], now: Date): T[] {
  return runners
    .map((runner, index) => ({ runner, index, rank: STATE_ORDER[runnerState({ revokedAt: runner.revokedAt ?? null, lastSeenAt: runner.lastSeenAt }, now)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ runner }) => runner)
}

/**
 * REV-37. A runner in service with no call for `SILENT_HOURS` (never seen: created that long ago).
 * The Runners screen folds these away, with one action to revoke them.
 */
export function isSilent(runner: Pick<RunnerView, 'revokedAt' | 'lastSeenAt' | 'createdAt'>, now: Date): boolean {
  if (runner.revokedAt) return false
  let last = runner.lastSeenAt ?? runner.createdAt
  return now.getTime() - last.getTime() >= SILENT_HOURS * 3_600_000
}

/** « 1 en ligne · 1 en retard · 27 hors ligne »: the runners in service by state, the empty states left out. */
export function stateCounts(runners: Pick<RunnerView, 'revokedAt' | 'lastSeenAt'>[], now: Date): string {
  let counts = { online: 0, late: 0, offline: 0 }
  for (let runner of runners) {
    let state = runnerState(runner, now)
    if (state !== 'revoked') counts[state]++
  }
  return countsText(counts)
}

/** « 1 en ligne · 27 hors ligne », from counts by state. */
export function countsText(counts: { online: number; late: number; offline: number }): string {
  let parts = [
    counts.online > 0 ? `${counts.online} en ligne` : null,
    counts.late > 0 ? `${counts.late} en retard` : null,
    counts.offline > 0 ? `${counts.offline} hors ligne` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'aucun en service'
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

/** What the screen says after a form, from `?notice=`. */
export const RUNNER_NOTICES = {
  revoked: 'Runner révoqué. Son token ne marche plus, et son job en cours est reparti en file.',
  trusted: 'Le runner reçoit maintenant la clé du service quand il n’a pas la sienne.',
  untrusted: 'Le runner ne reçoit plus la clé du service.',
  discarded: 'Token d’enregistrement annulé.',
  missing: 'Rien n’a changé. Ce runner ou ce token a été modifié ou supprimé depuis votre dernier affichage. Voyez son état ci-dessous, puis refaites l’action s’il le faut.',
  revoked_silent: 'Runners muets révoqués. Leurs tokens ne marchent plus, et leurs jobs en cours sont repartis en file.',
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
    let inService = screen.runners.filter((runner) => !runner.revokedAt)
    // REV-37: the runners silent for a day fold away, so that the ones that work are seen first.
    let active = byState(
      inService.filter((runner) => !isSilent(runner, screen.now)),
      screen.now,
    )
    let silent = inService.filter((runner) => isSilent(runner, screen.now))
    let silentOfOrg = silent.filter((runner) => runner.orgId !== null)
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
          <div class="runner-section-head">
            <h2 id="runners-title" class="section-title">
              Runners
            </h2>
            <p class="runner-counts">{stateCounts(inService, screen.now)}</p>
          </div>
          {inService.length === 0 ? (
            <div class="empty">
              <p>Aucun runner. Créez un token avec « Nouveau runner », puis lancez la commande sur la machine.</p>
            </div>
          ) : active.length === 0 ? (
            <p class="hint">Aucun runner n’a appelé depuis {SILENT_HOURS} h.</p>
          ) : (
            <RunnersTable runners={active} now={screen.now} version={version} admin={admin} csrf={csrf} caption="Runners en service" />
          )}
          {silent.length > 0 ? (
            <details class="runner-silent">
              <summary>
                {silent.length} {silent.length > 1 ? `runners muets depuis plus de ${SILENT_HOURS} h` : `runner muet depuis plus de ${SILENT_HOURS} h`}
              </summary>
              <div class="runner-silent-body">
                {admin && silentOfOrg.length > 0 ? (
                  <div class="runner-silent-action">
                    {/* The ids that the screen shows: the store revokes those still silent, no other. The
                        button of the confirmation posts this form; its action is also the form's own. */}
                    <form id="revoke-silent" method="post" action={routes.runnersRevokeSilent.href()} hidden>
                      <input type="hidden" name="_csrf" value={csrf} />
                      {silentOfOrg.map((runner) => (
                        <input type="hidden" name="id" value={runner.id} />
                      ))}
                    </form>
                    <Confirm
                      trigger={silentOfOrg.length > 1 ? `Révoquer ces ${silentOfOrg.length} runners…` : 'Révoquer ce runner…'}
                      action={routes.runnersRevokeSilent.href()}
                      csrf={null}
                      form="revoke-silent"
                      submit={silentOfOrg.length > 1 ? `Révoquer ${silentOfOrg.length} runners` : `Révoquer ${silentOfOrg[0]!.name}`}
                    >
                      <p>
                        Leurs tokens cesseront de marcher, et un job qu’ils tiendraient encore repartira en file. Un runner qui
                        a appelé depuis l’affichage de la page reste en service. Pour remettre l’un d’eux en service, il faudra
                        un nouveau token.
                      </p>
                    </Confirm>
                  </div>
                ) : null}
                <RunnersTable runners={silent} now={screen.now} version={version} admin={admin} csrf={csrf} caption={`Runners muets depuis plus de ${SILENT_HOURS} h`} />
              </div>
            </details>
          ) : null}
        </section>

        {revoked.length > 0 ? (
          <section class="runner-section" aria-labelledby="revoked-title">
            <h2 id="revoked-title" class="section-title">
              Révoqués <span class="count">{revoked.length}</span>
            </h2>
            <RunnersTable runners={revoked} now={screen.now} version={version} admin={false} csrf={csrf} caption="Runners révoqués" />
          </section>
        ) : null}

        <details class="runner-details">
          <summary>Détails techniques</summary>
          <div class="runner-facts">
            <ProtocolFacts version={version} />
            <LeaseFacts />
          </div>
        </details>

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
            <strong>Copiez-le maintenant.</strong> Il ne sera plus affiché. Il sert une fois, jusqu’à{' '}
            <time dateTime={created.expiresAt.toISOString()}>{hour(created.expiresAt)}</time>.
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
              Le token a expiré à <time dateTime={registration.expiresAt.toISOString()}>{clock(registration.expiresAt)}</time>{' '}
              sans qu’aucun runner ne s’enregistre. Vérifiez que le conteneur atteint {host} en HTTPS sortant, puis
              créez un nouveau token.
            </>
          ) : (
            <>
              Valable jusqu’à <time dateTime={registration.expiresAt.toISOString()}>{hour(registration.expiresAt)}</time>.{' '}
              {registration.trusted ? 'Clé du service.' : 'Clé du runner.'}
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
            <Confirm
              trigger="Annuler le token…"
              action={routes.runnerDiscard.href({ id: registration.id })}
              csrf={csrf}
              submit={`Annuler le token de ${registration.name}`}
            >
              <p>
                Le token de <strong class="mono">{registration.name}</strong> cesse de marcher tout de suite. Aucun runner
                ne pourra s’enregistrer avec. Pour enregistrer ce runner, il faudra un nouveau token.
              </p>
            </Confirm>
          </div>
        ) : null}
      </li>
    )
  }
}

interface RunnersTableProps {
  runners: RunnerView[]
  now: Date
  version: string
  admin: boolean
  csrf: string
  caption: string
}

/**
 * REV-37. The runners in a dense table at 1440 px; under 760 px each row is a card, each cell under
 * its column name (the `.table` of Repos). A revoked runner shows the date of its revocation in
 * place of the actions.
 */
function RunnersTable(handle: Handle<RunnersTableProps>) {
  return () => {
    let { runners, now, version, admin, csrf, caption } = handle.props
    let revoked = runners.some((runner) => runner.revokedAt)
    let actions = admin && runners.some((runner) => runner.orgId !== null && !runner.revokedAt)
    return (
      <div class="table-wrap">
        <table class="table runners-table">
          <caption class="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Runner</th>
              <th scope="col">État</th>
              <th scope="col">Clé du modèle</th>
              <th scope="col">Version</th>
              <th scope="col">Dernier signal</th>
              <th scope="col">Job en cours</th>
              <th scope="col">Jobs sur 24 h</th>
              {revoked ? <th scope="col">Révoqué</th> : null}
              {actions ? (
                <th scope="col">
                  <span class="visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {runners.map((runner) => (
              <RunnerRow runner={runner} now={now} version={version} admin={admin} csrf={csrf} revokedColumn={revoked} actionsColumn={actions} />
            ))}
          </tbody>
        </table>
      </div>
    )
  }
}

function RunnerRow(
  handle: Handle<{ runner: RunnerView; now: Date; version: string; admin: boolean; csrf: string; revokedColumn: boolean; actionsColumn: boolean }>,
) {
  return () => {
    let { runner, now, version, admin, csrf, revokedColumn, actionsColumn } = handle.props
    let state = runnerState(runner, now)
    let newer = state === 'revoked' ? null : newerVersion(runner.version, version)
    let service = runner.orgId === null
    let manage = admin && !service && state !== 'revoked'
    return (
      <tr id={`runner-${runner.id}`} class={`runner-row runner-${state}`}>
        <th scope="row" data-label="Runner">
          <div class="runner-ident">
            <span class="runner-name mono">{runner.name}</span>
            {service ? <span class="tag">Runner du service</span> : null}
            <Labels labels={runner.labels} />
          </div>
        </th>
        <td data-label="État">
          <span class={`status status-${state}`}>{runnerStateLabel(runner, now)}</span>
        </td>
        <td data-label="Clé du modèle">{runner.trusted ? 'Clé du service (de confiance)' : 'Clé du runner'}</td>
        <td data-label="Version">
          <span class="stack">
            <span class="mono">{runner.version ?? '—'}</span>
            {newer ? <span class="status status-wait">{newer} disponible</span> : null}
          </span>
        </td>
        <td data-label="Dernier signal">
          {runner.lastSeenAt ? (
            <time dateTime={runner.lastSeenAt.toISOString()} title={clock(runner.lastSeenAt)}>
              {agoShort(runner.lastSeenAt, now)}
            </time>
          ) : (
            'jamais'
          )}
        </td>
        <td data-label="Job en cours">
          {runner.currentJob ? (
            <span class="stack">
              <span class="mono">
                {runner.currentJob.repo}#{runner.currentJob.prNumber}
              </span>
              <span class="hint">{runner.currentJob.kind === 'resolve' ? 'résolution' : 'review'}</span>
            </span>
          ) : (
            'aucun'
          )}
        </td>
        <td data-label="Jobs sur 24 h" class="num">
          {runner.jobs24h}
        </td>
        {revokedColumn ? (
          <td data-label="Révoqué">
            {runner.revokedAt ? <time dateTime={runner.revokedAt.toISOString()}>{clock(runner.revokedAt)}</time> : '–'}
          </td>
        ) : null}
        {actionsColumn ? (
          <td data-label="Actions" class="row-action">
            {manage ? (
              <div class="runner-actions">
                <form method="post" action={routes.runnerTrust.href({ id: runner.id })}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <input type="hidden" name="trusted" value={runner.trusted ? 'false' : 'true'} />
                  <button class="button button-small" type="submit">
                    {runner.trusted ? 'Retirer la confiance' : 'Marquer de confiance'}
                    <span class="visually-hidden"> à {runner.name}</span>
                  </button>
                </form>
                <Confirm trigger="Révoquer…" action={routes.runnerRevoke.href({ id: runner.id })} csrf={csrf} submit={`Révoquer ${runner.name}`}>
                  <p>
                    Le token de <strong class="mono">{runner.name}</strong> cessera de marcher à son prochain appel, et son
                    job en cours repartira en file pour un autre runner. Pour le remettre en service, il faudra un nouveau
                    token.
                  </p>
                </Confirm>
              </div>
            ) : service && state !== 'revoked' ? (
              <span class="hint">géré par l’opérateur</span>
            ) : null}
          </td>
        ) : null}
      </tr>
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
          <dt>Attente d’un job</dt>
          <dd>{CLAIM_WAIT_SECONDS} s</dd>
        </div>
        <div>
          <dt>Signal pendant un job</dt>
          <dd>toutes les {HEARTBEAT_SECONDS} s</dd>
        </div>
        <div>
          <dt>Taille maximale d’une requête</dt>
          <dd>{Math.round(MAX_BODY_BYTES / 1000)} ko</dd>
        </div>
        <div>
          <dt>Token du runner</dt>
          <dd>
            <span class="mono">{RUNNER_TOKEN_PREFIX}…</span>, seule son empreinte est gardée
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
        Réservation et tentatives
      </h2>
      <dl>
        <div>
          <dt>Réservation d’un job</dt>
          <dd>{LEASE_SECONDS} s, prolongée à chaque signal du runner</dd>
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
    // The runner keeps its own key unless an admin chooses to trust it with the key of the service.
    let values = form?.values ?? { name: '', labels: '', keyMode: 'runner' as const }
    let errors = form?.errors ?? {}
    return (
      <section class="card new-runner" id="nouveau-runner" aria-labelledby="new-runner-title" tabIndex={-1}>
        <h2 id="new-runner-title" class="section-title">
          Nouveau runner
        </h2>
        <p class="hint">
          Le nom, les labels et la clé sont figés dans le token, et le runner ne peut pas les changer. Le token sert une
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
                Séparés par des virgules. Ils s’affichent sur la carte du runner.
              </p>
            )}
          </div>
          <fieldset class="field" aria-describedby={errors.keyMode ? 'runner-key-error' : undefined}>
            <legend class="field-label">Clé du modèle</legend>
            <label class="choice">
              <input type="radio" name="keyMode" value="runner" checked={values.keyMode === 'runner'} />
              <span>
                <strong>Clé du runner.</strong> La machine a sa propre clé (PROVIDER_API_KEY), et le service n’envoie
                jamais la sienne.
              </span>
            </label>
            <label class="choice">
              <input type="radio" name="keyMode" value="app" checked={values.keyMode === 'app'} />
              <span>
                <strong>Clé du service.</strong> Le runner est de confiance et reçoit la clé du service avec chaque job.
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
