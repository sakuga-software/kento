import assert from 'node:assert/strict';
import test from 'node:test';
import { LEVELS, MODEL_ID } from '../../protocol/src/index.ts';
import { fillBaseUrl, hostOf, normalBaseUrl, placeholdersOf, presetById, presetOf, PROVIDER_PRESETS, RESERVED_PRESET_IDS } from '../src/presets.ts';
import { costKnown, HOST_PRICES, PRESET_PRICES, priceOf } from '../src/prices.ts';

/** KNT-206. Values for the placeholders of a base URL. */
const FILLED = { resource: 'contoso-ai', region: 'eu-west-3' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

test('KNT-204. each preset: a stable id, an HTTPS base URL with no slash at the end, models that the protocol carries', () => {
  assert.ok(PROVIDER_PRESETS.length >= 1);
  const ids = PROVIDER_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  const urls = PROVIDER_PRESETS.map((preset) => normalBaseUrl(preset.baseUrl));
  assert.equal(new Set(urls).size, urls.length, 'base URLs are unique: presetOf finds one preset');
  for (const preset of PROVIDER_PRESETS) {
    assert.match(preset.id, /^[a-z][a-z0-9-]{1,30}$/, preset.id);
    assert.ok(!(RESERVED_PRESET_IDS as readonly string[]).includes(preset.id), `${preset.id} is a word of the picker`);
    // KNT-206: Amazon Bedrock serves Claude with the Messages API of Anthropic.
    assert.ok(preset.kind === 'openai_compatible' || preset.kind === 'anthropic', preset.id);
    assert.ok(preset.name.length > 0 && preset.name.length <= 60, preset.id);
    assert.ok(preset.baseUrl.startsWith('https://'), preset.id);
    assert.equal(normalBaseUrl(preset.baseUrl), preset.baseUrl, `${preset.id}: the base URL is written in its normal form`);
    assert.ok(preset.baseUrl.length <= 300, preset.id);
    assert.ok(preset.keysUrl.startsWith('https://'), preset.id);
    // KNT-206: no path when the provider has no call that tests a key for free; a note says it.
    if (preset.modelsPath === null) assert.ok(preset.testNote, preset.id);
    else assert.match(preset.modelsPath, /^\/[a-z/]+$/, preset.id);
    for (const source of [preset.modelsSource, preset.data]) {
      assert.ok(source.url.startsWith('https://'), preset.id);
      assert.match(source.checked, DAY, preset.id);
      assert.ok(!Number.isNaN(Date.parse(source.checked)), preset.id);
    }
    assert.ok(preset.data.note.length > 0, preset.id);
    for (const level of LEVELS) {
      const models = preset.models[level];
      assert.ok(models.length >= 1 && models.length <= 5, `${preset.id} ${level}: 1 to 5 models, as the form takes`);
      assert.equal(new Set(models).size, models.length, `${preset.id} ${level}`);
      for (const model of models) assert.match(model, MODEL_ID, `${preset.id} ${level} ${model}`);
    }
    for (const [model, max] of Object.entries(preset.maxOutputTokens ?? {})) {
      assert.ok(Number.isInteger(max) && max > 0, `${preset.id} ${model}`);
      assert.ok(LEVELS.some((level) => preset.models[level].includes(model)), `${preset.id}: ${model} is a model of the preset`);
    }
  }
});

test('KNT-204. each model of a preset has a dated price, found by the host of its base URL', () => {
  for (const preset of PROVIDER_PRESETS) {
    // KNT-206. A preset with a placeholder has its prices by its id; the Bedrock ids of Claude have
    // the prices of Anthropic.
    const baseUrl = fillBaseUrl(preset.baseUrl, FILLED);
    const host = hostOf(baseUrl)!;
    const table = placeholdersOf(preset.baseUrl).length > 0 ? PRESET_PRICES[preset.id] : HOST_PRICES[host];
    if (preset.kind === 'openai_compatible') {
      assert.ok(table, `${preset.id}: prices for ${host}`);
      assert.match(table.checked, DAY);
      assert.ok(table.url.startsWith('https://'));
    }
    for (const level of LEVELS) {
      for (const model of preset.models[level]) {
        const price = priceOf(preset.kind, model, baseUrl);
        assert.ok(price, `${preset.id}: a price for ${model}`);
        assert.ok(price.input > 0 && price.output > 0 && price.cacheRead <= price.input, `${preset.id} ${model}`);
        assert.ok(costKnown(preset.kind, model, `${baseUrl}/`), `${preset.id} ${model}: a slash at the end changes nothing`);
      }
    }
  }
});

test('KNT-204. presetOf: the kind and the base URL of the preset, a slash at the end or not, the host in any case', () => {
  const [first] = PROVIDER_PRESETS;
  assert.ok(first);
  assert.equal(presetOf('openai_compatible', first.baseUrl), first);
  assert.equal(presetOf('openai_compatible', `${first.baseUrl}/`), first);
  assert.equal(presetOf('openai_compatible', `https://${new URL(first.baseUrl).host.toUpperCase()}${new URL(first.baseUrl).pathname}`), first);
  // Another kind, another path, another host or no URL: no preset.
  assert.equal(presetOf('ollama', first.baseUrl), null);
  assert.equal(presetOf('openai_compatible', `${first.baseUrl}/v2`), null);
  assert.equal(presetOf('openai_compatible', 'https://llm.example.com/v1'), null);
  assert.equal(presetOf('openai_compatible', null), null);
  assert.equal(presetOf('openai_compatible', 'not a url'), null);
  assert.equal(presetById(first.id), first);
  assert.equal(presetById('constructor'), null);
});

test('KNT-204. a model of a server that is no preset keeps no price: its cost stays unknown', () => {
  const [first] = PROVIDER_PRESETS;
  const model = first!.models.lite[0]!;
  assert.equal(priceOf('openai_compatible', model, 'https://llm.example.com/v1'), null);
  assert.equal(priceOf('openai_compatible', model), null);
  assert.equal(priceOf('openai_compatible', 'constructor', first!.baseUrl), null);
  assert.equal(priceOf('openrouter', model, first!.baseUrl), null, 'the table of a host is for a server of the API of OpenAI only');
  assert.equal(costKnown('openai_compatible', 'qwen3', 'https://llm.example.com/v1'), false);
});
