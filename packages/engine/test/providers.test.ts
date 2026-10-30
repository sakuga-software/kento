import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askJson, costLine, levelConfig, ProviderError, providerLevelConfig } from '../src/index.ts';
import { defaultModels } from '../src/levels.ts';
import { costFromTable, costKnown } from '../src/prices.ts';
import { refusedKey } from '../src/providers.ts';

const SCHEMA = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };

type Recorded = { url: string; headers: Record<string, string>; body: any };

/** A fetch that records each call and answers with the next function of `answers`. */
function fakeFetch(answers: ((body: any) => Response)[]) {
  const calls: Recorded[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return answer(body);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const quiet = () => {};

test('Anthropic: the schema goes in output_config, the system prompt carries the cache mark, the cost comes from the table', async () => {
  const { fetch, calls } = fakeFetch([
    () =>
      json({
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 500 },
      }),
  ]);
  const config = providerLevelConfig('balanced', 'anthropic');
  const { answer, usage } = await askJson<{ ok: boolean }>({ apiKey: 'sk-ant-test', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'the pack', SCHEMA);

  assert.deepEqual(answer, { ok: true });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call!.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call!.headers['anthropic-version'], '2023-06-01');
  assert.equal(call!.headers.Authorization, undefined);
  assert.equal(call!.body.model, 'claude-sonnet-5-5');
  assert.deepEqual(call!.body.output_config.format, { type: 'json_schema', schema: SCHEMA.schema });
  assert.equal(call!.body.output_config.effort, 'medium');
  // No forced tool: Opus 5.5 and Sonnet 5.5 answer 400 to it.
  assert.equal(call!.body.tool_choice, undefined);
  assert.deepEqual(call!.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(call!.body.messages[0].content, 'the pack');

  // 1000 × 2 + 2000 × 0.2 + 500 × 10 = 7400 millionths of a dollar.
  assert.equal(usage.cost, 0.0074);
  assert.equal(usage.cost_source, 'table');
  assert.equal(usage.prompt_tokens, 3000);
  assert.equal(usage.completion_tokens, 500);
  assert.equal(usage.cache_read_tokens, 2000);
});

test('Anthropic: a refused key stops at the first model, and the error keeps the status', async () => {
  const { fetch, calls } = fakeFetch([() => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)]);
  const config = providerLevelConfig('lite', 'anthropic', ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  const error = await askJson({ apiKey: 'wrong', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'pack', SCHEMA).catch((e) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.status, 401);
  assert.ok(refusedKey(error));
  assert.equal(calls.length, 1, 'the second model is not called with a refused key');
  assert.doesNotMatch(error.message, /wrong/, 'the message never holds the key');
});

test('Anthropic: a refusal of the model is an error, and the next model answers', async () => {
  const { fetch, calls } = fakeFetch([
    () => json({ model: 'claude-haiku-5-5', stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: {} }),
    () => json({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":false}' }], usage: { input_tokens: 10, output_tokens: 1 } }),
  ]);
  const logs: string[] = [];
  const config = providerLevelConfig('lite', 'anthropic', ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  const { answer } = await askJson<{ ok: boolean }>({ apiKey: 'k', kind: 'anthropic', fetch, log: (m) => logs.push(m) }, config, 'review.md', 'p', SCHEMA);
  assert.deepEqual(answer, { ok: false });
  assert.equal(calls.length, 2);
  assert.match(logs[0]!, /declined the request \(cyber\)/);
});

test('OpenAI-compatible: a server that refuses response_format gets the call again with the schema in the prompt', async () => {
  const { fetch, calls } = fakeFetch([
    () => json({ error: { message: 'response_format is not supported' } }, 400),
    () => json({ model: 'qwen3', choices: [{ message: { content: 'Here: {"ok":true}' } }], usage: { prompt_tokens: 40, completion_tokens: 4 } }),
  ]);
  const config = providerLevelConfig('lite', 'openai_compatible', ['qwen3']);
  const { answer, usage } = await askJson<{ ok: boolean }>(
    { apiKey: 'k', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1/', fetch, log: quiet },
    config,
    'review.md',
    'p',
    SCHEMA,
  );
  assert.deepEqual(answer, { ok: true });
  assert.equal(calls[0]!.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(calls[0]!.headers.Authorization, 'Bearer k');
  assert.ok(calls[0]!.body.response_format);
  assert.equal(calls[1]!.body.response_format, undefined);
  assert.match(calls[1]!.body.messages[0].content, /JSON schema/);
  // No price for this model: the call counts 0, and says so.
  assert.equal(usage.cost, 0);
  assert.equal(usage.cost_source, 'unknown');
});

test('OpenAI-compatible: an answer that is not JSON gets one more call, and the tokens of both count', async () => {
  const { fetch, calls } = fakeFetch([
    () => json({ choices: [{ message: { content: 'I think it is fine.' } }], usage: { prompt_tokens: 40, completion_tokens: 4 } }),
    () => json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 50, completion_tokens: 3 } }),
  ]);
  const config = providerLevelConfig('lite', 'openai_compatible', ['m']);
  const { usage } = await askJson({ apiKey: 'k', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.messages.at(-2).content, 'I think it is fine.');
  assert.equal(usage.prompt_tokens, 90);
  assert.equal(usage.completion_tokens, 7);
});

test('OpenAI-compatible: two answers that are not JSON fail the model', async () => {
  const { fetch, calls } = fakeFetch([() => json({ choices: [{ message: { content: 'no' } }] })]);
  const config = providerLevelConfig('lite', 'openai_compatible', ['m']);
  const error = await askJson({ apiKey: 'k', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.status, null);
  assert.equal(calls.length, 2, 'one retry only');
});

test('OpenAI-compatible: without a base URL, nothing is called', async () => {
  const { fetch, calls } = fakeFetch([() => json({})]);
  const error = await askJson({ apiKey: 'k', kind: 'openai_compatible', fetch }, providerLevelConfig('lite', 'openai_compatible', ['m']), 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.match(String(error), /needs a base URL/);
  assert.equal(calls.length, 0);
});

test('Ollama: the schema goes in format, the call costs 0', async () => {
  const { fetch, calls } = fakeFetch([() => json({ model: 'qwen3:32b', message: { content: '{"ok":true}' }, prompt_eval_count: 900, eval_count: 80 })]);
  const config = providerLevelConfig('heavy', 'ollama', ['qwen3:32b']);
  const { usage } = await askJson({ apiKey: undefined, kind: 'ollama', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA);
  assert.equal(calls[0]!.url, 'http://localhost:11434/api/chat');
  assert.deepEqual(calls[0]!.body.format, SCHEMA.schema);
  assert.equal(calls[0]!.body.stream, false);
  assert.equal(calls[0]!.headers.Authorization, undefined);
  assert.equal(usage.cost, 0);
  assert.equal(usage.cost_source, 'free');
  assert.equal(usage.prompt_tokens, 900);
});

test('OpenRouter: the cost of the answer is kept, and the privacy settings stay', async () => {
  const { fetch, calls } = fakeFetch([() => json({ model: 'anthropic/claude-haiku-5.5', provider: 'Anthropic', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } })]);
  const { usage } = await askJson({ apiKey: 'k', fetch, log: quiet }, levelConfig('lite'), 'review.md', 'p', SCHEMA);
  assert.equal(usage.cost, 0.01);
  assert.equal(usage.cost_source, 'provider');
  assert.deepEqual(
    { zdr: calls[0]!.body.provider.zdr, data: calls[0]!.body.provider.data_collection, require: calls[0]!.body.provider.require_parameters },
    { zdr: true, data: 'deny', require: true },
  );
});

test('the models of a level at each provider', () => {
  assert.deepEqual(defaultModels('anthropic', 'heavy'), ['claude-opus-5-5']);
  assert.deepEqual(defaultModels('openrouter', 'lite'), ['anthropic/claude-haiku-5.5', 'z-ai/glm-5.3']);
  assert.deepEqual(defaultModels('ollama', 'lite'), []);
  const config = providerLevelConfig('lite', 'openai_compatible', ['a', 'b', 'c']);
  assert.deepEqual(config.models, ['a', 'b', 'c']);
  assert.equal(config.timeoutsMs.length, 3);
  // The bench keeps its models whatever the provider.
  assert.deepEqual(providerLevelConfig('lite', 'anthropic', undefined, { REVIEW_MODELS: 'x' }).models, ['x']);
});

test('the price table: long context of Haiku 5.5, and a model without a price', () => {
  assert.equal(costFromTable('anthropic', 'claude-haiku-5-5', { input: 10_000, output: 1_000 }), 0.0015);
  // Above 100,000 prompt tokens, every token has the higher price.
  assert.equal(costFromTable('anthropic', 'claude-haiku-5-5', { input: 200_000, output: 1_000 }), 0.1025);
  assert.equal(costFromTable('anthropic', 'claude-unknown', { input: 1, output: 1 }), null);
  assert.equal(costKnown('openai_compatible', 'qwen3'), false);
  assert.equal(costKnown('ollama', 'qwen3'), true);
  assert.equal(costKnown('anthropic', 'claude-opus-5-5'), true);
});

test('the cost line says when the cost is not known', () => {
  assert.match(costLine('lite', { model: 'qwen3', cost: 0, cost_source: 'unknown' }), /coût inconnu \(aucun prix pour ce modèle, compté 0 \$\)$/);
  assert.match(costLine('lite', { model: 'qwen3', cost: 0, cost_source: 'free' }), /0,000 \$ \(modèle local\)$/);
  assert.match(costLine('lite', { model: 'm', cost: 0.0123, cost_source: 'table' }), /· 0,012 \$$/);
  assert.match(costLine('lite', { model: 'm', cost: 0.0123 }), /· 0,012 \$$/);
});
