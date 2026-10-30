import type { Handle } from 'remix/component'

import { levelCost } from '@sakuga-review/engine/levels'
import type { Level } from '@sakuga-review/protocol'

import type { AppStatus } from '../org-settings/app-status.ts'
import { capAlerts, capReached, checkPermissions, missingEvents, REQUIRED_EVENTS, type CapPeriod } from '../org-settings/model.ts'
import { formatUsd, resetWhen } from '../org-settings/notice.ts'
import type { DeliveryView, OrgSettingsView } from '../org-settings/store.ts'
import { kentoDefaults, LEVEL_KEYS, SERVICE_PROVIDER, type ConfigField, type LevelModels } from '../repo-config/model.ts'
import { effectiveLevel, type EffectiveLevel } from '../repo-config/effective.ts'
import type { ProviderOption } from '../repo-config/providers.ts'
import { pageRoutes as routes } from '../routes.ts'
import { EffectiveLine } from './effective.tsx'
import { FormErrors, firstInvalid, focusIf, radioFocus } from './form-errors.tsx'
import { AlertIcon, CheckIcon } from './icons.tsx'
import { ago } from './runners.tsx'

/** The forms of the section, each one a `field` of `POST /settings/org`. */
export const ORG_FIELDS = ['caps', 'trustedBots', 'level', 'models.lite', 'models.balanced', 'models.heavy'] as const
export type OrgField = (typeof ORG_FIELDS)[number]
/** The defaults that « Revenir à Kentō » removes from the config of the org. */
export const ORG_RESET_FIELDS = ['level', 'models.lite', 'models.balanced', 'models.heavy'] as const satisfies readonly ConfigField[]

/** Where the page goes back after a form: the anchor of its section. */
export function anchorOf(field: OrgField): string {
  if (field === 'caps') return 'plafond'
  if (field === 'trustedBots') return 'bots'
  return 'defauts'
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
  lite: `Rapide, le moins cher : ${levelCost('lite')} une review.`,
  balanced: `Avec le code autour du changement : ${levelCost('balanced')}.`,
  heavy: `Plus de raisonnement : ${levelCost('heavy')}.`,
}

const PERMISSION_LABELS: Record<string, string> = {
  contents: 'Contents',
  pull_requests: 'Pull requests',
  issues: 'Issues',
  checks: 'Checks',
  members: 'Members (organisation)',
  metadata: 'Metadata',
}
const ACCESS: Record<'read' | 'write', string> = { read: 'lecture', write: 'écriture' }

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' })
const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })

function when(date: Date): string {
  return `le ${DATE.format(date)} à ${TIME.format(date)}`
}

/** « réglages v3, modifiés par alex le 29 oct. à 15:02 ». */
export function orgVersionLine(view: Pick<OrgSettingsView, 'version' | 'updatedBy' | 'updatedAt'>): string {
  if (view.version === 0) return 'réglages v0 : les valeurs de Kentō'
  let by = view.updatedBy ? ` par ${view.updatedBy}` : ''
  let at = view.updatedAt ? ` ${when(view.updatedAt)}` : ''
  return `réglages v${view.version}, modifiés${by}${at}`
}

/** « 3,42 $ » for the input of a limit: a comma, no symbol. */
function moneyInput(value: number | null): string {
  if (value === null) return ''
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',')
}

const PERIOD_TEXT: Record<CapPeriod, string> = { day: 'du jour', month: 'du mois' }

/**
 * The settings of the org (REV-13), above « Providers et clés »: the cost limit, the defaults that
 * the repositories inherit, the trusted bots, and the state of the GitHub App. An admin edits; a
 * member reads everything.
 */
export function OrgSettingsSections(handle: Handle<OrgSectionProps & { admin: boolean; csrf: string }>) {
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
                Plafond {PERIOD_TEXT[hit.period]} atteint : {formatUsd(hit.spentUsd)} sur {formatUsd(hit.capUsd)}.
              </strong>{' '}
              Aucun nouveau job n’est lancé ; les jobs en cours finissent, et les reviews reprennent {resetWhen(hit.resetsAt)}.{' '}
              {admin ? <a href="#plafond">Relever le plafond</a> : 'Un admin de l’organisation peut le relever.'}
            </p>
          </div>
        ) : null}
        {alerts.map((period) => (
          <div class="banner banner-info" role="status">
            <AlertIcon />
            <p>
              <strong>Seuil d’alerte {PERIOD_TEXT[period]} atteint</strong> : {formatUsd(period === 'day' ? spent.dayUsd : spent.monthUsd)} sur{' '}
              {formatUsd((period === 'day' ? view.caps.dailyCapUsd : view.caps.monthlyCapUsd)!)} ({view.caps.alertPct} %).
            </p>
          </div>
        ))}
        {notice ? <Notice notice={notice} /> : null}
        <p class="hint org-version">{orgVersionLine(view)}</p>
        <div class="org-settings">
          <CapSection {...props} />
          <DefaultsSection {...props} />
          <BotsSection {...props} />
          <AppSection {...props} />
        </div>
      </>
    )
  }
}

type SectionProps = OrgSectionProps & { admin: boolean; csrf: string }

function Hidden(handle: Handle<{ csrf: string; version: number; field: OrgField }>) {
  return () => (
    <>
      <input type="hidden" name="_csrf" value={handle.props.csrf} />
      <input type="hidden" name="version" value={String(handle.props.version)} />
      <input type="hidden" name="field" value={handle.props.field} />
    </>
  )
}

function FieldMessage(handle: Handle<{ id: string; error?: string; hint?: string }>) {
  return () => {
    let { id, error, hint } = handle.props
    if (error) {
      return (
        <p class="field-error" id={`${id}-error`}>
          {error}
        </p>
      )
    }
    return hint ? (
      <p class="field-hint" id={`${id}-hint`}>
        {hint}
      </p>
    ) : null
  }
}

function describedBy(id: string, error: string | undefined, hint: boolean): string | undefined {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined
}

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
            <strong>{formatUsd(spent)}</strong> {cap === null ? 'sans plafond' : `sur ${formatUsd(cap)} (${pct} %)`}
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
 * REV-27. The next job of each level of the org: the config of the org, else the provider « Par
 * défaut ». A repository may choose another one in its Config.
 */
export function orgEffectiveLevels(view: Pick<OrgSettingsView, 'config'>, providers: readonly ProviderOption[]): Record<Level, EffectiveLevel> {
  let kento = kentoDefaults()
  let out = {} as Record<Level, EffectiveLevel>
  for (let level of LEVEL_KEYS) {
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
      <section class="card config-card" id="plafond" aria-labelledby="cap-title" tabIndex={-1}>
        <header class="config-card-head">
          <h2 class="section-title" id="cap-title">
            Plafond de coût
          </h2>
        </header>
        <dl class="config-facts">
          <Gauge label="Aujourd’hui (UTC)" spent={view.costs.dayUsd} cap={view.caps.dailyCapUsd} alertPct={view.caps.alertPct} />
          <Gauge label="Ce mois-ci (UTC)" spent={view.costs.monthUsd} cap={view.caps.monthlyCapUsd} alertPct={view.caps.alertPct} />
          <div>
            <dt>Coût du jour par provider</dt>
            <dd>
              {view.costs.dayByProvider.length === 0 ? (
                'Aucune review payée aujourd’hui.'
              ) : (
                <ul class="cost-list">
                  {view.costs.dayByProvider.map((p) => (
                    <li>
                      <span>{p.label}</span> <strong>{formatUsd(p.usd)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
        <p class="hint">
          Au plafond, aucun nouveau job n’est mis en file : un push reçoit le check « Kentō · plafond », une commande une réponse. Les
          jobs déjà en file ou en cours finissent.
          {usesServiceKey(handle.props) ? ' La clé OpenRouter du service a aussi sa limite de 10 $ par jour : un second garde-fou pour les niveaux qui l’utilisent.' : null}
        </p>
        {admin ? (
          <form method="post" action={routes.orgSettingsSave.href()} noValidate>
            <Hidden csrf={csrf} version={view.version} field="caps" />
            <FormErrors errors={errors} />
            <div class="field">
              <label class="field-label" for="cap-day">
                Plafond par jour ($)
              </label>
              <input
                class="input config-cap"
                id="cap-day"
                name="dailyCapUsd"
                value={values.dailyCapUsd ?? ''}
                inputMode="decimal"
                autoComplete="off"
                {...focusIf(first, 'dailyCapUsd')}
                aria-invalid={errors.dailyCapUsd ? 'true' : undefined}
                aria-describedby={describedBy('cap-day', errors.dailyCapUsd, true)}
              />
              <FieldMessage id="cap-day" error={errors.dailyCapUsd} hint="Remis à zéro chaque nuit à minuit UTC. Vide : aucun plafond." />
            </div>
            <div class="field">
              <label class="field-label" for="cap-month">
                Plafond par mois ($)
              </label>
              <input
                class="input config-cap"
                id="cap-month"
                name="monthlyCapUsd"
                value={values.monthlyCapUsd ?? ''}
                inputMode="decimal"
                autoComplete="off"
                {...focusIf(first, 'monthlyCapUsd')}
                aria-invalid={errors.monthlyCapUsd ? 'true' : undefined}
                aria-describedby={describedBy('cap-month', errors.monthlyCapUsd, true)}
              />
              <FieldMessage id="cap-month" error={errors.monthlyCapUsd} hint="Le mois calendaire, en UTC. Vide : aucun plafond." />
            </div>
            <div class="field">
              <label class="field-label" for="cap-alert">
                Seuil d’alerte (%)
              </label>
              <input
                class="input config-cap"
                id="cap-alert"
                name="alertPct"
                value={values.alertPct ?? ''}
                inputMode="numeric"
                autoComplete="off"
                {...focusIf(first, 'alertPct')}
                aria-invalid={errors.alertPct ? 'true' : undefined}
                aria-describedby={describedBy('cap-alert', errors.alertPct, true)}
              />
              <FieldMessage id="cap-alert" error={errors.alertPct} hint="Ces réglages préviennent à partir de ce pourcentage d’un plafond." />
            </div>
            <button class="button button-primary" type="submit">
              Enregistrer le plafond
            </button>
          </form>
        ) : (
          <p>
            {view.caps.dailyCapUsd === null ? 'Aucun plafond par jour' : `${formatUsd(view.caps.dailyCapUsd)} par jour`},{' '}
            {view.caps.monthlyCapUsd === null ? 'aucun par mois' : `${formatUsd(view.caps.monthlyCapUsd)} par mois`} ; alerte à{' '}
            {view.caps.alertPct} %.
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
      <section class="card config-card org-defaults" id="defauts" aria-labelledby="defaults-title" tabIndex={-1}>
        <header class="config-card-head">
          <h2 class="section-title" id="defaults-title">
            Valeurs par défaut
          </h2>
        </header>
        <p class="hint">
          Chaque repo les hérite dans sa Config, et peut les remplacer ; un repo qui a remplacé une valeur garde la sienne.
        </p>
        <div class="org-default">
          <div class="config-card-head">
            <h3 class="org-default-title">Niveau d’un push</h3>
            <OrgSource set={view.config.level !== undefined} />
          </div>
          {admin ? (
            <>
              <form method="post" action={routes.orgSettingsSave.href()}>
                <Hidden csrf={csrf} version={view.version} field="level" />
                <FormErrors errors={mine?.errors ?? {}} />
                <fieldset class="field" aria-describedby={mine?.errors.defaultLevel ? 'org-level-error' : undefined}>
                  <legend class="visually-hidden">Niveau d’un push</legend>
                  {LEVEL_KEYS.map((key) => (
                    <label class="choice">
                      <input
                        type="radio"
                        name="defaultLevel"
                        value={key}
                        checked={key === selected}
                        autoFocus={mine?.errors.defaultLevel && key === radioFocus(selected, LEVEL_KEYS) ? true : undefined}
                      />
                      <span>
                        <strong class="mono">{key}</strong> — {LEVEL_HINTS[key]}
                      </span>
                    </label>
                  ))}
                  {mine?.errors.defaultLevel ? (
                    <p class="field-error" id="org-level-error">
                      {mine.errors.defaultLevel}
                    </p>
                  ) : null}
                </fieldset>
                {/* A row of the section: a secondary button (REV-29, one primary action per section at most). */}
                <button class="button" type="submit">
                  Enregistrer le niveau
                </button>
              </form>
              {view.config.level !== undefined ? <ResetForm csrf={csrf} version={view.version} field="level" label="le niveau" /> : null}
            </>
          ) : (
            <p>
              <strong class="mono">{level}</strong> — {LEVEL_HINTS[level]}
            </p>
          )}
        </div>
        {LEVEL_KEYS.map((key) => (
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

/** « réglé ici » or « valeur de Kentō ». The word carries the meaning. */
function OrgSource(handle: Handle<{ set: boolean }>) {
  return () => (handle.props.set ? <span class="tag tag-info">réglé pour l’org</span> : <span class="tag tag-quiet">valeur de Kentō</span>)
}

function ResetForm(handle: Handle<{ csrf: string; version: number; field: OrgField; label: string }>) {
  return () => {
    let { csrf, version, field, label } = handle.props
    return (
      <form method="post" action={routes.orgSettingsReset.href()}>
        <Hidden csrf={csrf} version={version} field={field} />
        <button class="button" type="submit">
          Revenir à Kentō<span class="visually-hidden"> pour {label}</span>
        </button>
      </form>
    )
  }
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
    // A level without a choice shows what runs today: the provider « Par défaut » and its models.
    let shown = set ? value : { provider: effective.provider.id, model: effective.model ?? '', fallback: effective.fallback }
    let values = form?.values ?? { provider: shown.provider, model: shown.model, fallback: shown.fallback ?? '' }
    let id = `org-${level}`
    let selected = values.provider ?? ''
    return (
      <div class="org-default" id={id}>
        <div class="config-card-head">
          <h3 class="org-default-title mono">{level}</h3>
          <OrgSource set={set} />
        </div>
        <EffectiveLine effective={effective} scope="org" source={set ? 'org' : 'kento'} />
        {admin ? (
          <>
            <form method="post" action={routes.orgSettingsSave.href()} noValidate>
              <Hidden csrf={csrf} version={version} field={`models.${level}`} />
              <FormErrors errors={errors} />
              <div class="org-default-fields">
                <div class="field">
                  <label class="field-label" for={`${id}-provider`}>
                    Provider
                  </label>
                  <select
                    class="input"
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
                        {selected} (indisponible)
                      </option>
                    ) : null}
                  </select>
                  <FieldMessage id={`${id}-provider`} error={errors.provider} hint={providers.find((p) => p.id === selected)?.hint} />
                </div>
                <div class="field">
                  <label class="field-label" for={`${id}-model`}>
                    Modèle
                  </label>
                  <input
                    class="input mono"
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
                  <label class="field-label" for={`${id}-fallback`}>
                    Repli
                  </label>
                  <input
                    class="input mono"
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
                  <FieldMessage id={`${id}-fallback`} error={errors.fallback} hint="Vide : pas de repli." />
                </div>
              </div>
              {set ? null : (
                <p class="hint">
                  Enregistrer fixe ce choix pour l’org : le niveau ne suivra plus le provider « Par défaut ».
                </p>
              )}
              <button class="button" type="submit">
                Enregistrer<span class="visually-hidden"> le modèle {level}</span>
              </button>
            </form>
            {set ? <ResetForm csrf={csrf} version={version} field={`models.${level}`} label={level} /> : null}
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
            Bots de confiance <span class="count">{view.trustedBots.length}</span>
          </h2>
        </header>
        <p class="hint">
          Les PR, les pushs et les commandes <span class="mono">@kento-review</span> de ces bots comptent comme ceux d’une personne qui a le
          droit d’écriture. Tout autre bot est ignoré.
        </p>
        {view.trustedBots.length === 0 ? (
          <p>Aucun bot de confiance.</p>
        ) : (
          <ul class="bot-list">
            {view.trustedBots.map((bot) => (
              <li class="mono">{bot}</li>
            ))}
          </ul>
        )}
        {admin ? (
          <form method="post" action={routes.orgSettingsSave.href()} noValidate>
            <Hidden csrf={csrf} version={view.version} field="trustedBots" />
            <FormErrors errors={mine?.errors ?? {}} />
            <div class="field">
              <label class="field-label" for="trusted-bots">
                Un login par ligne
              </label>
              <textarea
                class="input mono config-paths"
                id="trusted-bots"
                name="trustedBots"
                rows={4}
                spellCheck={false}
                autoFocus={mine?.errors.trustedBots ? true : undefined}
                aria-invalid={mine?.errors.trustedBots ? 'true' : undefined}
                aria-describedby={describedBy('trusted-bots', mine?.errors.trustedBots, true)}
                value={value}
              ></textarea>
              <FieldMessage id="trusted-bots" error={mine?.errors.trustedBots} hint="Par exemple renovate[bot] ; « [bot] » est ajouté s’il manque." />
            </div>
            <button class="button button-primary" type="submit">
              Enregistrer les bots
            </button>
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
    if (!delivery) return <>Aucun depuis 30 jours.</>
    return (
      <>
        <span class="mono">{deliveryText(delivery)}</span>{' '}
        <time dateTime={delivery.receivedAt.toISOString()} title={when(delivery.receivedAt)}>
          {ago(delivery.receivedAt, now)}
        </time>
        {delivery.reason ? <span class="hint"> — {delivery.reason}</span> : null}
      </>
    )
  }
}

function AppSection(handle: Handle<SectionProps>) {
  return () => {
    let { view, app, webhookUrl, webhookSecret, version, commit, now } = handle.props
    let status = app?.ok ? app.status : null
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
            App GitHub
          </h2>
          {status ? (
            problems === 0 ? (
              <span class="status status-online">
                <CheckIcon /> Tout est en place
              </span>
            ) : (
              <span class="status status-alert">
                <AlertIcon /> {problems} point{problems > 1 ? 's' : ''} à corriger
              </span>
            )
          ) : (
            <span class="status status-stale">État GitHub inconnu</span>
          )}
        </header>
        {app && !app.ok ? (
          <p class="hint" role="note">
            GitHub n’a pas répondu sur l’App : {app.error}
          </p>
        ) : null}
        {!app ? (
          <p class="hint" role="note">
            Le service n’a pas d’App GitHub (<span class="mono">GITHUB_APP_ID</span>) : il ne lit ni ses permissions ni son webhook.
          </p>
        ) : null}
        <dl class="config-facts">
          <div>
            <dt>Installation</dt>
            <dd>
              {status ? (
                <a href={status.installation.htmlUrl}>
                  {view.login} · n° {view.githubInstallationId}
                </a>
              ) : (
                <>
                  {view.login} · n° {view.githubInstallationId}
                </>
              )}
              {suspended ? <span class="tag tag-alert">suspendue</span> : null} · {view.repos.total} repo{view.repos.total > 1 ? 's' : ''} visibles
              {status ? (status.installation.repositorySelection === 'all' ? ' (tous)' : ' (choisis)') : ''}, {view.repos.enabled} activé
              {view.repos.enabled > 1 ? 's' : ''}
            </dd>
          </div>
          <div>
            <dt>URL du webhook</dt>
            <dd>
              <span class="mono">{status?.webhook?.url ?? webhookUrl ?? 'inconnue'}</span>
              {urlMismatch ? (
                <span class="field-error">
                  Kentō attend <span class="mono">{webhookUrl}</span>
                </span>
              ) : null}
              {status?.webhook && !status.webhook.sslVerified ? <span class="tag tag-alert">SSL non vérifié</span> : null}
            </dd>
          </div>
          <div>
            <dt>Signature</dt>
            <dd>
              {webhookSecret
                ? 'Vérifiée sur chaque livraison (X-Hub-Signature-256) ; une livraison mal signée reçoit 401 et n’est pas gardée.'
                : 'Non configurée (GITHUB_WEBHOOK_SECRET) : le webhook répond 503.'}
            </dd>
          </div>
          <div>
            <dt>Dernier événement</dt>
            <dd>
              <DeliveryLine delivery={view.deliveries.last} now={now} />
            </dd>
          </div>
          <div>
            <dt>Dernier push ou PR</dt>
            <dd>
              <DeliveryLine delivery={view.deliveries.lastPullRequest} now={now} />
            </dd>
          </div>
          <div>
            <dt>Échecs sur 24 h</dt>
            <dd>
              <strong>{view.deliveries.failures24h}</strong> sur {view.deliveries.total24h} livraison{view.deliveries.total24h > 1 ? 's' : ''}
              {view.deliveries.lastFailure ? (
                <span class="hint">
                  {' '}
                  — dernier : <DeliveryLine delivery={view.deliveries.lastFailure} now={now} />
                </span>
              ) : null}
            </dd>
          </div>
          {status ? (
            <div>
              <dt>Permissions</dt>
              <dd>
                <ul class="permission-list">
                  {permissions.map((p) => (
                    <li>
                      {p.ok ? <CheckIcon /> : <AlertIcon />} {PERMISSION_LABELS[p.name] ?? p.name} : {ACCESS[p.needed]}
                      {p.ok ? null : <span class="field-error"> — accordé : {p.granted ? ACCESS[p.granted] : 'rien'}</span>}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {status ? (
            <div>
              <dt>Événements</dt>
              <dd>
                {REQUIRED_EVENTS.map((event) => (
                  <span class={`tag ${missing.includes(event) ? 'tag-alert' : 'tag-ok'}`}>
                    {event}
                    {missing.includes(event) ? ' : non abonné' : ''}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Service</dt>
            <dd>
              Dokploy, projet Kentō, application <span class="mono">web</span> · version <span class="mono">{version}</span>
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
            <a class="button" href={status.deliveriesUrl}>
              Rejouer depuis la page de l’App
            </a>{' '}
            <span class="hint">« Recent Deliveries » → une livraison → « Redeliver ».</span>
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
      let by = notice.updatedBy ? ` par ${notice.updatedBy}` : ''
      let at = notice.updatedAt ? ` ${when(notice.updatedAt)}` : ''
      return (
        <div class="banner banner-alert" role="alert">
          <AlertIcon />
          <p>
            <strong>Les réglages ont changé entre-temps</strong> (v{notice.version}, modifiés{by}
            {at}). Rien n’a été enregistré : relisez les valeurs ci-dessous, puis recommencez.
          </p>
        </div>
      )
    }
    return (
      <div class="banner banner-ok" role="status">
        <CheckIcon />
        <p>
          <strong>{notice.kind === 'saved' ? 'Réglages enregistrés' : 'Valeur de Kentō reprise'}</strong> (v{notice.version}). Le
          prochain job les applique ; un job déjà en file garde les siens.
        </p>
      </div>
    )
  }
}
