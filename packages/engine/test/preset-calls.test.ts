// KNT-204. The calls to the presets, and how KNT-161 reads their limits. Every answer here is a
// response that the docs of the provider give (body, status, headers), on the day of `checked` in
// presets.ts. No test calls a provider, and no key is real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askJson, providerLevelConfig } from '../src/index.ts';
import { presetById } from '../src/presets.ts';
import { limitOf, rateLimited, refusedKey, usageLimited, type ProviderLimit } from '../src/providers.ts';

const SCHEMA = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
const NOW = Date.parse('2026-11-24T10:00:00Z');
const quiet = () => {};

type Recorded = { url: string; headers: Record<string, string>; body: any };

function fakeFetch(answers: (() => Response)[]) {
  const calls: Recorded[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return answers[Math.min(calls.length - 1, answers.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

function preset(id: string) {
  const found = presetById(id);
  assert.ok(found, id);
  return found;
}

/** One call of a level to a preset, with its own models. */
function callPreset(id: string, level: 'lite' | 'balanced' | 'heavy', answers: (() => Response)[]) {
  const { fetch, calls } = fakeFetch(answers);
  const p = preset(id);
  const config = providerLevelConfig(level, 'openai_compatible', [...p.models[level]]);
  const done = askJson<{ ok: boolean }>({ apiKey: 'test-key', kind: 'openai_compatible', baseUrl: p.baseUrl, fetch, log: quiet }, config, 'review.md', 'p', SCHEMA);
  return { done, calls, preset: p };
}

const answer = (model: string, usage: object) => () => json({ model, choices: [{ message: { content: '{"ok":true}' } }], usage });

test('KNT-204. a preset call: the URL of the preset, the schema, the name of the provider, and the cost from the table with the cached tokens apart', async () => {
  const { done, calls, preset: groq } = callPreset('groq', 'balanced', [
    answer('openai/gpt-oss-120b', { prompt_tokens: 100_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 40_000 } }),
  ]);
  const { usage } = await done;
  assert.equal(calls[0]!.url, `${groq.baseUrl}/chat/completions`);
  assert.equal(calls[0]!.body.model, 'openai/gpt-oss-120b');
  assert.equal(calls[0]!.body.response_format.type, 'json_schema');
  assert.equal(calls[0]!.body.response_format.json_schema.strict, true);
  assert.equal(calls[0]!.body.max_tokens, 24_000, 'the cap of the level: the model takes more');
  assert.equal(usage.provider, 'Groq');
  // 60,000 × 0.15 + 40,000 × 0.075 + 10,000 × 0.6 = 18,000 millionths of a dollar.
  assert.equal(usage.cost, 0.018);
  assert.equal(usage.cost_source, 'table');
});

test('KNT-204. a server that answers the dated id of an alias keeps the price of the id it was asked for', async () => {
  const { done } = callPreset('cerebras', 'lite', [answer('gpt-oss-120b-2026-01-01', { prompt_tokens: 1_000_000, completion_tokens: 0 })]);
  const { usage } = await done;
  assert.equal(usage.model, 'gpt-oss-120b-2026-01-01');
  assert.equal(usage.cost, 0.35);
  assert.equal(usage.cost_source, 'table');
});

test('KNT-204. the call asks for no more answer tokens than the model of the preset takes', async () => {
  const { done, calls, preset: deepinfra } = callPreset('deepinfra', 'lite', [answer('deepseek-ai/DeepSeek-V4.1-Flash-1017', { prompt_tokens: 10, completion_tokens: 1 })]);
  await done;
  assert.equal(calls[0]!.body.max_tokens, deepinfra.maxOutputTokens!['deepseek-ai/DeepSeek-V4.1-Flash-1017']);
  assert.ok(calls[0]!.body.max_tokens < 32_000);
});

test('KNT-204. a server that is no preset keeps the cap of the level and the name "The OpenAI-compatible server"', async () => {
  const { fetch, calls } = fakeFetch([() => json({ error: { message: 'Too many requests' } }, 429)]);
  const config = providerLevelConfig('lite', 'openai_compatible', ['m']);
  const error = await askJson({ apiKey: 'k', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.equal(calls[0]!.body.max_tokens, 32_000);
  assert.match(String(error), /The OpenAI-compatible server refused the call on a rate limit/);
});

/** A 429 of the OpenAI compatibility of Gemini: an array, the message, then the details. */
function gemini429(quotaId: string, retryDelay: string): string {
  return JSON.stringify([
    {
      error: {
        code: 429,
        message:
          'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count', quotaId, quotaDimensions: { location: 'global', model: 'gemini-4-neon' }, quotaValue: '2000000' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
        ],
      },
    },
  ]);
}

/**
 * The limits that the docs of each provider give: the status, the body and the headers of the
 * answer, and what KNT-161 must read in it.
 */
const LIMITS: { provider: string; what: string; status: number; body: string; headers?: Record<string, string>; limit: ProviderLimit | null }[] = [
  // https://developers.openai.com/api/docs/guides/rate-limits gives the headers, with these values;
  // https://developers.openai.com/api/docs/guides/error-codes the codes and types. The docs give no
  // body: these have the shape of the errors of the API.
  {
    provider: 'openai',
    what: 'a 429 of the requests, with retry-after',
    status: 429,
    body: '{"error":{"message":"Rate limit reached for requests","type":"rate_limit_error","param":null,"code":"rate_limit_exceeded"}}',
    headers: { 'retry-after': '56', 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' },
    limit: { kind: 'rate', resetAt: '2026-11-24T10:00:56Z' },
  },
  {
    provider: 'openai',
    what: 'a 429 "Slow down"',
    status: 429,
    body: '{"error":{"message":"Your request rate increased too quickly.","type":"rate_limit_error","param":null,"code":"slow_down"}}',
    limit: { kind: 'rate', resetAt: null },
  },
  {
    provider: 'openai',
    what: 'no prepaid credits left',
    status: 429,
    body: '{"error":{"message":"Your organization has no prepaid credits remaining.","type":"insufficient_quota","param":null,"code":"credit_balance_exhausted"}}',
    limit: { kind: 'usage', resetAt: null },
  },
  // The type « can still be insufficient_quota »: the code alone must be enough.
  {
    provider: 'openai',
    what: 'the spend limit of the organization, by its code alone',
    status: 429,
    body: '{"error":{"message":"The organization reached its limit.","type":"requests","param":null,"code":"organization_spend_limit_exceeded"}}',
    limit: { kind: 'usage', resetAt: null },
  },
  {
    provider: 'openai',
    what: 'the usage limit of the organization, by its code alone',
    status: 429,
    body: '{"error":{"message":"Monthly limit reached.","type":"requests","param":null,"code":"organization_usage_limit_exceeded"}}',
    limit: { kind: 'usage', resetAt: null },
  },
  {
    provider: 'openai',
    what: 'the hard limit of the billing',
    status: 429,
    body: '{"error":{"message":"Billing limit reached.","type":"requests","param":null,"code":"billing_hard_limit_reached"}}',
    limit: { kind: 'usage', resetAt: null },
  },
  // https://docs.x.ai/developers/rate-limits: « Exceeding any limit returns a 429 Too Many Requests
  // error », with no body and no header documented. https://docs.x.ai/console/billing: the calls are
  // « automatically rejected once your prepaid credits are depleted », with no status documented.
  { provider: 'xai', what: 'a 429 with no body', status: 429, body: '', limit: { kind: 'rate', resetAt: null } },
  {
    provider: 'xai',
    what: 'credits spent, whatever the status',
    status: 403,
    body: '{"code":"Some resource has been exhausted","error":"Your team has either used all available credits or reached its monthly spending limit."}',
    limit: { kind: 'usage', resetAt: null },
  },
  // https://docs.together.ai/docs/error-codes: 429 « limiting serverless requests during high demand »,
  // 402 « balance has reached its spend cut-off ». No body and no header documented.
  { provider: 'together', what: 'a 429 of high demand', status: 429, body: '{"error":{"message":"Too many requests","type":"rate_limit"}}', limit: { kind: 'rate', resetAt: null } },
  { provider: 'together', what: 'the spend cut-off', status: 402, body: '', limit: { kind: 'usage', resetAt: null } },
  // https://docs.fireworks.ai/serverless/rate-limits.md: « For 429 responses, honor the Retry-After
  // header ». https://docs.fireworks.ai/nexus/usage-limits: a 402 until the limit is raised. A 412
  // (a suspended account) is no limit: an admin must act.
  { provider: 'fireworks', what: 'a 429 with Retry-After', status: 429, body: '', headers: { 'retry-after': '30' }, limit: { kind: 'rate', resetAt: '2026-11-24T10:00:30Z' } },
  { provider: 'fireworks', what: 'the spend limit', status: 402, body: '', limit: { kind: 'usage', resetAt: null } },
  { provider: 'fireworks', what: 'a suspended account (412)', status: 412, body: '{"error":{"message":"Account suspended"}}', limit: null },
  // https://aistudio.google.com/docs/api-errors.md: the shape of the errors, 429 RESOURCE_EXHAUSTED for
  // « RPM, TPM, RPD, spend », and 402 RESOURCE_EXHAUSTED « Your Prepay credit balance is depleted ».
  // The docs give no body of a 429. The OpenAI compatibility answers it in an array, with the window
  // of the quota and a RetryInfo in `details`: the message first, then about 600 characters.
  {
    provider: 'gemini',
    what: 'a 429 of the tokens of a minute, in an array, with its retryDelay after the message',
    status: 429,
    body: gemini429('GenerateContentPaidTierInputTokensPerModelPerMinute', '58s'),
    limit: { kind: 'rate', resetAt: '2026-11-24T10:00:58Z' },
  },
  {
    provider: 'gemini',
    what: 'a 429 of the requests of a day: a usage limit',
    status: 429,
    body: gemini429('GenerateRequestsPerDayPerProjectPerModel', '3600s'),
    limit: { kind: 'usage', resetAt: '2026-11-24T11:00:00Z' },
  },
  {
    provider: 'gemini',
    what: 'the prepaid credits spent (402)',
    status: 402,
    body: '{"error":{"code":402,"message":"Your Prepay credit balance is depleted.","status":"RESOURCE_EXHAUSTED"}}',
    limit: { kind: 'usage', resetAt: null },
  },
  // https://docs.mistral.ai/llms/resources/error-glossary/llms.txt, verbatim for the 429; the 402 has
  // the code and the type of its table.
  {
    provider: 'mistral',
    what: 'a 429 "Rate limit exceeded"',
    status: 429,
    body: '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300","raw_status_code":429}',
    limit: { kind: 'rate', resetAt: null },
  },
  {
    provider: 'mistral',
    what: 'no capacity left',
    status: 429,
    body: '{"object":"error","message":"Not enough capacity available for this request, please retry later.","type":"backend_out_of_capacity","param":null,"code":"3505","raw_status_code":429}',
    headers: { 'retry-after': '20' },
    limit: { kind: 'rate', resetAt: '2026-11-24T10:00:20Z' },
  },
  {
    provider: 'mistral',
    what: 'out of credits (402)',
    status: 402,
    body: '{"object":"error","message":"Out of credits. Top up your balance to restore access.","type":"billing_wallet_depleted","param":null,"code":"2308","raw_status_code":402}',
    limit: { kind: 'usage', resetAt: null },
  },
  // https://console.groq.com/docs/rate-limits: retry-after only on a 429, the reset headers always,
  // with the values of the page. The docs give no body of a 429: this one has the shape of
  // https://console.groq.com/docs/errors.
  {
    provider: 'groq',
    what: 'a 429 of the tokens of the minute',
    status: 429,
    body: '{"error":{"message":"Rate limit reached for model openai/gpt-oss-120b on tokens per minute (TPM). Please try again in 7.66s.","type":"invalid_request_error"}}',
    headers: { 'retry-after': '2', 'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-reset-tokens': '7.66s' },
    limit: { kind: 'rate', resetAt: '2026-11-24T10:00:02Z' },
  },
  {
    provider: 'groq',
    what: 'a 429 with no retry-after: the latest reset header',
    status: 429,
    body: '{"error":{"message":"Rate limit reached","type":"invalid_request_error"}}',
    headers: { 'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-reset-tokens': '7.66s' },
    limit: { kind: 'rate', resetAt: '2026-11-24T10:03:00Z' },
  },
  // https://console.groq.com/docs/spend-limits: « API calls from any key in the organization will
  // return a 400 with code blocked_api_access ».
  {
    provider: 'groq',
    what: 'the spend limit of the organization, a 400',
    status: 400,
    body: '{"error":{"message":"API access is blocked for this organization","type":"invalid_request_error","code":"blocked_api_access"}}',
    limit: { kind: 'usage', resetAt: null },
  },
  // https://docs.deepinfra.com/chat/overview.md, verbatim.
  {
    provider: 'deepinfra',
    what: 'a busy model',
    status: 429,
    body: '{"error":{"message":"Model busy, retry later","type":"invalid_request_error","param":null,"code":"engine_overloaded"}}',
    limit: { kind: 'rate', resetAt: null },
  },
  // https://docs.deepinfra.com/account/rate-limits.md: « HTTP 429 with a `Rate limited` message ».
  { provider: 'deepinfra', what: 'the concurrent requests of a model', status: 429, body: 'Rate limited', limit: { kind: 'rate', resetAt: null } },
  // https://docs.deepinfra.com/integrations/pi: « a 402/quota error means the account needs funding ».
  { provider: 'deepinfra', what: 'an account to fund', status: 402, body: '{"error":"Payment required"}', limit: { kind: 'usage', resetAt: null } },
  // https://inference-docs.cerebras.ai/support/error: 402 PaymentRequired and 429 RateLimitError,
  // with no body given. https://inference-docs.cerebras.ai/support/rate-limits documents no header,
  // and says that the message names the bucket of tokens. The body of the minute below is the one
  // that the API answers (not in the docs): its code says "quota", and the limit ends within the minute.
  { provider: 'cerebras', what: 'a 402 with no body', status: 402, body: '', limit: { kind: 'usage', resetAt: null } },
  {
    provider: 'cerebras',
    what: 'a 429 of the tokens of the minute, whose code says "quota"',
    status: 429,
    body: '{"message":"Tokens per minute limit exceeded - too many tokens processed.","type":"too_many_tokens_error","param":"quota","code":"token_quota_exceeded"}',
    limit: { kind: 'rate', resetAt: null },
  },
  { provider: 'cerebras', what: 'a 429 with no words', status: 429, body: '', limit: { kind: 'rate', resetAt: null } },
];

for (const row of LIMITS) {
  test(`KNT-204. ${preset(row.provider).name}: ${row.what}`, () => {
    assert.deepEqual(limitOf(row.status, row.body, new Headers(row.headers ?? {}), NOW), row.limit);
  });
}

test('KNT-204. OpenAI and xAI: the answer cap goes in max_completion_tokens, never in max_tokens', async () => {
  for (const id of ['openai', 'xai']) {
    const p = preset(id);
    const { done, calls } = callPreset(id, 'heavy', [answer(p.models.heavy[0]!, { prompt_tokens: 10, completion_tokens: 1 })]);
    await done;
    assert.equal(calls[0]!.body.max_completion_tokens, 32_000, id);
    assert.ok(!('max_tokens' in calls[0]!.body), id);
  }
});

test('KNT-204. above 272,000 prompt tokens, GPT-5.6 Terra costs the long-context price', async () => {
  const { done } = callPreset('openai', 'balanced', [answer('gpt-5.6-terra', { prompt_tokens: 300_000, completion_tokens: 10_000 })]);
  // 300,000 × 4 + 10,000 × 18 = 1,380,000 millionths of a dollar.
  assert.equal((await done).usage.cost, 1.38);
});

test('KNT-204. a 401 of a preset is a refused key, never a limit', async () => {
  for (const id of ['openai', 'xai', 'together', 'fireworks', 'groq', 'deepinfra', 'cerebras']) {
    const { done } = callPreset(id, 'lite', [() => json({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)]);
    const error = await done.catch((e) => e);
    assert.ok(refusedKey(error), id);
    assert.ok(!usageLimited(error) && !rateLimited(error), id);
  }
});

test('KNT-204. Gemini: the call reads the window and the retryDelay past the 300 characters that the error keeps', async () => {
  const body = gemini429('GenerateContentPaidTierInputTokensPerModelPerMinute', '58s');
  assert.ok(body.indexOf('retryDelay') > 300 && body.indexOf('PerMinute') > 300);
  const { done } = callPreset('gemini', 'lite', [() => new Response(body, { status: 429 })]);
  const error = await done.catch((e) => e);
  assert.ok(rateLimited(error), String(error));
  assert.ok(error.resetAt, 'the reset of retryDelay');
});

test('KNT-204. Groq at its spend limit: the 400 stops the review at once, with no call without the schema and no other model', async () => {
  const blocked = LIMITS.find((row) => row.body.includes('blocked_api_access'))!;
  const { done, calls } = callPreset('groq', 'balanced', [() => new Response(blocked.body, { status: 400 })]);
  const error = await done.catch((e) => e);
  assert.ok(usageLimited(error), String(error));
  assert.equal(calls.length, 1);
  assert.match(String(error), /Groq refused the call on a usage limit \(400\)/);
});

test('KNT-204. a 400 that is no limit still gets the call without the schema', async () => {
  const { done, calls } = callPreset('cerebras', 'lite', [
    () => json({ message: 'response_format is not valid', type: 'invalid_request_error' }, 400),
    answer('gpt-oss-120b', { prompt_tokens: 10, completion_tokens: 1 }),
  ]);
  assert.deepEqual((await done).answer, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.response_format, undefined);
});
