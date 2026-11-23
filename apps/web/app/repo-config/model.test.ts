import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { triggerAllows } from '../db/webhook-store.ts'
import {
  jobConfig,
  jobModels,
  kentoDefaults,
  pathsMatch,
  readCapForm,
  readModelsForm,
  readOverrides,
  readPathsForm,
  resolveConfig,
  withoutField,
  hasField,
  type ConfigOverrides,
} from './model.ts'

function form(values: Record<string, string>): FormData {
  let data = new FormData()
  for (let [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

const SONNET = { provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: null }

describe('the config of a repository', () => {
  it('takes each key from the repository, else from its org, else from Kentō', () => {
    let org: ConfigOverrides = { trigger: 'ready', models: { heavy: { provider: 'service', model: 'x/opus', fallback: null } } }
    let repo: ConfigOverrides = { models: { balanced: SONNET }, monthlyCapUsd: 20 }
    let resolved = resolveConfig(org, repo)
    assert.deepEqual(resolved.models.balanced, { value: SONNET, source: 'repo' })
    assert.deepEqual(resolved.models.heavy, { value: { provider: 'service', model: 'x/opus', fallback: null }, source: 'org' })
    assert.deepEqual(resolved.models.lite, { value: kentoDefaults().models.lite, source: 'kento' })
    assert.deepEqual(resolved.trigger, { value: 'ready', source: 'org' })
    assert.deepEqual(resolved.paths, { value: [], source: 'kento' })
    assert.deepEqual(resolved.monthlyCapUsd, { value: 20, source: 'repo' })
  })

  it('has the models of the engine as the values of Kentō, through the provider of the service', () => {
    let models = kentoDefaults().models
    assert.deepEqual(models.lite, { provider: 'service', model: 'anthropic/claude-haiku-5.5', fallback: 'z-ai/glm-5.3' })
    assert.deepEqual(models.balanced, { provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: null })
    assert.equal(kentoDefaults().trigger, 'push')
    assert.equal(kentoDefaults().monthlyCapUsd, null)
  })

  it('"Back to the org value" removes one key, and only that one', () => {
    let repo: ConfigOverrides = { models: { balanced: SONNET, heavy: SONNET }, trigger: 'command', monthlyCapUsd: null }
    let without = withoutField(repo, 'models.balanced')
    assert.deepEqual(without, { models: { heavy: SONNET }, trigger: 'command', monthlyCapUsd: null })
    assert.deepEqual(repo.models?.balanced, SONNET, 'the config it came from does not change')
    assert.deepEqual(withoutField(withoutField(without, 'models.heavy'), 'trigger'), { monthlyCapUsd: null })
    // A limit set to "none" on the repository is a value: it hides the limit of the org.
    assert.equal(hasField({ monthlyCapUsd: null }, 'monthlyCapUsd'), true)
    assert.equal(resolveConfig({ monthlyCapUsd: 5 }, { monthlyCapUsd: null }).monthlyCapUsd.value, null)
  })

  it('reads the JSON of the database, and drops a key with a wrong value so that it is inherited', () => {
    assert.deepEqual(readOverrides(null), {})
    assert.deepEqual(readOverrides([]), {})
    assert.deepEqual(
      readOverrides({
        models: { lite: { provider: 'service', model: '-rm', fallback: null }, balanced: SONNET, heavy: { provider: 'a b', model: 'x', fallback: null } },
        trigger: 'sometimes',
        paths: ['apps/**', '../etc'],
        monthlyCapUsd: -1,
        unknown: true,
      }),
      { models: { balanced: SONNET } },
    )
    assert.deepEqual(readOverrides({ trigger: 'command', paths: ['apps/web'], monthlyCapUsd: 12.5 }), {
      trigger: 'command',
      paths: ['apps/web'],
      monthlyCapUsd: 12.5,
    })
  })

  it('freezes the models of the level of a job, and reads them back for the claim', () => {
    let config = jobConfig(resolveConfig({}, { models: { balanced: SONNET } }), 'balanced', 7)
    assert.deepEqual(config, { repoConfigVersion: 7, models: SONNET, source: 'repo' })
    assert.deepEqual(jobModels(JSON.parse(JSON.stringify(config))), SONNET)
    assert.equal(jobModels(null), null, 'a job queued before REV-12')
    assert.equal(jobModels({ models: { provider: 'service', model: 'a b', fallback: null } }), null)
  })
})

describe('the trigger', () => {
  it('"push" takes every action, "ready" no later push, "command" nothing', () => {
    for (let action of ['opened', 'synchronize', 'reopened', 'ready_for_review'] as const) assert.equal(triggerAllows('push', action), true)
    assert.equal(triggerAllows('ready', 'ready_for_review'), true)
    assert.equal(triggerAllows('ready', 'opened'), true)
    assert.equal(triggerAllows('ready', 'reopened'), true)
    assert.equal(triggerAllows('ready', 'synchronize'), false)
    for (let action of ['opened', 'synchronize', 'reopened', 'ready_for_review'] as const) assert.equal(triggerAllows('command', action), false)
  })
})

describe('the paths', () => {
  it('match a folder, `*` in one name, `**` across folders, and a renamed file', () => {
    let files = ['apps/web/app/ui/config.tsx', 'README.md', 'drizzle/0008_repo_config.sql']
    assert.equal(pathsMatch([], files), true, 'no pattern: every path')
    assert.equal(pathsMatch(['apps/web'], files), true)
    assert.equal(pathsMatch(['apps/web/'], files), true)
    assert.equal(pathsMatch(['apps/we'], files), false, 'a folder is a whole name')
    assert.equal(pathsMatch(['*.md'], files), true)
    assert.equal(pathsMatch(['*.tsx'], files), false, '`*` stays at the root')
    assert.equal(pathsMatch(['**/*.tsx'], files), true)
    assert.equal(pathsMatch(['apps/**/ui/*.tsx'], files), true)
    assert.equal(pathsMatch(['**/*.sql'], ['schema.sql']), true, '`**/` also matches no folder')
    assert.equal(pathsMatch(['docs/**', 'packages'], files), false)
    assert.equal(pathsMatch(['a.b'], ['axb']), false, 'a dot is a dot')
  })

  it('refuses an absolute path, `..`, a backslash and more than 20 patterns', () => {
    assert.deepEqual(readPathsForm(form({ paths: ' apps/web \n\n**/*.sql\napps/web' })), { ok: true, value: ['apps/web', '**/*.sql'] })
    assert.equal(readPathsForm(form({ paths: '/etc' })).ok, false)
    assert.equal(readPathsForm(form({ paths: 'apps/../x' })).ok, false)
    assert.equal(readPathsForm(form({ paths: 'apps\\web' })).ok, false)
    assert.equal(readPathsForm(form({ paths: Array.from({ length: 21 }, (_, i) => `p${i}`).join('\n') })).ok, false)
    assert.deepEqual(readPathsForm(form({ paths: '' })), { ok: true, value: [] })
  })
})

describe('the forms', () => {
  it('a level: a provider of the org, a model, and a fallback of the same provider or none', () => {
    let providers = [
      { id: 'service', kind: 'openrouter' as const },
      { id: 'own', kind: 'anthropic' as const },
    ]
    assert.deepEqual(readModelsForm(form({ provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: '' }), providers), { ok: true, value: SONNET })
    assert.deepEqual(readModelsForm(form({ provider: 'service', model: 'a/b', fallback: 'c/d' }), providers), {
      ok: true,
      value: { provider: 'service', model: 'a/b', fallback: 'c/d' },
    })
    let refused = readModelsForm(form({ provider: 'elsewhere', model: '', fallback: 'x y' }), providers)
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.deepEqual(Object.keys(refused.errors).sort(), ['fallback', 'model', 'provider'])
    let same = readModelsForm(form({ provider: 'service', model: 'a/b', fallback: 'a/b' }), providers)
    assert.equal(same.ok, false)
    // A model id is never an option of a command.
    assert.equal(readModelsForm(form({ provider: 'service', model: '--help', fallback: '' }), providers).ok, false)
  })

  it('a level: the model id has the form of its provider', () => {
    let providers = [
      { id: 'service', kind: 'openrouter' as const },
      { id: 'own', kind: 'anthropic' as const },
      { id: 'gpu', kind: 'ollama' as const },
      { id: 'vllm', kind: 'openai_compatible' as const },
    ]
    assert.deepEqual(readModelsForm(form({ provider: 'own', model: 'claude-sonnet-5-5', fallback: 'claude-haiku-5-5' }), providers), {
      ok: true,
      value: { provider: 'own', model: 'claude-sonnet-5-5', fallback: 'claude-haiku-5-5' },
    })
    let openrouterIds = readModelsForm(form({ provider: 'own', model: 'anthropic/claude-opus-5.5', fallback: 'z-ai/glm-5.3' }), providers)
    assert.equal(openrouterIds.ok, false)
    if (!openrouterIds.ok) assert.deepEqual(Object.keys(openrouterIds.errors).sort(), ['fallback', 'model'])
    assert.equal(readModelsForm(form({ provider: 'service', model: 'claude-sonnet-5-5', fallback: '' }), providers).ok, false)
    for (let provider of ['gpu', 'vllm']) {
      for (let model of ['qwen3:32b', 'Qwen/Qwen3-Coder-30B']) {
        assert.equal(readModelsForm(form({ provider, model, fallback: '' }), providers).ok, true, `${provider} ${model}`)
      }
    }
  })

  it('the monthly limit: dollars with a comma or a dot, or empty for none', () => {
    assert.deepEqual(readCapForm(form({ monthlyCapUsd: '12,50' })), { ok: true, value: 12.5 })
    assert.deepEqual(readCapForm(form({ monthlyCapUsd: ' 25 ' })), { ok: true, value: 25 })
    assert.deepEqual(readCapForm(form({ monthlyCapUsd: '' })), { ok: true, value: null })
    assert.equal(readCapForm(form({ monthlyCapUsd: '-3' })).ok, false)
    assert.equal(readCapForm(form({ monthlyCapUsd: '1e9' })).ok, false)
    assert.equal(readCapForm(form({ monthlyCapUsd: '100001' })).ok, false)
  })
})

describe('the JSON of postgres.js', () => {
  it('reads a config and the models of a job that come back as a JSON string', () => {
    assert.deepEqual(readOverrides(JSON.stringify({ trigger: 'ready' })), { trigger: 'ready' })
    assert.deepEqual(jobModels(JSON.stringify({ models: SONNET })), SONNET)
    assert.deepEqual(readOverrides('not json'), {})
  })
})

describe('the fallback provider of a level (KNT-161)', () => {
  const ANTHROPIC = '11111111-1111-4111-8111-111111111111'
  const OTHER = '22222222-2222-4222-8222-222222222222'
  const providers = [
    { id: 'service', kind: 'openrouter' as const },
    { id: ANTHROPIC, kind: 'anthropic' as const },
  ]
  const base = { provider: ANTHROPIC, model: 'claude-sonnet-5-5', fallback: '' }

  it('reads a fallback provider and its model, and none when both are empty', () => {
    assert.deepEqual(readModelsForm(form({ ...base, fallbackProvider: 'service', fallbackProviderModel: 'anthropic/claude-sonnet-5.5' }), providers), {
      ok: true,
      value: { provider: ANTHROPIC, model: 'claude-sonnet-5-5', fallback: null, fallbackProvider: { provider: 'service', model: 'anthropic/claude-sonnet-5.5' } },
    })
    assert.deepEqual(readModelsForm(form({ ...base, fallbackProvider: '', fallbackProviderModel: '' }), providers), {
      ok: true,
      value: { provider: ANTHROPIC, model: 'claude-sonnet-5-5', fallback: null },
    })
  })

  it('refuses the provider of the level, a provider of no org, a missing model, a model of the wrong form, a model without provider', () => {
    let errors = (values: Record<string, string>) => {
      let out = readModelsForm(form({ ...base, ...values }), providers)
      return out.ok ? {} : out.errors
    }
    assert.match(errors({ fallbackProvider: ANTHROPIC, fallbackProviderModel: 'claude-opus-5-5' }).fallbackProvider!, /another provider than the one of the level/)
    assert.match(errors({ fallbackProvider: OTHER, fallbackProviderModel: 'm' }).fallbackProvider!, /provider of the organization/)
    assert.match(errors({ fallbackProvider: 'service', fallbackProviderModel: '' }).fallbackProviderModel!, /Enter the model/)
    assert.ok(errors({ fallbackProvider: 'service', fallbackProviderModel: 'claude-sonnet-5-5' }).fallbackProviderModel, 'OpenRouter wants the vendor in the id')
    assert.match(errors({ fallbackProvider: '', fallbackProviderModel: 'm' }).fallbackProvider!, /Choose the provider of this model/)
  })

  it('keeps a fallback provider of the database, and drops a wrong one or the provider of the level alone', () => {
    let level = { provider: ANTHROPIC, model: 'claude-sonnet-5-5', fallback: null }
    let read = (fallbackProvider: unknown) => readOverrides({ models: { heavy: { ...level, fallbackProvider } } }).models?.heavy
    assert.deepEqual(read({ provider: 'service', model: 'anthropic/claude-opus-5.5' }), { ...level, fallbackProvider: { provider: 'service', model: 'anthropic/claude-opus-5.5' } })
    assert.deepEqual(read({ provider: 'service', model: 'not a model' }), level)
    assert.deepEqual(read({ provider: ANTHROPIC, model: 'claude-opus-5-5' }), level)
    assert.deepEqual(read(null), level)
  })
})
