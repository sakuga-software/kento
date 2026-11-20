import type { Handle } from 'remix/component'

import { CLAIM_WAIT_SECONDS, HEARTBEAT_SECONDS, LEASE_SECONDS, MAX_ATTEMPTS, MAX_BODY_BYTES, RUNNER_TOKEN_PREFIX } from '@sakuga-review/protocol'

import { instance } from '../instance.ts'
import { OFFLINE_SECONDS, ONLINE_SECONDS, REGISTRATION_TTL_MINUTES, SILENT_HOURS, type RegistrationView, type RunnersScreen, type RunnerView } from '../runner/admin.ts'
import { RETRY_BACKOFF_SECONDS } from '../runner/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { Button, Choice, Input, buttonClass } from './controls.tsx'
import { agoShort, clock, elapsed, hour } from './format.ts'
import { Shell, type PageFrame } from './shell.tsx'

// The dashboard store counts the runners by state in SQL with the same limits (REV-37).
export { OFFLINE_SECONDS, ONLINE_SECONDS } from '../runner/admin.ts'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

const NAME = /^[A-Za-z0-9._-]{1,100}$/
const LABEL = /^[A-Za-z0-9._-]{1,64}$/

/** The form "New runner", as typed, and what is wrong with it. */
export interface RegistrationForm {
  name: string
  labels: string
  keyMode: 'app' | 'runner'
}

export type RegistrationInput = { name: string; labels: string[]; trusted: boolean }

/** Checks the form "New runner". Returns the input, or a message per field. */
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
  if (!NAME.test(name)) errors.name = 'Letters, digits, dots, hyphens or underscores, 100 at most.'
  let labels = [...new Set(labelsText.split(/[\s,]+/).filter(Boolean))]
  if (labels.length > 20 || labels.some((label) => !LABEL.test(label))) {
    errors.labels = '20 labels at most, separated by commas. Each one has letters, digits, dots, hyphens or underscores.'
  }
  if (keyModeValue !== 'app' && keyModeValue !== 'runner') errors.keyMode = 'Choose where the key of the model is.'
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
    ...(input.trusted ? [] : ['-e PROVIDER_API_KEY=<your OpenRouter key>']),
    '-v kento-runner-state:/var/lib/kento-runner',
    '--tmpfs /tmp:rw,size=2g --read-only --cap-drop ALL --security-opt no-new-privileges',
    `${instance().runnerImage}:${input.version}`,
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
  revoked: 'Revoked',
  online: 'Online',
  late: 'Late signal',
  offline: 'Offline',
}

/** "Online", "Late signal", "Offline for 3 d": the word of the state of a runner. */
export function runnerStateLabel(runner: Pick<RunnerView, 'revokedAt' | 'lastSeenAt'>, now: Date): string {
  let state = runnerState(runner, now)
  if (state === 'offline' && runner.lastSeenAt) return `Offline for ${elapsed(runner.lastSeenAt, now)}`
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

/** "1 online · 1 late · 27 offline": the runners in service by state, the empty states left out. */
export function stateCounts(runners: Pick<RunnerView, 'revokedAt' | 'lastSeenAt'>[], now: Date): string {
  let counts = { online: 0, late: 0, offline: 0 }
  for (let runner of runners) {
    let state = runnerState(runner, now)
    if (state !== 'revoked') counts[state]++
  }
  return countsText(counts)
}

/** "1 online · 27 offline", from counts by state. */
export function countsText(counts: { online: number; late: number; offline: number }): string {
  let parts = [
    counts.online > 0 ? `${counts.online} online` : null,
    counts.late > 0 ? `${counts.late} late` : null,
    counts.offline > 0 ? `${counts.offline} offline` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'none in service'
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
  revoked: 'Runner revoked. Its token no longer works, and its job in progress went back to the queue.',
  trusted: 'The runner now gets the keys that Kentō stores for the providers of the org.',
  untrusted: 'The runner no longer gets the keys that Kentō stores.',
  discarded: 'Registration token cancelled.',
  missing: 'Nothing changed. Someone changed or deleted this runner or this token after the page loaded. Read its state below, then do the action again if necessary.',
  revoked_silent: 'Silent runners revoked. Their tokens no longer work, and their jobs in progress went back to the queue.',
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
        lead="The machines that do the reviews."
        actions={
          <a class={buttonClass('primary')} href="#new-runner">
            New runner
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
              Waiting tokens
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
              <p>No runner. Create a token with "New runner", then run the command on the machine.</p>
            </div>
          ) : active.length === 0 ? (
            <p class="hint">No runner called in the last {SILENT_HOURS} h.</p>
          ) : (
            <RunnersTable runners={active} now={screen.now} version={version} admin={admin} csrf={csrf} caption="Runners in service" />
          )}
          {silent.length > 0 ? (
            <details class="runner-silent">
              <summary>
                {silent.length} {silent.length === 1 ? `runner silent for more than ${SILENT_HOURS} h` : `runners silent for more than ${SILENT_HOURS} h`}
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
                      trigger={silentOfOrg.length > 1 ? `Revoke these ${silentOfOrg.length} runners…` : 'Revoke this runner…'}
                      action={routes.runnersRevokeSilent.href()}
                      csrf={null}
                      form="revoke-silent"
                      submit={silentOfOrg.length > 1 ? `Revoke ${silentOfOrg.length} runners` : `Revoke ${silentOfOrg[0]!.name}`}
                    >
                      <p>
                        Their tokens stop working, and a job that they still hold goes back to the queue. A runner that
                        called after the page loaded stays in service. To put one of them back in service, you need
                        a new token.
                      </p>
                    </Confirm>
                  </div>
                ) : null}
                <RunnersTable runners={silent} now={screen.now} version={version} admin={admin} csrf={csrf} caption={`Runners silent for more than ${SILENT_HOURS} h`} />
              </div>
            </details>
          ) : null}
        </section>

        {revoked.length > 0 ? (
          <section class="runner-section" aria-labelledby="revoked-title">
            <h2 id="revoked-title" class="section-title">
              Revoked <span class="count">{revoked.length}</span>
            </h2>
            <RunnersTable runners={revoked} now={screen.now} version={version} admin={false} csrf={csrf} caption="Revoked runners" />
          </section>
        ) : null}

        <details class="runner-details">
          <summary>Technical details</summary>
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
          Token of {created.name}
        </h2>
        <div class="banner banner-alert" role="status">
          <p>
            <strong>Copy it now.</strong> The screen does not show it again. It works once, until{' '}
            <time dateTime={created.expiresAt.toISOString()}>{hour(created.expiresAt)}</time>.
          </p>
        </div>
        <p class="hint">
          Run this command on the machine of the runner. The runner shows here when it registers.
          {created.trusted ? null : ' Put your OpenRouter key in place of <your OpenRouter key>.'}
        </p>
        <div class="copy-block">
          <label class="label" for="docker-command">
            docker run command
          </label>
          <textarea id="docker-command" class="mono command" readOnly rows={command.split('\n').length} spellCheck={false} value={command}></textarea>
          <Button type="button" data-copy="docker-command" hidden>
            Copy the command
          </Button>
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
          <span class={`status ${expired ? 'status-alert' : 'status-wait'}`}>{expired ? 'Token expired' : 'Waiting for the runner'}</span>
        </div>
        <Labels labels={registration.labels} />
        <p class="hint">
          {expired ? (
            <>
              The token expired at <time dateTime={registration.expiresAt.toISOString()}>{clock(registration.expiresAt)}</time>{' '}
              and no runner registered. Check that the container reaches {host} with outbound HTTPS, then
              create a new token.
            </>
          ) : (
            <>
              Valid until <time dateTime={registration.expiresAt.toISOString()}>{hour(registration.expiresAt)}</time>.{' '}
              {registration.trusted ? 'Keys stored in Kentō.' : 'Key on the runner.'}
            </>
          )}
        </p>
        {admin ? (
          <div class="runner-actions">
            <form method="post" action={routes.runnerRenew.href({ id: registration.id })}>
              <input type="hidden" name="_csrf" value={csrf} />
              <Button variant={expired ? 'primary' : 'outline'} type="submit">
                New token
              </Button>
            </form>
            <Confirm
              trigger="Cancel the token…"
              action={routes.runnerDiscard.href({ id: registration.id })}
              csrf={csrf}
              submit={`Cancel the token of ${registration.name}`}
            >
              <p>
                The token of <strong class="mono">{registration.name}</strong> stops working at once. No runner
                can register with it. To register this runner, you need a new token.
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
              <th scope="col">State</th>
              <th scope="col">Model key</th>
              <th scope="col">Version</th>
              <th scope="col">Last signal</th>
              <th scope="col">Job in progress</th>
              <th scope="col">Jobs in 24 h</th>
              {revoked ? <th scope="col">Revoked</th> : null}
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
            {service ? <span class="tag">Runner of the service</span> : null}
            <Labels labels={runner.labels} />
          </div>
        </th>
        <td data-label="State">
          <span class={`status status-${state}`}>{runnerStateLabel(runner, now)}</span>
        </td>
        <td data-label="Model key">{runner.trusted ? 'Keys stored in Kentō (trusted)' : 'Key on the runner'}</td>
        <td data-label="Version">
          <span class="stack">
            <span class="mono">{runner.version ?? '—'}</span>
            {newer ? <span class="status status-wait">{newer} available</span> : null}
          </span>
        </td>
        <td data-label="Last signal">
          {runner.lastSeenAt ? (
            <time dateTime={runner.lastSeenAt.toISOString()} title={clock(runner.lastSeenAt)}>
              {agoShort(runner.lastSeenAt, now)}
            </time>
          ) : (
            'never'
          )}
        </td>
        <td data-label="Job in progress">
          {runner.currentJob ? (
            <span class="stack">
              <span class="mono">
                {runner.currentJob.repo}#{runner.currentJob.prNumber}
              </span>
              <span class="hint">{runner.currentJob.kind === 'resolve' ? 'resolve' : 'review'}</span>
            </span>
          ) : (
            'none'
          )}
        </td>
        <td data-label="Jobs in 24 h" class="num">
          {runner.jobs24h}
        </td>
        {revokedColumn ? (
          <td data-label="Revoked">
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
                  <Button size="sm" type="submit">
                    {runner.trusted ? 'Remove the trust' : 'Mark as trusted'}
                    <span class="visually-hidden"> for {runner.name}</span>
                  </Button>
                </form>
                <Confirm trigger="Revoke…" action={routes.runnerRevoke.href({ id: runner.id })} csrf={csrf} submit={`Revoke ${runner.name}`}>
                  <p>
                    The token of <strong class="mono">{runner.name}</strong> stops working at its next call, and its
                    job in progress goes back to the queue for another runner. To put it back in service, you need a new
                    token.
                  </p>
                </Confirm>
              </div>
            ) : service && state !== 'revoked' ? (
              <span class="hint">managed by the operator</span>
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
    if (labels.length === 0) return <p class="labels labels-none">No label</p>
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
        Protocol
      </h2>
      <dl>
        <div>
          <dt>Image</dt>
          <dd class="mono">
            {instance().runnerImage}:{handle.props.version}
          </dd>
        </div>
        <div>
          <dt>Wait for a job</dt>
          <dd>{CLAIM_WAIT_SECONDS} s</dd>
        </div>
        <div>
          <dt>Signal during a job</dt>
          <dd>every {HEARTBEAT_SECONDS} s</dd>
        </div>
        <div>
          <dt>Largest request</dt>
          <dd>{Math.round(MAX_BODY_BYTES / 1000)} KB</dd>
        </div>
        <div>
          <dt>Runner token</dt>
          <dd>
            <span class="mono">{RUNNER_TOKEN_PREFIX}…</span>, only its hash is kept
          </dd>
        </div>
        <div>
          <dt>Registration token</dt>
          <dd>one use, {REGISTRATION_TTL_MINUTES} min</dd>
        </div>
      </dl>
    </section>
  )
}

function LeaseFacts(_handle: Handle<{}>) {
  return () => (
    <section class="card facts" aria-labelledby="lease-title">
      <h2 id="lease-title" class="section-title">
        Reservation and attempts
      </h2>
      <dl>
        <div>
          <dt>Reservation of a job</dt>
          <dd>{LEASE_SECONDS} s, extended at each signal of the runner</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{MAX_ATTEMPTS} at most per job</dd>
        </div>
        <div>
          <dt>Wait before a new attempt</dt>
          <dd>{RETRY_BACKOFF_SECONDS} s, then double</dd>
        </div>
        <div>
          <dt>Revoked runner</dt>
          <dd>its job goes back to the queue, with no attempt counted</dd>
        </div>
      </dl>
    </section>
  )
}

function NewRunnerForm(handle: Handle<{ csrf: string; form: RunnersPageProps['form'] }>) {
  return () => {
    let { csrf, form } = handle.props
    // The runner keeps its own key unless an admin chooses to trust it with the keys that Kentō stores.
    let values = form?.values ?? { name: '', labels: '', keyMode: 'runner' as const }
    let errors = form?.errors ?? {}
    return (
      <section class="card new-runner" id="new-runner" aria-labelledby="new-runner-title" tabIndex={-1}>
        <h2 id="new-runner-title" class="section-title">
          New runner
        </h2>
        <p class="hint">
          The token holds the name, the labels and the key, and the runner cannot change them. The token works
          once, for {REGISTRATION_TTL_MINUTES} min.
        </p>
        <form method="post" action={routes.runnerNew.href()} noValidate>
          <input type="hidden" name="_csrf" value={csrf} />
          <div class="field">
            <label class="label" for="runner-name">
              Name
            </label>
            <Input
              class="mono"
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
              <p class="description" id="runner-name-hint">
                For example runner-1.
              </p>
            )}
          </div>
          <div class="field">
            <label class="label" for="runner-labels">
              Labels
            </label>
            <Input
              class="mono"
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
              <p class="description" id="runner-labels-hint">
                Separated by commas. They show on the card of the runner.
              </p>
            )}
          </div>
          <fieldset class="field" aria-describedby={errors.keyMode ? 'runner-key-error' : undefined}>
            <legend class="label">Model key</legend>
            <Choice
              type="radio"
              name="keyMode"
              value="runner"
              checked={values.keyMode === 'runner'}
              label={
                <>
                  <strong>Key on the runner.</strong> The machine has its own key (PROVIDER_API_KEY), and the service never
                  sends its key.
                </>
              }
            />
            <Choice
              type="radio"
              name="keyMode"
              value="app"
              checked={values.keyMode === 'app'}
              label={
                <>
                  <strong>Keys stored in Kentō.</strong> The runner is trusted and gets, with each job, the key of the provider
                  that the org added in Settings. The OpenRouter key of the service stays on the runners of the service.
                </>
              }
            />
            {errors.keyMode ? (
              <p class="field-error" id="runner-key-error">
                {errors.keyMode}
              </p>
            ) : null}
          </fieldset>
          <Button variant="primary" type="submit">
            Create the token
          </Button>
        </form>
      </section>
    )
  }
}
