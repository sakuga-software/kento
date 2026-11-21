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
import { buildPack, namedFiles, onlyIndent } from '../src/pack.ts';
import { changedZonesSection, seenCode } from '../src/seen.ts';
import { withoutMergeAdvice } from '../src/risk.ts';
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

test('« Not reviewed » merges only the lines of one path with the same reason, and drops empty lines', () => {
  assert.deepEqual(
    notReviewedLines(
      ['a.json: generated or binary file', 'src/a.ts: removed to fit in the maximum size of the review'],
      [
        'a.json (generated)',
        '',
        'rule "No raw SQL": removed to fit in the maximum size of the review',
        // The reproduction of the critique of #48: two findings moved on one file, and a moved finding
        // on a file that the pack cut.
        'src/b.ts: Two requests race on the row. To check: The definition of lock is not in the pack.',
        'src/b.ts: The tenant filter is missing. To check: The schema of invoices is not provided.',
        'src/a.ts: The total is wrong. To check: The callers of total are not in the pack.',
      ],
    ),
    [
      'a.json: generated or binary file',
      'src/a.ts: removed to fit in the maximum size of the review',
      'rule "No raw SQL": removed to fit in the maximum size of the review',
      'src/b.ts: Two requests race on the row. To check: The definition of lock is not in the pack.',
      'src/b.ts: The tenant filter is missing. To check: The schema of invoices is not provided.',
      'src/a.ts: The total is wrong. To check: The callers of total are not in the pack.',
    ],
  );
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
  applyCoverage(reply, { files: 2, cut: ['app/db/invoice-store.ts'], large: [], narrowed: [], logic: ['app/db/invoice-store.ts'], core: ['app/db/invoice-store.ts'] });
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
  // The second form: one earlier finding is enough for the section to ask for the root cause.
  const one = earlierFindingsSection(repo, head, [earlier(12, 'fixed', 'The scanner lets a quoted name through')]).section;
  assert.match(one, /another form of an earlier one \(another input that the same code lets through\), name in the scenario the root cause/);
  assert.doesNotMatch(one, /more than once/);
  // Two of one kind on one file, by the words of their titles, whatever their lines at older heads.
  const { section } = earlierFindingsSection(repo, head, [earlier(12, 'fixed', 'The scanner lets a quoted name through'), earlier(80, 'open', 'The scanner lets a commented name through'), earlier(14, 'open', 'Off-by-one in the cursor')]);
  assert.match(section, /### Defects found more than once on the same code\n\n- E1, E2 · `src\/scan\.ts` · "The scanner lets a quoted name through"\n/);
  // Two different defects near each other, or one that a person set aside, make no class.
  const lone = earlierFindingsSection(repo, head, [earlier(12, 'fixed', 'The scanner lets a quoted name through'), earlier(13, 'open', 'Null dereference of the cursor'), earlier(14, 'dismissed', 'The scanner lets a quoted name pass')]).section;
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

test('the commits name a file by a stem that is no plain word; trailers and words such as `github` do not count', () => {
  const paths = ['app/auth/github.test.ts', 'app/repos/repos.test.ts', 'app/db/webhook-store.ts', 'CLAUDE.md', 'src/rules/no-raw-sql.ts'];
  const message = 'feat(web): split GitHub installations from the repos and the webhook\n\nno-raw-sql keeps its rule.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nSigned-off-by: Dev <dev@example.com>';
  assert.deepEqual([...namedFiles(message, paths)], ['src/rules/no-raw-sql.ts']);
});

test('a named file never ranks above the core: over the budget, a named test goes before a store', () => {
  const { repo, commit } = repository();
  const base = commit('base', { 'README.md': '# Acme\n' });
  const head = commit('fix(billing): the invoice-store keeps the totals, invoice-store.test checks it', {
    'app/db/invoice-store.ts': source('store', 120),
    'test/invoice-store.test.ts': lines(130, (i) => `test('total ${i} of the store', () => assert.equal(read(${i}), ${i})); // the total ${i} of the invoice store, with its tax and its date`),
  });
  assert.deepEqual(buildPack(repo, base, head, 'full').skipped, ['test/invoice-store.test.ts: removed to fit in the maximum size of the review']);
});

test('only an indent change of a language where the indent means nothing counts as formatting', () => {
  const moved = '@@ -1,2 +1,2 @@\n-if (a) {\n-return 1;\n+  if (a) {\n+    return 1;\n';
  assert.equal(onlyIndent('src/a.ts', moved), true);
  assert.equal(onlyIndent('src/a.py', moved), false, 'Python');
  assert.equal(onlyIndent('ci.yml', moved), false, 'YAML');
  assert.equal(onlyIndent('Makefile', moved), false);
  assert.equal(onlyIndent('src/a.ts', '@@ -1 +1 @@\n-const s = "a b";\n+const s = "a  b";\n'), false, 'a space inside a string');
});

test('only a positive advice to merge leaves the risk; a warning, a condition and « e.g. » stay', () => {
  assert.equal(
    withoutMergeAdvice('It is not safe to merge until the store is read. This is not low risk: the migration drops a column. Do not merge it now. It can be merged only after the guard. Safe to merge, e.g. after a look at the labels.'),
    'It is not safe to merge until the store is read. This is not low risk: the migration drops a column. Do not merge it now. It can be merged only after the guard.',
  );
  assert.equal(withoutMergeAdvice('The lock is wrong, e.g. on a retry. Low risk.'), 'The lock is wrong, e.g. on a retry.');
});

test('after a merge of the base, the zones changed since the last review are those of the pull request only', () => {
  const { repo, git, commit } = repository();
  const fn = (body: string, extra = '') => `export function total(a: number, b: number) {\n  return ${body};\n}\n${extra}`;
  commit('base', { 'a.ts': fn('a + b') });
  git('checkout', '-q', '-b', 'pr');
  const reviewed = commit('change the total', { 'a.ts': fn('a + b + 1') });
  git('checkout', '-q', 'main');
  const main2 = commit('main moves on', { 'a.ts': fn('a + b', '\n\n\n\n\n\n\n\n\n\nexport const fromMain = 1;\n') });
  git('checkout', '-q', 'pr');
  git('merge', '-q', '--no-edit', main2);
  commit('change the total again', { 'a.ts': fn('a + b + 2', '\n\n\n\n\n\n\n\n\n\nexport const fromMain = 1;\n') });
  const head = git('rev-parse', 'HEAD');
  const own = new Map([['a.ts', new Set([2])]]);
  const zones = changedZonesSection(seenCode(repo, reviewed, head, own), ['a.ts']);
  assert.match(zones, /- `a\.ts`: lines 2\n/);
  // Without the lines of the pull request, the line of the base counts as changed.
  assert.match(changedZonesSection(seenCode(repo, reviewed, head), ["a.ts"]), /- `a\.ts`: lines 2, 4–14\n/);
  void main2;
});

test('a « Not reviewed » line of the model of any length is read in linear time (CodeQL on #48)', () => {
  const line = `!:${' '.repeat(100_000)}\n!`;
  const started = performance.now();
  assert.deepEqual(notReviewedLines([], [line, line]), [line]);
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
});
