import type { Handle } from 'remix/component'

import { levelCost } from '@kento-review/engine/levels'
import { LEVELS, type Level } from '@kento-review/protocol'

import { mention } from '../instance.ts'
import type { AppStatus } from '../org-settings/app-status.ts'
import { capAlerts, capReached, checkPermissions, missingEvents, REQUIRED_EVENTS, type CapPeriod } from '../org-settings/model.ts'
import { resetWhen } from '../org-settings/notice.ts'
import type { DeliveryView, OrgSettingsView } from '../org-settings/store.ts'
import { kentoDefaults, SERVICE_PROVIDER, type ConfigField, type LevelModels } from '../repo-config/model.ts'
import { effectiveLevel, type EffectiveLevel } from '../repo-config/effective.ts'
import type { ProviderOption } from '../repo-config/providers.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Button, Choice, Input, Select, Textarea, buttonClass } from './controls.tsx'
import { EffectiveLine } from './effective.tsx'
import { FormErrors, firstInvalid, focusIf, radioFocus } from './form-errors.tsx'
import { describedBy, FieldMessage, ResetForm, VersionFields, versionLine } from './form-fields.tsx'
import { agoOrDate, moneyInput, plural, usd, when } from './format.ts'
import { AlertIcon, CheckIcon } from './icons.tsx'
import { appStatusReason, deliveryReason, reasonSentence, TechDetails } from './reasons.tsx'

/** The forms of the section, each one a `field` of `POST /settings/org`. */
export const ORG_FIELDS = ['caps', 'trustedBots', 'level', 'models.lite', 'models.balanced', 'models.heavy'] as const
export type OrgField = (typeof ORG_FIELDS)[number]
/** The defaults that "Back to the Kentō value" removes from the config of the org. */
export const ORG_RESET_FIELDS = ['level', 'models.lite', 'models.balanced', 'models.heavy'] as const satisfies readonly ConfigField[]

/** Where the page goes back after a form: the anchor of its section. */
export function anchorOf(field: OrgField): string {
  if (field === 'caps') return 'cap'
  if (field === 'trustedBots') return 'bots'
  return 'defaults'
}

export type OrgNotice =
  | { kind: 'saved' | 'reset'; version: number }
  | { kind: 'conflict'; version: number; updatedBy: string | null; updatedAt: Date | null }

export interface OrgForm {
  field: OrgField
  values: Record<string, string>
  errors: Record<string, string>
}

export interface OrgSectionProps {
  view: OrgSettingsView
  /** What GitHub says about the App. Null: the service has no GitHub App configured. */
  app: { ok: true; status: AppStatus } | { ok: false; error: string } | null
  /** The providers that a level can use (REV-11 and REV-12). */
  providers: ProviderOption[]
  /** The URL that the webhook of the App must post to: `<public URL>/webhooks/github`. */
  webhookUrl: string | null
  /** GITHUB_WEBHOOK_SECRET is set: each delivery is checked with it. */
  webhookSecret: boolean
  version: string
  commit: string | null
  now: Date
  notice: OrgNotice | null
  form: OrgForm | null
}

const LEVEL_HINTS: Record<Level, string> = {
  lite: `Fast and the cheapest, ${levelCost('lite')} per review.`,
  balanced: `Also reads the code around the change, ${levelCost('balanced')}.`,
  heavy: `Reasons for longer, ${levelCost('heavy')}.`,
}

const PERMISSION_LABELS: Record<string, string> = {
  contents: 'Contents',
  pull_requests: 'Pull requests',
  issues: 'Issues',
  checks: 'Checks',
  members: 'Members (organization)',
  metadata: 'Metadata',
}
const ACCESS: Record<'read' | 'write', string> = { read: 'read', write: 'write' }

/** "settings v3, changed by octocat on 29 Oct at 15:02". */
export function orgVersionLine(view: Pick<OrgSettingsView, 'version' | 'updatedBy' | 'updatedAt'>): string {
  return versionLine({ name: 'settings', changed: 'changed', empty: 'settings v0, the values of Kentō' }, view)
}

const PERIOD_TEXT: Record<CapPeriod, string> = { day: 'Daily', month: 'Monthly' }

/**
 * The settings of the org (REV-13), above "Providers and keys": the cost limit, the defaults that
 * the repositories inherit, the trusted bots, and the state of the GitHub App. An admin edits; a
 * member reads everything.
 */
/**
 * KNT-168. At the end of a section on a phone: back to the bar "Sections" at the top of the page,
 * which opens the list (settings.js). Hidden where the sidebar stays in view. Without JavaScript the
 * link leads to the list, which is part of the page.
 */
export function SectionsLink(handle: Handle<{ section: string }>) {
  return () => (
    <p class="settings-back">
      <a href="#settings-nav" data-settings-back={handle.props.section}>
        Sections
      </a>
    </p>
  )
}

export function OrgSettingsSections(handle: Handle<OrgSectionProps & { admin: boolean; csrf: string; back: boolean }>) {
  return () => {
    let props = handle.props
    let { view, now, notice, admin } = props
    let spent = { dayUsd: view.costs.dayUsd, monthUsd: view.costs.monthUsd }
    let hit = capReached(view.caps, spent, now)
    let alerts = hit ? [] : capAlerts(view.caps, spent)
    return (
      <>
        {hit ? (
          <div class="banner banner-alert" role="alert">
            <AlertIcon />
            <p>
              <strong>
                {PERIOD_TEXT[hit.period]} cap reached, {usd(hit.spentUsd)} of {usd(hit.capUsd)}.
              </strong>{' '}
              No new job starts. The jobs in progress finish, and the reviews start again {resetWhen(hit.resetsAt)}.{' '}
              {admin ? <a href="#cap">Raise the cap</a> : 'An admin of the organization can raise it.'}
            </p>
          </div>
        ) : null}
        {alerts.map((period) => (
          <div class="banner banner-info" role="status">
            <AlertIcon />
            <p>
              <strong>{PERIOD_TEXT[period]} alert threshold reached</strong>, {usd(period === 'day' ? spent.dayUsd : spent.monthUsd)} of{' '}
              {usd((period === 'day' ? view.caps.dailyCapUsd : view.caps.monthlyCapUsd)!)} ({view.caps.alertPct}%).
            </p>
          </div>
        ))}
        {notice ? <Notice notice={notice} /> : null}
        <div class="org-settings">
          <CapSection {...props} />
          {props.back ? <SectionsLink section="cap" /> : null}
          <DefaultsSection {...props} />
          {props.back ? <SectionsLink section="defaults" /> : null}
          <BotsSection {...props} />
          {props.back ? <SectionsLink section="bots" /> : null}
          <AppSection {...props} />
          {props.back ? <SectionsLink section="app" /> : null}
        </div>
      </>
    )
  }
}

type SectionProps = OrgSectionProps & { admin: boolean; csrf: string }

/** One cost against its limit: the words carry it, the bar only repeats it. */
function Gauge(handle: Handle<{ label: string; spent: number; cap: number | null; alertPct: number }>) {
  return () => {
    let { label, spent, cap, alertPct } = handle.props
    let pct = cap === null ? null : cap === 0 ? 100 : Math.min(100, Math.round((spent / cap) * 100))
    let tone = pct === null ? 'idle' : pct >= 100 ? 'alert' : pct >= alertPct ? 'warn' : 'ok'
    return (
      <div class="gauge">
        <dt>{label}</dt>
        <dd>
          <span class="gauge-value">
            <strong>{usd(spent)}</strong> {cap === null ? 'no cap' : `of ${usd(cap)} (${pct}%)`}
          </span>
          {pct === null ? null : (
            <span class={`gauge-bar gauge-${tone}`} aria-hidden="true">
              <span class={`gauge-fill gauge-w${Math.round(pct / 5) * 5}`} />
            </span>
          )}
        </dd>
      </div>
    )
  }
}

/**
 * REV-27. The next job of each level of the org: the config of the org, else the "Default"
 * provider. A repository may choose another one in its Config.
 */
export function orgEffectiveLevels(view: Pick<OrgSettingsView, 'config'>, providers: readonly ProviderOption[]): Record<Level, EffectiveLevel> {
  let kento = kentoDefaults()
  let out = {} as Record<Level, EffectiveLevel>
  for (let level of LEVELS) {
    let set = view.config.models?.[level]
    out[level] = effectiveLevel(level, set ? { value: set, source: 'org' } : { value: kento.models[level], source: 'kento' }, providers)
  }
  return out
}

/** A level of the org runs on the OpenRouter key that the service holds. */
function usesServiceKey(props: Pick<OrgSectionProps, 'view' | 'providers'>): boolean {
  return Object.values(orgEffectiveLevels(props.view, props.providers)).some((e) => e.provider.id === SERVICE_PROVIDER && e.provider.serviceHoldsKey)
}

function CapSection(handle: Handle<SectionProps>) {
  return () => {
    let { view, admin, csrf, form } = handle.props
    let mine = form?.field === 'caps' ? form : null
    let errors = mine?.errors ?? {}
    let first = firstInvalid(errors, ['dailyCapUsd', 'monthlyCapUsd', 'alertPct'])
    let values = mine?.values ?? {
      dailyCapUsd: moneyInput(view.caps.dailyCapUsd),
      monthlyCapUsd: moneyInput(view.caps.monthlyCapUsd),
      alertPct: String(view.caps.alertPct),
    }
    return (
      <section class="card config-card" id="cap" aria-labelledby="cap-title" tabIndex={-1}>
        <header class="config-card-head">
          <h2 class="section-title" id="cap-title">
            Cost cap
          </h2>
        </header>
        {admin ? <p class="hint">Leave a field empty for no cap.</p> : null}
        <dl class="config-facts cap-facts">
          <Gauge label="Today (UTC)" spent={view.costs.dayUsd} cap={view.caps.dailyCapUsd} alertPct={view.caps.alertPct} />
          <Gauge label="This month (UTC)" spent={view.costs.monthUsd} cap={view.caps.monthlyCapUsd} alertPct={view.caps.alertPct} />
          <div>
            <dt>Cost of the day per provider</dt>
            <dd>
              {view.costs.dayByProvider.length === 0 ? (
                'No paid review today.'
              ) : (
                <ul class="cost-list">
                  {view.costs.dayByProvider.map((p) => (
                    <li>
                      <span>{p.label}</span> <strong>{usd(p.usd)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
        <p class="hint">
          At the cap, no new job enters the queue. A push gets the check "Kentō · cap", and a command gets an answer. The
          jobs already in the queue or in progress finish.
          {usesServiceKey(handle.props) ? ' The OpenRouter key of the service also has its own limit of $10 per day, for the levels that use it.' : null}
        </p>
        {admin ? (
          <form method="post" action={routes.orgSettingsSave.href()} noValidate>
            <VersionFields csrf={csrf} version={view.version} field="caps" />
            <FormErrors errors={errors} />
            {/* REV-91: the three limits on one line, each with a short hint. */}
            <div class="cap-fields">
              <div class="field">
                <label class="label" for="cap-day">
                  Daily cap ($)
                </label>
                <Input
                  class="config-cap"
                  id="cap-day"
                  name="dailyCapUsd"
                  value={values.dailyCapUsd ?? ''}
                  inputMode="decimal"
                  autoComplete="off"
                  {...focusIf(first, 'dailyCapUsd')}
                  aria-invalid={errors.dailyCapUsd ? 'true' : undefined}
                  aria-describedby={describedBy('cap-day', errors.dailyCapUsd, true)}
                />
                <FieldMessage id="cap-day" error={errors.dailyCapUsd} hint="Set back to zero at midnight UTC." />
              </div>
              <div class="field">
                <label class="label" for="cap-month">
                  Monthly cap ($)
                </label>
                <Input
                  class="config-cap"
                  id="cap-month"
                  name="monthlyCapUsd"
                  value={values.monthlyCapUsd ?? ''}
                  inputMode="decimal"
                  autoComplete="off"
                  {...focusIf(first, 'monthlyCapUsd')}
                  aria-invalid={errors.monthlyCapUsd ? 'true' : undefined}
                  aria-describedby={describedBy('cap-month', errors.monthlyCapUsd, true)}
                />
                <FieldMessage id="cap-month" error={errors.monthlyCapUsd} hint="Calendar month, in UTC." />
              </div>
              <div class="field">
                <label class="label" for="cap-alert">
                  Alert threshold (%)
                </label>
                <Input
                  class="config-cap"
                  id="cap-alert"
                  name="alertPct"
                  value={values.alertPct ?? ''}
                  inputMode="numeric"
                  autoComplete="off"
                  {...focusIf(first, 'alertPct')}
                  aria-invalid={errors.alertPct ? 'true' : undefined}
                  aria-describedby={describedBy('cap-alert', errors.alertPct, true)}
                />
                <FieldMessage id="cap-alert" error={errors.alertPct} hint="Warns before the cap." />
              </div>
            </div>
            <Button variant="primary" type="submit">
              Save the cap
            </Button>
          </form>
        ) : (
          <p>
            {view.caps.dailyCapUsd === null ? 'No daily cap' : `${usd(view.caps.dailyCapUsd)} per day`},{' '}
            {view.caps.monthlyCapUsd === null ? 'no monthly cap' : `${usd(view.caps.monthlyCapUsd)} per month`}, alert at{' '}
            {view.caps.alertPct}%.
          </p>
        )}
      </section>
    )
  }
}

function DefaultsSection(handle: Handle<SectionProps>) {
  return () => {
    let { view, admin, csrf, form, providers } = handle.props
    let kento = kentoDefaults()
    let level = view.config.level ?? kento.level
    let mine = form?.field === 'level' ? form : null
    let selected = mine?.values.defaultLevel ?? level
    return (
      <section class="card config-card org-defaults" id="defaults" aria-labelledby="defaults-title" tabIndex={-1}>
        <header class="config-card-head">
          <h2 class="section-title" id="defaults-title">
            Default values
          </h2>
        </header>
        <p class="hint">
          Each repo takes them in its Config, and can replace them. A repo that replaced a value keeps its own value.
        </p>
        <div class="org-default" id="org-level" tabIndex={-1}>
          <div class="config-card-head">
            <h3 class="org-default-title">Level of a push</h3>
            <OrgSource set={view.config.level !== undefined} />
          </div>
          {admin ? (
            <>
              <form method="post" action={routes.orgSettingsSave.href()}>
                <VersionFields csrf={csrf} version={view.version} field="level" />
                <FormErrors errors={mine?.errors ?? {}} />
                <fieldset class="field" aria-describedby={mine?.errors.defaultLevel ? 'org-level-error' : undefined}>
                  <legend class="visually-hidden">Level of a push</legend>
                  {LEVELS.map((key) => (
                    <Choice
                      type="radio"
                      name="defaultLevel"
                      value={key}
                      checked={key === selected}
                      autoFocus={mine?.errors.defaultLevel && key === radioFocus(selected, LEVELS) ? true : undefined}
                      label={
                        <>
                          <strong class="mono">{key}</strong>. {LEVEL_HINTS[key]}
                        </>
                      }
                    />
                  ))}
                  {mine?.errors.defaultLevel ? (
                    <p class="field-error" id="org-level-error">
                      {mine.errors.defaultLevel}
                    </p>
                  ) : null}
                </fieldset>
                {/* A row of the section: a secondary button (REV-29, one primary action per section at most). */}
                <Button type="submit">
                  Save the level
                </Button>
              </form>
              {view.config.level !== undefined ? <OrgReset csrf={csrf} version={view.version} field="level" label="the level" /> : null}
            </>
          ) : (
            <p>
              <strong class="mono">{level}</strong>. {LEVEL_HINTS[level]}
            </p>
          )}
        </div>
        {LEVELS.map((key) => (
          <LevelDefault
            level={key}
            value={view.config.models?.[key] ?? kento.models[key]}
            set={view.config.models?.[key] !== undefined}
            effective={orgEffectiveLevels(view, providers)[key]}
            providers={providers}
            admin={admin}
            csrf={csrf}
            version={view.version}
            form={form?.field === `models.${key}` ? form : null}
          />
        ))}
      </section>
    )
  }
}

/** "set for the org" or "value of Kentō". The word carries the meaning. */
function OrgSource(handle: Handle<{ set: boolean }>) {
  return () => (handle.props.set ? <span class="tag tag-info">set for the org</span> : <span class="tag tag-quiet">value of Kentō</span>)
}

function OrgReset(handle: Handle<{ csrf: string; version: number; field: OrgField; label: string }>) {
  return () => <ResetForm action={routes.orgSettingsReset.href()} to="Kentō" {...handle.props} />
}

function LevelDefault(
  handle: Handle<{
    level: Level
    value: LevelModels
    set: boolean
    effective: EffectiveLevel
    providers: ProviderOption[]
    admin: boolean
    csrf: string
    version: number
    form: OrgForm | null
  }>,
) {
  return () => {
    let { level, value, set, effective, providers, admin, csrf, version, form } = handle.props
    let errors = form?.errors ?? {}
    let first = firstInvalid(errors, ['provider', 'model', 'fallback'])
    // A level without a choice shows what runs today: the "Default" provider and its models.
    let shown = set ? value : { provider: effective.provider.id, model: effective.model ?? '', fallback: effective.fallback }
    let values = form?.values ?? { provider: shown.provider, model: shown.model, fallback: shown.fallback ?? '' }
    let id = `org-${level}`
    let selected = values.provider ?? ''
    return (
      <div class="org-default" id={id} tabIndex={-1}>
        <div class="config-card-head">
          <h3 class="org-default-title mono">{level}</h3>
          <OrgSource set={set} />
        </div>
        <EffectiveLine effective={effective} scope="org" source={set ? 'org' : 'kento'} />
        {admin ? (
          <>
            <form method="post" action={routes.orgSettingsSave.href()} noValidate>
              <VersionFields csrf={csrf} version={version} field={`models.${level}`} />
              <FormErrors errors={errors} />
              <div class="org-default-fields">
                <div class="field">
                  <label class="label" for={`${id}-provider`}>
                    Provider
                  </label>
                  <Select
                    id={`${id}-provider`}
                    name="provider"
                    {...focusIf(first, 'provider')}
                    aria-invalid={errors.provider ? 'true' : undefined}
                    aria-describedby={describedBy(`${id}-provider`, errors.provider, providers.some((p) => p.id === selected))}
                  >
                    {providers.map((p) => (
                      <option value={p.id} selected={p.id === selected}>
                        {p.label}
                      </option>
                    ))}
                    {selected && !providers.some((p) => p.id === selected) ? (
                      <option value={selected} selected>
                        {selected} (not available)
                      </option>
                    ) : null}
                  </Select>
                  <FieldMessage id={`${id}-provider`} error={errors.provider} hint={providers.find((p) => p.id === selected)?.hint} />
                </div>
                <div class="field">
                  <label class="label" for={`${id}-model`}>
                    Model
                  </label>
                  <Input
                    class="mono"
                    id={`${id}-model`}
                    name="model"
                    value={values.model ?? ''}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    {...focusIf(first, 'model')}
                    aria-invalid={errors.model ? 'true' : undefined}
                    aria-describedby={describedBy(`${id}-model`, errors.model, false)}
                  />
                  <FieldMessage id={`${id}-model`} error={errors.model} />
                </div>
                <div class="field">
                  <label class="label" for={`${id}-fallback`}>
                    Fallback
                  </label>
                  <Input
                    class="mono"
                    id={`${id}-fallback`}
                    name="fallback"
                    value={values.fallback ?? ''}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    {...focusIf(first, 'fallback')}
                    aria-invalid={errors.fallback ? 'true' : undefined}
                    aria-describedby={describedBy(`${id}-fallback`, errors.fallback, true)}
                  />
                  <FieldMessage id={`${id}-fallback`} error={errors.fallback} hint="Leave it empty for no fallback." />
                </div>
              </div>
              {set ? null : (
                <p class="hint">
                  "Save" fixes this choice for the organization, and the level no longer follows the "Default" provider.
                </p>
              )}
              <Button type="submit">
                Save<span class="visually-hidden"> the model {level}</span>
              </Button>
            </form>
            {set ? <OrgReset csrf={csrf} version={version} field={`models.${level}`} label={level} /> : null}
          </>
        ) : null}
      </div>
    )
  }
}

function BotsSection(handle: Handle<SectionProps>) {
  return () => {
    let { view, admin, csrf, form } = handle.props
    let mine = form?.field === 'trustedBots' ? form : null
    let value = mine?.values.trustedBots ?? view.trustedBots.join('\n')
    return (
      <section class="card config-card" id="bots" aria-labelledby="bots-title" tabIndex={-1}>
        <header class="config-card-head">
          <h2 class="section-title" id="bots-title">
            Trusted bots <span class="count">{view.trustedBots.length}</span>
          </h2>
        </header>
        <p class="hint">
          The PRs, the pushes and the <span class="mono">{mention()}</span> commands of these bots count as those of a person with write
          access. Kentō ignores every other bot.
        </p>
        {view.trustedBots.length === 0 ? (
          <p>No trusted bot.</p>
        ) : (
          <ul class="bot-list">
            {view.trustedBots.map((bot) => (
              <li class="mono">{bot}</li>
            ))}
          </ul>
        )}
        {admin ? (
          <form method="post" action={routes.orgSettingsSave.href()} noValidate>
            <VersionFields csrf={csrf} version={view.version} field="trustedBots" />
            <FormErrors errors={mine?.errors ?? {}} />
            <div class="field">
              <label class="label" for="trusted-bots">
                One login per line
              </label>
              <Textarea
                class="mono config-paths"
                id="trusted-bots"
                name="trustedBots"
                rows={4}
                spellCheck={false}
                autoFocus={mine?.errors.trustedBots ? true : undefined}
                aria-invalid={mine?.errors.trustedBots ? 'true' : undefined}
                aria-describedby={describedBy('trusted-bots', mine?.errors.trustedBots, true)}
                value={value}
              ></Textarea>
              <FieldMessage id="trusted-bots" error={mine?.errors.trustedBots} hint={'For example renovate[bot]. Kentō adds "[bot]" if it is missing.'} />
            </div>
            <Button variant="primary" type="submit">
              Save the bots
            </Button>
          </form>
        ) : null}
      </section>
    )
  }
}

function deliveryText(delivery: DeliveryView): string {
  return `${delivery.event}${delivery.action ? `.${delivery.action}` : ''} · ${delivery.status} ${delivery.outcome}`
}

function DeliveryLine(handle: Handle<{ delivery: DeliveryView | null; now: Date }>) {
  return () => {
    let { delivery, now } = handle.props
    if (!delivery) return <>None in the last 30 days.</>
    let reason = deliveryReason(delivery)
    return (
      <>
        <span class="mono">{deliveryText(delivery)}</span>{' '}
        <time dateTime={delivery.receivedAt.toISOString()} title={when(delivery.receivedAt)}>
          {agoOrDate(delivery.receivedAt, now)}
        </time>
        {reason ? <span class="hint delivery-reason">{reasonSentence(reason)}</span> : null}
        <TechDetails raw={reason?.raw ?? null} />
      </>
    )
  }
}

function AppSection(handle: Handle<SectionProps>) {
  return () => {
    let { view, app, webhookUrl, webhookSecret, version, commit, now } = handle.props
    let status = app?.ok ? app.status : null
    let appError = app && !app.ok ? appStatusReason(app.error) : null
    let permissions = status ? checkPermissions(status.installation.permissions) : []
    let missing = status ? missingEvents(status.installation.events) : []
    let urlMismatch = status?.webhook && webhookUrl ? status.webhook.url !== webhookUrl : false
    let suspended = view.suspendedAt ?? status?.installation.suspendedAt ?? null
    let sslOff = status?.webhook ? !status.webhook.sslVerified : false
    let problems = permissions.filter((p) => !p.ok).length + missing.length + (urlMismatch ? 1 : 0) + (sslOff ? 1 : 0) + (suspended ? 1 : 0)
    return (
      <section class="card config-card app-status" id="app" aria-labelledby="app-title" tabIndex={-1}>
        <header class="config-card-head">
          <h2 class="section-title" id="app-title">
            GitHub App
          </h2>
          {status ? (
            problems === 0 ? (
              <span class="status status-online">
                <CheckIcon /> Everything is in place
              </span>
            ) : (
              <span class="status status-alert">
                <AlertIcon /> {problems} {plural(problems, 'item')} to fix
              </span>
            )
          ) : (
            <span class="status status-stale">GitHub state unknown</span>
          )}
        </header>
        {appError ? (
          <div class="hint" role="note">
            <p>{reasonSentence(appError)}</p>
            <TechDetails raw={appError.raw} />
          </div>
        ) : null}
        {!app ? (
          <p class="hint" role="note">
            The service has no GitHub App (<span class="mono">GITHUB_APP_ID</span>). It reads neither its permissions nor its webhook.
          </p>
        ) : null}
        <dl class="config-facts">
          {/* KNT-149: the ids of the parts are the links under "GitHub App" in the sidebar. */}
          <div id="app-installation" tabIndex={-1}>
            <dt>Installation</dt>
            <dd>
              {status ? (
                <a href={status.installation.htmlUrl}>
                  {view.login} · no. {view.githubInstallationId}
                </a>
              ) : (
                <>
                  {view.login} · no. {view.githubInstallationId}
                </>
              )}
              {suspended ? <span class="tag tag-alert">suspended</span> : null} · {view.repos.total} visible {plural(view.repos.total, 'repo')}
              {status ? (status.installation.repositorySelection === 'all' ? ' (all)' : ' (chosen)') : ''}, {view.repos.enabled} enabled
            </dd>
          </div>
          <div id="app-webhook" tabIndex={-1}>
            <dt>Webhook URL</dt>
            <dd>
              <span class="mono">{status?.webhook?.url ?? webhookUrl ?? 'unknown'}</span>
              {urlMismatch ? (
                <span class="field-error">
                  Kentō expects <span class="mono">{webhookUrl}</span>
                </span>
              ) : null}
              {status?.webhook && !status.webhook.sslVerified ? <span class="tag tag-alert">SSL not verified</span> : null}
            </dd>
          </div>
          <div>
            <dt>Signature</dt>
            <dd>
              {webhookSecret
                ? 'Checked on each delivery (X-Hub-Signature-256). A delivery with a wrong signature gets 401, and Kentō does not keep it.'
                : 'Not configured (GITHUB_WEBHOOK_SECRET), and the webhook answers 503.'}
            </dd>
          </div>
          <div id="app-deliveries" tabIndex={-1}>
            <dt>Last event</dt>
            <dd>
              <DeliveryLine delivery={view.deliveries.last} now={now} />
            </dd>
          </div>
          <div>
            <dt>Last push or PR</dt>
            <dd>
              <DeliveryLine delivery={view.deliveries.lastPullRequest} now={now} />
            </dd>
          </div>
          <div>
            <dt>Failures in 24 h</dt>
            <dd>
              <strong>{view.deliveries.failures24h}</strong> of {view.deliveries.total24h} {plural(view.deliveries.total24h, 'delivery', 'deliveries')}
              {view.deliveries.lastFailure ? (
                <>
                  <span class="hint"> · last failure </span>
                  <DeliveryLine delivery={view.deliveries.lastFailure} now={now} />
                </>
              ) : null}
            </dd>
          </div>
          {status ? (
            <div id="app-permissions" tabIndex={-1}>
              <dt>Permissions</dt>
              <dd>
                <ul class="permission-list">
                  {permissions.map((p) => (
                    <li>
                      {p.ok ? <CheckIcon /> : <AlertIcon />} {PERMISSION_LABELS[p.name] ?? p.name}: {ACCESS[p.needed]}
                      {p.ok ? null : <span class="field-error">, granted: {p.granted ? ACCESS[p.granted] : 'nothing'}</span>}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {status ? (
            <div>
              <dt>Events</dt>
              <dd>
                {REQUIRED_EVENTS.map((event) => (
                  <span class={`tag ${missing.includes(event) ? 'tag-alert' : 'tag-ok'}`}>
                    {event}
                    {missing.includes(event) ? ': not subscribed' : ''}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Service</dt>
            <dd>
              Dokploy, project Kentō, application <span class="mono">web</span> · version <span class="mono">{version}</span>
              {commit ? (
                <>
                  {' '}
                  · commit <span class="mono">{commit.slice(0, 9)}</span>
                </>
              ) : null}
            </dd>
          </div>
        </dl>
        {status ? (
          <p>
            <a class={buttonClass()} href={status.deliveriesUrl}>
              Redeliver from the page of the App
            </a>{' '}
            <span class="hint">Open "Recent Deliveries", choose a delivery, then "Redeliver".</span>
          </p>
        ) : null}
      </section>
    )
  }
}

function Notice(handle: Handle<{ notice: OrgNotice }>) {
  return () => {
    let { notice } = handle.props
    if (notice.kind === 'conflict') {
      let by = notice.updatedBy ? ` by ${notice.updatedBy}` : ''
      let at = notice.updatedAt ? ` ${when(notice.updatedAt)}` : ''
      return (
        <div class="banner banner-alert" role="alert">
          <AlertIcon />
          <p>
            <strong>The settings changed in the meantime</strong> (v{notice.version}, changed{by}
            {at}). Nothing was saved. Read the values below again, then try again.
          </p>
        </div>
      )
    }
    return (
      <div class="banner banner-ok" role="status">
        <CheckIcon />
        <p>
          <strong>{notice.kind === 'saved' ? 'Settings saved' : 'Value of Kentō restored'}</strong> (v{notice.version}). The
          next job applies them. A job already in the queue keeps its own values.
        </p>
      </div>
    )
  }
}
