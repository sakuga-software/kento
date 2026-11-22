// REV-68. A review call with tools: the model asks for code, gets it, then answers.
// Run with `pnpm test`, or `node --test packages/engine/test/`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { askJson, levelConfig, providerLevelConfig } from '../src/index.ts';
import { askModel } from '../src/model.ts';
import { LEVELS } from '../src/levels.ts';
import { RepoTools, TOOL_BUDGETS, TOOLS_NOTE } from '../src/tools.ts';
import { messageResponse } from './sse.ts';
import { FINAL_INSTRUCTION } from '../src/sections.ts';

const SCHEMA = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const quiet = () => {};

function fakeFetch(answers: ((body: any) => Response)[]) {
  const calls: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    // A copy: the engine changes its messages between requests.
    const body = JSON.parse(String(init.body));
    calls.push(body);
    return answers[Math.min(calls.length - 1, answers.length - 1)]!(body);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, encoding: 'utf8' }).trim();

describe('a review call with tools', () => {
  const root = mkdtempSync(join(process.env.SAKUGA_TEST_TMP ?? tmpdir(), 'sakuga-review-tool-loop-'));
  let head = '';
  before(() => {
    git(root, 'init', '-q', '.');
    writeFileSync(join(root, 'mail.ts'), 'export const disableStandardEmails = true;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'head');
    head = git(root, 'rev-parse', 'HEAD');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const anthropicUsage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
    input_tokens: input,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
  });

  test('Anthropic: a tool_use round, then the answer; the tokens of both requests add up', async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        json({
          model: 'claude-sonnet-5-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: 'need mail.ts', signature: 's' },
            { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'mail.ts' } },
          ],
          usage: anthropicUsage(100, 0, 5000, 50),
        }),
      () => json({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: anthropicUsage(80, 5000, 60, 20) }),
    ]);
    const tools = new RepoTools(root, head, TOOL_BUDGETS.balanced);
    const config = providerLevelConfig('balanced', 'anthropic');
    const { answer, usage } = await askJson<{ ok: boolean }>({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'the pack', SCHEMA, undefined, tools);

    assert.deepEqual(answer, { ok: true });
    assert.equal(calls.length, 2);
    const [first, second] = calls;
    assert.deepEqual(first.tools.map((t: any) => t.name), ['read_file', 'grep']);
    assert.deepEqual(first.tool_choice, { type: 'auto' });
    // The pack carries the cache mark: the second request reads it from the cache.
    assert.deepEqual(first.messages, [{ role: 'user', content: [{ type: 'text', text: 'the pack', cache_control: { type: 'ephemeral' } }] }]);
    assert.equal(second.messages.length, 3);
    assert.equal(second.messages[0].content[0].cache_control, undefined);
    assert.equal(second.messages[1].role, 'assistant');
    assert.equal(second.messages[1].content[0].type, 'thinking');
    assert.deepEqual(second.messages[2].content, [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'mail.ts\n1| export const disableStandardEmails = true;', cache_control: { type: 'ephemeral' } },
    ]);
    assert.deepEqual(tools.used, { rounds: 1, calls: 1, bytes: Buffer.byteLength('mail.ts\n1| export const disableStandardEmails = true;') });

    assert.equal(usage.prompt_tokens, 100 + 5000 + 80 + 5000 + 60);
    assert.equal(usage.completion_tokens, 70);
    assert.equal(usage.cache_read_tokens, 5000);
    assert.equal(usage.cache_write_tokens, 5060);
    assert.equal(usage.cost_source, 'table');
  });

  test('Anthropic, streamed: the tool input and the signed thinking come back from their deltas (REV-108)', async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        messageResponse(
          'claude-haiku-5-5',
          [
            { type: 'thinking', thinking: 'need mail.ts', signature: 'sig-1' },
            { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'mail.ts' } },
          ],
          'tool_use',
          { input: 100, output: 50 },
        ),
      () => messageResponse('claude-haiku-5-5', [{ type: 'text', text: '{"ok":true}' }], 'end_turn', { input: 80, output: 20 }),
    ]);
    const tools = new RepoTools(root, head, TOOL_BUDGETS.lite);
    const config = providerLevelConfig('lite', 'anthropic');
    const { answer } = await askJson<{ ok: boolean }>({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'the pack', SCHEMA, undefined, tools);

    assert.deepEqual(answer, { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].messages[1].content[0], { type: 'thinking', thinking: 'need mail.ts', signature: 'sig-1' });
    assert.deepEqual(calls[1].messages[1].content[1], { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'mail.ts' } });
    assert.equal(calls[1].messages[2].content[0].content, 'mail.ts\n1| export const disableStandardEmails = true;');
  });

  test('Anthropic: once the rounds are used, the request offers no tool and the model must answer', async () => {
    const { fetch, calls } = fakeFetch([
      () => json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'grep', input: { pattern: 'disable' } }], usage: anthropicUsage(1, 0, 0, 1) }),
      () => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":false}' }], usage: anthropicUsage(1, 0, 0, 1) }),
    ]);
    const tools = new RepoTools(root, head, { rounds: 1, calls: 5, bytes: 10_000 });
    const config = providerLevelConfig('lite', 'anthropic');
    const { answer } = await askJson<{ ok: boolean }>({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA, undefined, tools);
    assert.deepEqual(answer, { ok: false });
    assert.deepEqual(calls.map((c) => c.tool_choice), [{ type: 'auto' }, { type: 'none' }]);
    assert.equal(calls[1].messages[2].content[0].content, 'mail.ts:1:export const disableStandardEmails = true;');
  });

  test('OpenRouter: tool_calls, then the answer; the cost is the sum, and only a Claude model gets the cache mark', async () => {
    for (const model of ['anthropic/claude-sonnet-5.5', 'z-ai/glm-5.3']) {
      const { fetch, calls } = fakeFetch([
        () =>
          json({
            model,
            choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"mail.ts","to":1}' } }] } }],
            usage: { prompt_tokens: 5000, completion_tokens: 30, cost: 0.01, prompt_tokens_details: { cached_tokens: 0 } },
          }),
        () => json({ model, provider: 'P', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5100, completion_tokens: 40, cost: 0.002, prompt_tokens_details: { cached_tokens: 4900 } } }),
      ]);
      const tools = new RepoTools(root, head, TOOL_BUDGETS.lite);
      const config = levelConfig('lite', { REVIEW_MODELS: model });
      const { answer, usage } = await askJson<{ ok: boolean }>({ apiKey: 'k', fetch, log: quiet }, config, 'review.md', 'the pack', SCHEMA, undefined, tools);
      assert.deepEqual(answer, { ok: true });
      assert.equal(calls[0].tool_choice, 'auto');
      assert.deepEqual(calls[0].tools.map((t: any) => t.function.name), ['read_file', 'grep']);
      assert.equal(calls[0].messages[1].content[0].cache_control?.type, model.startsWith('anthropic/') ? 'ephemeral' : undefined);
      assert.deepEqual(calls[1].messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: 'mail.ts\n1| export const disableStandardEmails = true;' });
      assert.equal(usage.cost, 0.012);
      assert.equal(usage.cost_source, 'provider');
      assert.equal(usage.prompt_tokens, 10_100);
      assert.equal(usage.completion_tokens, 70);
      assert.equal(usage.cache_read_tokens, 4900);
    }
  });

  test('passes at once share the calls and bytes, not the rounds (Kentō on #148)', async () => {
    // Each conversation asks for one tool, then answers. With rounds counted per review, the second
    // pass would get `none` at its first request.
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push(body.tool_choice);
      const asked = body.messages.length > 1;
      return asked
        ? json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: anthropicUsage(1, 0, 0, 1) })
        : json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'grep', input: { pattern: 'disable' } }], usage: anthropicUsage(1, 0, 0, 1) });
    }) as typeof globalThis.fetch;
    const seen: unknown[] = [];
    const tools = new RepoTools(root, head, { rounds: 1, calls: 10, bytes: 10_000 });
    const config = providerLevelConfig('lite', 'anthropic');
    const ask = () => askJson<{ ok: boolean }>({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, config, 'review.md', 'p', SCHEMA, undefined, tools);
    const answers = await Promise.all([ask(), ask(), ask()]);
    assert.deepEqual(answers.map((a) => a.answer), [{ ok: true }, { ok: true }, { ok: true }]);
    assert.deepEqual(seen.filter((c: any) => c.type === 'auto').length, 3);
    assert.deepEqual(tools.used.calls, 3);
    assert.deepEqual(tools.used.rounds, 3);
  });

  test('a round whose tool call finds the budget used still counts once, and the next request offers none (Kentō on #148)', async () => {
    const { fetch, calls } = fakeFetch([
      () => json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'grep', input: { pattern: 'disable' } }], usage: anthropicUsage(1, 0, 0, 1) }),
      () => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: anthropicUsage(1, 0, 0, 1) }),
    ]);
    const tools = new RepoTools(root, head, { rounds: 5, calls: 1, bytes: 10_000 });
    await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, providerLevelConfig('lite', 'anthropic'), 'review.md', 'p', SCHEMA, undefined, tools);
    assert.deepEqual(calls.map((c) => c.tool_choice.type), ['auto', 'none']);
    assert.deepEqual(tools.used.rounds, 1);

    // A model that answers at once ran no round: before, the offer alone counted one.
    const direct = fakeFetch([() => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: anthropicUsage(1, 0, 0, 1) })]);
    const unused = new RepoTools(root, head, TOOL_BUDGETS.lite);
    await askJson({ apiKey: 'k', kind: 'anthropic', fetch: direct.fetch, log: quiet }, providerLevelConfig('lite', 'anthropic'), 'review.md', 'p', SCHEMA, undefined, unused);
    assert.deepEqual(unused.used, { rounds: 0, calls: 0, bytes: 0 });
  });

  test('a tool request after the last round fails the model, and the next one takes over with the budget left (Kentō on #148)', async () => {
    const logs: string[] = [];
    for (const kind of ['anthropic', 'openrouter'] as const) {
      logs.length = 0;
      const toolAgain =
        kind === 'anthropic'
          ? () => json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'y', name: 'grep', input: { pattern: 'disable' } }], usage: anthropicUsage(1, 0, 0, 1) })
          : () => json({ choices: [{ message: { content: 'Let me look.', tool_calls: [{ id: 'y', type: 'function', function: { name: 'grep', arguments: '{"pattern":"disable"}' } }] } }], usage: { cost: 0 } });
      const done =
        kind === 'anthropic'
          ? () => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: anthropicUsage(1, 0, 0, 1) })
          : () => json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { cost: 0 } });
      // Model 1: a tool round, then a tool request again when none is offered. Model 2: answers.
      const { fetch, calls } = fakeFetch([toolAgain, toolAgain, done]);
      const tools = new RepoTools(root, head, { rounds: 1, calls: 10, bytes: 10_000 });
      const config =
        kind === 'anthropic' ? providerLevelConfig('lite', 'anthropic', ['m1', 'm2']) : levelConfig('lite', { REVIEW_MODELS: 'a/m1,a/m2' });
      const { answer } = await askJson<{ ok: boolean }>({ apiKey: 'k', kind, fetch, log: (m) => logs.push(m) }, config, 'review.md', 'p', SCHEMA, undefined, tools);
      assert.deepEqual(answer, { ok: true }, kind);
      assert.equal(calls.length, 3, kind);
      assert.match(logs[0]!, /asked for a tool after its last round/, kind);
      assert.match(logs[1]!, /^attempt 2 with \S+ starts with 1 of 10 tool calls and \d+ of 10000 bytes used$/, kind);
    }
  });

  test('without tools, the request is the one of before: no tools, the pack as a plain string', async () => {
    const { fetch, calls } = fakeFetch([() => json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { cost: 0.001 } })]);
    await askJson({ apiKey: 'k', fetch, log: quiet }, levelConfig('lite'), 'review.md', 'the pack', SCHEMA);
    assert.equal(calls[0].tools, undefined);
    assert.equal(calls[0].tool_choice, undefined);
    assert.equal(calls[0].messages[1].content, 'the pack');
  });

  test('askModel with tools adds their note at the end of the user message, after the focus of a pass (REV-113)', async () => {
    const { fetch, calls } = fakeFetch([() => json({ choices: [{ message: { content: '{"summary":"s","findings":[]}' } }], usage: { cost: 0 } })]);
    await askModel({ apiKey: 'k', fetch, log: quiet }, levelConfig('lite'), 'the pack', 'FOCUS', new RepoTools(root, head, TOOL_BUDGETS.lite));
    const system: string = calls[0].messages[0].content;
    assert.ok(!system.includes('FOCUS') && !system.includes(TOOLS_NOTE), 'the system prompt stays the same for every pass');
    assert.equal(calls[0].messages[1].content[0].text, `the pack\n\nFOCUS\n\n${TOOLS_NOTE}\n\n${FINAL_INSTRUCTION}\n`);
  });
});

test('the levels have no tools; REVIEW_TOOLS=1 gives the budget of the level, another value throws', () => {
  for (const level of ['lite', 'balanced', 'heavy'] as const) {
    assert.equal(LEVELS[level].tools, undefined);
    assert.equal(levelConfig(level).tools, undefined);
    assert.equal(levelConfig(level, { REVIEW_TOOLS: '0' }).tools, undefined);
    assert.deepEqual(levelConfig(level, { REVIEW_TOOLS: '1' }).tools, TOOL_BUDGETS[level]);
  }
  assert.throws(() => levelConfig('lite', { REVIEW_TOOLS: 'yes' }), /REVIEW_TOOLS must be 1/);
});
