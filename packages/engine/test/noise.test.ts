// KNT-158. Review noise: « Not reviewed » twice, the trim that drops the file of the change, a score
// that contradicts its text, a class of defect drip-fed one form per push, a merge of the base read
// as the change.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { EarlierFinding } from '../../protocol/src/index.ts';
import { applyCoverage } from '../src/coverage.ts';
import { earlierFindingsSection } from '../src/earlier.ts';
import type { Answer, Finding, Usage } from '../src/findings.ts';
import { reviewPullRequest } from '../src/index.ts';
import { buildPack, namedFiles } from '../src/pack.ts';
import { descriptionBlock, notReviewedLines, reviewBody } from '../src/render.ts';

const repos: string[] = [];
after(() => repos.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repository() {
  const repo = mkdtempSync(join(tmpdir(), 'engine-noise-'));
  repos.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  const commit = (message: string, files: Record<string, string> = {}) => {
    write(files);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  return { repo, git, commit };
}

/** About `kb` kilobytes of lines of one shape, under the 1000 changed lines of a file. */
const lines = (kb: number, line: (i: number) => string) => {
  const out: string[] = [];
  while (out.join('\n').length < kb * 1000) out.push(line(out.length));
  assert.ok(out.length < 1000);
  return `${out.join('\n')}\n`;
};
const source = (name: string, kb: number) => lines(kb, (i) => `export const ${name}${i} = (row: { id: string; total: number }) => row.id.length > ${i} && row.total > 0; // the check ${i} of the ${name} module, with its total`);

const answer = (over: Partial<Answer> = {}): Answer => ({
  confidence_score: 4,
  risk: 'Safe to merge after a look at one minor point.',
  summary: 'Summary.',
  diagram: '',
  findings: [],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
  ...over,
});
const finding = (over: Partial<Finding> = {}): Finding => ({
  path: 'src/scan.ts',
  start_line: 12,
  line: 12,
  severity: 'major',
  category: 'security',
  confidence: 90,
  title: 'The scanner lets a quoted name through',
  scenario: 'A name in double quotes passes the scanner.',
  fix: 'Handle the quotes.',
  suggestion: '',
  ...over,
});
const usage: Usage = { model: 'anthropic/claude-haiku-5.5', cost: 0.01, cost_source: 'table' };
const context = { count: 1, head: '1'.repeat(40), subject: 's', commitUrl: `https://github.com/o/n/commit/${'1'.repeat(40)}`, level: 'lite' as const };

test('« Not reviewed » holds one line per path, with the first reason, and no empty line', () => {
  assert.deepEqual(notReviewedLines(['a.json: generated or binary file', 'src/big.ts: removed to fit in the maximum size of the review'], ['a.json (generated)', '`src/big.ts`: not read', '', 'rule "No raw SQL": removed to fit in the maximum size of the review', 'src/other.ts: the caller is not shown']), [
    'a.json: generated or binary file',
    'src/big.ts: removed to fit in the maximum size of the review',
    'rule "No raw SQL": removed to fit in the maximum size of the review',
    'src/other.ts: the caller is not shown',
  ]);
  const block = descriptionBlock(answer({ not_reviewed: ['a.json (generated)'] }), [], ['a.json: generated or binary file'], 0, usage, () => 12, context);
  assert.equal(block.split('\n').filter((l) => l.startsWith('- a.json')).length, 1);
  const empty = descriptionBlock(answer({ not_reviewed: ['', '  '] }), [], [], 0, usage, () => 12, context);
  assert.doesNotMatch(empty, /Not reviewed/);
});

test('a blocking finding with a model score of 4: the head and the block say it, never « safe to merge »', () => {
  const blocked = answer({ findings: [finding()], risk: 'One quoted form passes. Safe to merge after a look at one minor point.' });
  const body = reviewBody(blocked, () => 12, 'lite', usage);
  assert.match(body, /\*\*Confidence score: 2\/5\*\* · ⛔ 1 blocking issue · One quoted form passes\.\n/);
  assert.doesNotMatch(body, /safe to merge/i);
  const block = descriptionBlock(blocked, [], [], 0, usage, () => 12, context);
  assert.match(block, /^One quoted form passes\.$/m);
  // A risk made only of an advice to merge gives a fixed sentence.
  assert.match(reviewBody(answer({ findings: [finding()] }), () => 12, 'lite', usage), / · ⛔ 1 blocking issue · Fix the blocking issues before a merge\.\n/);
  assert.doesNotMatch(block, /safe to merge/i);
  // Without a blocking finding, the words of the model stay.
  assert.match(reviewBody(answer(), () => 12, 'lite', usage), / · Safe to merge after a look at one minor point\.\n/);
});

test('a partial review keeps no advice to merge in its risk', () => {
  const reply = answer({ confidence_score: 5, risk: 'Low risk. Safe to merge. The store gets a column.' });
  applyCoverage(reply, { files: 2, cut: ['app/db/invoice-store.ts'], narrowed: [] });
  assert.equal(reply.risk, 'Partial review: 1 file of logic not read, a schema, a migration or a store among them (see Not reviewed). The store gets a column.');
});

test('the commits name a file by its path, its name or its stem, not by a common stem', () => {
  const paths = ['src/rules/no-raw-sql.ts', 'test/no-raw-sql.test.ts', 'src/index.ts', 'src/db/store.ts', 'docs/guide.md'];
  assert.deepEqual([...namedFiles('fix(lint): catch every form of raw SQL in no-raw-sql\n\nThe index and the store do not change.', paths)], ['src/rules/no-raw-sql.ts', 'test/no-raw-sql.test.ts']);
  assert.deepEqual([...namedFiles('docs: update docs/guide.md', paths)], ['docs/guide.md']);
});

test('over the budget, the rule that the commits name and its test stay, an unrelated source file goes', () => {
  const { repo, commit } = repository();
  const base = commit('base', { 'README.md': '# Acme\n' });
  const head = commit('fix(lint): catch every form of raw SQL in no-raw-sql', {
    'src/rules/no-raw-sql.ts': source('rule', 120),
    'test/no-raw-sql.test.ts': lines(100, (i) => `test('form ${i} of raw SQL is caught', () => assert.equal(lint('select ${i} from the table of the invoices'), 1)); // the form ${i} of the rule`),
    'src/billing/other.ts': source('other', 80),
  });
  const { skipped } = buildPack(repo, base, head, 'full');
  assert.deepEqual(skipped, ['src/billing/other.ts: removed to fit in the maximum size of the review']);
});

test('over the budget, a file whose change is whitespace only, or that .gitattributes marks generated, goes first', () => {
  const { repo, commit } = repository();
  const flat = source('flat', 35);
  const base = commit('base', { 'src/flat.ts': flat, '.gitattributes': 'src/gen/** linguist-generated\n' });
  const head = commit('feat(billing): add the payments', {
    'src/flat.ts': flat.replace(/^/gm, '  '),
    'src/pay.ts': source('pay', 90),
    'src/refund.ts': source('refund', 85),
  });
  assert.deepEqual(buildPack(repo, base, head, 'full').skipped, ['src/flat.ts: removed to fit in the maximum size of the review']);
  const generated = commit('feat(billing): add the client', { 'src/flat.ts': flat, 'src/gen/client.ts': source('client', 70) });
  assert.deepEqual(buildPack(repo, base, generated, 'full').skipped, ['src/gen/client.ts: removed to fit in the maximum size of the review']);
});

test('two earlier findings of one kind on the same code ask for the root cause and the fix of the class', () => {
  const { repo, commit } = repository();
  const head = commit('base', { 'src/scan.ts': 'export const scan = (s: string) => s;\n' });
  const earlier = (line: number, status: EarlierFinding['status'], title: string, category: EarlierFinding['category'] = 'security'): EarlierFinding => ({
    key: `k${line}`,
    path: 'src/scan.ts',
    line,
    title,
    severity: 'major',
    category,
    status,
    reason: null,
    commit: head,
  });
  const { section } = earlierFindingsSection(repo, head, [earlier(12, 'fixed', 'A quoted name passes'), earlier(20, 'open', 'A comment hides a name'), earlier(90, 'open', 'Far away')]);
  assert.match(section, /### Defects found more than once on the same code\n\n- E1, E2 · `src\/scan\.ts:12` · security\n/);
  assert.match(section, /name the root cause that lets every form through/);
  const lone = earlierFindingsSection(repo, head, [earlier(12, 'fixed', 'A quoted name passes'), earlier(14, 'dismissed', 'Not a defect'), earlier(16, 'open', 'A test is missing', 'test')]).section;
  assert.doesNotMatch(lone, /more than once/);
});

test('a push that merges the base into a file of the pull request reads the whole pull request, not the lines of the base', async () => {
  const { repo, git, commit } = repository();
  const fn = (body: string, extra = '') => `export function total(a: number, b: number) {\n  return ${body};\n}\n${extra}`;
  const base = commit('base', { 'a.ts': fn('a + b') });
  git('checkout', '-q', '-b', 'pr');
  const reviewed = commit('change the total', { 'a.ts': fn('a + b + 1') });
  git('checkout', '-q', 'main');
  const main2 = commit('main moves on', { 'a.ts': fn('a + b', '\nexport const fromMain = 1;\n') });
  git('checkout', '-q', 'pr');
  git('merge', '-q', '--no-edit', main2);
  const head = git('rev-parse', 'HEAD');
  const packs: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    packs.push(request.messages[1].content);
    return new Response(JSON.stringify({ model: request.model, provider: 'Fake', choices: [{ message: { content: JSON.stringify(answer()) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }));
  }) as typeof globalThis.fetch;
  const result = await reviewPullRequest({ repoDir: repo, base: main2, head, level: 'lite', apiKey: 'k', fetch, log: () => {}, delta: { since: reviewed, score: 4, findings: [], settled: [] } });
  assert.equal(result.delta, null, 'the whole pull request');
  assert.match(packs[0]!, /^\+ {2}return a \+ b \+ 1;$/m);
  assert.doesNotMatch(packs[0]!, /^\+export const fromMain/m, 'the line that the base brought is no change of the pull request');
  void base;
});
