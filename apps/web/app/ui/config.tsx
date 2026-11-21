import type { Handle } from 'remix/component'

import { levelCost } from '@kento-review/engine/levels'
import { isOneOf, LEVELS, MAX_JOB_RULES, type Level } from '@kento-review/protocol'

import {
  MAX_PATHS,
  resolveConfig,
  type ConfigField,
  type LevelModels,
  type Resolved,
  type Source,
  type Trigger,
} from '../repo-config/model.ts'
import { mention } from '../instance.ts'
import { effectiveLevel } from '../repo-config/effective.ts'
import type { ProviderOption } from '../repo-config/providers.ts'
import type { RepoConfigView } from '../repo-config/store.ts'
import type { RuleView } from '../rules/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Button, Choice, Input, Select, Textarea, buttonClass } from './controls.tsx'
import { EffectiveLine } from './effective.tsx'
import { FormErrors, firstInvalid, focusIf, radioFocus } from './form-errors.tsx'
import { describedBy, FieldMessage, ResetForm, VersionFields, versionLine as sharedVersionLine } from './form-fields.tsx'
import { moneyInput, usd, when } from './format.ts'
import { AlertIcon, CheckIcon } from './icons.tsx'
import { AssignmentTab, type AssignmentTabProps } from './assignment.tsx'
import { RulesList, type RuleFormState, type RuleNotice } from './rules.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** The tabs of the screen, in their order. Rules come with REV-19, assignment with REV-21. */
export const CONFIG_TABS = ['models', 'levels', 'trigger', 'rules', 'assignment'] as const
export type ConfigTab = (typeof CONFIG_TABS)[number]


const TAB_LABELS: Record<ConfigTab, string> = {
  models: 'Provider and models',
  levels: 'Levels and passes',
  trigger: 'Trigger',
  rules: 'Rules',
  assignment: 'Assignment',
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

/** REV-19. The tab Rules: the rules of the repository, and what else goes to the model. */
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
  /** Null: the service has no rules; the tab says "Soon". */
  rules?: ConfigRules | null
  /** REV-21. The tab Assignment. Null: the service has no assignment rules; the tab says "Soon". */
  assignment?: Omit<AssignmentTabProps, 'repoId' | 'defaultLevel' | 'admin' | 'csrf'> | null
}

/** "config v7, changed by octocat on 27 Oct at 18:02". */
export function versionLine(view: Pick<RepoConfigView, 'version' | 'updatedBy' | 'updatedAt'>): string {
  return sharedVersionLine({ name: 'config', changed: 'changed', empty: 'config v0, everything comes from the organization' }, view)
}

function shortName(fullName: string, org: string): string {
  let [owner, name] = fullName.split('/') as [string, string]
  return owner.toLowerCase() === org.toLowerCase() ? name : fullName
}

const LEVEL_HINTS: Record<Level, string> = {
  lite: `Fast and the cheapest, ${levelCost('lite')} per review.`,
  balanced: `Also reads the code around the change, ${levelCost('balanced')}.`,
  heavy: `Reasons for longer, ${levelCost('heavy')}.`,
}

const TRIGGER_CHOICES: { value: Trigger; title: string; text: string }[] = [
  { value: 'push', title: 'At each push', text: 'Each push of a PR that is not a draft, and its change to "Ready for review".' },
  {
    value: 'ready',
    title: 'When the PR becomes "Ready for review"',
    text: 'A review when a ready PR opens, when it becomes "Ready for review", and when it reopens. The later pushes create none.',
  },
  { value: 'command', title: 'On request', get text() { return `No automatic review. Only a ${mention()} command creates one.` } },
]

/**
 * "Config of orchard" (REV-12): the default level, a provider and a model for each level with their
 * fallback, and what triggers a review. An admin of the org edits; a member reads.
 */
export function ConfigPage(handle: Handle<ConfigPageProps>) {
  return () => {
    let { frame, view, providers, tab, notice, form, rules, assignment } = handle.props
    // REV-32. A tab that the service does not have yet: named in the bar, with "Soon" and no link.
    let soon = (key: ConfigTab) => (key === 'rules' && !rules) || (key === 'assignment' && !assignment)
    let viewer = frame.viewer!
    let admin = viewer.role === 'admin'
    let name = shortName(view.fullName, viewer.org.name)
    let resolved = resolveConfig(view.orgConfig, view.config, view.defaultLevel)
    let ctx: FormContext = { csrf: frame.csrfToken, repoId: view.id, version: view.version, admin, form }

    return (
      <Shell
        frame={frame}
        section="repos"
        title={`Config of ${name}`}
        lead={versionLine(view)}
        actions={
          <a class={buttonClass()} href={`${routes.repos.href()}#repo-${view.id}`}>
            Back to the repos
          </a>
        }
      >
        {notice ? <Notice notice={notice} /> : null}
        {!view.enabled ? (
          <div class="banner banner-info" role="status">
            <AlertIcon />
            <p>
              <strong>{name} is not enabled.</strong> This config applies to the jobs after an admin enables the repo on
              the Repos screen.
            </p>
          </div>
        ) : null}

        <nav class="config-tabs" aria-label="Sections of the config">
          <ul>
            {CONFIG_TABS.map((key) => (
              <li>
                {soon(key) && key !== tab ? (
                  <span class="config-tab-soon">
                    {TAB_LABELS[key]}
                    <span class="tag tag-quiet">Soon</span>
                    {/* REV-32: a screen reader hears that it is no link yet. */}
                    <span class="visually-hidden">: not available yet</span>
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
          ) : tab === 'assignment' && assignment ? (
            <AssignmentTab {...assignment} repoId={view.id} defaultLevel={resolved.level.value} admin={admin} csrf={frame.csrfToken} />
          ) : (
            <section class="empty" aria-labelledby="later-title">
              <h2 id="later-title">Soon here</h2>
              <p>
                {tab === 'rules'
                  ? 'The rules of the repo and of the organization, sent to the model by the paths of the diff, come soon.'
                  : 'The assignment rules (who triggers what, at which level) come soon.'}
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

/** "from the org" or "set for this repo". The word carries the meaning; the colour only repeats it. */
function SourceTag(handle: Handle<{ source: Source }>) {
  return () =>
    handle.props.source === 'repo' ? <span class="tag tag-info">set for this repo</span> : <span class="tag tag-quiet">from the org</span>
}

/** "Back to the org value": a form of its own, shown only for a value that the repository sets. */
function RepoReset(handle: Handle<{ ctx: FormContext; field: ConfigField; label: string }>) {
  return () => {
    let { ctx, field, label } = handle.props
    let action = routes.repoConfigReset.href({ id: ctx.repoId })
    return <ResetForm action={action} csrf={ctx.csrf} version={ctx.version} field={field} to="org" label={label} />
  }
}

function ModelsTab(handle: Handle<{ resolved: Record<Level, Resolved<LevelModels>>; providers: ProviderOption[]; ctx: FormContext }>) {
  return () => {
    let { resolved, providers, ctx } = handle.props
    return (
      <>
        <p class="hint config-intro">
          The model of each level, then its fallback if the call fails. The runner applies the config of the moment when the job
          enters the queue.
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
    // Nothing chosen, in the repository or the org: the form shows what runs, the "Default" provider.
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
                <Select
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
                      {selected} (not available)
                    </option>
                  ) : null}
                </Select>
                <FieldMessage id={providerId} error={errors.provider} hint={providers.find((p) => p.id === selected)?.hint ?? 'This provider is no longer in the organization.'} />
              </div>
              <div class="field">
                <label class="field-label" for={modelId}>
                  Model
                </label>
                <Input
                  class="mono"
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
                  Fallback if the call fails
                </label>
                <Input
                  class="mono"
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
                <FieldMessage id={fallbackId} error={errors.fallback} hint="Another model of the same provider. Leave it empty for none." />
              </div>
              {value.source === 'kento' && effective.origin === 'default' ? (
                <p class="hint">"Set here" fixes this choice for the repo, and the level no longer follows the "Default" provider.</p>
              ) : null}
              <Button type="submit">
                {value.source === 'repo' ? 'Save' : 'Set here'}
                <span class="visually-hidden"> for {level}</span>
              </Button>
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
              Default level
            </h2>
            <SourceTag source={resolvedLevel.source} />
          </header>
          <p class="hint">The level of the review of a push. A command can ask for another one.</p>
          {ctx.admin ? (
            <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })}>
              <Hidden ctx={ctx} field="level" />
              <FormErrors errors={mine?.errors ?? {}} />
              <fieldset class="field" aria-describedby={mine?.errors.defaultLevel ? 'default-level-error' : undefined}>
                <legend class="visually-hidden">Default level</legend>
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
                  <p class="field-error" id="default-level-error">
                    {mine.errors.defaultLevel}
                  </p>
                ) : null}
              </fieldset>
              <Button variant="primary" type="submit">
                {resolvedLevel.source === 'repo' ? 'Save the level' : 'Set here'}
                {resolvedLevel.source === 'repo' ? null : <span class="visually-hidden"> the level</span>}
              </Button>
            </form>
          ) : null}
          {ctx.admin && resolvedLevel.source === 'repo' ? <RepoReset ctx={ctx} field="level" label="the level" /> : null}
          {ctx.admin ? null : (
            <p>
              <strong class="mono">{level}</strong>. {LEVEL_HINTS[level]}
            </p>
          )}
        </section>
        <section class="card config-card" aria-labelledby="passes-title">
          <header class="config-card-head">
            <h2 class="section-title" id="passes-title">
              Passes and check
            </h2>
            <span class="tag tag-quiet">Soon</span>
          </header>
          <dl class="config-facts">
            <div>
              <dt>Plan of the passes</dt>
              <dd>One pass</dd>
            </div>
            <div>
              <dt>Check</dt>
              <dd>None</dd>
            </div>
          </dl>
          <p class="hint">Several passes and the check of the findings come soon.</p>
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
              Trigger
            </h2>
            <SourceTag source={trigger.source} />
          </header>
          {ctx.admin ? (
            <>
              <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })}>
                <Hidden ctx={ctx} field="trigger" />
                <FormErrors errors={triggerForm?.errors ?? {}} />
                <fieldset class="field" aria-describedby={triggerForm?.errors.trigger ? 'trigger-error' : undefined}>
                  <legend class="visually-hidden">What creates a review</legend>
                  {TRIGGER_CHOICES.map((choice) => (
                    <Choice
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
                      label={
                        <>
                          <strong>{choice.title}</strong>. {choice.text}
                        </>
                      }
                    />
                  ))}
                  {triggerForm?.errors.trigger ? (
                    <p class="field-error" id="trigger-error">
                      {triggerForm.errors.trigger}
                    </p>
                  ) : null}
                </fieldset>
                <Button variant="primary" type="submit">
                  {trigger.source === 'repo' ? 'Save' : 'Set here'}
                  <span class="visually-hidden"> the trigger</span>
                </Button>
              </form>
              {trigger.source === 'repo' ? <RepoReset ctx={ctx} field="trigger" label="the trigger" /> : null}
            </>
          ) : (
            <p>
              <strong>{TRIGGER_CHOICES.find((c) => c.value === trigger.value)!.title}</strong>.{' '}
              {TRIGGER_CHOICES.find((c) => c.value === trigger.value)!.text}
            </p>
          )}
          <p class="hint">A draft never creates an automatic review.</p>
        </section>

        <section class="card config-card" aria-labelledby="paths-title">
          <header class="config-card-head">
            <h2 class="section-title" id="paths-title">
              Paths
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
                    An automatic review only if the PR changes one of these paths
                  </label>
                  <Textarea
                    class="mono config-paths"
                    id="config-paths"
                    name="paths"
                    rows={5}
                    spellCheck={false}
                    autoFocus={pathsForm?.errors.paths ? true : undefined}
                    aria-invalid={pathsForm?.errors.paths ? 'true' : undefined}
                    aria-describedby={describedBy('config-paths', pathsForm?.errors.paths, true)}
                    value={pathsValue}
                  ></Textarea>
                  <FieldMessage
                    id="config-paths"
                    error={pathsForm?.errors.paths}
                    hint={
                      <>
                        One pattern per line from the root, {MAX_PATHS} at most: <code>apps/web</code> (a folder),{' '}
                        <code>**/*.sql</code>, <code>src/*.ts</code>. Leave it empty to review all paths.
                      </>
                    }
                  />
                </div>
                <Button variant="primary" type="submit">
                  {paths.source === 'repo' ? 'Save' : 'Set here'}
                  <span class="visually-hidden"> the paths</span>
                </Button>
              </form>
              {paths.source === 'repo' ? <RepoReset ctx={ctx} field="paths" label="the paths" /> : null}
            </>
          ) : paths.value.length === 0 ? (
            <p>All paths.</p>
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
              Monthly cap
            </h2>
            <SourceTag source={cap.source} />
          </header>
          <p class={reached ? 'hint hint-alert' : 'hint'}>
            Spent this month: {usd(spent)}
            {cap.value !== null ? ` of ${usd(cap.value)}` : ''}
            {reached ? '. Cap reached: no automatic review until the 1st of the month.' : '.'}
          </p>
          {ctx.admin ? (
            <>
              <form method="post" action={routes.repoConfigSave.href({ id: ctx.repoId })} noValidate>
                <Hidden ctx={ctx} field="monthlyCapUsd" />
                <FormErrors errors={capForm?.errors ?? {}} />
                <div class="field">
                  <label class="field-label" for="config-cap">
                    Cap of the automatic reviews, in dollars per month
                  </label>
                  <Input
                    class="mono config-cap"
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
                    hint={`Leave it empty for no cap. A ${mention()} command always runs, because a person asked for it.`}
                  />
                </div>
                <Button variant="primary" type="submit">
                  {cap.source === 'repo' ? 'Save' : 'Set here'}
                  <span class="visually-hidden"> the cap</span>
                </Button>
              </form>
              {cap.source === 'repo' ? <RepoReset ctx={ctx} field="monthlyCapUsd" label="the cap" /> : null}
            </>
          ) : (
            <p>{cap.value === null ? 'No cap.' : `${usd(cap.value)} per month.`}</p>
          )}
        </section>

        <section class="card config-card" aria-labelledby="rights-title">
          <header class="config-card-head">
            <h2 class="section-title" id="rights-title">
              Rights
            </h2>
            <a class="tag tag-quiet" href={`${routes.settings.href()}#bots`}>
              org setting
            </a>
          </header>
          <dl class="config-facts">
            <div>
              <dt>{mention()} command</dt>
              <dd>
                A person with write access to the repo
                {trustedBots.length > 0 ? (
                  <>
                    , or a trusted bot: <span class="mono">{trustedBots.join(', ')}</span>
                  </>
                ) : (
                  '. No trusted bot'
                )}
                .
              </dd>
            </div>
            <div>
              <dt>PR from a fork</dt>
              <dd>No job until an admin allows it, because the code of a fork is not the code of the repo.</dd>
            </div>
          </dl>
        </section>
      </div>
    )
  }
}

/**
 * REV-19. "Rules": the rules of the repository, and a reminder of what else goes to the model with
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
              Rules of {name} <span class="count">{active}</span>
            </h2>
          </header>
          {over > 0 ? (
            <div class="banner banner-alert" role="note">
              <AlertIcon />
              <p>
                <strong>
                  A job sends {MAX_JOB_RULES} rules at most. {over === 1 ? 'The last active org rule does not go' : `The last ${over} active org rules do not go`}
                </strong>{' '}
                with the reviews of this repo. The rules of the repo go first. Disable or delete some of them to make room.
              </p>
            </div>
          ) : null}
          <p class="hint">
            The model checks each rule one by one, only when the PR changes one of its paths. A finding that
            applies a rule names it in its comment.
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
            Also goes to the model
          </h2>
          <ul class="rules-also-list">
            <li>
              <a href={`${routes.settings.href()}#org-rules`}>
                {rules.orgActive === 0 ? 'No org rule' : rules.orgActive === 1 ? '1 active org rule' : `${rules.orgActive} active org rules`}
              </a>
              , by the same paths.
            </li>
            <li>
              <span class="mono">CLAUDE.md</span> and <span class="mono">AGENTS.md</span> at the root of the repo, if they have 400 lines
              at most.
            </li>
          </ul>
          <p class="hint">
            The rules come from this screen and from the settings of the org, never from the code of a PR. A text of the PR that looks
            like a rule is still code to review.
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
      let by = notice.updatedBy ? ` by ${notice.updatedBy}` : ''
      let at = notice.updatedAt ? ` ${when(notice.updatedAt)}` : ''
      return (
        <div class="banner banner-alert" role="alert">
          <AlertIcon />
          <p>
            <strong>The config changed in the meantime</strong> (v{notice.version}, changed{by}
            {at}). Nothing was saved. Read the values below again, then try again.
          </p>
        </div>
      )
    }
    return (
      <div class="banner banner-ok" role="status">
        <CheckIcon />
        <p>
          <strong>{notice.kind === 'saved' ? 'Config saved' : 'Value of the organization restored'}</strong> (v{notice.version}).
          The next job applies it. A job already in the queue keeps its own config.
        </p>
      </div>
    )
  }
}
