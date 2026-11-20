import { LEVELS as ENGINE_LEVELS } from '@kento-review/engine/levels'
import { isLevel, isOneOf, LEVELS, type Level, type ProviderKind } from '@kento-review/protocol'

// The config of a repository (REV-12) and of its org: what each key means, how the screen and the
// service read the JSON of the database, and how a repository inherits from its org. No database,
// no network.
//
// A key that a config does not hold is inherited: the repository takes the value of its org, and
// the org the value of Kentō. "Back to the org value" removes the key from the config of the repository.

/**
 * The provider of a level, its model, and the model of the same provider that takes over when the
 * call fails. `provider`: `service` (the key of the service, OpenRouter), or the id of a provider of
 * the org (REV-11).
 */
export interface LevelModels {
  provider: string
  model: string
  fallback: string | null
}

/**
 * What creates a review job without a command:
 * - `push`: each push of a pull request that is not a draft, and its passage to "Ready for review";
 * - `ready`: only the opening of a pull request that is not a draft, its passage to "Ready for
 *   review", and its reopening; a later push creates nothing;
 * - `command`: nothing. Only a command in a comment (`@kento-review`) creates a job.
 */
export const TRIGGERS = ['push', 'ready', 'command'] as const
export type Trigger = (typeof TRIGGERS)[number]

/** What a repository or an org sets. Each key is optional: absent, it is inherited. */
export interface ConfigOverrides {
  /**
   * REV-13. The level of the review of a push. A repository without it takes the level of its org,
   * then the column `repos.default_level` (an earlier release wrote only that), then `lite`.
   */
  level?: Level
  models?: Partial<Record<Level, LevelModels>>
  trigger?: Trigger
  /**
   * Paths of the repository, as patterns (`apps/web/**`, `*.md`). A pull request that changes no file
   * under one of them gets no automatic job. Empty: every path.
   */
  paths?: string[]
  /** The most that the automatic reviews of the repository can cost in a calendar month (UTC), in dollars. Null: no limit. */
  monthlyCapUsd?: number | null
}

/** The keys that "Back to the org value" removes one by one. */
export const CONFIG_FIELDS = ['level', 'models.lite', 'models.balanced', 'models.heavy', 'trigger', 'paths', 'monthlyCapUsd'] as const
export type ConfigField = (typeof CONFIG_FIELDS)[number]

/** Where a value of the resolved config comes from. */
export type Source = 'repo' | 'org' | 'kento'

export interface Resolved<T> {
  value: T
  source: Source
}

/** The config that a job applies: each key resolved, with where it came from. */
export interface ResolvedConfig {
  level: Resolved<Level>
  models: Record<Level, Resolved<LevelModels>>
  trigger: Resolved<Trigger>
  paths: Resolved<string[]>
  monthlyCapUsd: Resolved<number | null>
}

/** The provider of the service: OpenRouter, with the key of the service or of the runner (REV-11 names it `service`). */
export const SERVICE_PROVIDER = 'service'

/** The values of Kentō: the levels of the engine, every push, every path, no limit. */
export function kentoDefaults(): Required<ConfigOverrides> & { models: Record<Level, LevelModels> } {
  let models = {} as Record<Level, LevelModels>
  for (let level of LEVELS) {
    let [primary, fallback] = ENGINE_LEVELS[level].models
    models[level] = { provider: SERVICE_PROVIDER, model: primary!, fallback: fallback ?? null }
  }
  return { level: 'lite', models, trigger: 'push', paths: [], monthlyCapUsd: null }
}

/** Resolves a key: the repository, else its org, else Kentō. */
function pick<T>(repo: T | undefined, org: T | undefined, kento: T): Resolved<T> {
  if (repo !== undefined) return { value: repo, source: 'repo' }
  if (org !== undefined) return { value: org, source: 'org' }
  return { value: kento, source: 'kento' }
}

/**
 * `columnLevel`: `repos.default_level`. A release before REV-13 kept the level of a repository only
 * there; the migration 0010 copied every level other than `lite` into the config. A column that still
 * differs from `lite` without a key in the config counts as a choice of the repository.
 */
export function resolveConfig(org: ConfigOverrides, repo: ConfigOverrides, columnLevel: Level = 'lite'): ResolvedConfig {
  let kento = kentoDefaults()
  let models = {} as Record<Level, Resolved<LevelModels>>
  for (let level of LEVELS) models[level] = pick(repo.models?.[level], org.models?.[level], kento.models[level])
  let level: Resolved<Level> =
    repo.level === undefined && org.level === undefined && columnLevel !== kento.level
      ? { value: columnLevel, source: 'repo' }
      : pick(repo.level, org.level, kento.level)
  return {
    level,
    models,
    trigger: pick(repo.trigger, org.trigger, kento.trigger),
    paths: pick(repo.paths, org.paths, kento.paths),
    monthlyCapUsd: pick(repo.monthlyCapUsd, org.monthlyCapUsd, kento.monthlyCapUsd),
  }
}

/** What the service writes in `jobs.config` and sends to the runner: the models of the level of the job. */
export interface JobConfig {
  /** The version of the config of the repository when the job was queued; 0 before the first change. */
  repoConfigVersion: number
  models: LevelModels
  /** Where the models came from, for the logs. */
  source: Source
  /** REV-21. The assignment rule that set the level of a job of a push (`JobAssignment`). The runner never reads it. */
  assignment?: unknown
}

export function jobConfig(resolved: ResolvedConfig, level: Level, repoConfigVersion: number): JobConfig {
  let models = resolved.models[level]
  return { repoConfigVersion, models: models.value, source: models.source }
}

// --- The JSON of the database -----------------------------------------------------------------

/** As MODEL_ID of the protocol (REV-11): an id of a model at its provider. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const MAX_PATHS = 20
export const MAX_PATH_LENGTH = 200
/** The highest monthly limit that the screen takes: the column of the costs holds less than 10,000 dollars a review. */
export const MAX_CAP_USD = 100_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A `jsonb` value as postgres.js gives it next to drizzle: parsed, or still a JSON string. */
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function readLevelModels(value: unknown): LevelModels | null {
  if (!isObject(value)) return null
  let { provider, model, fallback } = value
  if (typeof provider !== 'string' || !PROVIDER.test(provider)) return null
  if (typeof model !== 'string' || !MODEL.test(model)) return null
  if (fallback !== null && (typeof fallback !== 'string' || !MODEL.test(fallback))) return null
  return { provider, model, fallback }
}

/**
 * Reads a config of the database. A key with a wrong value is dropped, and so inherited: a row that
 * an older or newer release wrote never stops the enqueue of a job.
 */
export function readOverrides(json: unknown): ConfigOverrides {
  let value = parsed(json)
  if (!isObject(value)) return {}
  let out: ConfigOverrides = {}
  if (isLevel(value.level)) out.level = value.level
  if (isObject(value.models)) {
    let models: Partial<Record<Level, LevelModels>> = {}
    for (let level of LEVELS) {
      let entry = readLevelModels(value.models[level])
      if (entry) models[level] = entry
    }
    if (Object.keys(models).length > 0) out.models = models
  }
  if (isOneOf(TRIGGERS, value.trigger)) out.trigger = value.trigger
  if (Array.isArray(value.paths) && value.paths.length <= MAX_PATHS && value.paths.every((p) => typeof p === 'string' && checkPattern(p) === null)) {
    out.paths = value.paths as string[]
  }
  if (value.monthlyCapUsd === null) out.monthlyCapUsd = null
  else if (typeof value.monthlyCapUsd === 'number' && Number.isFinite(value.monthlyCapUsd) && value.monthlyCapUsd >= 0 && value.monthlyCapUsd <= MAX_CAP_USD) {
    out.monthlyCapUsd = value.monthlyCapUsd
  }
  return out
}

/** The config without one key: "Back to the org value". */
export function withoutField(config: ConfigOverrides, field: ConfigField): ConfigOverrides {
  let out: ConfigOverrides = { ...config, ...(config.models ? { models: { ...config.models } } : {}) }
  if (field.startsWith('models.')) {
    let level = field.slice('models.'.length) as Level
    delete out.models?.[level]
    if (out.models && Object.keys(out.models).length === 0) delete out.models
  } else {
    delete out[field as 'level' | 'trigger' | 'paths' | 'monthlyCapUsd']
  }
  return out
}

/** Whether the repository sets this key itself. */
export function hasField(config: ConfigOverrides, field: ConfigField): boolean {
  if (field.startsWith('models.')) return config.models?.[field.slice('models.'.length) as Level] !== undefined
  return config[field as 'level' | 'trigger' | 'paths' | 'monthlyCapUsd'] !== undefined
}

// --- Paths ------------------------------------------------------------------------------------

/** Why a pattern is refused, or null. */
export function checkPattern(pattern: string): string | null {
  if (pattern.length === 0) return 'an empty pattern'
  if (pattern.length > MAX_PATH_LENGTH) return `more than ${MAX_PATH_LENGTH} characters`
  if (pattern.startsWith('/')) return 'a path starts without "/", from the root of the repo'
  if (pattern.includes('\\') || [...pattern].some((char) => char.charCodeAt(0) < 0x20)) return 'a backslash or a control character'
  if (pattern.split('/').includes('..')) return '".." names nothing in a repo'
  return null
}

// The patterns of the trigger and of the rules of REV-19 have one meaning: packages/engine/src/paths.ts.
export { pathsMatch, patternToRegExp } from '@kento-review/engine/paths'

// --- The forms of the screen ------------------------------------------------------------------

export type FormResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> }

function field(form: FormData, name: string): string {
  let value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The form of one level: the provider, its model, then the fallback model (empty: none). The
 * provider must be one of `providers`, the providers that the org can use.
 */
export function readModelsForm(form: FormData, providers: readonly { id: string; kind: ProviderKind }[]): FormResult<LevelModels> {
  let errors: Record<string, string> = {}
  let provider = field(form, 'provider')
  let model = field(form, 'model')
  let fallback = field(form, 'fallback')
  let kind = providers.find((p) => p.id === provider)?.kind
  if (!kind) errors.provider = 'Choose a provider of the organization.'
  if (model === '') errors.model = 'Enter a model.'
  else if (!MODEL.test(model)) errors.model = MODEL_HELP
  else if (kind && idFormHelp(kind, model)) errors.model = idFormHelp(kind, model)!
  if (fallback !== '' && !MODEL.test(fallback)) errors.fallback = MODEL_HELP
  else if (fallback !== '' && kind && idFormHelp(kind, fallback)) errors.fallback = idFormHelp(kind, fallback)!
  else if (fallback !== '' && fallback === model) errors.fallback = 'The fallback must be another model, or stay empty.'
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: { provider, model, fallback: fallback === '' ? null : fallback } }
}

const MODEL_HELP = 'A model id: letters, digits and ". _ : / @ -", 200 characters at most.'

/**
 * An OpenRouter id names its vendor (`anthropic/claude-sonnet-5.5`); an Anthropic id does not
 * (`claude-sonnet-5-5`). The other provider answers 404 to the wrong form.
 *
 * What the provider expects, for an id of the wrong form; null for an id it takes. The form refuses
 * such an id (#66); the screens and the claim of a job read an id already in the database with it
 * (REV-62).
 */
export function idFormHelp(kind: ProviderKind, model: string): string | null {
  if (kind === 'openrouter') return model.includes('/') ? null : ID_FORM_HELP.openrouter
  if (kind === 'anthropic') return model.includes('/') ? ID_FORM_HELP.anthropic : null
  return null
}

const ID_FORM_HELP = {
  openrouter: 'OpenRouter expects the vendor before the model, for example anthropic/claude-sonnet-5.5.',
  anthropic: 'Anthropic expects its own id, without "anthropic/", for example claude-sonnet-5-5.',
} as const

export function readTriggerForm(form: FormData): FormResult<Trigger> {
  let value = field(form, 'trigger')
  if (!isOneOf(TRIGGERS, value)) return { ok: false, errors: { trigger: 'Choose a trigger.' } }
  return { ok: true, value }
}

export function readPathsForm(form: FormData): FormResult<string[]> {
  let lines = field(form, 'paths')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  let unique = [...new Set(lines)]
  if (unique.length > MAX_PATHS) return { ok: false, errors: { paths: `${MAX_PATHS} patterns at most.` } }
  for (let pattern of unique) {
    let problem = checkPattern(pattern)
    if (problem) return { ok: false, errors: { paths: `"${pattern.slice(0, 60)}": ${problem}.` } }
  }
  return { ok: true, value: unique }
}

/** The monthly limit: a number of dollars with a comma or a dot, or empty for no limit. */
export function readCapForm(form: FormData): FormResult<number | null> {
  let raw = field(form, 'monthlyCapUsd').replace(/\s/g, '').replace(',', '.')
  if (raw === '') return { ok: true, value: null }
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { ok: false, errors: { monthlyCapUsd: 'An amount in dollars, for example 25 or 12.50. Leave it empty for no cap.' } }
  let value = Number(raw)
  if (value > MAX_CAP_USD) return { ok: false, errors: { monthlyCapUsd: `$${MAX_CAP_USD.toLocaleString('en-US')} at most.` } }
  return { ok: true, value }
}

export function readLevelForm(form: FormData): FormResult<Level> {
  let value = field(form, 'defaultLevel')
  if (!isLevel(value)) return { ok: false, errors: { defaultLevel: 'Choose a level.' } }
  return { ok: true, value }
}

/** The models of `jobs.config`, as the claim sends them. Null: a job queued before REV-12, or a value that is not a config. */
export function jobModels(json: unknown): LevelModels | null {
  let value = parsed(json)
  return isObject(value) ? readLevelModels(value.models) : null
}
