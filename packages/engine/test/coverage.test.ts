// KNT-166. When the pack must cut a large pull request, the schema, the migrations and the stores go
// last, a large function keeps its hunks before its file goes, and the review says what it did not read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { applyCoverage } from '../src/coverage.ts';
import type { Answer } from '../src/findings.ts';
import { reviewPullRequest } from '../src/index.ts';
import { buildPack, trimRank, TRIM_RANK, type Coverage } from '../src/pack.ts';

const repos: string[] = [];
after(() => repos.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A repository with a base commit and a head commit: `files` at the base, `changes` at the head. */
function pullRequest(files: Record<string, string>, changes: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), 'engine-coverage-'));
  repos.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (all: Record<string, string>) => {
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  write({ 'README.md': '# Acme\n', ...files });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  write(changes);
  git('add', '-A');
  git('commit', '-q', '-m', 'add the invoices');
  return { repo, base, head: git('rev-parse', 'HEAD') };
}

/** About `kb` kilobytes of lines of one shape, under the 1000 changed lines of a file. */
const lines = (kb: number, line: (i: number) => string) => {
  const out: string[] = [];
  while (out.join('\n').length < kb * 1000) out.push(line(out.length));
  assert.ok(out.length < 1000);
  return `${out.join('\n')}\n`;
};
const schema = lines(80, (i) => `export const column${i} = text('column_${i}').notNull(); // the column ${i} of the invoices`);
const migration = lines(75, (i) => `ALTER TABLE "invoices" ADD COLUMN "column_${i}" text NOT NULL DEFAULT 'none'; -- column ${i}`);
const testFile = lines(60, (i) => `test('invoice ${i} keeps its column', () => assert.equal(read(${i}), 'column_${i}')); // ${i}`);
const ui = lines(60, (i) => `export const Row${i} = () => <tr className="invoice-row"><td>{'column ${i}'}</td></tr>; // ${i}`);
const guide = lines(30, (i) => `The column ${i} of an invoice holds one value that the billing page shows to the owner.`);

test('the trim ranks the files: generated-like, docs, tests, UI, source, then schema, migrations and stores', () => {
  const rank = (path: string) => trimRank(path);
  assert.equal(rank('public/assets/app.min.css'), TRIM_RANK.generated);
  assert.equal(rank('apps/web/public/assets/index-BpX3k9aF.js'), TRIM_RANK.generated);
  assert.equal(trimRank('apps/web/public/assets/app.js', `+${'x'.repeat(1200)}\n`), TRIM_RANK.generated, 'very long lines');
  assert.equal(rank('apps/web/public/assets/kento.css'), TRIM_RANK.ui, 'hand-written');
  assert.equal(rank('apps/web/public/assets/frame.js'), TRIM_RANK.source, 'hand-written');
  assert.equal(rank('apps/web/drizzle/meta/0029_snapshot.json'), TRIM_RANK.generated);
  assert.equal(rank('apps/web/drizzle/meta/_journal.json'), TRIM_RANK.generated);
  assert.equal(rank('apps/docs/src/server.ts'), TRIM_RANK.source, 'code under docs/');
  assert.equal(rank('requirements.txt'), TRIM_RANK.source);
  assert.equal(rank('CMakeLists.txt'), TRIM_RANK.source);
  assert.equal(rank('docs/notes.txt'), TRIM_RANK.docs);
  assert.equal(rank('test/fixtures/invoice.json'), TRIM_RANK.generated);
  assert.equal(rank('docs/guide.md'), TRIM_RANK.docs);
  assert.equal(rank('apps/web/test/db/migrations.test.ts'), TRIM_RANK.tests);
  assert.equal(rank('apps/web/e2e/invoices.ts'), TRIM_RANK.tests);
  assert.equal(rank('apps/web/app/ui/invoices.tsx'), TRIM_RANK.ui);
  assert.equal(rank('apps/web/app/billing/pay.ts'), TRIM_RANK.source);
  for (const path of ['apps/web/app/db/schema.ts', 'apps/web/drizzle/0002_paid.sql', 'apps/web/app/db/webhook-store.ts', 'apps/web/app/runner/store.ts', 'prisma/schema.prisma']) {
    assert.equal(rank(path), TRIM_RANK.core, path);
  }
});

test('over the budget, the pack drops the docs and the tests before the schema and the migration', () => {
  const { repo, base, head } = pullRequest(
    {},
    { 'app/db/schema.ts': schema, 'drizzle/0002_columns.sql': migration, 'test/invoices.test.ts': testFile, 'app/ui/invoices.tsx': ui, 'docs/guide.md': guide },
  );
  const { pack, skipped, coverage } = buildPack(repo, base, head, 'full');
  assert.deepEqual(skipped, ['docs/guide.md: removed to fit in the maximum size of the review', 'test/invoices.test.ts: removed to fit in the maximum size of the review']);
  assert.deepEqual(coverage, { files: 5, cut: ['docs/guide.md', 'test/invoices.test.ts'], large: [], narrowed: [], logic: ['test/invoices.test.ts'], core: [] });
  assert.match(pack, /\+\+\+ b\/app\/db\/schema\.ts/);
  assert.match(pack, /\+\+\+ b\/drizzle\/0002_columns\.sql/);
  assert.match(pack, /\+\+\+ b\/app\/ui\/invoices\.tsx/);
});

test('a large function keeps its hunks with three lines of context before its file is dropped', () => {
  const body = (changed: string) => ['export function report(rows: string[]) {', ...lines(80, (i) => `  rows.push('the line ${i} of the report of the invoices, with its total and its date');`).trimEnd().split('\n').map((l, i) => (i === 400 ? changed : l)), '}', ''].join('\n');
  const { repo, base, head } = pullRequest(
    { 'app/lib/report.ts': body("  rows.push('total');") },
    {
      'app/lib/report.ts': body("  rows.push('total with tax');"),
      'app/lib/a.ts': lines(79, (i) => `export const a${i} = 'the value ${i} of the first module of the billing of the invoices';`),
      'app/lib/b.ts': lines(79, (i) => `export const b${i} = 'the value ${i} of the second module of the billing of the invoices';`),
    },
  );
  const { pack, skipped, coverage } = buildPack(repo, base, head, 'full');
  assert.deepEqual(skipped, []);
  assert.deepEqual(coverage, { files: 3, cut: [], large: [], narrowed: ['app/lib/report.ts'], logic: [], core: [] });
  assert.match(pack, /\n-  rows\.push\('total'\);\n\+  rows\.push\('total with tax'\);\n/);
  assert.doesNotMatch(pack, /\n export function report\(rows: string\[\]\) \{\n/, 'the whole function is not in the pack');
  assert.match(pack, /these files show three lines of context only: `app\/lib\/report\.ts`\./);
});

test('when a drop leaves room, a store gets its whole function back', () => {
  const store = (changed: string) => ['export function readInvoices(rows: string[]) {', ...lines(40, (i) => `  rows.push('the row ${i} of the store of the invoices, with its total and its date');`).trimEnd().split('\n').map((l, i) => (i === 200 ? changed : l)), '}', ''].join('\n');
  const { repo, base, head } = pullRequest(
    { 'app/db/invoice-store.ts': store("  rows.push('total');") },
    {
      'app/db/invoice-store.ts': store("  rows.push('total with tax');"),
      'app/lib/pay.ts': lines(110, (i) => `export const pay${i} = (total: number) => total * ${i} + 1; // the step ${i} of the payment of an invoice, with its total and its tax`),
      'test/pay.test.ts': lines(125, (i) => `test('the step ${i} of a payment', () => assert.equal(pay${i}(1), ${i} + 1)); // the step ${i} of the payment of an invoice, with its total, its tax and its date`),
      'app/ui/pay.tsx': lines(70, (i) => `export const Step${i} = () => <li className="pay-step">{'step ${i}'}</li>; // the step ${i}`),
    },
  );
  const { pack, coverage } = buildPack(repo, base, head, 'full');
  assert.deepEqual(coverage, { files: 4, cut: ['test/pay.test.ts'], large: [], narrowed: [], logic: ['test/pay.test.ts'], core: [] });
  assert.match(pack, /\n export function readInvoices\(rows: string\[\]\) \{\n/, 'the whole function is back');
  assert.doesNotMatch(pack, /three lines of context only/);
});

const answer = (over: Partial<Answer> = {}): Answer => ({
  confidence_score: 5,
  risk: 'Low risk: the invoices get new columns.',
  summary: 'Adds the columns of the invoices.',
  diagram: '',
  findings: [],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
  ...over,
});

const coverage = (over: Partial<Coverage>): Coverage => ({ files: 6, cut: [], large: [], narrowed: [], logic: [], core: [], ...over });

test('a review that did not read a schema says so in its risk and its summary, and gives 3 at most', () => {
  const reply = answer({ risk: 'The invoices get new columns. Low risk, safe to merge.' });
  const cap = applyCoverage(reply, coverage({ cut: ['app/db/schema.ts', 'test/invoices.test.ts'], large: ['app/lib/big.ts'], narrowed: ['app/lib/report.ts'], logic: ['app/db/schema.ts', 'test/invoices.test.ts', 'app/lib/big.ts'], core: ['app/db/schema.ts'] }));
  assert.equal(cap, 3);
  assert.equal(reply.confidence_score, 3);
  assert.equal(reply.risk, 'Partial review: 3 files of logic not read, a schema, a migration or a store among them (see Not reviewed). The invoices get new columns.');
  assert.equal(
    reply.summary,
    'Adds the columns of the invoices.\n\nThis review did not read 3 of the 6 changed files: 2 to fit in its size (`app/db/schema.ts`, `test/invoices.test.ts`); 1 with more than 1000 changed lines (`app/lib/big.ts`).\n\nIt read this file with three lines of context only: `app/lib/report.ts`.',
  );
});

test('a file of logic not read gives 4 at most, a UI file and a test too; a lower score of the model stays', () => {
  for (const path of ['app/lib/pay.ts', 'app/ui/pay.tsx', 'test/pay.test.ts']) {
    const high = answer();
    assert.equal(applyCoverage(high, coverage({ cut: [path], logic: [path] })), 4, path);
    assert.equal(high.confidence_score, 4);
  }
  const low = answer({ confidence_score: 2 });
  applyCoverage(low, coverage({ cut: ['app/lib/pay.ts'], logic: ['app/lib/pay.ts'] }));
  assert.equal(low.confidence_score, 2);
});

test('docs and generated files not read: the summary says it, the risk and the score stay', () => {
  const reply = answer();
  assert.equal(applyCoverage(reply, coverage({ files: 4, cut: ['docs/guide.md'], large: ['apps/web/drizzle/meta/0029_snapshot.json'] })), null);
  assert.equal(reply.confidence_score, 5);
  assert.equal(reply.risk, 'Low risk: the invoices get new columns.');
  assert.match(reply.summary, /did not read 2 of the 4 changed files: 1 to fit in its size \(`docs\/guide\.md`\); 1 with more than 1000 changed lines/);
  const whole = answer();
  assert.equal(applyCoverage(whole, coverage({})), null);
  assert.deepEqual(whole, answer());
});

test('a warning of the model stays in the risk of a partial review; only an advice to merge goes', () => {
  const reply = answer({ risk: 'It is not safe to merge until the store is checked. Low risk otherwise, e.g. for the labels. Safe to merge.' });
  applyCoverage(reply, coverage({ cut: ['app/lib/pay.ts'], logic: ['app/lib/pay.ts'] }));
  assert.equal(reply.risk, 'Partial review: 1 file of logic not read (see Not reviewed). It is not safe to merge until the store is checked.');
});

test('a review whose pack cut the schema is not « safe to merge » at 5: the model says 5, the review gives 3', async () => {
  const { repo, base, head } = pullRequest(
    {},
    { 'app/db/schema.ts': schema, 'drizzle/0002_columns.sql': migration, 'app/db/invoice-store.ts': lines(90, (i) => `export const read${i} = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)); // ${i}`) },
  );
  const fetch = (async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const content = JSON.stringify(answer());
    return new Response(JSON.stringify({ model: request.model, provider: 'Fake', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }));
  }) as typeof globalThis.fetch;
  const logs: string[] = [];
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: (m) => logs.push(m) });
  assert.equal(result.coverage?.cut.length, 1);
  assert.equal(result.score, 3);
  assert.notEqual(result.verdict, 'APPROVE');
  // The fixture is a critical change too (KNT-154): its prefix comes first.
  assert.match(result.answer.risk, /^(?:Critical change \([^)]*\)\. )?Partial review: 1 file of logic not read, a schema, a migration or a store among them/);
  assert.match(result.answer.summary, /This review did not read 1 of the 3 changed files: 1 to fit in its size \(`app\/db\/[a-z-]+\.ts`\)\./);
  assert.match(logs.join('\n'), /score capped at 3: the model said 5, and the review did not read 1 changed file of logic/);
});

test('an incremental review counts as not read a store that the whole pack cuts and that it does not read again', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'engine-coverage-'));
  repos.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  const base = commit('base', { 'README.md': '# Acme\n' });
  const reviewed = commit('add the columns', {
    'app/db/schema.ts': schema,
    'drizzle/0002_columns.sql': migration,
    'app/db/invoice-store.ts': lines(90, (i) => `export const read${i} = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)); // ${i}`),
  });
  const head = commit('fix the label', { 'app/lib/label.ts': 'export const label = (n: number) => `${n} invoices`;\n' });
  const fetch = (async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ model: request.model, provider: 'Fake', choices: [{ message: { content: JSON.stringify(answer()) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }));
  }) as typeof globalThis.fetch;
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: () => {}, delta: { since: reviewed, score: 3, findings: [], settled: [] } });
  assert.deepEqual(result.delta?.files, ['app/lib/label.ts'], 'an incremental review');
  assert.deepEqual(result.coverage, { files: 4, cut: ['app/db/invoice-store.ts'], large: [], narrowed: [], logic: ['app/db/invoice-store.ts'], core: ['app/db/invoice-store.ts'] });
  // « Not reviewed » lists it too, as the summary does.
  assert.ok(result.skipped.includes('app/db/invoice-store.ts: removed to fit in the maximum size of the review'), result.skipped.join('\n'));
  assert.equal(result.score, 3);
});

test('a migration PR with a Drizzle snapshot of 3 900 lines is not capped: the snapshot is generated', () => {
  const snapshot = `${JSON.stringify({ tables: Object.fromEntries(Array.from({ length: 1300 }, (_, i) => [`t${i}`, { name: `t${i}`, columns: {} }])) }, null, 2)}\n`;
  assert.ok(snapshot.split('\n').length > 3000);
  const { repo, base, head } = pullRequest({}, { 'apps/web/drizzle/0031_roles.sql': 'ALTER TABLE "memberships" ADD COLUMN "role" text;\n', 'apps/web/drizzle/meta/0031_snapshot.json': snapshot, 'apps/web/drizzle/meta/_journal.json': '{"entries":[]}\n' });
  const { coverage: c } = buildPack(repo, base, head, 'full');
  assert.deepEqual(c.logic, []);
  const reply = answer();
  assert.equal(applyCoverage(reply, c), null, 'no cap');
  assert.equal(reply.confidence_score, 5);
});

test('a test-only pull request over the budget: the tests are the change, the fixture is not dropped first, and a cut test counts as logic', () => {
  const { repo, base, head } = pullRequest(
    {},
    {
      'test/a.test.ts': lines(100, (i) => `test('case ${i} of the invoices', () => assert.equal(pay(${i}), ${i})); // the case ${i} of the payment of an invoice`),
      'test/b.test.ts': lines(95, (i) => `test('case ${i} of the refunds', () => assert.equal(refund(${i}), ${i})); // the case ${i} of the refund of an invoice`),
      'test/fixtures/rows.json': lines(60, (i) => `{"id": "row_${i}", "total": ${i}, "label": "the row ${i} of the fixture of the invoices"},`),
    },
  );
  const { coverage: c } = buildPack(repo, base, head, 'full');
  assert.deepEqual(c.cut, ['test/a.test.ts'], 'the larger test goes; the fixture, ranked as the tests, is smaller');
  assert.deepEqual(c.logic, ['test/a.test.ts']);
});

test('a file of logic over 1000 changed lines, and no cut: the review gives 4, and its log counts that file (Kentō on #46)', async () => {
  const big = Array.from({ length: 1100 }, (_, i) => `export const step${i} = ${i};`).join('\n');
  const { repo, base, head } = pullRequest({}, { 'app/lib/steps.ts': `${big}\n`, 'app/lib/pay.ts': 'export const pay = 1;\n' });
  const fetch = (async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ model: request.model, provider: 'Fake', choices: [{ message: { content: JSON.stringify(answer()) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }));
  }) as typeof globalThis.fetch;
  const logs: string[] = [];
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: (m) => logs.push(m) });
  assert.deepEqual(result.coverage?.cut, []);
  assert.deepEqual(result.coverage?.large, ['app/lib/steps.ts']);
  assert.equal(result.score, 4);
  assert.match(logs.join('\n'), /score capped at 4: the model said 5, and the review did not read 1 changed file of logic/);
});

test('a partial review of a critical change: « Critical change (…). » first, then « Partial review: … »', () => {
  const reply = answer({ risk: 'Critical change (CI). The workflow gets a step. Low risk.' });
  applyCoverage(reply, coverage({ cut: ['app/lib/pay.ts'], logic: ['app/lib/pay.ts'] }));
  assert.equal(reply.risk, 'Critical change (CI). Partial review: 1 file of logic not read (see Not reviewed). The workflow gets a step.');
});
