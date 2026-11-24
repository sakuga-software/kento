import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askJson, providerLevelConfig } from '../src/index.ts';
import { fillBaseUrl, placeholdersOf, presetById, presetOf } from '../src/presets.ts';
import { bedrockClaude, costFromTable, costKnown, longContextThreshold, priceOf } from '../src/prices.ts';
import { limitOf, rateLimited, thinkingOff, usageLimited } from '../src/providers.ts';

// KNT-206. The presets of Azure OpenAI and Amazon Bedrock, and the answers of these clouds. The
// answers are the forms that their docs and their users show: no call reaches a cloud.

const SCHEMA = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
const quiet = () => {};
const NOW = Date.parse('2026-11-24T10:00:00Z');

type Recorded = { url: string; headers: Record<string, string>; body: any };

function fakeFetch(answers: (() => Response)[]) {
  const calls: Recorded[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return answers[Math.min(calls.length - 1, answers.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });

const azure = presetById('azure-openai')!;
const bedrock = presetById('bedrock-claude')!;

test('KNT-206. the Azure preset: any resource, on each host of Azure, a slash at the end or not', () => {
  assert.deepEqual(placeholdersOf(azure.baseUrl), ['resource']);
  for (const url of [
    'https://contoso-ai.openai.azure.com/openai/v1',
    'https://contoso-ai.openai.azure.com/openai/v1/',
    'https://CONTOSO-AI.openai.azure.com/openai/v1',
    'https://contoso-ai.services.ai.azure.com/openai/v1',
    'https://contoso-ai.cognitiveservices.azure.com/openai/v1',
  ]) {
    assert.equal(presetOf('openai_compatible', url), azure, url);
  }
  // The form shows the URL with its placeholder after an error: the choice stays Azure.
  assert.equal(presetOf('openai_compatible', azure.baseUrl), azure);
  for (const url of [
    // Another host, a host that ends with the host of Azure, a dot in the resource, another path.
    'https://contoso-ai.openai.azure.com.example.com/openai/v1',
    'https://example.com/contoso.openai.azure.com/openai/v1',
    'https://a.b.openai.azure.com/openai/v1',
    'https://-x.openai.azure.com/openai/v1',
    'https://contoso-ai.openai.azure.com/openai/deployments/gpt/v1',
    'http://contoso-ai.openai.azure.com/openai/v1',
  ]) {
    assert.equal(presetOf('openai_compatible', url), null, url);
  }
  assert.equal(presetOf('anthropic', 'https://contoso-ai.openai.azure.com/openai/v1'), null, 'the kind counts');
});

test('KNT-206. the Bedrock preset: the Messages API of Anthropic in any AWS Region, with no free test of the key', () => {
  assert.equal(bedrock.kind, 'anthropic');
  for (const region of ['us-east-1', 'eu-west-3', 'ap-southeast-2', 'us-gov-west-1']) {
    assert.equal(presetOf('anthropic', fillBaseUrl(bedrock.baseUrl, { region })), bedrock, region);
  }
  for (const url of ['https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v2', 'https://bedrock-runtime.evil.amazonaws.com/anthropic', 'https://bedrock-runtime.us-east-1.amazonaws.com.example.com/anthropic']) {
    assert.equal(presetOf('anthropic', url), null, url);
  }
  assert.equal(presetOf('openai_compatible', fillBaseUrl(bedrock.baseUrl, { region: 'us-east-1' })), null);
  assert.equal(bedrock.modelsPath, null);
  assert.ok(bedrock.testNote);
});

test('KNT-206. the ids of Claude on Bedrock: the Anthropic id, and a geography costs 10 % more than global', () => {
  assert.deepEqual(bedrockClaude('global.anthropic.claude-opus-5-5'), { id: 'claude-opus-5-5', regional: false });
  assert.deepEqual(bedrockClaude('anthropic.claude-sonnet-5-5'), { id: 'claude-sonnet-5-5', regional: false });
  assert.deepEqual(bedrockClaude('eu.anthropic.claude-haiku-5-5'), { id: 'claude-haiku-5-5', regional: true });
  assert.deepEqual(bedrockClaude('us.anthropic.claude-opus-4-6-v1'), { id: 'claude-opus-4-6', regional: true });
  assert.equal(bedrockClaude('claude-opus-5-5'), null);
  assert.equal(bedrockClaude('xx.anthropic.claude-opus-5-5'), null, 'an unknown prefix is no Bedrock id');
  assert.equal(bedrockClaude('anthropic/claude-opus-5.5'), null, 'an id of OpenRouter is no Bedrock id');

  // The AWS Price List of 2026-11-23: global, the prices of Anthropic; a geography, 1.1 times them.
  assert.deepEqual(priceOf('anthropic', 'global.anthropic.claude-opus-5-5'), priceOf('anthropic', 'claude-opus-5-5'));
  const eu = priceOf('anthropic', 'eu.anthropic.claude-sonnet-5-5')!;
  assert.ok(Math.abs(eu.input - 2.2) < 1e-9 && Math.abs(eu.output - 11) < 1e-9 && Math.abs(eu.cacheWrite1h - 4.4) < 1e-9);
  const tokens = { input: 1_000_000, output: 0 };
  assert.equal(costFromTable('anthropic', 'eu.anthropic.claude-haiku-5-5', { input: 200_000, output: 0 }), 0.11, 'the long context of Haiku 5.5, 1.1 times');
  assert.equal(costFromTable('anthropic', 'global.anthropic.claude-sonnet-5-5', tokens), 2);
  assert.equal(longContextThreshold('anthropic', ['global.anthropic.claude-haiku-5-5']), 100_000);
  for (const level of ['lite', 'balanced', 'heavy'] as const) {
    for (const model of bedrock.models[level]) assert.ok(costKnown('anthropic', model), model);
  }
  // The request without thinking of Haiku 5.5 (REV-108) comes on Bedrock too.
  assert.deepEqual(thinkingOff('global.anthropic.claude-haiku-5-5'), { type: 'disabled' });
  assert.equal(thinkingOff('global.anthropic.claude-sonnet-5-5'), null);
});

test('KNT-206. Azure: a dated model in the answer has the price of its model; another resource host prices it too', () => {
  const url = 'https://contoso-ai.services.ai.azure.com/openai/v1';
  assert.deepEqual(priceOf('openai_compatible', 'gpt-6-sol-2026-09-22', url), priceOf('openai_compatible', 'gpt-6-sol', url));
  assert.equal(priceOf('openai_compatible', 'gpt-6-sol', url)!.input, 2);
  assert.equal(priceOf('openai_compatible', 'my-deployment', url), null, 'a deployment with another name has no price');
  assert.equal(priceOf('openai_compatible', 'gpt-6-sol', 'https://llm.example.com/v1'), null);
});

test('KNT-206. a call to Azure OpenAI: the v1 path, the key in Bearer, max_completion_tokens, the price of the dated model', async () => {
  const { fetch, calls } = fakeFetch([
    () =>
      json({
        model: 'gpt-6-sol-2026-09-22',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 0 } },
      }),
  ]);
  const baseUrl = 'https://contoso-ai.openai.azure.com/openai/v1';
  const config = providerLevelConfig('heavy', 'openai_compatible', ['gpt-6-sol']);
  const { answer, usage } = await askJson<{ ok: boolean }>({ apiKey: 'azure-key-1234', kind: 'openai_compatible', baseUrl, fetch, log: quiet }, config, 'review.md', 'p', SCHEMA);
  assert.deepEqual(answer, { ok: true });
  assert.equal(calls[0]!.url, `${baseUrl}/chat/completions`);
  assert.equal(calls[0]!.headers.Authorization, 'Bearer azure-key-1234');
  assert.equal(calls[0]!.body.model, 'gpt-6-sol');
  assert.equal(calls[0]!.body.max_tokens, undefined, 'the reasoning models of Azure refuse max_tokens');
  assert.equal(calls[0]!.body.max_completion_tokens, config.maxTokens);
  assert.equal(calls[0]!.body.response_format.json_schema.strict, true);
  // 1 M × 2 + 0.1 M × 10 = 3 dollars.
  assert.equal(usage.cost, 3);
  assert.equal(usage.cost_source, 'table');
});

test('KNT-206. a call to Claude on Bedrock: /anthropic/v1/messages, the key in x-api-key, the price of the profile of the request', async () => {
  const { fetch, calls } = fakeFetch([
    () =>
      json({
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      }),
  ]);
  const baseUrl = 'https://bedrock-runtime.eu-west-3.amazonaws.com/anthropic';
  const config = providerLevelConfig('balanced', 'anthropic', ['eu.anthropic.claude-sonnet-5-5']);
  const { usage } = await askJson<{ ok: boolean }>({ apiKey: 'bedrock-api-key-1234', kind: 'anthropic', baseUrl, fetch, log: quiet }, config, 'review.md', 'p', SCHEMA);
  assert.equal(calls[0]!.url, `${baseUrl}/v1/messages`);
  assert.equal(calls[0]!.headers['x-api-key'], 'bedrock-api-key-1234');
  assert.equal(calls[0]!.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0]!.body.model, 'eu.anthropic.claude-sonnet-5-5');
  assert.deepEqual(calls[0]!.body.output_config.format, { type: 'json_schema', schema: SCHEMA.schema });
  // The answer names the Anthropic id, but the eu. profile of the request bills 1.1 times: 2.2 dollars.
  assert.equal(usage.cost, 2.2);
  assert.equal(usage.cost_source, 'table');
});

// The 429 of Azure OpenAI, as the users of Azure post it.
const AZURE_429 = JSON.stringify({
  error: {
    code: '429',
    message:
      'Requests to the ChatCompletions_Create Operation under Azure OpenAI API version v1 have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 6 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.',
  },
});

test('KNT-206. the 429 of Azure OpenAI is a rate limit: the link to its quota page is no usage limit', () => {
  const body = AZURE_429.slice(0, 300);
  assert.ok(body.includes('quotaincrease'), 'the link is in the 300 characters that the adapter keeps');
  assert.deepEqual(limitOf(429, body, new Headers({ 'retry-after': '6', 'retry-after-ms': '5300' }), NOW), { kind: 'rate', resetAt: '2026-11-24T10:00:06Z' });
  assert.deepEqual(limitOf(429, body, new Headers({ 'retry-after-ms': '5300' }), NOW), { kind: 'rate', resetAt: '2026-11-24T10:00:06Z' });
  // The daily limit of Azure: a reset one day away stops the review.
  assert.equal(limitOf(429, body.replace('6 seconds', '86400 seconds'), new Headers({ 'retry-after': '86400' }), NOW)?.kind, 'usage');
  // The words of a quota still count, as a word.
  assert.equal(limitOf(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', undefined, NOW)?.kind, 'usage');
  assert.equal(limitOf(429, 'Quota exceeded for the model', undefined, NOW)?.kind, 'usage');
  assert.equal(limitOf(400, 'The quotas of the project are spent', undefined, NOW)?.kind, 'usage');
});

test('KNT-206. a 429 of Azure through the adapter: the next model of the level, then a rate limit', async () => {
  const { fetch, calls } = fakeFetch([() => new Response(AZURE_429, { status: 429, headers: { 'retry-after': '6' } })]);
  const config = providerLevelConfig('balanced', 'openai_compatible', ['gpt-6.1-terra', 'gpt-6-luna']);
  const error = await askJson({ apiKey: 'k', kind: 'openai_compatible', baseUrl: 'https://contoso-ai.openai.azure.com/openai/v1', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.ok(rateLimited(error), String(error));
  assert.ok(!usageLimited(error));
  assert.equal(calls.length, 2, 'a rate limit is per model: the second model is called');
});

test('KNT-206. the ThrottlingException of Bedrock is a rate limit with no reset', () => {
  const body = JSON.stringify({ message: 'Too many tokens, please wait before trying again.' });
  assert.deepEqual(limitOf(429, body, new Headers({ 'x-amzn-errortype': 'ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/' }), NOW), { kind: 'rate', resetAt: null });
});

test('KNT-206. an Azure id with another suffix than a date has no price: its cost shows as unknown', () => {
  const url = 'https://contoso-ai.openai.azure.com/openai/v1';
  assert.equal(priceOf('openai_compatible', 'gpt-6-sol-2026-09-22-preview', url), null);
  assert.equal(costKnown('openai_compatible', 'gpt-6-sol-2026-09-22-preview', url), false);
});
