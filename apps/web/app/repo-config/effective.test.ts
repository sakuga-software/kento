import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { wrongModelId } from '../runner/controller.ts'
import { effectiveLevel, wrongIdAction } from './effective.ts'
import { idFormHelp, kentoDefaults } from './model.ts'
import { serviceOption, type ProviderOption } from './providers.ts'

const ANTHROPIC_ID = '0b5c3a57-6a8e-4d7e-9a43-1d2f3e4a5b6c'

function anthropic(overrides: Partial<ProviderOption> = {}): ProviderOption {
  return {
    id: ANTHROPIC_ID,
    kind: 'anthropic',
    label: 'Anthropic de Sakuga',
    hint: '',
    isDefault: false,
    keyFrom: 'clé du runner',
    serviceHoldsKey: false,
    models: {},
    ...overrides,
  }
}

describe('a model id of the wrong form, already in the database (REV-62)', () => {
  it('names what each provider expects, and takes the other providers as they are', () => {
    assert.match(idFormHelp('anthropic', 'anthropic/claude-opus-5.5') ?? '', /sans « anthropic\/ »/)
    assert.equal(idFormHelp('anthropic', 'claude-opus-5-5'), null)
    assert.match(idFormHelp('openrouter', 'claude-opus-5-5') ?? '', /le fournisseur devant le modèle/)
    assert.equal(idFormHelp('openrouter', 'anthropic/claude-opus-5.5'), null)
    assert.equal(idFormHelp('ollama', 'qwen3:32b'), null)
    assert.equal(idFormHelp('openai_compatible', 'meta-llama/Llama-4'), null)
  })

  it('shows the model and the fallback of the level that its provider refuses, and where to correct them', () => {
    let providers = [serviceOption(true), anthropic()]
    let chosen = effectiveLevel(
      'heavy',
      { value: { provider: ANTHROPIC_ID, model: 'anthropic/claude-opus-5.5', fallback: 'claude-sonnet-5-5' }, source: 'repo' },
      providers,
    )
    assert.deepEqual(
      chosen.wrongIds.map((wrong) => wrong.id),
      ['anthropic/claude-opus-5.5'],
    )
    assert.match(wrongIdAction(chosen, 'repo', 'repo'), /formulaire ci-dessous/)
    assert.match(wrongIdAction(chosen, 'repo', 'org'), /Réglages de l’organisation/)

    let byDefault = effectiveLevel('lite', { value: kentoDefaults().models.lite, source: 'kento' }, [
      serviceOption(true),
      anthropic({ isDefault: true, models: { lite: ['claude-haiku-5-5', 'anthropic/claude-haiku-5.5'] } }),
    ])
    assert.deepEqual(
      byDefault.wrongIds.map((wrong) => wrong.id),
      ['anthropic/claude-haiku-5.5'],
    )
    assert.match(wrongIdAction(byDefault, 'org', 'kento'), /Providers et clés/)
  })

  it('shows nothing for ids of the right form, and for the models of Kentō', () => {
    let providers = [serviceOption(true), anthropic()]
    for (let level of ['lite', 'balanced', 'heavy'] as const) {
      assert.deepEqual(effectiveLevel(level, { value: kentoDefaults().models[level], source: 'kento' }, providers).wrongIds, [])
    }
    let right = effectiveLevel('heavy', { value: { provider: ANTHROPIC_ID, model: 'claude-opus-5-5', fallback: null }, source: 'org' }, providers)
    assert.deepEqual(right.wrongIds, [])
  })

  it('fails at the claim the ids that the runner would run, and only those', () => {
    let provider = { id: ANTHROPIC_ID, kind: 'anthropic' as const, models: { lite: ['anthropic/claude-haiku-5.5'] } }
    let job = { provider, level: 'lite' as const, config: null }
    assert.match(wrongModelId(job as never, { wantsModels: true, readsProviders: true }) ?? '', /^id de modèle invalide pour Anthropic : anthropic\/claude-haiku-5\.5\. /)

    // The config names right ids for this provider, and the runner reads them: the provider's list is not run.
    let config = { models: { provider: ANTHROPIC_ID, model: 'claude-haiku-5-5', fallback: null } }
    assert.equal(wrongModelId({ ...job, config } as never, { wantsModels: true, readsProviders: true }), null)
    // A runner that does not read the models of the config runs those of the provider.
    assert.notEqual(wrongModelId({ ...job, config } as never, { wantsModels: false, readsProviders: true }), null)

    // The OpenRouter of the service, with an Anthropic id in the config.
    let service = { provider: null, level: 'lite' as const, config: { models: { provider: 'service', model: 'claude-haiku-5-5', fallback: null } } }
    assert.match(wrongModelId(service as never, { wantsModels: true, readsProviders: true }) ?? '', /^id de modèle invalide pour OpenRouter : claude-haiku-5-5\. /)
    assert.equal(wrongModelId(service as never, { wantsModels: false, readsProviders: true }), null)
    // A runner of an earlier release, without `providers`, still gets the models of `service`.
    assert.notEqual(wrongModelId(service as never, { wantsModels: true, readsProviders: false }), null)
    // A config whose provider the job does not carry: the runner runs the models of Kentō.
    let elsewhere = { ...service, config: { models: { provider: ANTHROPIC_ID, model: 'anthropic/x', fallback: null } } }
    assert.equal(wrongModelId(elsewhere as never, { wantsModels: true, readsProviders: true }), null)
  })

  it('names every id of the wrong form in the reason, not only the first', () => {
    let provider = { id: ANTHROPIC_ID, kind: 'anthropic' as const, models: { lite: ['anthropic/a', 'claude-haiku-5-5', 'anthropic/b'] } }
    let reason = wrongModelId({ provider, level: 'lite', config: null } as never, { wantsModels: true, readsProviders: true })
    assert.match(reason ?? '', /^id de modèle invalide pour Anthropic : anthropic\/a, anthropic\/b\. Anthropic attend/)
  })
})
