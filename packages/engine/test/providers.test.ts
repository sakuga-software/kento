import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askJson, levelConfig, ProviderError, providerLevelConfig } from '../src/index.ts';
import { costLine } from '../src/render.ts';
import { defaultModels } from '../src/levels.ts';
import { costFromTable, costKnown } from '../src/prices.ts';
import { limitOf, limitOfReason, MAX_THINKING_MS, RateLimitError, rateLimited, refusedKey, thinkingOff, thinkingWaitMs, UsageLimitError, usageLimited } from '../src/providers.ts';
import { messageResponse, sseResponse, startEvents } from './sse.ts';

const SCHEMA = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };

type Recorded = { url: string; headers: Record<string, string>; body: any };

/** A fetch that records each call and answers with the next function of `answers`. */
function fakeFetch(answers: ((body: any, init: RequestInit) => Response)[]) {
  const calls: Recorded[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return answer(body, init);
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
  assert.deepEqual(call!.body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(call!.body.messages[0].content, [{ type: 'text', text: 'the pack' }]);

  // 1000 × 2 + 2000 × 0.1 + 500 × 10 = 7200 millionths of a dollar: a read costs 0.05 times the input on Sonnet 5.5.
  assert.equal(usage.cost, 0.0072);
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

test('Anthropic: an answer cut by max_tokens names the stop_reason in the error (REV-104)', async () => {
  const { fetch, calls } = fakeFetch([
    () => json({ model: 'claude-sonnet-5-5', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":' }], usage: { input_tokens: 10, output_tokens: 32000 } }),
  ]);
  const config = providerLevelConfig('balanced', 'anthropic');
  const error = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.match(error.message, /Anthropic gave no JSON object \(stop_reason max_tokens, 32000 output tokens, 6 characters of text\)/);
  // REV-108. Sonnet 5.5 refuses `thinking: disabled`: no second request.
  assert.equal(calls.length, 1);
});

test('Anthropic: the request streams, and the usage gives the stop_reason, the thinking tokens and the times (REV-108)', async () => {
  const { fetch, calls } = fakeFetch([
    () => messageResponse('claude-haiku-5-5', [{ type: 'thinking', thinking: 'the diff', signature: 'sig' }, { type: 'text', text: '{"ok":true}' }], 'end_turn', { input: 1000, cacheRead: 5000, output: 900, thinking: 700 }),
  ]);
  const config = providerLevelConfig('lite', 'anthropic');
  const { answer, usage } = await askJson<{ ok: boolean }>({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'the pack', SCHEMA);

  assert.deepEqual(answer, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.stream, true);
  assert.equal(calls[0]!.body.thinking, undefined, 'the first request keeps the adaptive thinking of the model');
  assert.equal(usage.prompt_tokens, 6000);
  assert.equal(usage.completion_tokens, 900);
  assert.equal(usage.stop_reason, 'end_turn');
  assert.equal(usage.thinking_tokens, 700);
  assert.equal(typeof usage.first_token_ms, 'number');
  assert.equal(typeof usage.first_text_ms, 'number');
  assert.equal(usage.retried_without_thinking, undefined);
});

test('Anthropic: Haiku cut at max_tokens asks once more without thinking, and the tokens of both requests count (REV-108)', async () => {
  const { fetch, calls } = fakeFetch([
    () => messageResponse('claude-haiku-5-5', [{ type: 'thinking', thinking: '', signature: 'sig' }], 'max_tokens', { input: 1000, output: 32000, thinking: 32000 }),
    () => messageResponse('claude-haiku-5-5', [{ type: 'text', text: '{"ok":false}' }], 'end_turn', { input: 1000, output: 300 }),
  ]);
  const config = providerLevelConfig('lite', 'anthropic');
  const { answer, usage } = await askJson<{ ok: boolean }>({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'the pack', SCHEMA);

  assert.deepEqual(answer, { ok: false });
  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.deepEqual(second!.body.thinking, { type: 'disabled' });
  assert.equal(second!.body.output_config.effort, 'medium', 'Haiku 5.5 accepts `disabled` at low, medium and high');
  assert.equal(second!.body.model, first!.body.model);
  // No cache write for the second request: the pack carries no mark.
  assert.deepEqual(second!.body.messages[0].content, [{ type: 'text', text: 'the pack' }]);
  assert.equal(usage.completion_tokens, 32300);
  assert.equal(usage.prompt_tokens, 2000);
  assert.equal(usage.thinking_tokens, 32000);
  assert.equal(usage.stop_reason, 'end_turn');
  assert.equal(usage.retried_without_thinking, 'max_tokens');
});

test('Anthropic: when the request without thinking is cut too, the error says so (REV-108)', async () => {
  const { fetch, calls } = fakeFetch([() => messageResponse('claude-haiku-5-5', [{ type: 'text', text: '{"ok":' }], 'max_tokens', { output: 32000 })]);
  const config = providerLevelConfig('lite', 'anthropic');
  const error = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.equal(calls.length, 2);
  assert.match(error.message, /Anthropic gave no JSON object \(stop_reason max_tokens, 32000 output tokens, 6 characters of text, after a request without thinking\)/);
});

test('Anthropic: a thinking with no answer block in time stops the request, and the call asks without thinking (REV-108)', async () => {
  const { fetch, calls } = fakeFetch([
    (_body, init) => sseResponse([...startEvents('claude-haiku-5-5', { input: 1000 }), { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }], init.signal, true),
    () => messageResponse('claude-haiku-5-5', [{ type: 'text', text: '{"ok":true}' }], 'end_turn', { input: 1000, output: 200 }),
  ]);
  // 400 ms for the call: a third is for the second request, so the thinking gets about 266 ms.
  const config = providerLevelConfig('lite', 'anthropic', undefined, { REVIEW_TIMEOUT_MS: '400' });
  const { answer, usage } = await askJson<{ ok: boolean }>({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA);

  assert.deepEqual(answer, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.body.thinking, { type: 'disabled' });
  assert.equal(usage.retried_without_thinking, 'no_answer_in_time');
  // The input of the stopped request counts. Of its output, only the 1 token of message_start came.
  assert.equal(usage.prompt_tokens, 2000);
  assert.equal(usage.completion_tokens, 201);
  assert.ok(usage.first_text_ms! >= 250);
});

test('Anthropic: a request that the API holds before its first block is not stopped: the clock starts at the thinking (REV-108)', async () => {
  const { fetch, calls } = fakeFetch([(_body, init) => sseResponse(startEvents('claude-haiku-5-5'), init.signal, true)]);
  const config = providerLevelConfig('lite', 'anthropic', undefined, { REVIEW_TIMEOUT_MS: '300' });
  const error = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.equal(calls.length, 1);
  assert.match(error.message, /TimeoutError|timeout/i);
});

test('Anthropic: a failed request without thinking names its cause (REV-108)', async () => {
  const { fetch, calls } = fakeFetch([
    () => messageResponse('claude-haiku-5-5', [{ type: 'thinking', thinking: '', signature: 's' }], 'max_tokens', { output: 32000 }),
    () => json({ type: 'error', error: { type: 'api_error', message: 'Internal' } }, 500),
  ]);
  const config = providerLevelConfig('lite', 'anthropic');
  const error = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.equal(calls.length, 2);
  assert.equal(error.status, 500);
  assert.match(error.message, /Anthropic answered 500: .* \(in the request without thinking, after max_tokens\)/);
});

test('Anthropic: a model that cannot turn its thinking off gets no deadline (REV-108)', async () => {
  const { fetch, calls } = fakeFetch([
    (_body, init) =>
      sseResponse([...startEvents('claude-sonnet-5-5'), { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }], init.signal, true),
  ]);
  const config = providerLevelConfig('balanced', 'anthropic', undefined, { REVIEW_TIMEOUT_MS: '300' });
  const error = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.equal(calls.length, 1);
  assert.match(error.message, /TimeoutError|timeout/i);
});

test('Anthropic: an error event in the stream fails the model (REV-108)', async () => {
  const { fetch } = fakeFetch([
    () => sseResponse([...startEvents('claude-haiku-5-5'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]),
  ]);
  const config = providerLevelConfig('lite', 'anthropic');
  const error = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.match(error.message, /Anthropic stopped the stream: overloaded_error: Overloaded/);
});

test('thinkingOff: only Haiku 5.5 accepts `disabled` (REV-108)', () => {
  assert.deepEqual(thinkingOff('claude-haiku-5-5'), { type: 'disabled' });
  assert.equal(thinkingOff('claude-sonnet-5-5'), null);
  assert.equal(thinkingOff('claude-opus-5-5'), null);
  // At `lite`: 60 s of thinking, but never past 120 s of the 180 s, the 60 s left for the second request.
  assert.equal(thinkingWaitMs(180_000, 5_000), MAX_THINKING_MS);
  assert.equal(thinkingWaitMs(180_000, 90_000), 30_000);
  assert.equal(thinkingWaitMs(180_000, 130_000), null);
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
  assert.match(costLine('lite', { model: 'qwen3', cost: 0, cost_source: 'unknown' }), /unknown cost \(no price for this model, counted as \$0\)$/);
  assert.match(costLine('lite', { model: 'qwen3', cost: 0, cost_source: 'free' }), /\$0\.000 \(local model\)$/);
  assert.match(costLine('lite', { model: 'm', cost: 0.0123, cost_source: 'table' }), /· \$0\.012$/);
  assert.match(costLine('lite', { model: 'm', cost: 0.0123 }), /· \$0\.012$/);
});

test('a prompt that the client gives replaces the file of prompts/ with that name only', async () => {
  const answer = () => json({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: {} });
  const { fetch, calls } = fakeFetch([answer]);
  const client = { apiKey: 'k', kind: 'anthropic' as const, fetch, log: quiet, prompts: { 'review.md': 'the old prompt' } };
  const config = providerLevelConfig('lite', 'anthropic');
  await askJson(client, config, 'review.md', 'p', SCHEMA);
  await askJson(client, config, 'verify.md', 'p', SCHEMA);
  assert.equal(calls[0]!.body.system[0].text, 'the old prompt');
  assert.notEqual(calls[1]!.body.system[0].text, 'the old prompt');
});

test('KNT-161. a usage limit stops at the first model of the provider, and the error keeps its reset time', async () => {
  // The call reads the clock: the reset is ten days from now, at midnight UTC.
  const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const body = { type: 'error', error: { type: 'invalid_request_error', message: `You have reached your specified API usage limits. You will regain access on ${day} at 00:00 UTC.` } };
  const { fetch, calls } = fakeFetch([() => json(body, 400), () => json({ content: [{ type: 'text', text: '{"ok":true}' }] })]);
  const config = providerLevelConfig('lite', 'anthropic', ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  const error = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.ok(usageLimited(error), String(error));
  assert.equal(calls.length, 1, 'the second model of the same provider is not called');
  assert.equal(error.resetAt, `${day}T00:00:00Z`);
  assert.equal(error.status, 400);
  assert.ok(!refusedKey(error), 'a usage limit is not a refused key');
  assert.deepEqual(limitOfReason(String(error.message)), { kind: 'usage', resetAt: `${day}T00:00:00Z` });
});

const NOW = Date.parse('2026-11-21T10:00:00Z');
const headers = (h: Record<string, string>) => new Headers(h);

test('KNT-161. a 402, a body that names a quota, credits, a spend or key limit, or a far reset is a usage limit', () => {
  assert.deepEqual(limitOf(402, 'Insufficient credits', undefined, NOW), { kind: 'usage', resetAt: null });
  assert.deepEqual(limitOf(429, 'You exceeded your current quota', undefined, NOW), { kind: 'usage', resetAt: null });
  assert.deepEqual(limitOf(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits', undefined, NOW), { kind: 'usage', resetAt: null });
  assert.deepEqual(limitOf(400, 'Your credit balance is too low', undefined, NOW), { kind: 'usage', resetAt: null });
  assert.deepEqual(limitOf(403, 'Key limit exceeded until 2026-12-24T08:30:00+01:00', undefined, NOW), { kind: 'usage', resetAt: '2026-12-24T07:30:00Z' });
  // A 429 with no words of a usage limit, that ends in more than 10 minutes: a retry of the job would fail too.
  assert.deepEqual(limitOf(429, 'Rate limit exceeded', headers({ 'retry-after': '3600' }), NOW), { kind: 'usage', resetAt: '2026-11-21T11:00:00Z' });
});

test('KNT-161. a 429 with a short or no reset is a rate limit, with the reset time of retry-after or of the headers', () => {
  assert.deepEqual(limitOf(429, 'Too many requests', headers({ 'retry-after': '120' }), NOW), { kind: 'rate', resetAt: '2026-11-21T10:02:00Z' });
  assert.deepEqual(limitOf(429, '{}', headers({ 'anthropic-ratelimit-tokens-reset': '2026-11-21T10:05:00Z' }), NOW), { kind: 'rate', resetAt: '2026-11-21T10:05:00Z' });
  assert.deepEqual(limitOf(429, 'slow down', undefined, NOW), { kind: 'rate', resetAt: null });
  assert.deepEqual(limitOf(400, 'rate_limit_error: try later', undefined, NOW), { kind: 'rate', resetAt: null });
  assert.equal(limitOf(401, 'invalid x-api-key', undefined, NOW), null);
  assert.equal(limitOf(400, 'max_tokens is too large', undefined, NOW), null);
  assert.equal(limitOf(500, 'rate limit of the upstream', undefined, NOW), null);
});

test('KNT-161. the reset headers: decimal seconds, epoch seconds or milliseconds, a delta, a duration; never in the past', () => {
  const reset = (h: Record<string, string>) => limitOf(429, '{}', headers(h), NOW)?.resetAt;
  assert.equal(reset({ 'retry-after': '1.5' }), '2026-11-21T10:00:02Z');
  assert.equal(reset({ 'retry-after': 'Sat, 21 Nov 2026 10:01:00 GMT' }), '2026-11-21T10:01:00Z');
  assert.equal(reset({ 'x-ratelimit-reset': String(Date.parse('2026-11-21T10:04:00Z')) }), '2026-11-21T10:04:00Z');
  assert.equal(reset({ 'x-ratelimit-reset': String(Date.parse('2026-11-21T10:04:00Z') / 1000) }), '2026-11-21T10:04:00Z');
  assert.equal(reset({ 'x-ratelimit-reset': '12' }), '2026-11-21T10:00:12Z');
  assert.equal(reset({ 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' }), '2026-11-21T10:06:00Z');
  assert.equal(reset({ 'x-ratelimit-reset-tokens': '250ms' }), '2026-11-21T10:00:01Z');
  // A time in the past is no reset, so the next field is read.
  assert.equal(reset({ 'retry-after': 'Thu, 19 Nov 2026 10:00:00 GMT' }), null);
  assert.equal(reset({ 'retry-after': 'Thu, 19 Nov 2026 10:00:00 GMT', 'x-ratelimit-reset': '30' }), '2026-11-21T10:00:30Z');
  assert.equal(reset({ 'x-ratelimit-reset': '0' }), null);
});

test('KNT-161. only the reset fields of the body are read: another date of the body never beats retry-after', () => {
  const body = '{"error":{"message":"Rate limit exceeded","created":"2026-11-20T09:00:00Z"}}';
  assert.equal(limitOf(429, body, headers({ 'retry-after': '30' }), NOW)?.resetAt, '2026-11-21T10:00:30Z');
  assert.equal(limitOf(429, '{"created":"2026-11-21T10:05:00Z"}', undefined, NOW)?.resetAt, null);
  assert.equal(limitOf(429, 'Rate limit exceeded, try again at 2026-11-21T10:03:00Z', undefined, NOW)?.resetAt, '2026-11-21T10:03:00Z');
  assert.equal(limitOf(429, 'Usage limit until 2026-11-20T10:00:00Z', undefined, NOW)?.resetAt, null);
  const openRouterDay = '{"error":{"message":"Rate limit exceeded: free-models-per-day","metadata":{"headers":{"X-RateLimit-Reset":"1763769600000"}}}}';
  assert.equal(limitOf(429, openRouterDay, undefined, Date.parse('2025-11-21T10:00:00Z'))?.resetAt, '2025-11-22T00:00:00Z');
});

test('KNT-161. a 403 is a limit only with the words of a usage limit: « rate limit » alone stays a refused key', () => {
  assert.equal(limitOf(403, '{"error":{"message":"flagged","metadata":{"flagged_input":"see the rate limit"}}}', undefined, NOW), null);
  assert.deepEqual(limitOf(403, 'Key limit exceeded', undefined, NOW), { kind: 'usage', resetAt: null });
  assert.ok(refusedKey(new ProviderError('Anthropic answered 403: permission_error', 403)));
  assert.ok(!refusedKey(new UsageLimitError('OpenRouter refused the call on a usage limit (403): Key limit exceeded', 403, null)));
  assert.ok(!refusedKey(new RateLimitError('refused the call on a rate limit (403)', 403, null)));
});

test('KNT-161. OpenRouter: a short 429 on Haiku tries GLM, which answers', async () => {
  const { fetch, calls } = fakeFetch([
    () => new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429, headers: { 'retry-after': '30' } }),
    () => json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 40, completion_tokens: 3 } }),
  ]);
  const reply = await askJson({ apiKey: 'k', kind: 'openrouter', fetch, log: quiet }, levelConfig('lite'), 'review.md', 'p', SCHEMA);
  assert.deepEqual(reply.answer, { ok: true });
  assert.deepEqual(calls.map((call) => call.body.model), ['anthropic/claude-haiku-5.5', 'z-ai/glm-5.3']);
});

test('KNT-161. OpenRouter: a short 429 on every model is a rate limit with the latest reset, that the service reads', async () => {
  const { fetch, calls } = fakeFetch([
    () => new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429, headers: { 'retry-after': '90' } }),
    () => new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429, headers: { 'retry-after': '20' } }),
  ]);
  const before = Date.now();
  const error = await askJson({ apiKey: 'k', kind: 'openrouter', fetch, log: quiet }, levelConfig('lite'), 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.equal(calls.length, 2);
  assert.ok(rateLimited(error), String(error));
  assert.ok(!usageLimited(error) && !refusedKey(error));
  assert.equal(error.status, 429);
  const wait = Date.parse(error.resetAt ?? '') - before;
  assert.ok(wait > 80_000 && wait <= 92_000, `the latest reset, about 90 s away: ${error.resetAt}`);
  assert.deepEqual(limitOfReason(String(error.message)), { kind: 'rate', resetAt: error.resetAt });
});

test('KNT-161. a short 429, then a usage limit on the next model, stops on the usage limit', async () => {
  const { fetch, calls } = fakeFetch([
    () => new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429 }),
    () => json({ error: { message: 'Insufficient credits' } }, 402),
  ]);
  const error = await askJson({ apiKey: 'k', kind: 'openrouter', fetch, log: quiet }, levelConfig('lite'), 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.equal(calls.length, 2);
  assert.ok(usageLimited(error), String(error));
  assert.equal(limitOfReason(String(error.message))?.kind, 'usage');
});

test('KNT-161. a short 429, then another failure, is not a limit', async () => {
  const { fetch } = fakeFetch([
    () => new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429 }),
    () => json({ error: { message: 'overloaded' } }, 503),
  ]);
  const error = await askJson({ apiKey: 'k', kind: 'openrouter', fetch, log: quiet }, levelConfig('lite'), 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.ok(!rateLimited(error) && !usageLimited(error), String(error));
  assert.equal(limitOfReason(String(error.message)), null);
});

test('KNT-161. the reason of a runner of an earlier release is read too: a 429, a 402 or a body that names a limit', () => {
  assert.deepEqual(limitOfReason('no model gave a usable answer: ProviderError: OpenRouter answered 403: {"error":{"message":"Key limit exceeded"}}'), { kind: 'usage', resetAt: null });
  assert.deepEqual(
    limitOfReason('no model gave a usable answer: ProviderError: Anthropic answered 400: {"error":{"message":"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."}}', NOW),
    { kind: 'usage', resetAt: '2026-12-01T00:00:00Z' },
  );
  assert.deepEqual(limitOfReason('OpenRouter answered 429: Rate limit exceeded'), { kind: 'rate', resetAt: null });
  assert.equal(limitOfReason('no model gave a usable answer: ProviderError: Anthropic answered 401: invalid x-api-key'), null);
  assert.equal(limitOfReason('OpenRouter answered 500: rate limit of the upstream'), null);
  assert.equal(limitOfReason('OpenRouter answered 500: overloaded'), null);
  assert.equal(limitOfReason('clone failed: exit 128'), null);
  // A 401 stays a refused key, even when its body names a limit.
  assert.equal(limitOfReason('OpenRouter answered 401: {"error":{"message":"invalid key, see the rate limit page"}}'), null);
  assert.equal(limitOf(401, 'quota of the key', undefined), null);
});
