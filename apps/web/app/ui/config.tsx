import type { Handle, RemixNode } from 'remix/component'

import type { Level } from '@sakuga-review/protocol'

import {
  LEVEL_KEYS,
  MAX_PATHS,
  resolveConfig,
  type ConfigField,
  type LevelModels,
  type Resolved,
  type Source,
  type Trigger,
} from '../repo-config/model.ts'
import type { ProviderOption } from '../repo-config/providers.ts'
import type { RepoConfigView } from '../repo-config/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { AlertIcon, CheckIcon } from './icons.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** The tabs of the screen, in their order. Rules and assignment come with M5. */
export const CONFIG_TABS = ['models', 'levels', 'trigger', 'rules', 'assignment'] as const
export type ConfigTab = (typeof CONFIG_TABS)[number]

const TAB_LABELS: Record<ConfigTab, string> = {
  models: 'Provider et modèles',
  levels: 'Niveaux et passes',
  trigger: 'Déclenchement',
  rules: 'Règles',
  assignment: 'Assignation',
}

/** The tab of a form: where the screen goes back after it. */
export function tabOf(field: ConfigField | 'level'): ConfigTab {
  if (field.startsWith('models.')) return 'models'
  if (field === 'level') return 'levels'
  return 'trigger'
}

export function isConfigTab(value: unknown): value is ConfigTab {
  return typeof value === 'string' && (CONFIG_TABS as readonly string[]).includes(value)
}

export type ConfigNotice =
  | { kind: 'saved'; version: number }
  | { kind: 'reset'; version: number }
  /** The form came from an older version: nothing was written. */
  | { kind: 'conflict'; version: number; updatedBy: string | null; updatedAt: Date | null }

/** A form sent back with its errors: its values stay, under the field that it changes. */
export interface ConfigForm {
  field: ConfigField | 'level'
  values: Record<string, string>
  errors: Record<string, string>
}

export interface ConfigPageProps {
  frame: PageFrame
  view: RepoConfigView
  providers: ProviderOption[]
  tab: ConfigTab
  notice: ConfigNotice | null
  form: ConfigForm | null
  /** KENTO_TRUSTED_BOTS: the bots that can give a command. */
  trustedBots: string[]
}

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' })
const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
const USD = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** « le 27 oct. à 18:02 ». */
function when(date: Date): string {
  return `le ${DATE.format(date)} à ${TIME.format(date)}`
}

/** « config v7, modifiée par alex le 27 oct. à 18:02 ». */
export function versionLine(view: Pick<RepoConfigView, 'version' | 'updatedBy' | 'updatedAt'>): string {
  if (view.version === 0) return 'config v0 : tout est hérité de l’org'
  let by = view.updatedBy ? ` par ${view.updatedBy}` : ''
  let at = view.updatedAt ? ` ${when(view.updatedAt)}` : ''
  return `config v${view.version}, modifiée${by}${at}`
}

function shortName(fullName: string, org: string): string {
  let [owner, name] = fullName.split('/') as [string, string]
  return owner.toLowerCase() === org.toLowerCase() ? name : fullName
}

const LEVEL_HINTS: Record<Level, string> = {
  lite: 'Rapide, le moins cher : environ 1 centime une review.',
  balanced: 'Avec le code autour du changement : environ 5 centimes.',
  heavy: 'Plus de raisonnement : de 10 à 50 centimes.',
}

const TRIGGER_CHOICES: { value: Trigger; title: string; text: string }[] = [
  { value: 'push', title: 'À chaque push', text: 'chaque push d’une PR qui n’est pas un brouillon, et son passage en « Ready for review ».' },
  {
    value: 'ready',
    title: 'Au passage en « Ready for review »',
    text: 'une review à l’ouverture d’une PR prête, à son passage en « Ready for review » et à sa réouverture ; les pushs suivants n’en créent pas.',
  },
  { value: 'command', title: 'À la demande', text: 'aucune review automatique : seule une commande @kento review en crée une.' },
]

/**
 * « Config de orchard » (REV-12): the default level, a provider and a model for each level with their
 * fallback, and what triggers a review. An admin of the org edits; a member reads.
 */
export function ConfigPage(handle: Handle<ConfigPageProps>) {
  return () => {
    let { frame, view, providers, tab, notice, form, trustedBots } = handle.props
    let viewer = frame.viewer!
    let admin = viewer.role === 'admin'
    let name = shortName(view.fullName, viewer.org.login)
    let resolved = resolveConfig(view.orgConfig, view.config)
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
                <a href={`${routes.repoConfig.href({ id: view.id })}?tab=${key}`} aria-current={key === tab ? 'page' : undefined}>
                  {TAB_LABELS[key]}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div class="config-panel">
          {tab === 'models' ? (
            <ModelsTab resolved={resolved.models} providers={providers} ctx={ctx} />
          ) : tab === 'levels' ? (
            <LevelsTab level={view.defaultLevel} ctx={ctx} />
          ) : tab === 'trigger' ? (
            <TriggerTab
              trigger={resolved.trigger}
              paths={resolved.paths}
              cap={resolved.monthlyCapUsd}
              spent={view.spentThisMonthUsd}
              trustedBots={trustedBots}
              ctx={ctx}
            />
          ) : (
            <section class="empty" aria-labelledby="later-title">
              <h2 id="later-title">Bientôt ici</h2>
              <p>
                {tab === 'rules'
                  ? 'Les règles du repo et de l’org, envoyées au modèle selon les chemins du diff, arrivent avec M5.'
                  : 'Les règles d’assignation (qui déclenche quoi, à quel niveau) arrivent avec M5.'}
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
  return () => {
    let { ctx, field } = handle.props
    return (
      <>
        {ctx.csrf ? <input type="hidden" name="_csrf" value={ctx.csrf} /> : null}
        <input type="hidden" name="version" value={String(ctx.version)} />
        <input type="hidden" name="field" value={field} />
      </>
    )
  }
}

/** « hérité de l’org » or « remplacé ici ». The word carries the meaning; the colour only repeats it. */
function SourceTag(handle: Handle<{ source: Source }>) {
  return () =>
    handle.props.source === 'repo' ? <span class="tag tag-info">remplacé ici</span> : <span class="tag tag-quiet">hérité de l’org</span>
}

/** « Revenir à l’org »: a form of its own, shown only for a value that the repository sets. */
function ResetForm(handle: Handle<{ ctx: FormContext; field: ConfigField; label: string }>) {
  return () => {
    let { ctx, field, label } = handle.props
    return (
      <form method="post" action={routes.repoConfigReset.href({ id: ctx.repoId })}>
        <Hidden ctx={ctx} field={field} />
        <button class="button" type="submit">
          Revenir à l’org<span class="visually-hidden"> pour {label}</span>
        </button>
      </form>
    )
  }
}

function FieldError(handle: Handle<{ id: string; error: string | undefined; hint?: RemixNode }>) {
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
          {LEVEL_KEYS.map((level) => (
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
    let current = value.value
    let values = mine?.values ?? { provider: current.provider, model: current.model, fallback: current.fallback ?? '' }
    let id = `level-${level}`
    let providerLabel = providers.find((p) => p.id === current.provider)?.label ?? current.provider
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
        {ctx.admin ? (
          <>
            <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })} noValidate>
              <Hidden ctx={ctx} field={field} />
              <div class="field">
                <label class="field-label" for={providerId}>
                  Provider
                </label>
                <select
                  class="input"
                  id={providerId}
                  name="provider"
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
                <FieldError id={providerId} error={errors.provider} hint={providers.find((p) => p.id === selected)?.hint ?? 'Ce provider n’est plus dans l’org.'} />
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
                  aria-invalid={errors.model ? 'true' : undefined}
                  aria-describedby={describedBy(modelId, errors.model, false)}
                />
                <FieldError id={modelId} error={errors.model} />
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
                  aria-invalid={errors.fallback ? 'true' : undefined}
                  aria-describedby={describedBy(fallbackId, errors.fallback, true)}
                />
                <FieldError id={fallbackId} error={errors.fallback} hint="Un autre modèle du même provider. Vide : pas de repli." />
              </div>
              <button class="button button-primary" type="submit">
                {value.source === 'repo' ? 'Enregistrer' : 'Remplacer ici'}
                <span class="visually-hidden"> pour {level}</span>
              </button>
            </form>
            {value.source === 'repo' ? <ResetForm ctx={ctx} field={field} label={level} /> : null}
          </>
        ) : (
          <dl class="config-facts">
            <div>
              <dt>Modèle</dt>
              <dd>
                <span class="mono">{current.model}</span> <span class="hint">via {providerLabel}</span>
              </dd>
            </div>
            <div>
              <dt>Repli</dt>
              <dd>{current.fallback ? <span class="mono">{current.fallback}</span> : 'aucun'}</dd>
            </div>
          </dl>
        )}
      </section>
    )
  }
}

function LevelsTab(handle: Handle<{ level: Level; ctx: FormContext }>) {
  return () => {
    let { level, ctx } = handle.props
    let mine = ctx.form?.field === 'level' ? ctx.form : null
    let selected = mine?.values.defaultLevel ?? level
    return (
      <div class="config-grid">
        <section class="card config-card" aria-labelledby="default-level-title">
          <header class="config-card-head">
            <h2 class="section-title" id="default-level-title">
              Niveau par défaut
            </h2>
          </header>
          <p class="hint">Le niveau de la review d’un push. Une commande peut en demander un autre.</p>
          {ctx.admin ? (
            <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })}>
              <Hidden ctx={ctx} field="level" />
              <fieldset class="field" aria-describedby={mine?.errors.defaultLevel ? 'default-level-error' : undefined}>
                <legend class="visually-hidden">Niveau par défaut</legend>
                {LEVEL_KEYS.map((key) => (
                  <label class="choice">
                    <input type="radio" name="defaultLevel" value={key} checked={key === selected} />
                    <span>
                      <strong class="mono">{key}</strong> — {LEVEL_HINTS[key]}
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
                Enregistrer le niveau
              </button>
            </form>
          ) : (
            <p>
              <strong class="mono">{level}</strong> — {LEVEL_HINTS[level]}
            </p>
          )}
        </section>
        <section class="card config-card" aria-labelledby="passes-title">
          <header class="config-card-head">
            <h2 class="section-title" id="passes-title">
              Passes et vérification
            </h2>
            <span class="tag tag-quiet">jusqu’à M5</span>
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
          <p class="hint">Les passes multiples et la vérification des findings arrivent avec M5, mesurées sur le bench.</p>
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
    let capValue = capForm?.values.monthlyCapUsd ?? (cap.value === null ? '' : Number.isInteger(cap.value) ? String(cap.value) : cap.value.toFixed(2).replace('.', ','))
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
                <fieldset class="field" aria-describedby={triggerForm?.errors.trigger ? 'trigger-error' : undefined}>
                  <legend class="visually-hidden">Ce qui crée une review</legend>
                  {TRIGGER_CHOICES.map((choice) => (
                    <label class="choice">
                      <input type="radio" name="trigger" value={choice.value} checked={choice.value === selectedTrigger} />
                      <span>
                        <strong>{choice.title}</strong> — {choice.text}
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
              {trigger.source === 'repo' ? <ResetForm ctx={ctx} field="trigger" label="le déclenchement" /> : null}
            </>
          ) : (
            <p>
              <strong>{TRIGGER_CHOICES.find((c) => c.value === trigger.value)!.title}</strong> —{' '}
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
                    aria-invalid={pathsForm?.errors.paths ? 'true' : undefined}
                    aria-describedby={describedBy('config-paths', pathsForm?.errors.paths, true)}
                    value={pathsValue}
                  ></textarea>
                  <FieldError
                    id="config-paths"
                    error={pathsForm?.errors.paths}
                    hint={
                      <>
                        Un motif par ligne depuis la racine, {MAX_PATHS} au plus : <code>apps/web</code> (un dossier),{' '}
                        <code>**/*.sql</code>, <code>src/*.ts</code>. Vide : tous les chemins.
                      </>
                    }
                  />
                </div>
                <button class="button button-primary" type="submit">
                  {paths.source === 'repo' ? 'Enregistrer' : 'Remplacer ici'}
                  <span class="visually-hidden"> les chemins</span>
                </button>
              </form>
              {paths.source === 'repo' ? <ResetForm ctx={ctx} field="paths" label="les chemins" /> : null}
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
            Dépensé ce mois-ci : {USD.format(spent)}
            {cap.value !== null ? ` sur ${USD.format(cap.value)}` : ''}
            {reached ? ' : plafond atteint, plus de review automatique jusqu’au 1er du mois.' : '.'}
          </p>
          {ctx.admin ? (
            <>
              <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })} noValidate>
                <Hidden ctx={ctx} field="monthlyCapUsd" />
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
                    aria-invalid={capForm?.errors.monthlyCapUsd ? 'true' : undefined}
                    aria-describedby={describedBy('config-cap', capForm?.errors.monthlyCapUsd, true)}
                  />
                  <FieldError
                    id="config-cap"
                    error={capForm?.errors.monthlyCapUsd}
                    hint="Vide : aucun plafond. Une commande @kento review passe toujours : quelqu’un l’a demandée."
                  />
                </div>
                <button class="button button-primary" type="submit">
                  {cap.source === 'repo' ? 'Enregistrer' : 'Remplacer ici'}
                  <span class="visually-hidden"> le plafond</span>
                </button>
              </form>
              {cap.source === 'repo' ? <ResetForm ctx={ctx} field="monthlyCapUsd" label="le plafond" /> : null}
            </>
          ) : (
            <p>{cap.value === null ? 'Aucun plafond.' : `${USD.format(cap.value)} par mois.`}</p>
          )}
        </section>

        <section class="card config-card" aria-labelledby="rights-title">
          <header class="config-card-head">
            <h2 class="section-title" id="rights-title">
              Droits
            </h2>
            <span class="tag tag-quiet">non modifiable</span>
          </header>
          <dl class="config-facts">
            <div>
              <dt>Commande @kento</dt>
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
              <dd>Aucun job tant qu’un admin ne l’autorise pas : le code d’un fork n’est pas celui du repo.</dd>
            </div>
          </dl>
        </section>
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
            {at}). Rien n’a été enregistré : relisez les valeurs ci-dessous, puis recommencez.
          </p>
        </div>
      )
    }
    return (
      <div class="banner banner-ok" role="status">
        <CheckIcon />
        <p>
          <strong>{notice.kind === 'saved' ? 'Config enregistrée' : 'Valeur de l’org reprise'}</strong> (v{notice.version}).
          Le prochain job l’applique ; un job déjà en file garde la sienne.
        </p>
      </div>
    )
  }
}
