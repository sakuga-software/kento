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
import { buildPack, trimRank, TRIM_RANK } from '../src/pack.ts';

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
  assert.deepEqual(coverage, { files: 5, cut: ['docs/guide.md', 'test/invoices.test.ts'], narrowed: [] });
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
  assert.deepEqual(coverage, { files: 3, cut: [], narrowed: ['app/lib/report.ts'] });
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
  assert.deepEqual(coverage, { files: 4, cut: ['test/pay.test.ts'], narrowed: [] });
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

test('a review that did not read a schema says so in its risk and its summary, and gives 3 at most', () => {
  const reply = answer();
  const cap = applyCoverage(reply, { files: 6, cut: ['app/db/schema.ts', 'test/invoices.test.ts'], narrowed: ['app/lib/report.ts'] });
  assert.equal(cap, 3);
  assert.equal(reply.confidence_score, 3);
  assert.equal(reply.risk, 'Partial review: 1 file of logic not read, a schema, a migration or a store among them (see Not reviewed). Low risk: the invoices get new columns.');
  assert.equal(
    reply.summary,
    'Adds the columns of the invoices.\n\nThis review did not read 2 of the 6 changed files, to fit in its size: `app/db/schema.ts`, `test/invoices.test.ts`.\n\nIt read this file with three lines of context only: `app/lib/report.ts`.',
  );
});

test('a source file not read gives 4 at most; a lower score of the model stays', () => {
  const high = answer();
  assert.equal(applyCoverage(high, { files: 3, cut: ['app/lib/pay.ts'], narrowed: [] }), 4);
  assert.equal(high.confidence_score, 4);
  const low = answer({ confidence_score: 2 });
  applyCoverage(low, { files: 3, cut: ['app/lib/pay.ts'], narrowed: [] });
  assert.equal(low.confidence_score, 2);
});

test('docs and tests not read: the summary says it, the risk and the score stay', () => {
  const reply = answer();
  assert.equal(applyCoverage(reply, { files: 4, cut: ['docs/guide.md', 'test/invoices.test.ts'], narrowed: [] }), null);
  assert.equal(reply.confidence_score, 5);
  assert.equal(reply.risk, 'Low risk: the invoices get new columns.');
  assert.match(reply.summary, /did not read 2 of the 4 changed files/);
  const whole = answer();
  assert.equal(applyCoverage(whole, { files: 4, cut: [], narrowed: [] }), null);
  assert.deepEqual(whole, answer());
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
  assert.match(result.answer.risk, /^Partial review: 1 file of logic not read, a schema, a migration or a store among them/);
  assert.match(result.answer.summary, /This review did not read 1 of the 3 changed files, to fit in its size: `app\/db\/[a-z-]+\.ts`\./);
  assert.match(logs.join('\n'), /score capped at 3: the model said 5, and the review did not read 1 changed file/);
});
