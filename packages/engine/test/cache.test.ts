// REV-113. The prompt cache of Anthropic: a system prompt and a schema that stay the same for every
// review of a level, the docs first in the pack, the cache marks and their TTL, the cache writes by
// TTL in the usage and in the cost, and the passes sent one after the other.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { askJson, providerLevelConfig, reviewPullRequest, type Answer } from '../src/index.ts';
import { ANSWER_SCHEMA, withPatch } from '../src/findings.ts';
import { afterFirstStart, reviewInPasses } from '../src/passes.ts';
import { costFromTable } from '../src/prices.ts';
import { MAX_PACK_MARKS, requestTokens, userContent } from '../src/providers.ts';
import { prepareReview } from '../src/review.ts';
import { RepoTools, TOOL_BUDGETS } from '../src/tools.ts';
import { blockEvents, endEvents, messageResponse, startEvents as startEventsOf } from './sse.ts';

const quiet = () => {};
const SCHEMA = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, encoding: 'utf8' }).trim();

const ANSWER: Answer = {
  confidence_score: 4,
  risk: 'Low',
  summary: 'Summary',
  diagram: '',
  findings: [],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
  threads: null,
};

/** A fetch that answers as Anthropic and records each body. */
function anthropic() {
  const bodies: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return messageResponse('claude-sonnet-5-5', [{ type: 'text', text: JSON.stringify(ANSWER) }], 'end_turn', { input: 100, output: 10 });
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

/** Every cache mark of a request, in the order of the prompt: tools, system, then messages. */
function marks(body: any): { at: string; ttl: string }[] {
  const out: { at: string; ttl: string }[] = [];
  for (const block of body.system ?? []) if (block.cache_control) out.push({ at: 'system', ttl: block.cache_control.ttl ?? '5m' });
  body.messages.forEach((message: any, m: number) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block: any, b: number) => {
      if (block.cache_control) out.push({ at: `messages[${m}][${b}]`, ttl: block.cache_control.ttl ?? '5m' });
    });
  });
  return out;
}

/** The API refuses a mark of 1 hour after a mark of 5 minutes, and more than 4 marks. */
function assertValidMarks(body: any) {
  const all = marks(body);
  assert.ok(all.length <= 4, `at most 4 cache marks, not ${all.length}`);
  const firstShort = all.findIndex((m) => m.ttl === '5m');
  if (firstShort >= 0) assert.ok(all.slice(firstShort).every((m) => m.ttl === '5m'), `a mark of 1 hour comes before every mark of 5 minutes: ${JSON.stringify(all)}`);
}

describe('the prefix of the prompt cache', () => {
  const repos: string[] = [];
  const heads: Record<string, { base: string; first: string; second: string }> = {};

  /** A repository with a CLAUDE.md, a library and a pull request of two pushes on app/src/app.ts. */
  function repo(name: string, docs: string) {
    const root = mkdtempSync(join(process.env.SAKUGA_TEST_TMP ?? tmpdir(), `sakuga-review-cache-${name}-`));
    repos.push(root);
    git(root, 'init', '-q', '.');
    writeFileSync(join(root, 'CLAUDE.md'), docs);
    mkdirSync(join(root, 'app', 'src'), { recursive: true });
    writeFileSync(join(root, 'app', 'src', 'lib.ts'), 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n');
    writeFileSync(join(root, 'app', 'src', 'app.ts'), "import { total } from './lib';\n\nexport function bill(items: number[]) {\n  return total(items);\n}\n");
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'app', 'src', 'app.ts'), "import { total } from './lib';\n\nexport function bill(items: number[]) {\n  return total(items) * 1.2;\n}\n");
    git(root, 'commit', '-q', '-am', 'tax');
    const first = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'app', 'src', 'app.ts'), "import { total } from './lib';\n\nexport function bill(items: number[]) {\n  return Math.round(total(items) * 1.2);\n}\n");
    git(root, 'commit', '-q', '-am', 'round');
    const second = git(root, 'rev-parse', 'HEAD');
    heads[root] = { base, first, second };
    return root;
  }

  let shop = '';
  let blog = '';
  before(() => {
    shop = repo('shop', '# Shop\n\nThe money is in cents.\n');
    blog = repo('blog', '# Blog\n\nThe posts are in Markdown.\n');
  });
  after(() => {
    for (const root of repos) rmSync(root, { recursive: true, force: true });
  });

  test('two repositories with other docs, rules and earlier findings get the same system prompt and the same schema', async () => {
    const { fetch, bodies } = anthropic();
    const config = providerLevelConfig('balanced', 'anthropic');
    const rule = { id: 'r1', scope: 'repo' as const, title: 'Money in cents', text: 'No float for money.', paths: [], severityFloor: null };
    const otherRules = [
      { id: 'r2', scope: 'org' as const, title: 'Posts in Markdown', text: 'No HTML in a post.', paths: [], severityFloor: 'major' as const },
      { id: 'r3', scope: 'repo' as const, title: 'Dates in UTC', text: 'No local time.', paths: [], severityFloor: null },
    ];
    const earlierOf = (repo: string, key: string, title: string) => ({
      findings: [{ key, path: 'app/src/app.ts', line: 4, title, severity: 'major' as const, category: 'bug' as const, status: 'open' as const, reason: null, commit: heads[repo]!.first }],
      last: null,
    });
    await reviewPullRequest({ repoDir: shop, base: heads[shop]!.base, head: heads[shop]!.second, level: 'balanced', config, kind: 'anthropic', apiKey: 'k', fetch, log: quiet, rules: [rule], earlier: earlierOf(shop, 'abc', 'Float for money') });
    await reviewPullRequest({ repoDir: blog, base: heads[blog]!.base, head: heads[blog]!.second, level: 'balanced', config, kind: 'anthropic', apiKey: 'k', fetch, log: quiet, rules: otherRules, earlier: earlierOf(blog, 'def', 'HTML in a post') });
    await reviewPullRequest({ repoDir: blog, base: heads[blog]!.base, head: heads[blog]!.first, level: 'balanced', config, kind: 'anthropic', apiKey: 'k', fetch, log: quiet });
    const [a, b, plain] = bodies;
    assert.match(a.messages[0].content.map((c: any) => c.text).join(''), /## Rules[\s\S]*## Earlier findings/, 'the first review holds rules and earlier findings');
    assert.match(b.messages[0].content.map((c: any) => c.text).join(''), /### R2 · Dates in UTC[\s\S]*## Earlier findings/, 'the second review holds other rules and other earlier findings');
    assert.deepEqual(a.system, b.system);
    assert.deepEqual(a.system, plain.system);
    assert.deepEqual(a.output_config, b.output_config, 'the same sections give the same schema, whatever their references: it is in the cached prefix');
    // REV-113. In each finding, `rule_id` and `follows` cost the applicable suggestions on the bench:
    // a pack without these sections gets the plain schema.
    const findingKeys = (body: any) => Object.keys(body.output_config.format.schema.properties.findings.items.properties);
    assert.ok(findingKeys(a).includes('rule_id') && findingKeys(a).includes('follows'));
    assert.deepEqual(plain.output_config.format.schema, withPatch(ANSWER_SCHEMA), 'no section: the plain schema');
    assert.deepEqual(a.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    assertValidMarks(a);
    assertValidMarks(b);
  });

  test('the docs open the pack and carry a mark of 1 hour; the rest of the pack keeps its order and has no mark', async () => {
    const { fetch, bodies } = anthropic();
    const config = providerLevelConfig('balanced', 'anthropic');
    const rule = { id: 'r1', scope: 'repo' as const, title: 'Money in cents', text: 'No float for money.', paths: [], severityFloor: null };
    const result = await reviewPullRequest({ repoDir: shop, base: heads[shop]!.base, head: heads[shop]!.first, level: 'balanced', config, kind: 'anthropic', apiKey: 'k', fetch, log: quiet, rules: [rule] });
    const content = bodies[0].messages[0].content;
    assert.equal(content.length, 2);
    assert.match(content[0].text, /^## CLAUDE\.md\n\n# Shop/);
    assert.match(content[1].text, /^# Pull request [0-9a-f]{9}\.\.\.[0-9a-f]{9}\n\n## Commits[\s\S]*## Rules[\s\S]*## Diff[\s\S]*## Imports[\s\S]*## Context/);
    assert.deepEqual(content.map((c: any) => c.cache_control ?? null), [{ type: 'ephemeral', ttl: '1h' }, null]);
    // Only the place of the docs changes: the blocks hold the whole pack, and nothing else.
    assert.equal(content.map((c: any) => c.text).join(''), result.pack);
    assertValidMarks(bodies[0]);
  });

  test('a reference that the pack does not hold goes: no rule, no earlier finding and no thread in the pack', async () => {
    const stray = {
      ...ANSWER,
      findings: [{ path: 'app/src/app.ts', start_line: 4, line: 4, severity: 'major', category: 'bug', confidence: 90, title: 'Float for money', scenario: 's', fix: 'f', suggestion: '', patch: '', rule_id: 'R1', follows: 'E1' }],
      threads: [{ id: 'T1', verdict: 'refuted', reason: 'r' }],
    };
    const fetch = (async () => messageResponse('claude-sonnet-5-5', [{ type: 'text', text: JSON.stringify(stray) }], 'end_turn')) as typeof globalThis.fetch;
    const result = await reviewPullRequest({ repoDir: shop, base: heads[shop]!.base, head: heads[shop]!.first, level: 'balanced', config: providerLevelConfig('balanced', 'anthropic'), kind: 'anthropic', apiKey: 'k', fetch, log: quiet });
    assert.equal(result.findings.length, 1, 'the finding stays');
    assert.ok(!('rule_id' in result.findings[0]!));
    assert.ok(!('follows' in result.findings[0]!));
    assert.deepEqual(result.refutedThreads, []);
    assert.deepEqual(result.refutedInThread, []);
  });

  test('two pushes of one pull request, whole or incremental: the docs stay the same, byte for byte', () => {
    const config = providerLevelConfig('balanced', 'anthropic');
    const at = (head: string) => prepareReview({ repoDir: shop, base: heads[shop]!.base, head, level: 'balanced', apiKey: 'k' }, config).parts;
    const [first, second] = [at(heads[shop]!.first), at(heads[shop]!.second)];
    assert.equal(second[0]!.text, first[0]!.text);
    assert.notEqual(second[1]!.text, first[1]!.text, 'the heads and the diff change');
    // REV-88. An incremental review reads only the files that changed since.
    const delta = prepareReview(
      { repoDir: shop, base: heads[shop]!.base, head: heads[shop]!.second, level: 'balanced', apiKey: 'k', delta: { since: heads[shop]!.first, score: 4, findings: [], settled: [] } },
      config,
    ).parts;
    assert.equal(delta[0]!.text, first[0]!.text);
  });

  test('a review in passes sends the same system prompt and pack to each pass, the end of the pack marked for 5 minutes, then the focus', async () => {
    const answer = JSON.stringify(ANSWER);
    const bodies: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return messageResponse('claude-haiku-5-5', [{ type: 'text', text: answer }], 'end_turn');
    }) as typeof globalThis.fetch;
    const passConfig = providerLevelConfig('lite', 'anthropic');
    const verifyConfig = providerLevelConfig('balanced', 'anthropic');
    await reviewInPasses({ repoDir: shop, base: heads[shop]!.base, head: heads[shop]!.first, level: 'balanced', kind: 'anthropic', apiKey: 'k', fetch, log: quiet }, { passConfig, verifyConfig });
    assert.equal(bodies.length, 3, 'three passes, and no check without a finding');
    const prefix = (body: any) => JSON.stringify({ system: body.system, format: body.output_config, pack: body.messages[0].content.slice(0, -1) });
    assert.ok(bodies.every((body) => prefix(body) === prefix(bodies[0])), 'the passes share the prefix up to their focus');
    for (const body of bodies) {
      assertValidMarks(body);
      assert.deepEqual(marks(body).map((m) => m.ttl), ['1h', '1h', '5m']);
      assert.equal(body.messages[0].content.at(-1).cache_control, undefined, 'the focus has no mark');
    }
  });
});

describe('the cache marks of a request', () => {
  test('a part with `cache` carries a mark with its TTL, at most MAX_PACK_MARKS of them, never 1 hour after 5 minutes; an empty part goes', () => {
    const blocks = userContent(
      [
        { text: 'a', cache: '1h' },
        { text: '', cache: '1h' },
        { text: 'b', cache: '5m' },
        { text: 'c', cache: '1h' },
        { text: 'd' },
      ],
      true,
    );
    assert.deepEqual(
      blocks.map((b) => [b.text, b.cache_control ?? null]),
      [
        ['a', null],
        ['b', { type: 'ephemeral' }],
        ['c', { type: 'ephemeral' }],
        ['d', null],
      ],
    );
    assert.equal(MAX_PACK_MARKS, 2);
    assert.ok(userContent([{ text: 'a', cache: '1h' }], false).every((b) => !b.cache_control), 'no mark without `marks`');
  });

  test('with tools: the pack keeps its marks, the last block moves, 4 marks at most, 1 hour before 5 minutes', async () => {
    const root = mkdtempSync(join(process.env.SAKUGA_TEST_TMP ?? tmpdir(), 'sakuga-review-cache-tools-'));
    try {
      git(root, 'init', '-q', '.');
      writeFileSync(join(root, 'mail.ts'), 'export const on = true;\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'head');
      const head = git(root, 'rev-parse', 'HEAD');
      const bodies: any[] = [];
      const answers = [
        () => messageResponse('claude-sonnet-5-5', [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'mail.ts' } }], 'tool_use'),
        () => messageResponse('claude-sonnet-5-5', [{ type: 'tool_use', id: 'tu_2', name: 'grep', input: { pattern: 'on' } }], 'tool_use'),
        () => messageResponse('claude-sonnet-5-5', [{ type: 'text', text: '{"ok":true}' }], 'end_turn'),
      ];
      const fetch = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return answers[bodies.length - 1]!();
      }) as typeof globalThis.fetch;
      const parts = [
        { text: 'docs', cache: '1h' as const },
        { text: 'pack', cache: '5m' as const },
        { text: 'focus' },
      ];
      await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, providerLevelConfig('balanced', 'anthropic'), 'review.md', parts, SCHEMA, undefined, new RepoTools(root, head, TOOL_BUDGETS.balanced));
      assert.equal(bodies.length, 3);
      for (const body of bodies) {
        assertValidMarks(body);
        assert.deepEqual(
          marks(body).slice(0, 3).map((m) => m.ttl),
          ['1h', '1h', '5m'],
          'the system prompt, the docs and the pack',
        );
      }
      assert.deepEqual(marks(bodies[0]).map((m) => m.at), ['system', 'messages[0][0]', 'messages[0][1]', 'messages[0][2]']);
      assert.deepEqual(marks(bodies[2]).map((m) => m.at), ['system', 'messages[0][0]', 'messages[0][1]', 'messages[4][0]'], 'only the last tool result keeps the moving mark');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the request without thinking of REV-108 has no mark on the pack: the change of thinking empties the cache of the messages', async () => {
    const bodies: any[] = [];
    const answers = [
      () => messageResponse('claude-haiku-5-5', [{ type: 'thinking', thinking: '', signature: 's' }], 'max_tokens', { input: 1000, output: 32000 }),
      () => messageResponse('claude-haiku-5-5', [{ type: 'text', text: '{"ok":true}' }], 'end_turn', { input: 1000, output: 10 }),
    ];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return answers[bodies.length - 1]!();
    }) as typeof globalThis.fetch;
    const { usage } = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, providerLevelConfig('lite', 'anthropic'), 'review.md', [{ text: 'docs', cache: '1h' }, { text: 'diff' }], SCHEMA);
    assert.deepEqual(marks(bodies[0]).map((m) => m.at), ['system', 'messages[0][0]']);
    assert.deepEqual(marks(bodies[1]).map((m) => m.at), ['system']);
    assert.equal(usage.thinking, 'adaptive+disabled');
  });
});

describe('the usage and the cost of the cache', () => {
  test('the cache writes split by TTL; without the split, a write counts at 5 minutes', () => {
    assert.deepEqual(
      requestTokens({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, output_tokens: 5 }),
      { input: 10, cacheRead: 20, cacheWrite: 100, cacheWrite1h: 200, output: 5 },
    );
    assert.deepEqual(requestTokens({ input_tokens: 10, cache_creation_input_tokens: 300, output_tokens: 5 }), { input: 10, cacheRead: 0, cacheWrite: 300, cacheWrite1h: 0, output: 5 });
  });

  test('a streamed answer gives the cache read, the writes by TTL, the hashes of the prefix, the effort and the thinking', async () => {
    const fetch = (async () =>
      messageResponse('claude-sonnet-5-5', [{ type: 'text', text: '{"ok":true}' }], 'end_turn', { input: 2000, cacheRead: 5000, cacheWrite: 9000, cacheWrite1h: 8000, output: 500 })) as typeof globalThis.fetch;
    const { usage } = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, providerLevelConfig('balanced', 'anthropic'), 'review.md', 'pack', SCHEMA);
    assert.equal(usage.prompt_tokens, 16_000);
    assert.equal(usage.cache_read_tokens, 5000);
    assert.equal(usage.cache_write_tokens, 9000);
    assert.equal(usage.cache_write_5m_tokens, 1000);
    assert.equal(usage.cache_write_1h_tokens, 8000);
    assert.match(usage.system_hash!, /^[0-9a-f]{12}$/);
    assert.match(usage.schema_hash!, /^[0-9a-f]{12}$/);
    assert.equal(usage.effort, 'medium');
    assert.equal(usage.thinking, 'adaptive');
    // 2000 × 2 + 5000 × 0.1 + 1000 × 2.5 + 8000 × 4 + 500 × 10 = 44,000 millionths of a dollar.
    assert.equal(usage.cost, 0.044);
  });

  test('a write costs 1.25 times the input at 5 minutes and 2 times at 1 hour; a read 0.05 times on Sonnet and Opus 5.5, 0.1 times on Haiku 5.5', () => {
    const million = { input: 0, output: 0 };
    assert.equal(costFromTable('anthropic', 'claude-sonnet-5-5', { ...million, cacheWrite: 1_000_000 }), 2.5);
    assert.equal(costFromTable('anthropic', 'claude-sonnet-5-5', { ...million, cacheWrite1h: 1_000_000 }), 4);
    assert.equal(costFromTable('anthropic', 'claude-sonnet-5-5', { ...million, cacheRead: 1_000_000 }), 0.1);
    assert.equal(costFromTable('anthropic', 'claude-opus-5-5', { ...million, cacheWrite: 1_000_000 }), 5);
    assert.equal(costFromTable('anthropic', 'claude-opus-5-5', { ...million, cacheWrite1h: 1_000_000 }), 8);
    assert.equal(costFromTable('anthropic', 'claude-opus-5-5', { ...million, cacheRead: 1_000_000 }), 0.2);
    assert.equal(costFromTable('anthropic', 'claude-haiku-5-5', { ...million, cacheWrite: 80_000 }), 0.01);
    assert.equal(costFromTable('anthropic', 'claude-haiku-5-5', { ...million, cacheWrite1h: 80_000 }), 0.016);
    assert.equal(costFromTable('anthropic', 'claude-haiku-5-5', { ...million, cacheRead: 80_000 }), 0.0008);
  });

  test('Haiku 5.5 above 100,000 prompt tokens: the cache tokens count in the prompt, and the tier reads one request', async () => {
    // 60,000 + 50,000 = 110,000 prompt tokens: every token at the prices above the tier.
    assert.equal(costFromTable('anthropic', 'claude-haiku-5-5', { input: 60_000, cacheWrite1h: 50_000, output: 1000 }), 0.03 + 0.05 + 0.0025);
    // Two requests of 70,000 tokens each, the second without thinking: each one stays under the tier.
    const answers = [
      () => messageResponse('claude-haiku-5-5', [{ type: 'thinking', thinking: '', signature: 's' }], 'max_tokens', { input: 70_000, output: 1000 }),
      () => messageResponse('claude-haiku-5-5', [{ type: 'text', text: '{"ok":true}' }], 'end_turn', { input: 70_000, output: 1000 }),
    ];
    let n = 0;
    const fetch = (async () => answers[n++]!()) as typeof globalThis.fetch;
    const { usage } = await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, providerLevelConfig('lite', 'anthropic'), 'review.md', 'pack', SCHEMA);
    assert.equal(usage.prompt_tokens, 140_000);
    // 2 × (70,000 × 0.1 + 1000 × 0.5) = 15,000 millionths of a dollar, not the 72,000 of the tier above.
    assert.equal(usage.cost, 0.015);
  });
});

describe('the requests sent at once', () => {
  test('the others leave when the answer of the first starts, before the first ends', async () => {
    const events: string[] = [];
    let startFirst: () => void = () => {};
    let endFirst: () => void = () => {};
    const results = afterFirstStart(['a', 'b', 'c'], async (item, onStart) => {
      events.push(`send ${item}`);
      if (onStart) {
        await new Promise<void>((resolve) => (startFirst = resolve));
        events.push('a starts');
        onStart();
        await new Promise<void>((resolve) => (endFirst = resolve));
        events.push('a ends');
      }
      return item;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ['send a'], 'b and c wait for the start of a');
    startFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ['send a', 'a starts', 'send b', 'send c'], 'b and c leave while a is still open');
    endFirst();
    const settled = await results;
    assert.deepEqual(settled.map((s) => s.status === 'fulfilled' && s.value), ['a', 'b', 'c']);
  });

  test('a review in passes sends the second pass after the stream of the first starts, and before it ends', async () => {
    const root = mkdtempSync(join(process.env.SAKUGA_TEST_TMP ?? tmpdir(), 'sakuga-review-cache-passes-'));
    try {
      git(root, 'init', '-q', '.');
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'base');
      const base = git(root, 'rev-parse', 'HEAD');
      writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
      git(root, 'commit', '-q', '-am', 'two');
      const head = git(root, 'rev-parse', 'HEAD');
      const events: string[] = [];
      let startFirst: () => void = () => {};
      let endFirst: () => void = () => {};
      const firstStarts = new Promise<void>((resolve) => (startFirst = resolve));
      const firstEnds = new Promise<void>((resolve) => (endFirst = resolve));
      const encoder = new TextEncoder();
      const event = (e: object) => encoder.encode(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
      const [start, ...rest] = [
        ...startEventsOf('claude-haiku-5-5'),
        ...blockEvents([{ type: 'text', text: JSON.stringify(ANSWER) }]),
        ...endEvents('end_turn'),
      ];
      let n = 0;
      const fetch = (async () => {
        const index = n++;
        events.push(`send ${index}`);
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            if (index === 0) await firstStarts;
            controller.enqueue(event(start!));
            if (index === 0) {
              await firstEnds;
              events.push('0 ends');
            }
            for (const e of rest) controller.enqueue(event(e));
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }) as typeof globalThis.fetch;
      const config = providerLevelConfig('lite', 'anthropic');
      const review = reviewInPasses({ repoDir: root, base, head, level: 'lite', kind: 'anthropic', apiKey: 'k', fetch, log: quiet }, { passConfig: config, verifyConfig: config });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(events, ['send 0'], 'the passes 2 and 3 wait for the start of the first');
      startFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(events, ['send 0', 'send 1', 'send 2'], 'the passes 2 and 3 leave while the first streams');
      endFirst();
      await review;
      assert.deepEqual(events, ['send 0', 'send 1', 'send 2', '0 ends']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a first call that fails before its answer starts lets the others leave', async () => {
    const sent: string[] = [];
    const settled = await afterFirstStart(['a', 'b'], async (item, onStart) => {
      sent.push(item);
      if (onStart) throw new Error('down');
      return item;
    });
    assert.deepEqual(sent, ['a', 'b']);
    assert.equal(settled[0]!.status, 'rejected');
    assert.equal(settled[1]!.status, 'fulfilled');
  });

  test('askJson calls onStart at the first event of the stream of Anthropic', async () => {
    let started = 0;
    const fetch = (async () => messageResponse('claude-sonnet-5-5', [{ type: 'text', text: '{"ok":true}' }], 'end_turn')) as typeof globalThis.fetch;
    await askJson({ apiKey: 'k', kind: 'anthropic', fetch, log: quiet }, providerLevelConfig('balanced', 'anthropic'), 'review.md', 'pack', SCHEMA, undefined, undefined, () => started++);
    assert.equal(started, 1);
  });
});
