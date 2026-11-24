// KNT-205. The limits of the clouds of Europe, from recorded answers. Each answer is built from what
// the docs of the provider give: the status, the names and the form of the headers, the shape of the
// body. Where the docs show no body, the test says so.
import assert from 'node:assert/strict';
import test from 'node:test';
import { askJson, providerLevelConfig } from '../src/index.ts';
import { presetById } from '../src/presets.ts';
import { priceOf } from '../src/prices.ts';
import { limitOf, RateLimitError } from '../src/providers.ts';

const SCHEMA = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
const NOW = Date.parse('2026-11-24T10:00:00Z');

/** A fetch that records each request and gives the same answer each time. */
function answering(answer: () => Response) {
  const bodies: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

// Scaleway, « Rate limits »: the headers and their values, durations such as `250ms`. The docs give
// the shape of an error body (« {"error": {"message", "type", "param", "code"}} ») and no example of
// a 429: the words of the message are those of the table of the errors.
const scaleway429 = () =>
  new Response(JSON.stringify({ error: { message: 'Too Many Tokens', type: 'rate_limit', param: null, code: 429 } }), {
    status: 429,
    headers: {
      'x-ratelimit-limit-requests': '600',
      'x-ratelimit-remaining-requests': '599',
      'x-ratelimit-reset-requests': '250ms',
      'x-ratelimit-limit-tokens': '1000000',
      'x-ratelimit-remaining-tokens': '0',
      'x-ratelimit-reset-tokens': '35ms',
    },
  });

test('KNT-205. Scaleway: a 429 with its reset headers is a rate limit that ends within the second', () => {
  const answer = scaleway429();
  // The latest reset of the headers (250 ms), rounded up to the second.
  assert.deepEqual(limitOf(429, JSON.stringify({ error: { message: 'Too Many Tokens', type: 'rate_limit', param: null, code: 429 } }), answer.headers, NOW), {
    kind: 'rate',
    resetAt: '2026-11-24T10:00:01Z',
  });
  // The older models answer « {"object": "error", "message", "type", "param", "code"} ».
  const legacy = JSON.stringify({ object: 'error', message: 'Too Many Requests', type: 'TooManyRequests', param: null, code: 429 });
  assert.deepEqual(limitOf(429, legacy, answer.headers, NOW), { kind: 'rate', resetAt: '2026-11-24T10:00:01Z' });
});

test('KNT-205. Scaleway: the call asks max_completion_tokens, under the cap of the model, and a 429 names the provider', async () => {
  const preset = presetById('scaleway')!;
  const { fetch, bodies } = answering(() =>
    new Response(JSON.stringify({ error: { message: 'Too Many Requests', type: 'rate_limit', param: null, code: 429 } }), {
      status: 429,
      headers: { 'x-ratelimit-reset-requests': '250ms' },
    }),
  );
  const config = providerLevelConfig('heavy', 'openai_compatible', ['glm-5.3']);
  const error = await askJson({ apiKey: 'k', kind: 'openai_compatible', baseUrl: preset.baseUrl, fetch, log: () => {} }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.ok(error instanceof RateLimitError, String(error));
  assert.match(error.message, /: Scaleway Generative APIs refused the call on a rate limit \(429/);
  assert.equal(bodies[0].max_completion_tokens, 24_000, '« 24k » in the table of the models');
  assert.equal(bodies[0].max_tokens, undefined);
  assert.equal(bodies[0].response_format.type, 'json_schema');
  assert.equal(bodies[0].tools, undefined, 'Scaleway gives no tool call with a JSON schema: the adapter sends no tools');
});

test('KNT-205. OVHcloud: a 429 with no header and no body is a rate limit with no reset', async () => {
  // « Exceeding the limit returns a 429 error code »: the docs name no header and show no body.
  assert.deepEqual(limitOf(429, '', new Headers(), NOW), { kind: 'rate', resetAt: null });
  const preset = presetById('ovhcloud')!;
  const { fetch, bodies } = answering(() => new Response('', { status: 429 }));
  const config = providerLevelConfig('lite', 'openai_compatible', ['gpt-oss-20b']);
  const error = await askJson({ apiKey: 'k', kind: 'openai_compatible', baseUrl: preset.baseUrl, fetch, log: () => {} }, config, 'review.md', 'p', SCHEMA).catch((e) => e);
  assert.ok(error instanceof RateLimitError, String(error));
  assert.match(error.message, /: OVHcloud AI Endpoints refused the call on a rate limit \(429\)/);
  assert.equal(bodies[0].max_tokens, 32_000, 'the docs give no cap: the levels ask 32,000');
});

test('KNT-205. the prices in euros are counted in dollars at the rate of the ECB of 2026-11-24', () => {
  // Scaleway, glm-5.3: 1.80 € and 5.50 € a million tokens, before tax.
  assert.deepEqual(priceOf('openai_compatible', 'glm-5.3', 'https://api.scaleway.ai/v1'), { input: 1.9733, output: 6.0297, cacheRead: 1.9733, cacheWrite: 1.9733, cacheWrite1h: 1.9733 });
  // A cached price where Scaleway gives one.
  assert.equal(priceOf('openai_compatible', 'deepseek-v4-flash-0731', 'https://api.scaleway.ai/v1')!.cacheRead, 0.0877);
  assert.equal(priceOf('openai_compatible', 'gpt-oss-120b', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1')!.output, 0.4385);
});
