import type { Handle } from 'remix/component'

import { defaultModels } from '@sakuga-review/engine/levels'
import { costKnown } from '@sakuga-review/engine/prices'
import { LEVELS, type Level, type ProviderKind } from '@sakuga-review/protocol'

import { KIND_LABELS, type ProviderField, type ProviderFormValues } from '../providers/form.ts'
import type { ProviderView } from '../providers/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { FormErrors, firstInvalid, focusIf } from './form-errors.tsx'
import { agoShort, clock, hourOrDate } from './format.ts'
import { OrgSettingsSections, orgEffectiveLevels, orgVersionLine, type OrgSectionProps } from './org-settings.tsx'
import { RulesList, type RuleFormState, type RuleNotice } from './rules.tsx'
import type { RuleView } from '../rules/store.ts'
import { Shell, type PageFrame } from './shell.tsx'

const KINDS: readonly ProviderKind[] = ['anthropic', 'openrouter', 'openai_compatible', 'ollama']
/** REV-28. What each type needs, all shown under the select: right whatever the choice, without JavaScript. */
const KIND_HINTS: Record<ProviderKind, string> = {
  anthropic: 'une clé Anthropic (sk-ant-…) ; l’URL et les modèles du type par défaut.',
  openrouter: 'une clé OpenRouter (sk-or-…) ; l’URL et les modèles du type par défaut.',
  openai_compatible: 'l’URL du serveur, obligatoire, et au moins un modèle par niveau.',
  ollama: 'un serveur sur la machine d’un runner ; le service n’a jamais de clé.',
}
/** The order of the fields of « Ajouter un provider »: the first one in error gets the focus. */
const PROVIDER_FIELDS: readonly ProviderField[] = ['kind', 'label', 'baseUrl', 'apiKey', 'models']

/** What the section says after a form, from `?notice=`. */
export const PROVIDER_NOTICES = {
  added: { tone: 'ok', text: 'Provider ajouté. Testez-le pour vérifier la clé.' },
  // No « Tester » for these two: the service has no key, and cannot reach the server of a runner.
  added_runner: { tone: 'ok', text: 'Provider ajouté. Sa clé reste sur le runner, et le premier job d’un runner qui l’a dira si elle marche.' },
  added_ollama: { tone: 'ok', text: 'Provider ajouté. Son serveur est sur le réseau d’un runner. Le premier job d’un runner avec PROVIDER_KIND=ollama dira s’il répond.' },
  replaced: { tone: 'ok', text: 'Clé remplacée. L’ancienne n’est plus gardée.' },
  default: { tone: 'ok', text: 'Ce provider est maintenant « Par défaut ». Les niveaux sans provider choisi l’utilisent.' },
  removed: { tone: 'info', text: 'Provider retiré, avec sa clé.' },
  tested_ok: { tone: 'ok', text: 'Le provider a accepté la clé.' },
  tested_refused: { tone: 'alert', text: 'Le provider a refusé la clé.' },
  test_failed: { tone: 'alert', text: 'Le test n’a pas abouti, et l’état du provider ne change pas.' },
  missing: { tone: 'alert', text: 'Rien n’a changé. Ce provider a été modifié ou retiré depuis votre dernier affichage. Voyez son état ci-dessous, puis refaites l’action s’il le faut.' },
} as const
export type ProviderNotice = keyof typeof PROVIDER_NOTICES

export type ProviderState = 'runner' | 'refused' | 'valid' | 'unknown'

/**
 * The state of a provider, as the screen and the catalog of REV-12 show it. A refusal comes first,
 * also for a runner-held provider: a job of a runner that got 401 or 403 records it (REV-31).
 */
export function providerState(provider: Pick<ProviderView, 'runnerHeld' | 'refusedAt' | 'lastOkAt'>): ProviderState {
  if (provider.refusedAt) return 'refused'
  if (provider.runnerHeld) return 'runner'
  if (provider.lastOkAt) return 'valid'
  return 'unknown'
}

export interface SettingsPageProps {
  frame: PageFrame
  /** Null: the service has no providers section. */
  providers: ProviderView[] | null
  /** REV-13. The settings of the org, above the providers. Null: not configured on the service. */
  org?: OrgSectionProps | null
  now: Date
  /** KENTO_SECRETS_KEY is set: the service can store a key. */
  secretsConfigured: boolean
  /** KENTO_PROVIDER_API_KEY is set: the jobs of an org without a provider use it. */
  serviceKey: boolean
  notice?: { kind: ProviderNotice; detail?: string | null } | null
  form?: { values: ProviderFormValues; errors: Partial<Record<ProviderField, string>> } | null
  /** The provider whose « Remplacer la clé » failed, with its message. */
  keyError?: { id: string; message: string } | null
  /** REV-19. The rules of the org. Null: the service has no rules. */
  rules?: { list: RuleView[]; form: RuleFormState | null; notice: RuleNotice | null; noticeRule: string | null } | null
}

export function SettingsPage(handle: Handle<SettingsPageProps>) {
  return () => {
    let { frame, providers, org, now, secretsConfigured, serviceKey, notice, form, keyError, rules } = handle.props
    let admin = frame.viewer?.role === 'admin'
    let csrf = frame.csrfToken ?? ''
    let refused = (providers ?? []).filter((p) => providerState(p) === 'refused')
    // REV-27. Which levels of the org run on each provider: the same rule as Valeurs par défaut.
    let effective = org ? orgEffectiveLevels(org.view, org.providers) : null
    let usage = (id: string) => (effective ? LEVELS.filter((level) => effective[level].provider.id === id) : null)
    return (
      <Shell
        frame={frame}
        section="settings"
        title="Réglages"
        // REV-91: the version of the settings goes under the title, after « Pour toute l’organisation ».
        lead={org ? `Pour toute l’organisation · ${orgVersionLine(org.view)}` : 'Ce qui vaut pour toute l’organisation.'}
      >
        {refused.map((p) => {
          let levels = usage(p.id)
          let failing =
            levels === null
              ? p.isDefault
                ? 'Les jobs de l’organisation échouent tant qu’elle n’est pas remplacée.'
                : 'Ce provider n’est pas celui des jobs.'
              : levels.length > 0
                ? `Les jobs ${levels.length > 1 ? 'des niveaux' : 'du niveau'} ${levelList(levels)} échouent tant qu’elle n’est pas remplacée.`
                : 'Aucun niveau de l’organisation ne l’utilise. Seul un repo qui l’a choisi dans sa Config en est touché.'
          return (
            <div class="banner banner-alert" role="alert">
              <p>
                <strong>
                  {p.runnerHeld ? <>Le runner a reçu {p.refusedStatus} pour la clé de « {p.label} » </> : <>La clé de « {p.label} » est refusée ({p.refusedStatus}) </>}
                  depuis <time dateTime={p.refusedAt!.toISOString()}>{hourOrDate(p.refusedAt!, now)}</time>.
                </strong>{' '}
                {failing}{' '}
                {p.runnerHeld ? (
                  <a href={`#provider-${p.id}`}>Que faire</a>
                ) : admin ? (
                  <a href={`#provider-${p.id}`}>Remplacer la clé</a>
                ) : (
                  'Un admin de l’organisation peut la remplacer.'
                )}
              </p>
            </div>
          )
        })}
        {notice ? (
          <div class={`banner banner-${PROVIDER_NOTICES[notice.kind].tone}`} role="status">
            <p>
              {PROVIDER_NOTICES[notice.kind].text}
              {notice.detail ? <> {notice.detail}</> : null}
            </p>
          </div>
        ) : null}

        <div class="settings-layout">
          <SettingsNav org={!!org} rules={!!rules} providers={!!providers} />
          <div class="settings-content">
        {org ? <OrgSettingsSections {...org} admin={admin} csrf={csrf} /> : null}

        {rules ? (
          <section class="card config-card" id="regles" aria-labelledby="org-rules-title" tabIndex={-1}>
            <h2 id="org-rules-title" class="section-title">
              Règles d’org <span class="count">{rules.list.filter((r) => r.active).length}</span>
            </h2>
            <p class="hint">
              Elles partent avec la review de chaque repo de l’organisation, après les règles du repo, quand la PR touche l’un de
              leurs chemins. Les règles d’un seul repo s’écrivent dans sa Config, onglet Règles.
            </p>
            <RulesList
              scope="org"
              repoId={null}
              rules={rules.list}
              admin={admin}
              csrf={csrf}
              form={rules.form}
              notice={rules.notice}
              noticeRule={rules.noticeRule}
            />
          </section>
        ) : null}

        {providers ? (
          <section class="provider-section" id="providers" aria-labelledby="providers-title" tabIndex={-1}>
            <h2 id="providers-title" class="section-title">
              Providers et clés <span class="count">{providers.length}</span>
            </h2>
            <p class="hint provider-lead">
              Le provider par défaut fait les reviews de l’organisation. Sa clé est chiffrée au repos (AES-256-GCM) ; l’écran
              n’en montre que les 4 derniers caractères, et seul un runner de confiance de l’organisation la reçoit, pour un
              job.
            </p>
            {!secretsConfigured ? (
              <div class="banner banner-info" role="note">
                <p>
                  Le chiffrement des clés n’est pas configuré sur le service (<span class="mono">KENTO_SECRETS_KEY</span>) :
                  seul un provider dont la clé reste sur le runner peut être ajouté.
                </p>
              </div>
            ) : null}
            {providers.length === 0 ? (
              <div class="empty">
                <p>
                  {serviceKey
                    ? 'Aucun provider. Les jobs utilisent la clé OpenRouter du service. Ajoutez le vôtre pour payer vos reviews et choisir vos modèles.'
                    : 'Aucun provider, et le service n’a pas de clé. Seul un runner avec sa propre clé fait les reviews.'}
                </p>
              </div>
            ) : (
              <ul class="provider-list">
                {providers.map((provider) => (
                  <ProviderItem
                    provider={provider}
                    now={now}
                    admin={admin}
                    csrf={csrf}
                    keyError={keyError?.id === provider.id ? keyError.message : null}
                    levels={usage(provider.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {admin && providers ? <NewProviderForm csrf={csrf} form={form ?? null} secretsConfigured={secretsConfigured} /> : null}
          </div>
        </div>
        <script src={`/assets/settings.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script>
      </Shell>
    )
  }
}

/**
 * The table of contents of the settings (REV-29): one link per section, as tabs under the title
 * (REV-91). Each section keeps its anchor: #plafond, #defauts, #bots, #app, #regles, #providers.
 * #nouveau-provider still opens the form (settings.js); the button of the section does too.
 */
function SettingsNav(handle: Handle<{ org: boolean; rules: boolean; providers: boolean }>) {
  return () => {
    let { org, rules, providers } = handle.props
    let links: [string, string][] = [
      ...(org
        ? ([
            ['#plafond', 'Coûts et plafond'],
            ['#defauts', 'Niveaux et modèles'],
            ['#bots', 'Bots de confiance'],
            ['#app', 'App GitHub'],
          ] as [string, string][])
        : []),
      ...(rules ? ([['#regles', 'Règles d’org']] as [string, string][]) : []),
      ...(providers ? ([['#providers', 'Providers et clés']] as [string, string][]) : []),
    ]
    if (links.length < 2) return null
    return (
      <nav class="settings-nav" aria-label="Sections des réglages">
        <ul>
          {links.map(([href, label]) => (
            <li>
              <a href={href}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>
    )
  }
}

const STATE_TEXT: Record<ProviderState, string> = {
  runner: 'Clé sur le runner',
  refused: 'Clé refusée',
  valid: 'Valide',
  unknown: 'Jamais appelé',
}
const STATE_CLASS: Record<ProviderState, string> = {
  // A key on the runner is a normal state: neutral. The amber of `status-wait` says « attention ».
  runner: 'status-neutral',
  refused: 'status-alert',
  valid: 'status-online',
  unknown: 'status-stale',
}

/** « lite », « lite et heavy », « lite, balanced et heavy ». */
function levelList(levels: readonly Level[]): string {
  return levels.length <= 1 ? levels.join('') : `${levels.slice(0, -1).join(', ')} et ${levels.at(-1)}`
}

/**
 * REV-27. The levels of the org that run on this provider, under its name: « Par défaut » and the
 * choices of Valeurs par défaut never say two different things. Null: the service has no settings of
 * the org.
 */
function ProviderUsage(handle: Handle<{ provider: ProviderView; levels: Level[] | null }>) {
  return () => {
    let { provider, levels } = handle.props
    if (!levels) return null
    let others = LEVELS.filter((level) => !levels.includes(level))
    let defaults = <a href="#defauts">Valeurs par défaut</a>
    if (provider.isDefault) {
      return (
        <p class="hint provider-usage">
          {levels.length === LEVELS.length ? (
            <>Fait les niveaux {levelList(levels)} de l’organisation.</>
          ) : levels.length > 0 ? (
            <>
              Fait les niveaux {levelList(levels)} de l’organisation. {others.length > 1 ? 'Les niveaux' : 'Le niveau'} {levelList(others)}{' '}
              {others.length > 1 ? 'ont' : 'a'} un autre provider, choisi
              dans {defaults}.
            </>
          ) : (
            <>Aucun niveau de l’organisation ne l’utilise. Chacun a son provider, choisi dans {defaults}.</>
          )}{' '}
          Un repo peut choisir le sien dans sa Config.
        </p>
      )
    }
    return levels.length > 0 ? (
      <p class="hint provider-usage">
        Choisi pour {levels.length > 1 ? 'les niveaux' : 'le niveau'} {levelList(levels)} de l’organisation, dans {defaults}.
      </p>
    ) : null
  }
}

function ProviderItem(
  handle: Handle<{ provider: ProviderView; now: Date; admin: boolean; csrf: string; keyError: string | null; levels: Level[] | null }>,
) {
  return () => {
    let { provider, now, admin, csrf, keyError, levels } = handle.props
    let state = providerState(provider)
    let id = provider.id
    return (
      <li class={`provider provider-${state}`} id={`provider-${id}`} tabIndex={-1}>
        <div class="provider-head">
          <h3 class="provider-name">{provider.label}</h3>
          <span class="tag">{KIND_LABELS[provider.kind]}</span>
          {provider.isDefault ? <span class="tag tag-ok">Par défaut</span> : null}
          <span class={`status ${STATE_CLASS[state]}`}>
            {state === 'refused' ? (
              <>
                {provider.runnerHeld ? 'Refusée sur le runner' : 'Refusée'} · {provider.refusedStatus} depuis{' '}
                <time dateTime={provider.refusedAt!.toISOString()}>{hourOrDate(provider.refusedAt!, now)}</time>
              </>
            ) : state === 'valid' ? (
              <>
                Valide · dernier appel{' '}
                <time dateTime={provider.lastOkAt!.toISOString()} title={clock(provider.lastOkAt!)}>
                  {agoShort(provider.lastOkAt!, now)}
                </time>
              </>
            ) : (
              state === 'runner' && provider.kind === 'ollama' ? 'Serveur du runner' : STATE_TEXT[state]
            )}
          </span>
        </div>
        <ProviderUsage provider={provider} levels={levels} />
        <dl class="provider-facts">
          <div>
            <dt>Clé</dt>
            <dd>
              {provider.keyLast4 ? (
                <span class="mono" aria-label={`se termine par ${provider.keyLast4}`}>
                  ••••{provider.keyLast4}
                </span>
              ) : provider.kind === 'ollama' ? (
                'aucune, serveur du runner'
              ) : (
                'sur le runner (PROVIDER_API_KEY)'
              )}
            </dd>
          </div>
          <div>
            <dt>URL</dt>
            <dd class="mono">{provider.baseUrl ?? 'par défaut'}</dd>
          </div>
          {LEVELS.map((level) => {
            let models = provider.models[level] ?? defaultModels(provider.kind, level)
            return (
              <div>
                <dt>Modèles {level}</dt>
                <dd>
                  {models.map((model) => (
                    <span class="model">
                      <span class="mono">{model}</span>
                      {costKnown(provider.kind, model) ? null : <span class="tag tag-warn">sans prix : non compté dans le plafond</span>}
                    </span>
                  ))}
                </dd>
              </div>
            )
          })}
          {provider.keySetAt ? (
            <div>
              <dt>Clé posée</dt>
              <dd>
                <time dateTime={provider.keySetAt.toISOString()}>{clock(provider.keySetAt)}</time>
              </dd>
            </div>
          ) : null}
        </dl>
        {state === 'refused' && provider.refusedMessage ? <p class="hint">Dernière réponse : {provider.refusedMessage}</p> : null}
        {provider.runnerHeld && state === 'refused' ? (
          <p class="hint provider-todo">
            <strong>Que faire.</strong> Remplacez <span class="mono">PROVIDER_API_KEY</span> sur les runners de l’organisation qui ont{' '}
            <span class="mono">PROVIDER_KIND={provider.kind}</span>, puis relancez une review. Le premier job qui aboutit efface ce refus.
          </p>
        ) : null}
        {state === 'runner' ? (
          <p class="hint">
            Le service n’a pas cette clé. Un runner de l’organisation avec <span class="mono">PROVIDER_KIND={provider.kind}</span> fait
            ses jobs, et son état se lit dans ses jobs.
          </p>
        ) : null}
        {admin ? (
          <div class="provider-actions">
            {provider.runnerHeld ? null : (
              <form method="post" action={routes.providerTest.href({ id })}>
                <input type="hidden" name="_csrf" value={csrf} />
                <button class="button" type="submit">
                  Tester
                </button>
              </form>
            )}
            {provider.isDefault ? null : (
              <form method="post" action={routes.providerDefault.href({ id })}>
                <input type="hidden" name="_csrf" value={csrf} />
                <button class="button" type="submit">
                  Mettre par défaut
                </button>
              </form>
            )}
            {provider.runnerHeld ? null : (
              <details class="confirm replace-key" open={keyError !== null || state === 'refused' ? true : undefined}>
                <summary class={`button ${state === 'refused' ? 'button-primary' : ''}`}>Remplacer la clé</summary>
                <form class="confirm-body replace-body" method="post" action={routes.providerKey.href({ id })} noValidate>
                  <input type="hidden" name="_csrf" value={csrf} />
                  {keyError ? <FormErrors errors={{ apiKey: keyError }} /> : null}
                  <div class="field">
                    <label class="field-label" for={`key-${id}`}>
                      Nouvelle clé {KIND_LABELS[provider.kind]}
                    </label>
                    <input
                      class="input mono"
                      id={`key-${id}`}
                      name="apiKey"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      autoFocus={keyError ? true : undefined}
                      aria-invalid={keyError ? 'true' : undefined}
                      aria-describedby={keyError ? `key-${id}-error` : `key-${id}-hint`}
                    />
                    {keyError ? (
                      <p class="field-error" id={`key-${id}-error`}>
                        {keyError}
                      </p>
                    ) : (
                      <p class="field-hint" id={`key-${id}-hint`}>
                        L’ancienne clé est effacée. Les jobs déjà en cours gardent celle qu’ils ont reçue.
                      </p>
                    )}
                  </div>
                  <button class="button button-primary" type="submit">
                    Remplacer
                  </button>
                </form>
              </details>
            )}
            <Confirm trigger="Retirer…" action={routes.providerRemove.href({ id })} csrf={csrf} submit={`Retirer ${provider.label}`}>
              <p>
                <strong>{provider.label}</strong> et sa clé seront effacés.{' '}
                {provider.isDefault
                  ? 'Le plus ancien des autres providers devient celui des jobs ; sans autre provider, les jobs utilisent la clé du service.'
                  : 'Les jobs n’utilisent pas ce provider.'}
              </p>
            </Confirm>
          </div>
        ) : null}
      </li>
    )
  }
}

function NewProviderForm(handle: Handle<{ csrf: string; form: SettingsPageProps['form']; secretsConfigured: boolean }>) {
  return () => {
    let { csrf, form, secretsConfigured } = handle.props
    let values: ProviderFormValues = form?.values ?? {
      kind: 'anthropic',
      label: '',
      baseUrl: '',
      runnerHeld: !secretsConfigured,
      models: { lite: '', balanced: '', heavy: '' },
    }
    let errors = form?.errors ?? {}
    let first = firstInvalid(errors, PROVIDER_FIELDS)
    // A key in error with the key field disabled (no KENTO_SECRETS_KEY): the way out is the box below it.
    let focusRunnerHeld = first === 'apiKey' && !secretsConfigured
    let field = (name: ProviderField) => ({
      ...(focusRunnerHeld ? {} : focusIf(first, name)),
      'aria-invalid': errors[name] ? ('true' as const) : undefined,
      'aria-describedby': errors[name] ? `provider-${name}-error` : `provider-${name}-hint`,
    })
    let message = (name: ProviderField, hint: string) =>
      errors[name] ? (
        <p class="field-error" id={`provider-${name}-error`}>
          {errors[name]}
        </p>
      ) : (
        <p class="field-hint" id={`provider-${name}-hint`}>
          {hint}
        </p>
      )
    return (
      // Folded until it is asked for (REV-29): open after a form with errors, or when the URL names
      // #nouveau-provider (public/assets/settings.js).
      <section class="new-provider" id="nouveau-provider" aria-labelledby="new-provider-title" tabIndex={-1}>
        <details class="new-provider-toggle" open={form && Object.keys(form.errors).length > 0 ? true : undefined}>
          <summary class="button">
            <span id="new-provider-title">Ajouter un provider</span>
          </summary>
          <div class="card new-provider-card">
        <form method="post" action={routes.providerAdd.href()} noValidate autoComplete="off">
          <input type="hidden" name="_csrf" value={csrf} />
          <FormErrors errors={errors} />
          <div class="field">
            <label class="field-label" for="provider-kind">
              Type
            </label>
            <select
              class="input"
              id="provider-kind"
              name="kind"
              {...field('kind')}
              aria-describedby={errors.kind ? 'provider-kind-error provider-kind-hint' : 'provider-kind-hint'}
            >
              {KINDS.map((kind) => (
                <option value={kind} selected={values.kind === kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            {errors.kind ? (
              <p class="field-error" id="provider-kind-error">
                {errors.kind}
              </p>
            ) : null}
            <ul class="field-hint kind-hints" id="provider-kind-hint">
              {KINDS.map((kind) => (
                <li>
                  <strong>{KIND_LABELS[kind]}</strong> : {KIND_HINTS[kind]}
                </li>
              ))}
            </ul>
          </div>
          <div class="field">
            <label class="field-label" for="provider-label">
              Nom
            </label>
            <input class="input" id="provider-label" name="label" value={values.label} maxLength={60} required {...field('label')} />
            {message('label', 'Ce que l’écran affiche, par exemple « Anthropic de Sakuga ».')}
          </div>
          <div class="field">
            <label class="field-label" for="provider-baseUrl">
              URL du serveur
            </label>
            <input class="input mono" id="provider-baseUrl" name="baseUrl" value={values.baseUrl} inputMode="url" spellCheck={false} {...field('baseUrl')} />
            {message('baseUrl', 'Laissez vide pour l’URL du type. Obligatoire pour un serveur compatible OpenAI. HTTPS, sauf Ollama.')}
          </div>
          <div class="field">
            <label class="field-label" for="provider-apiKey">
              Clé
            </label>
            <input
              class="input mono"
              id="provider-apiKey"
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={!secretsConfigured ? true : undefined}
              {...field('apiKey')}
            />
            {message('apiKey', 'Chiffrée dès sa réception ; elle ne revient jamais dans le navigateur.')}
          </div>
          <label class="choice">
            <input type="checkbox" name="runnerHeld" checked={values.runnerHeld ? true : undefined} autoFocus={focusRunnerHeld ? true : undefined} />
            <span>
              <strong>La clé reste sur le runner.</strong> Un runner de l’organisation l’a dans <span class="mono">PROVIDER_API_KEY</span> ; le
              service ne l’a jamais.
            </span>
          </label>
          <fieldset class="field" aria-describedby={errors.models ? 'provider-models-error' : 'provider-models-hint'}>
            <legend class="field-label">Modèles par niveau</legend>
            {LEVELS.map((level) => (
              <div class="model-field">
                <label class="field-hint" for={`provider-models-${level}`}>
                  {level}
                </label>
                <input
                  class="input mono"
                  id={`provider-models-${level}`}
                  name={`models_${level}`}
                  value={values.models[level]}
                  spellCheck={false}
                  placeholder={defaultModels(values.kind, level).join(', ') || 'à nommer'}
                  autoFocus={first === 'models' && level === 'lite' ? true : undefined}
                  aria-invalid={errors.models ? 'true' : undefined}
                />
              </div>
            ))}
            {message('models', 'Séparés par des virgules, le premier d’abord. Laissez vide pour les modèles par défaut du type (Anthropic, OpenRouter).')}
          </fieldset>
          <button class="button button-primary" type="submit">
            Ajouter le provider
          </button>
        </form>
          </div>
        </details>
      </section>
    )
  }
}
