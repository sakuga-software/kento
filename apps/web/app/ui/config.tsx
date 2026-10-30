import type { Handle } from 'remix/component'

import { levelCost } from '@sakuga-review/engine/levels'
import { isOneOf, LEVELS, MAX_JOB_RULES, type Level } from '@sakuga-review/protocol'

import {
  MAX_PATHS,
  resolveConfig,
  type ConfigField,
  type LevelModels,
  type Resolved,
  type Source,
  type Trigger,
} from '../repo-config/model.ts'
import { effectiveLevel } from '../repo-config/effective.ts'
import type { ProviderOption } from '../repo-config/providers.ts'
import type { RepoConfigView } from '../repo-config/store.ts'
import type { RuleView } from '../rules/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { EffectiveLine } from './effective.tsx'
import { FormErrors, firstInvalid, focusIf, radioFocus } from './form-errors.tsx'
import { describedBy, FieldMessage, ResetForm, VersionFields, versionLine as sharedVersionLine } from './form-fields.tsx'
import { moneyInput, usd, when } from './format.ts'
import { AlertIcon, CheckIcon } from './icons.tsx'
import { RulesList, type RuleFormState, type RuleNotice } from './rules.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** The tabs of the screen, in their order. Rules come with REV-19, assignment with M5. */
export const CONFIG_TABS = ['models', 'levels', 'trigger', 'rules', 'assignment'] as const
export type ConfigTab = (typeof CONFIG_TABS)[number]

/**
 * REV-32. The tabs that come with M5: named in the bar, with « Bientôt » and no link. Règles is one
 * of them only on a service without the rules (REV-19).
 */
const SOON_TABS: readonly ConfigTab[] = ['assignment']

const TAB_LABELS: Record<ConfigTab, string> = {
  models: 'Provider et modèles',
  levels: 'Niveaux et passes',
  trigger: 'Déclenchement',
  rules: 'Règles',
  assignment: 'Assignation',
}

/** The tab of a form: where the screen goes back after it. */
export function tabOf(field: ConfigField): ConfigTab {
  if (field.startsWith('models.')) return 'models'
  if (field === 'level') return 'levels'
  return 'trigger'
}

export function isConfigTab(value: unknown): value is ConfigTab {
  return isOneOf(CONFIG_TABS, value)
}

export type ConfigNotice =
  | { kind: 'saved'; version: number }
  | { kind: 'reset'; version: number }
  /** The form came from an older version: nothing was written. */
  | { kind: 'conflict'; version: number; updatedBy: string | null; updatedAt: Date | null }

/** A form sent back with its errors: its values stay, under the field that it changes. */
export interface ConfigForm {
  field: ConfigField
  values: Record<string, string>
  errors: Record<string, string>
}

/** REV-19. The tab Règles: the rules of the repository, and what else goes to the model. */
export interface ConfigRules {
  list: RuleView[]
  /** The active rules of the org: they go with the reviews of this repository too. */
  orgActive: number
  form: RuleFormState | null
  notice: RuleNotice | null
  noticeRule: string | null
}

export interface ConfigPageProps {
  frame: PageFrame
  view: RepoConfigView
  providers: ProviderOption[]
  tab: ConfigTab
  notice: ConfigNotice | null
  form: ConfigForm | null
  /** Null: the service has no rules; the tab says « Bientôt ». */
  rules?: ConfigRules | null
}

/** « config v7, modifiée par alex le 27 oct. à 18:02 ». */
export function versionLine(view: Pick<RepoConfigView, 'version' | 'updatedBy' | 'updatedAt'>): string {
  return sharedVersionLine({ name: 'config', changed: 'modifiée', empty: 'config v0, tout est hérité de l’organisation' }, view)
}

function shortName(fullName: string, org: string): string {
  let [owner, name] = fullName.split('/') as [string, string]
  return owner.toLowerCase() === org.toLowerCase() ? name : fullName
}

const LEVEL_HINTS: Record<Level, string> = {
  lite: `Rapide et le moins cher, ${levelCost('lite')} par review.`,
  balanced: `Lit aussi le code autour du changement, ${levelCost('balanced')}.`,
  heavy: `Raisonne plus longtemps, ${levelCost('heavy')}.`,
}

const TRIGGER_CHOICES: { value: Trigger; title: string; text: string }[] = [
  { value: 'push', title: 'À chaque push', text: 'Chaque push d’une PR qui n’est pas un brouillon, et son passage en « Ready for review ».' },
  {
    value: 'ready',
    title: 'Au passage en « Ready for review »',
    text: 'Une review à l’ouverture d’une PR prête, à son passage en « Ready for review » et à sa réouverture. Les pushs suivants n’en créent pas.',
  },
  { value: 'command', title: 'À la demande', text: 'Aucune review automatique. Seule une commande @kento-review en crée une.' },
]

/**
 * « Config de orchard » (REV-12): the default level, a provider and a model for each level with their
 * fallback, and what triggers a review. An admin of the org edits; a member reads.
 */
export function ConfigPage(handle: Handle<ConfigPageProps>) {
  return () => {
    let { frame, view, providers, tab, notice, form, rules } = handle.props
    let soon = (key: ConfigTab) => SOON_TABS.includes(key) || (key === 'rules' && !rules)
    let viewer = frame.viewer!
    let admin = viewer.role === 'admin'
    let name = shortName(view.fullName, viewer.org.login)
    let resolved = resolveConfig(view.orgConfig, view.config, view.defaultLevel)
    let ctx: FormContext = { csrf: frame.csrfToken, repoId: view.id, version: view.version, admin, form }

    return (
      <Shell
        frame={frame}
        section="repos"
        title={`Config de ${name}`}
        lead={versionLine(view)}
        actions={
          <a class="button" href={`${routes.repos.href()}#repo-${view.id}`}>
            Retour aux repos
          </a>
        }
      >
        {notice ? <Notice notice={notice} /> : null}
        {!view.enabled ? (
          <div class="banner banner-info" role="status">
            <AlertIcon />
            <p>
              <strong>{name} n’est pas activé.</strong> Cette config s’appliquera aux jobs dès qu’un admin l’activera sur
              l’écran Repos.
            </p>
          </div>
        ) : null}

        <nav class="config-tabs" aria-label="Sections de la config">
          <ul>
            {CONFIG_TABS.map((key) => (
              <li>
                {soon(key) && key !== tab ? (
                  <span class="config-tab-soon">
                    {TAB_LABELS[key]}
                    <span class="tag tag-quiet">Bientôt</span>
                    {/* REV-32: a screen reader hears that it is no link yet. */}
                    <span class="visually-hidden"> : pas encore disponible</span>
                  </span>
                ) : (
                  <a href={`${routes.repoConfig.href({ id: view.id })}?tab=${key}`} aria-current={key === tab ? 'page' : undefined}>
                    {TAB_LABELS[key]}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <div class="config-panel">
          {tab === 'models' ? (
            <ModelsTab resolved={resolved.models} providers={providers} ctx={ctx} />
          ) : tab === 'levels' ? (
            <LevelsTab level={resolved.level} ctx={ctx} />
          ) : tab === 'trigger' ? (
            <TriggerTab
              trigger={resolved.trigger}
              paths={resolved.paths}
              cap={resolved.monthlyCapUsd}
              spent={view.spentThisMonthUsd}
              trustedBots={view.trustedBots}
              ctx={ctx}
            />
          ) : tab === 'rules' && rules ? (
            <RulesTab rules={rules} repoId={view.id} name={name} admin={admin} csrf={frame.csrfToken} />
          ) : (
            <section class="empty" aria-labelledby="later-title">
              <h2 id="later-title">Bientôt ici</h2>
              <p>
                {tab === 'rules'
                  ? 'Les règles du repo et de l’organisation, envoyées au modèle selon les chemins du diff, arrivent bientôt.'
                  : 'Les règles d’assignation (qui déclenche quoi, à quel niveau) arrivent bientôt.'}
              </p>
            </section>
          )}
        </div>
      </Shell>
    )
  }
}

interface FormContext {
  csrf: string | null
  repoId: string
  version: number
  admin: boolean
  form: ConfigForm | null
}

function Hidden(handle: Handle<{ ctx: FormContext; field: string }>) {
  return () => <VersionFields csrf={handle.props.ctx.csrf} version={handle.props.ctx.version} field={handle.props.field} />
}

/** « hérité de l’org » or « remplacé ici ». The word carries the meaning; the colour only repeats it. */
function SourceTag(handle: Handle<{ source: Source }>) {
  return () =>
    handle.props.source === 'repo' ? <span class="tag tag-info">remplacé ici</span> : <span class="tag tag-quiet">hérité de l’org</span>
}

/** « Revenir à l’org »: a form of its own, shown only for a value that the repository sets. */
function RepoReset(handle: Handle<{ ctx: FormContext; field: ConfigField; label: string }>) {
  return () => {
    let { ctx, field, label } = handle.props
    let action = routes.repoConfigReset.href({ id: ctx.repoId })
    return <ResetForm action={action} csrf={ctx.csrf} version={ctx.version} field={field} to="l’org" label={label} />
  }
}

function ModelsTab(handle: Handle<{ resolved: Record<Level, Resolved<LevelModels>>; providers: ProviderOption[]; ctx: FormContext }>) {
  return () => {
    let { resolved, providers, ctx } = handle.props
    return (
      <>
        <p class="hint config-intro">
          Le modèle de chaque niveau, puis son repli si l’appel échoue. Le runner applique la config du moment où le job est
          mis en file.
        </p>
        <div class="config-grid">
          {LEVELS.map((level) => (
            <LevelCard level={level} value={resolved[level]} providers={providers} ctx={ctx} />
          ))}
        </div>
      </>
    )
  }
}

function LevelCard(handle: Handle<{ level: Level; value: Resolved<LevelModels>; providers: ProviderOption[]; ctx: FormContext }>) {
  return () => {
    let { level, value, providers, ctx } = handle.props
    let field: ConfigField = `models.${level}`
    let mine = ctx.form?.field === field ? ctx.form : null
    let errors = mine?.errors ?? {}
    let first = firstInvalid(errors, ['provider', 'model', 'fallback'])
    let current = value.value
    let effective = effectiveLevel(level, value, providers)
    // Nothing chosen, in the repository or the org: the form shows what runs, the provider « Par défaut ».
    let shown = value.source === 'kento' ? { provider: effective.provider.id, model: effective.model ?? '', fallback: effective.fallback } : current
    let values = mine?.values ?? { provider: shown.provider, model: shown.model, fallback: shown.fallback ?? '' }
    let id = `level-${level}`
    let providerId = `${id}-provider`
    let modelId = `${id}-model`
    let fallbackId = `${id}-fallback`
    let selected = values.provider ?? ''
    return (
      <section class="card config-card" id={id} aria-labelledby={`${id}-title`}>
        <header class="config-card-head">
          <h2 class="section-title mono" id={`${id}-title`}>
            {level}
          </h2>
          <SourceTag source={value.source} />
        </header>
        <EffectiveLine effective={effective} scope="repo" source={value.source} />
        {ctx.admin ? (
          <>
            <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })} noValidate>
              <Hidden ctx={ctx} field={field} />
              <FormErrors errors={errors} />
              <div class="field">
                <label class="field-label" for={providerId}>
                  Provider
                </label>
                <select
                  class="input"
                  id={providerId}
                  name="provider"
                  {...focusIf(first, 'provider')}
                  aria-invalid={errors.provider ? 'true' : undefined}
                  aria-describedby={describedBy(providerId, errors.provider, true)}
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
                <FieldMessage id={providerId} error={errors.provider} hint={providers.find((p) => p.id === selected)?.hint ?? 'Ce provider n’est plus dans l’organisation.'} />
              </div>
              <div class="field">
                <label class="field-label" for={modelId}>
                  Modèle
                </label>
                <input
                  class="input mono"
                  id={modelId}
                  name="model"
                  value={values.model ?? ''}
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  {...focusIf(first, 'model')}
                  aria-invalid={errors.model ? 'true' : undefined}
                  aria-describedby={describedBy(modelId, errors.model, false)}
                />
                <FieldMessage id={modelId} error={errors.model} />
              </div>
              <div class="field">
                <label class="field-label" for={fallbackId}>
                  Repli si l’appel échoue
                </label>
                <input
                  class="input mono"
                  id={fallbackId}
                  name="fallback"
                  value={values.fallback ?? ''}
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  {...focusIf(first, 'fallback')}
                  aria-invalid={errors.fallback ? 'true' : undefined}
                  aria-describedby={describedBy(fallbackId, errors.fallback, true)}
                />
                <FieldMessage id={fallbackId} error={errors.fallback} hint="Un autre modèle du même provider. Laissez vide pour ne pas en avoir." />
              </div>
              {value.source === 'kento' && effective.origin === 'default' ? (
                <p class="hint">Remplacer ici fixe ce choix pour le repo, et le niveau ne suivra plus le provider « Par défaut ».</p>
              ) : null}
              <button class="button" type="submit">
                {value.source === 'repo' ? 'Enregistrer' : 'Remplacer ici'}
                <span class="visually-hidden"> pour {level}</span>
              </button>
            </form>
            {value.source === 'repo' ? <RepoReset ctx={ctx} field={field} label={level} /> : null}
          </>
        ) : null}
      </section>
    )
  }
}

function LevelsTab(handle: Handle<{ level: Resolved<Level>; ctx: FormContext }>) {
  return () => {
    let { level: resolvedLevel, ctx } = handle.props
    let level = resolvedLevel.value
    let mine = ctx.form?.field === 'level' ? ctx.form : null
    let selected = mine?.values.defaultLevel ?? level
    return (
      <div class="config-grid">
        <section class="card config-card" aria-labelledby="default-level-title">
          <header class="config-card-head">
            <h2 class="section-title" id="default-level-title">
              Niveau par défaut
            </h2>
            <SourceTag source={resolvedLevel.source} />
          </header>
          <p class="hint">Le niveau de la review d’un push. Une commande peut en demander un autre.</p>
          {ctx.admin ? (
            <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })}>
              <Hidden ctx={ctx} field="level" />
              <FormErrors errors={mine?.errors ?? {}} />
              <fieldset class="field" aria-describedby={mine?.errors.defaultLevel ? 'default-level-error' : undefined}>
                <legend class="visually-hidden">Niveau par défaut</legend>
                {LEVELS.map((key) => (
                  <label class="choice">
                    <input
                      type="radio"
                      name="defaultLevel"
                      value={key}
                      checked={key === selected}
                      autoFocus={mine?.errors.defaultLevel && key === radioFocus(selected, LEVELS) ? true : undefined}
                    />
                    <span>
                      <strong class="mono">{key}</strong>. {LEVEL_HINTS[key]}
                    </span>
                  </label>
                ))}
                {mine?.errors.defaultLevel ? (
                  <p class="field-error" id="default-level-error">
                    {mine.errors.defaultLevel}
                  </p>
                ) : null}
              </fieldset>
              <button class="button button-primary" type="submit">
                {resolvedLevel.source === 'repo' ? 'Enregistrer le niveau' : 'Remplacer ici'}
                {resolvedLevel.source === 'repo' ? null : <span class="visually-hidden"> le niveau</span>}
              </button>
            </form>
          ) : null}
          {ctx.admin && resolvedLevel.source === 'repo' ? <RepoReset ctx={ctx} field="level" label="le niveau" /> : null}
          {ctx.admin ? null : (
            <p>
              <strong class="mono">{level}</strong>. {LEVEL_HINTS[level]}
            </p>
          )}
        </section>
        <section class="card config-card" aria-labelledby="passes-title">
          <header class="config-card-head">
            <h2 class="section-title" id="passes-title">
              Passes et vérification
            </h2>
            <span class="tag tag-quiet">Bientôt</span>
          </header>
          <dl class="config-facts">
            <div>
              <dt>Plan des passes</dt>
              <dd>Une passe</dd>
            </div>
            <div>
              <dt>Vérification</dt>
              <dd>Aucune</dd>
            </div>
          </dl>
          <p class="hint">Les passes multiples et la vérification des findings arrivent bientôt.</p>
        </section>
      </div>
    )
  }
}

interface TriggerTabProps {
  trigger: Resolved<Trigger>
  paths: Resolved<string[]>
  cap: Resolved<number | null>
  spent: number
  trustedBots: string[]
  ctx: FormContext
}

function TriggerTab(handle: Handle<TriggerTabProps>) {
  return () => {
    let { trigger, paths, cap, spent, trustedBots, ctx } = handle.props
    let form = (field: ConfigField) => (ctx.form?.field === field ? ctx.form : null)
    let triggerForm = form('trigger')
    let pathsForm = form('paths')
    let capForm = form('monthlyCapUsd')
    let selectedTrigger = triggerForm?.values.trigger ?? trigger.value
    let pathsValue = pathsForm?.values.paths ?? paths.value.join('\n')
    let capValue = capForm?.values.monthlyCapUsd ?? moneyInput(cap.value)
    let reached = cap.value !== null && spent >= cap.value
    return (
      <div class="config-grid">
        <section class="card config-card" aria-labelledby="trigger-title">
          <header class="config-card-head">
            <h2 class="section-title" id="trigger-title">
              Déclenchement
            </h2>
            <SourceTag source={trigger.source} />
          </header>
          {ctx.admin ? (
            <>
              <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })}>
                <Hidden ctx={ctx} field="trigger" />
                <FormErrors errors={triggerForm?.errors ?? {}} />
                <fieldset class="field" aria-describedby={triggerForm?.errors.trigger ? 'trigger-error' : undefined}>
                  <legend class="visually-hidden">Ce qui crée une review</legend>
                  {TRIGGER_CHOICES.map((choice) => (
                    <label class="choice">
                      <input
                        type="radio"
                        name="trigger"
                        value={choice.value}
                        checked={choice.value === selectedTrigger}
                        autoFocus={
                          triggerForm?.errors.trigger &&
                          choice.value ===
                            radioFocus(
                              selectedTrigger,
                              TRIGGER_CHOICES.map((c) => c.value),
                            )
                            ? true
                            : undefined
                        }
                      />
                      <span>
                        <strong>{choice.title}</strong>. {choice.text}
                      </span>
                    </label>
                  ))}
                  {triggerForm?.errors.trigger ? (
                    <p class="field-error" id="trigger-error">
                      {triggerForm.errors.trigger}
                    </p>
                  ) : null}
                </fieldset>
                <button class="button button-primary" type="submit">
                  {trigger.source === 'repo' ? 'Enregistrer' : 'Remplacer ici'}
                  <span class="visually-hidden"> le déclenchement</span>
                </button>
              </form>
              {trigger.source === 'repo' ? <RepoReset ctx={ctx} field="trigger" label="le déclenchement" /> : null}
            </>
          ) : (
            <p>
              <strong>{TRIGGER_CHOICES.find((c) => c.value === trigger.value)!.title}</strong>.{' '}
              {TRIGGER_CHOICES.find((c) => c.value === trigger.value)!.text}
            </p>
          )}
          <p class="hint">Un brouillon ne crée jamais de review automatique.</p>
        </section>

        <section class="card config-card" aria-labelledby="paths-title">
          <header class="config-card-head">
            <h2 class="section-title" id="paths-title">
              Chemins
            </h2>
            <SourceTag source={paths.source} />
          </header>
          {ctx.admin ? (
            <>
              <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })} noValidate>
                <Hidden ctx={ctx} field="paths" />
                <FormErrors errors={pathsForm?.errors ?? {}} />
                <div class="field">
                  <label class="field-label" for="config-paths">
                    Une review automatique seulement si la PR touche l’un de ces chemins
                  </label>
                  <textarea
                    class="input mono config-paths"
                    id="config-paths"
                    name="paths"
                    rows={5}
                    spellCheck={false}
                    autoFocus={pathsForm?.errors.paths ? true : undefined}
                    aria-invalid={pathsForm?.errors.paths ? 'true' : undefined}
                    aria-describedby={describedBy('config-paths', pathsForm?.errors.paths, true)}
                    value={pathsValue}
                  ></textarea>
                  <FieldMessage
                    id="config-paths"
                    error={pathsForm?.errors.paths}
                    hint={
                      <>
                        Un motif par ligne depuis la racine, {MAX_PATHS} au plus : <code>apps/web</code> (un dossier),{' '}
                        <code>**/*.sql</code>, <code>src/*.ts</code>. Laissez vide pour relire tous les chemins.
                      </>
                    }
                  />
                </div>
                <button class="button button-primary" type="submit">
                  {paths.source === 'repo' ? 'Enregistrer' : 'Remplacer ici'}
                  <span class="visually-hidden"> les chemins</span>
                </button>
              </form>
              {paths.source === 'repo' ? <RepoReset ctx={ctx} field="paths" label="les chemins" /> : null}
            </>
          ) : paths.value.length === 0 ? (
            <p>Tous les chemins.</p>
          ) : (
            <ul class="config-paths-list">
              {paths.value.map((pattern) => (
                <li class="mono">{pattern}</li>
              ))}
            </ul>
          )}
        </section>

        <section class="card config-card" aria-labelledby="cap-title">
          <header class="config-card-head">
            <h2 class="section-title" id="cap-title">
              Plafond mensuel
            </h2>
            <SourceTag source={cap.source} />
          </header>
          <p class={reached ? 'hint hint-alert' : 'hint'}>
            Dépensé ce mois-ci : {usd(spent)}
            {cap.value !== null ? ` sur ${usd(cap.value)}` : ''}
            {reached ? ' : plafond atteint, plus de review automatique jusqu’au 1er du mois.' : '.'}
          </p>
          {ctx.admin ? (
            <>
              <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })} noValidate>
                <Hidden ctx={ctx} field="monthlyCapUsd" />
                <FormErrors errors={capForm?.errors ?? {}} />
                <div class="field">
                  <label class="field-label" for="config-cap">
                    Plafond des reviews automatiques, en dollars par mois
                  </label>
                  <input
                    class="input mono config-cap"
                    id="config-cap"
                    name="monthlyCapUsd"
                    value={capValue}
                    inputMode="decimal"
                    autoComplete="off"
                    autoFocus={capForm?.errors.monthlyCapUsd ? true : undefined}
                    aria-invalid={capForm?.errors.monthlyCapUsd ? 'true' : undefined}
                    aria-describedby={describedBy('config-cap', capForm?.errors.monthlyCapUsd, true)}
                  />
                  <FieldMessage
                    id="config-cap"
                    error={capForm?.errors.monthlyCapUsd}
                    hint="Laissez vide pour n’avoir aucun plafond. Une commande @kento-review passe toujours, car quelqu’un l’a demandée."
                  />
                </div>
                <button class="button button-primary" type="submit">
                  {cap.source === 'repo' ? 'Enregistrer' : 'Remplacer ici'}
                  <span class="visually-hidden"> le plafond</span>
                </button>
              </form>
              {cap.source === 'repo' ? <RepoReset ctx={ctx} field="monthlyCapUsd" label="le plafond" /> : null}
            </>
          ) : (
            <p>{cap.value === null ? 'Aucun plafond.' : `${usd(cap.value)} par mois.`}</p>
          )}
        </section>

        <section class="card config-card" aria-labelledby="rights-title">
          <header class="config-card-head">
            <h2 class="section-title" id="rights-title">
              Droits
            </h2>
            <a class="tag tag-quiet" href={`${routes.settings.href()}#bots`}>
              réglage de l’org
            </a>
          </header>
          <dl class="config-facts">
            <div>
              <dt>Commande @kento-review</dt>
              <dd>
                Une personne qui a le droit d’écriture sur le repo
                {trustedBots.length > 0 ? (
                  <>
                    , ou un bot de confiance : <span class="mono">{trustedBots.join(', ')}</span>
                  </>
                ) : (
                  ' ; aucun bot de confiance'
                )}
                .
              </dd>
            </div>
            <div>
              <dt>PR d’un fork</dt>
              <dd>Aucun job tant qu’un admin ne l’autorise pas, car le code d’un fork n’est pas celui du repo.</dd>
            </div>
          </dl>
        </section>
      </div>
    )
  }
}

/**
 * REV-19. « Règles »: the rules of the repository, and a reminder of what else goes to the model with
 * them: the rules of the org, and CLAUDE.md and AGENTS.md of the repository.
 */
function RulesTab(handle: Handle<{ rules: ConfigRules; repoId: string; name: string; admin: boolean; csrf: string | null }>) {
  return () => {
    let { rules, repoId, name, admin, csrf } = handle.props
    let active = rules.list.filter((r) => r.active).length
    // A job carries MAX_JOB_RULES rules at most: those of the repository first, then those of the org.
    let over = active + rules.orgActive - MAX_JOB_RULES
    return (
      <div class="rules-layout">
        <section class="card config-card" id="rules" aria-labelledby="rules-title" tabIndex={-1}>
          <header class="config-card-head">
            <h2 class="section-title" id="rules-title">
              Règles de {name} <span class="count">{active}</span>
            </h2>
          </header>
          {over > 0 ? (
            <div class="banner banner-alert" role="note">
              <AlertIcon />
              <p>
                <strong>
                  Un job envoie {MAX_JOB_RULES} règles au plus : {over === 1 ? 'la dernière règle d’org active ne part pas' : `les ${over} dernières règles d’org actives ne partent pas`}
                </strong>{' '}
                avec les reviews de ce repo. Les règles du repo passent d’abord ; désactivez-en ou supprimez-en pour faire de la place.
              </p>
            </div>
          ) : null}
          <p class="hint">
            Le modèle vérifie chaque règle une par une, seulement quand la PR touche l’un de ses chemins. Un constat qui
            applique une règle la nomme dans son commentaire.
          </p>
          <RulesList
            scope="repo"
            repoId={repoId}
            rules={rules.list}
            admin={admin}
            csrf={csrf}
            form={rules.form}
            notice={rules.notice}
            noticeRule={rules.noticeRule}
          />
        </section>
        <aside class="card config-card rules-also" aria-labelledby="rules-also-title">
          <h2 class="section-title" id="rules-also-title">
            Part aussi au modèle
          </h2>
          <ul class="rules-also-list">
            <li>
              <a href={`${routes.settings.href()}#regles`}>
                {rules.orgActive === 0 ? 'Aucune règle d’org' : rules.orgActive === 1 ? '1 règle d’org active' : `${rules.orgActive} règles d’org actives`}
              </a>
              , selon les mêmes chemins.
            </li>
            <li>
              <span class="mono">CLAUDE.md</span> et <span class="mono">AGENTS.md</span> à la racine du repo, s’ils font 400 lignes
              au plus.
            </li>
          </ul>
          <p class="hint">
            Les règles viennent de cet écran et des réglages de l’org, jamais du code d’une PR : un texte de la PR qui ressemble à
            une règle reste du code à relire.
          </p>
        </aside>
      </div>
    )
  }
}

function Notice(handle: Handle<{ notice: ConfigNotice }>) {
  return () => {
    let { notice } = handle.props
    if (notice.kind === 'conflict') {
      let by = notice.updatedBy ? ` par ${notice.updatedBy}` : ''
      let at = notice.updatedAt ? ` ${when(notice.updatedAt)}` : ''
      return (
        <div class="banner banner-alert" role="alert">
          <AlertIcon />
          <p>
            <strong>La config a changé entre-temps</strong> (v{notice.version}, modifiée{by}
            {at}). Rien n’a été enregistré. Relisez les valeurs ci-dessous, puis recommencez.
          </p>
        </div>
      )
    }
    return (
      <div class="banner banner-ok" role="status">
        <CheckIcon />
        <p>
          <strong>{notice.kind === 'saved' ? 'Config enregistrée' : 'Valeur de l’organisation reprise'}</strong> (v{notice.version}).
          Le prochain job l’applique ; un job déjà en file garde la sienne.
        </p>
      </div>
    )
  }
}
