// KNT-201. Above 100,000 prompt tokens, a call to Claude Haiku 5.5 costs 5 times more. The pack of a
// level whose model has such a threshold keeps the whole call under it; the other levels keep their
// pack as it was.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ProviderKind } from '../../protocol/src/index.ts';
import { earlierFindingsSection, MAX_EARLIER_SECTION_BYTES } from '../src/earlier.ts';
import { answerSchema } from '../src/findings.ts';
import { levelConfig, providerLevelConfig, type LevelConfig } from '../src/levels.ts';
import { askModel, reviewCallBytes } from '../src/model.ts';
import { buildPack, BYTES_PER_TOKEN, MAX_PACK_BYTES } from '../src/pack.ts';
import { BASE_PASSES } from '../src/passes.ts';
import { longContextThreshold } from '../src/prices.ts';
import { prepareReview } from '../src/review.ts';
import { changedZonesSection, MAX_CHANGED_ZONES_SECTION_BYTES } from '../src/seen.ts';

let repo = '';
let base = '';
let head = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

/** About `kb` kilobytes of lines of one shape, under the 1000 changed lines of a file. */
const lines = (kb: number, line: (i: number) => string) => {
  const out: string[] = [];
  while (out.join('\n').length < kb * 1000) out.push(line(out.length));
  assert.ok(out.length < 1000);
  return `${out.join('\n')}\n`;
};

// A pull request of about 245 KB of diff: over MAX_PACK_BYTES by its guide only, and over the room of
// a call of 100,000 tokens by its test too.
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-long-context-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  writeFileSync(join(repo, 'README.md'), '# Acme\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  const files = {
    'docs/guide.md': lines(30, (i) => `The step ${i} of a payment holds one value that the billing page shows to the owner of the account.`),
    'test/pay.test.ts': lines(60, (i) => `test('the step ${i} of a payment', () => assert.equal(pay${i}(1), ${i} + 1)); // the step ${i} of the payment of an invoice`),
    'app/ui/pay.tsx': lines(60, (i) => `export const Step${i} = () => <li className="pay-step">{'step ${i}'}</li>; // the step ${i} of the payment of an invoice`),
    'app/lib/pay.ts': lines(92, (i) => `export const pay${i} = (total: number) => total * ${i} + 1; // the step ${i} of the payment of an invoice, with its tax`),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'add the payment');
  head = git('rev-parse', 'HEAD');
});
after(() => rmSync(repo, { recursive: true, force: true }));

const prepare = (config: LevelConfig, kind: ProviderKind, focuses?: readonly string[]) =>
  prepareReview({ apiKey: undefined, kind, repoDir: repo, base, head, level: 'lite', config }, config, focuses);
/** The bytes of the whole call: the system prompt, the schema, the pack and the notes at its end. */
const callBytes = (config: LevelConfig, prepared: ReturnType<typeof prepare>, focuses?: readonly string[]) =>
  reviewCallBytes({}, config, prepared.parts, answerSchema({ threads: false }), focuses) + prepared.pack.length;
const CAP = 100_000 * BYTES_PER_TOKEN;
const haiku = providerLevelConfig('lite', 'anthropic');

test('the models with a long-context threshold, at Anthropic and through OpenRouter', () => {
  assert.equal(longContextThreshold('anthropic', ['claude-haiku-5-5']), 100_000);
  assert.equal(longContextThreshold('openrouter', ['anthropic/claude-haiku-5.5', 'z-ai/glm-5.3']), 100_000, 'the lowest threshold of the level');
  assert.equal(longContextThreshold('openrouter', levelConfig('lite').models), 100_000);
  for (const level of ['balanced', 'heavy'] as const) {
    assert.equal(longContextThreshold('openrouter', levelConfig(level).models), null, level);
    assert.equal(longContextThreshold('anthropic', providerLevelConfig(level, 'anthropic').models), null, level);
  }
  assert.equal(longContextThreshold('openrouter', ['z-ai/glm-5.3']), null);
  assert.equal(longContextThreshold('openrouter', ['claude-haiku-5-5']), null, 'an OpenRouter id names its provider');
  assert.equal(longContextThreshold('ollama', ['anthropic/claude-haiku-5.5']), null);
  assert.equal(longContextThreshold('anthropic', ['constructor']), null);
});

test('a pack near the threshold keeps the whole call under it, and cuts in the order of a large pull request', () => {
  const full = buildPack(repo, base, head, 'definitions');
  assert.deepEqual(full.coverage.cut, ['docs/guide.md'], 'MAX_PACK_BYTES cuts the guide only');
  const fullCall = reviewCallBytes({}, haiku, full.parts, answerSchema({ threads: false })) + full.pack.length;
  assert.ok(fullCall > CAP, `without the threshold, the call would pass it: ${fullCall} bytes`);
  for (const kind of ['anthropic', 'openrouter'] as const) {
    const config = kind === 'anthropic' ? haiku : levelConfig('lite');
    const prepared = prepare(config, kind);
    const bytes = callBytes(config, prepared);
    assert.ok(bytes <= CAP, `${kind}: ${bytes} bytes, ${CAP} at most`);
    // The same order as MAX_PACK_BYTES: the guide, then the tests. The source and the UI stay.
    assert.deepEqual(prepared.coverage?.cut, ['docs/guide.md', 'test/pay.test.ts'], kind);
    assert.match(prepared.pack, /\+\+\+ b\/app\/lib\/pay\.ts/);
    assert.match(prepared.pack, /\+\+\+ b\/app\/ui\/pay\.tsx/);
  }
});

test('the bytes that the budget counts around the pack are those that the call sends, with the longest focus of the passes', async () => {
  const focuses = BASE_PASSES.map((pass) => pass.focus);
  const longest = focuses.reduce((a, b) => (b.length > a.length ? b : a));
  const prepared = prepare(haiku, 'anthropic', focuses);
  assert.ok(callBytes(haiku, prepared, focuses) <= CAP);
  let sent = 0;
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent = body.system[0].text.length + JSON.stringify(body.output_config.format.schema).length;
    for (const block of body.messages[0].content) sent += block.text.length;
    throw new Error('no network in this test');
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(askModel({ apiKey: 'test', kind: 'anthropic', fetch, log: () => {} }, haiku, prepared.parts, longest, undefined, undefined, answerSchema({ threads: false })));
  assert.equal(sent, callBytes(haiku, prepared, focuses));
  assert.equal(reviewCallBytes({}, haiku, prepared.parts, answerSchema({ threads: false }), focuses), reviewCallBytes({}, haiku, prepared.parts, answerSchema({ threads: false })) + longest.length + 2);
});

test('a level whose model has no threshold keeps the pack of MAX_PACK_BYTES, the same bytes', () => {
  const full = buildPack(repo, base, head, 'definitions');
  for (const [config, kind] of [
    [levelConfig('balanced'), 'openrouter'],
    [providerLevelConfig('balanced', 'anthropic'), 'anthropic'],
    [providerLevelConfig('heavy', 'anthropic'), 'anthropic'],
    [providerLevelConfig('lite', 'openrouter', ['z-ai/glm-5.3']), 'openrouter'],
  ] as const) {
    const prepared = prepare({ ...config, context: 'definitions' }, kind);
    assert.equal(prepared.pack, full.pack, `${config.models.join(',')} at ${kind}`);
    assert.deepEqual(prepared.coverage?.cut, ['docs/guide.md']);
  }
  // The same pull request at Haiku 5.5 is cut further.
  assert.ok(prepare(haiku, 'anthropic').pack.length < full.pack.length);
  assert.equal(MAX_PACK_BYTES, 240_000);
});

test('a config that changes the model of a level changes the budget of its pack', () => {
  const full = buildPack(repo, base, head, 'full');
  // `balanced` on Haiku 5.5, as a config of a repository can choose it: the threshold holds.
  const cheap = providerLevelConfig('balanced', 'anthropic', ['claude-haiku-5-5']);
  const prepared = prepare(cheap, 'anthropic');
  assert.ok(callBytes(cheap, prepared) <= CAP);
  assert.ok(prepared.pack.length < full.pack.length);
  // `lite` on another model (the bench sets REVIEW_MODELS): no threshold, the whole budget.
  const other = levelConfig('lite', { REVIEW_MODELS: 'z-ai/glm-5.3' });
  assert.equal(prepare(other, 'openrouter').pack, buildPack(repo, base, head, 'definitions').pack);
});

test('the unkeyed sections stay under the bounds that the budget counts for them', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    key: i.toString(16).padStart(12, '0'),
    path: `app/lib/module-${i}.ts`,
    line: i + 1,
    title: `The total of the step ${i} of a payment is rounded before the tax, and the owner pays one cent more`,
    severity: 'minor' as const,
    category: 'bug' as const,
    status: 'dismissed' as const,
    reason: 'The rounding is the one of the bank. '.repeat(10),
    commit: head,
  }));
  const earlier = earlierFindingsSection(repo, head, many).section;
  assert.ok(earlier.length > 16_000, 'the section is full');
  assert.ok(earlier.length <= MAX_EARLIER_SECTION_BYTES, `${earlier.length} bytes`);
  const changed = new Map(Array.from({ length: 2000 }, (_, i) => [`app/lib/module-${i}.ts`, new Set([i + 1, i + 3, i + 5])] as const));
  const zones = changedZonesSection({ since: head, changed, existed: () => true }, [...changed.keys()]);
  assert.ok(zones.length > 6_000, 'the section is full');
  assert.ok(zones.length <= MAX_CHANGED_ZONES_SECTION_BYTES, `${zones.length} bytes`);
});

test('the « Not reviewed » lines of the files that the pack drops count in the call too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-long-context-many-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'dev@example.com');
    run('config', 'user.name', 'Dev');
    writeFileSync(join(dir, 'README.md'), '# Acme\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'base');
    const from = run('rev-parse', 'HEAD');
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    write('app/lib/pay.ts', lines(92, (i) => `export const pay${i} = (total: number) => total * ${i} + 1; // the step ${i} of the payment of an invoice, with its tax`));
    write('app/ui/pay.tsx', lines(45, (i) => `export const Step${i} = () => <li className="pay-step">{'step ${i}'}</li>; // the step ${i} of the payment of an invoice`));
    write('app/lib/tax.ts', lines(60, (i) => `export const tax${i} = (total: number) => total * ${i} / 100; // the tax ${i} of the payment of an invoice, with its rate`));
    // Many small tests with long paths: each one that goes leaves a line in « Not reviewed ».
    const folder = `test/${'payments-of-an-invoice-with-its-tax-and-its-rate-at-the-end-of-the-month/'.repeat(5)}for-the-owner`;
    for (let i = 0; i < 80; i++) write(`${folder}/step-${String(i).padStart(4, '0')}.test.ts`, `test('the step ${i}', () => assert.equal(pay${i}(1), ${i} + 1));\n`.repeat(2));
    run('add', '-A');
    run('commit', '-q', '-m', 'add the payment');
    const to = run('rev-parse', 'HEAD');
    const prepared = prepareReview({ apiKey: undefined, kind: 'anthropic', repoDir: dir, base: from, head: to, level: 'lite', config: haiku }, haiku);
    assert.ok((prepared.coverage?.cut.length ?? 0) >= 50, `${prepared.coverage?.cut.length} files cut`);
    const bytes = callBytes(haiku, prepared);
    assert.ok(bytes <= CAP, `${bytes} bytes, ${CAP} at most`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a call whose parts around the pack leave no room for a diff keeps the pack of MAX_PACK_BYTES, and says so', () => {
  const logs: string[] = [];
  const prompts = { 'review.md': 'Review the pull request.\n'.repeat(10_000) };
  const prepared = prepareReview({ apiKey: undefined, kind: 'anthropic', prompts, repoDir: repo, base, head, level: 'lite', config: haiku, log: (m) => logs.push(m) }, haiku);
  assert.equal(prepared.pack, buildPack(repo, base, head, 'definitions').pack);
  assert.match(logs.join('\n'), /passes the long-context threshold of 100000 tokens/);
});
