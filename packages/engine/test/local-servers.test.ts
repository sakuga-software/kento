import assert from 'node:assert/strict';
import test from 'node:test';
import { askJson, providerLevelConfig } from '../src/index.ts';
import { LOCAL_SERVERS, localServerById, localServerOf, normalBaseUrl, onRunnerNetwork, PROVIDER_PRESETS, RESERVED_PRESET_IDS } from '../src/presets.ts';
import { costKnown } from '../src/prices.ts';

const SCHEMA = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

test('KNT-205. each local server: a stable id that no preset takes, its default URL over HTTP, its docs dated', () => {
  assert.ok(LOCAL_SERVERS.length >= 1);
  const ids = [...PROVIDER_PRESETS.map((preset) => preset.id), ...LOCAL_SERVERS.map((server) => server.id)];
  assert.equal(new Set(ids).size, ids.length, 'one id for one choice of the picker');
  for (const server of LOCAL_SERVERS) {
    assert.match(server.id, /^[a-z][a-z0-9-]{1,30}$/, server.id);
    assert.ok(!(RESERVED_PRESET_IDS as readonly string[]).includes(server.id), server.id);
    assert.ok(server.name.length > 0 && server.name.length <= 60, server.id);
    assert.match(server.baseUrl, /^http:\/\/localhost:\d+\/v1$/, `${server.id}: the default URL on the machine of the runner`);
    assert.equal(normalBaseUrl(server.baseUrl), server.baseUrl, server.id);
    assert.ok(server.setup.length > 0 && server.setup.length <= 400, server.id);
    assert.ok(server.docs.url.startsWith('https://'), server.id);
    assert.match(server.docs.checked, DAY, server.id);
    assert.equal(localServerById(server.id), server);
    assert.equal(localServerOf('openai_compatible', `${server.baseUrl}/`), server);
    assert.equal(localServerOf('ollama', server.baseUrl), null);
    assert.ok(onRunnerNetwork('openai_compatible', server.baseUrl), server.id);
  }
  const urls = LOCAL_SERVERS.map((server) => server.baseUrl);
  assert.equal(new Set(urls).size, urls.length, 'localServerOf finds one server');
  assert.equal(localServerById('constructor'), null);
});

test('KNT-205. a server on the network of a runner: Ollama, or a server of the API of OpenAI over HTTP', () => {
  assert.ok(onRunnerNetwork('ollama', null));
  assert.ok(onRunnerNetwork('ollama', 'https://gpu.example.com'));
  assert.ok(onRunnerNetwork('openai_compatible', 'http://gpu.lan:8000/v1'));
  assert.ok(onRunnerNetwork('openai_compatible', ' HTTP://gpu.lan:8000/v1'));
  // HTTPS is a cloud, or a server that the admin put behind TLS: its cost is not known.
  assert.ok(!onRunnerNetwork('openai_compatible', 'https://gpu.lan:8000/v1'));
  assert.ok(!onRunnerNetwork('openai_compatible', null));
  assert.ok(!onRunnerNetwork('anthropic', 'http://proxy.lan'));
  assert.ok(!onRunnerNetwork('openrouter', 'http://proxy.lan'));
  // The screen says that the cost is known (0), and the cap counts it.
  assert.ok(costKnown('openai_compatible', 'qwen3-coder', 'http://localhost:1234/v1'));
  assert.ok(!costKnown('openai_compatible', 'qwen3-coder', 'https://llm.example.com/v1'));
});

test('KNT-205. a call to a local server goes to its /chat/completions with the schema, and costs 0', async () => {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: 'qwen3-coder-30b', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 900, completion_tokens: 80 } }));
  }) as typeof globalThis.fetch;
  const config = providerLevelConfig('balanced', 'openai_compatible', ['qwen3-coder-30b']);
  const { answer, usage } = await askJson<{ ok: boolean }>(
    { apiKey: undefined, kind: 'openai_compatible', baseUrl: 'http://gpu.lan:1234/v1', fetch, log: () => {} },
    config,
    'review.md',
    'p',
    SCHEMA,
  );
  assert.deepEqual(answer, { ok: true });
  assert.equal(calls[0]!.url, 'http://gpu.lan:1234/v1/chat/completions');
  assert.equal(calls[0]!.headers.Authorization, undefined, 'no key: no header');
  assert.equal(calls[0]!.body.response_format.type, 'json_schema');
  assert.equal(usage.cost, 0);
  assert.equal(usage.cost_source, 'free');
  // The same server over HTTPS: its cost is not known.
  const { usage: tls } = await askJson(
    { apiKey: 'k', kind: 'openai_compatible', baseUrl: 'https://gpu.lan:1234/v1', fetch, log: () => {} },
    config,
    'review.md',
    'p',
    SCHEMA,
  );
  assert.equal(tls.cost_source, 'unknown');
});
