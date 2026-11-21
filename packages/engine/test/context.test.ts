// KNT-151. The context gives the code that a premise of a finding most often needs: the function that
// the change calls, the table that it writes, the route that a changed test requests, a whole workflow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Answer, Finding } from '../src/findings.ts';
import { reviewPullRequest } from '../src/index.ts';
import { buildContext, buildPack } from '../src/pack.ts';
import { moveUnreadPremises } from '../src/premise.ts';

let repo = '';
let base = '';
let head = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
// Lines that keep two functions of a file apart, so that no hunk of one shows the other.
const filler = (name: string, n = 30) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`).join('\n');

const billing = (body: string[]) =>
  [
    "import * as accounts from './accounts.server';",
    "import { db, sql } from '../db/client';",
    "import { invoices } from '../db/schema';",
    '',
    'export async function payInvoice(user: { id: string }, id: string) {',
    ...body,
    '}',
    '',
    filler('step'),
    '',
    '/** Only an admin of the organization pays: the session gives the role. */',
    'function assertAdmin(user: { id: string; role?: string }) {',
    "  if (user.role !== 'admin') throw new Response('Forbidden', { status: 403 });",
    '}',
    '',
  ].join('\n');

const workflow = (step: string) =>
  [
    'name: CI',
    'on:',
    '  pull_request:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...Array.from({ length: 20 }, (_, i) => `      - run: echo step ${i}`),
    `      - run: ${step}`,
    '',
  ].join('\n');

const routeTest = (extra: string[]) =>
  [
    "import { test } from 'node:test';",
    '',
    "test('an admin pays an invoice', async () => {",
    "  const id = 'inv_1';",
    '  const response = await fetch(`http://localhost/api/invoices/${id}`, { method: "POST" });',
    ...extra,
    '});',
    '',
  ].join('\n');

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-context-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  write('app/lib/accounts.server.ts', [filler('limit', 10), '', 'export async function requireOwner(user: { id: string }) {', '  return user.id.length > 0;', '}', ''].join('\n'));
  write('app/lib/billing.server.ts', billing(['  return id;']));
  write('app/db/client.ts', 'export const db = {} as any;\nexport const sql = (() => {}) as any;\n');
  write(
    'app/db/schema.ts',
    [
      "import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';",
      '',
      filler('other', 20),
      '',
      'export const invoices = pgTable(',
      "  'invoices',",
      '  {',
      "    id: text('id').primaryKey(),",
      "    orgId: text('org_id').notNull(),",
      "    paidAt: timestamp('paid_at'),",
      '  },',
      ');',
      '',
    ].join('\n'),
  );
  write('drizzle/0001_init.sql', 'CREATE TABLE "orgs" (\n\t"id" text PRIMARY KEY\n);\n--> statement-breakpoint\nCREATE TABLE "invoices" (\n\t"id" text PRIMARY KEY,\n\t"org_id" text NOT NULL REFERENCES "orgs"("id")\n);\n');
  write('drizzle/0002_paid.sql', 'ALTER TABLE "invoices" ADD COLUMN "paid_at" timestamptz;\n');
  write(
    'app/routes/api/invoices/$id/route.ts',
    [
      "import { payInvoice } from '../../../../lib/billing.server';",
      '',
      'export async function action({ params, context }: { params: { id: string }; context: { user: { id: string } } }) {',
      '  // The session middleware sets the role of the user.',
      '  return Response.json(await payInvoice(context.user, params.id));',
      '}',
      '',
    ].join('\n'),
  );
  write('test/invoices.test.ts', routeTest([]));
  write('.github/workflows/ci.yml', workflow('echo done'));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');

  write(
    'app/lib/billing.server.ts',
    billing([
      '  assertAdmin(user);',
      '  await accounts.requireOwner(user);',
      '  await sql`update invoices set paid_at = now() where id = ${id}`;',
      '  return id;',
    ]),
  );
  write('test/invoices.test.ts', routeTest(['  if (response.status !== 200) throw new Error(String(response.status));']));
  write('.github/workflows/ci.yml', workflow('echo finished'));
  git('commit', '-q', '-am', 'pay an invoice');
  head = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

let packed = '';
const context = () => (packed ||= buildPack(repo, base, head, 'definitions').pack.split('\n## Context\n')[1] ?? '');

test('a hunk that calls a function defined further down its own file gets that definition', () => {
  const text = context();
  assert.match(text, /app\/lib\/billing\.server\.ts:\d+-\d+ · definition of `assertAdmin`, which the PR calls/);
  assert.match(text, /\|\s+if \(user\.role !== 'admin'\) throw new Response\('Forbidden', \{ status: 403 \}\);/);
});

test('a call through an imported object gets the definition of the method in its module', () => {
  const text = context();
  assert.match(text, /app\/lib\/accounts\.server\.ts:\d+-\d+ · definition of `accounts\.requireOwner`, which the PR calls/);
  assert.match(text, /export async function requireOwner\(user: \{ id: string \}\) \{\n\d+\|\s+return user\.id\.length > 0;/);
});

test('a diff that writes a table gets its schema, the migration that creates it and the last one that alters it', () => {
  const text = context();
  assert.match(text, /app\/db\/schema\.ts:\d+-\d+ · table `invoices`, which the PR reads or writes/);
  assert.match(text, /\|\s+orgId: text\('org_id'\)\.notNull\(\),/);
  assert.match(text, /drizzle\/0001_init\.sql:5-8 · migration that creates the table `invoices`/);
  assert.match(text, /\|\s+"org_id" text NOT NULL REFERENCES "orgs"\("id"\)/);
  assert.match(text, /drizzle\/0002_paid\.sql:1-1 · last migration that alters the table `invoices`/);
  // The other table of the first migration is not in the context.
  assert.doesNotMatch(text, /CREATE TABLE "orgs"/);
});

test('a changed test gets the route that it requests', () => {
  const text = context();
  assert.match(text, /app\/routes\/api\/invoices\/\$id\/route\.ts:3-6 · route `\/api\/invoices\/:id`, which a changed test requests/);
  assert.match(text, /\|\s+return Response\.json\(await payInvoice\(context\.user, params\.id\)\);/);
});

test('a workflow file shows whole in the diff, not only its hunk', () => {
  const { pack } = buildPack(repo, base, head, 'definitions');
  const diff = pack.split('\n## Diff\n')[1]!.split('\n## Imports\n')[0]!;
  assert.match(diff, /\n name: CI\n on:\n {3}pull_request:\n permissions:\n {3}contents: read\n/);
  assert.match(diff, /\n- {6}- run: echo done\n\+ {6}- run: echo finished\n/);
});

test('a snippet over the budget gives its place to a smaller one after it', () => {
  const paths = ['app/lib/billing.server.ts', 'test/invoices.test.ts'];
  const all = buildContext(repo, base, head, paths, 60_000, 'definitions');
  const snippets = all.split(/(?=^### )/m);
  const smallest = Math.min(...snippets.map((s) => s.length));
  assert.ok(snippets.length > 2 && snippets[0]!.length > smallest, 'the first snippet is not the smallest one');
  const fitted = buildContext(repo, base, head, paths, smallest, 'definitions');
  assert.ok(snippets.includes(fitted), `one whole snippet fits, got ${JSON.stringify(fitted.slice(0, 80))}`);
});

// A finding whose premise is code that the review did not read goes to « Not reviewed ».

const PAY = 'app/lib/billing.server.ts';
const finding = (over: Partial<Finding>): Finding => ({
  path: PAY,
  start_line: 7,
  line: 7,
  severity: 'major',
  category: 'security',
  confidence: 70,
  title: 'requireOwner can be reached without the admin check',
  scenario: 'A member who is not an admin calls the route. The code of requireOwner is not in the message, so the check of the role is not confirmed, and the invoice is paid.',
  fix: 'Check the role in requireOwner.',
  suggestion: '',
  ...over,
});
const answer = (findings: Finding[], score = 4): Answer => ({
  confidence_score: score,
  risk: 'Risk',
  summary: 'Summary',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

test('a finding that says its code is not in the message goes to « Not reviewed », with what to check', () => {
  const reply = answer([finding({}), finding({ title: 'Paid twice on a retry', scenario: 'Two clicks send two requests, and both update the row.', line: 8 })]);
  const moved = moveUnreadPremises(reply);
  assert.deepEqual(moved.map((f) => f.title), ['requireOwner can be reached without the admin check']);
  assert.deepEqual(reply.findings.map((f) => f.title), ['Paid twice on a retry']);
  assert.deepEqual(reply.not_reviewed, [
    `${PAY}: requireOwner can be reached without the admin check. To check: The code of requireOwner is not in the message, so the check of the role is not confirmed, and the invoice is paid.`,
  ]);
  assert.equal(reply.confidence_score, 4, 'the check never changes the score of the model');
});

test('a sure finding, or a defect about a check that the code lacks, stays a finding', () => {
  const sure = finding({ confidence: 90 });
  const email = finding({ title: 'An email not verified can pay', scenario: 'The route never reads emailVerified, so a user whose email is not verified pays an invoice.' });
  const migration = finding({ title: 'The column has no migration', scenario: 'The schema adds paid_at, but the migration is not in the diff, so the update fails on the database.' });
  const reply = answer([sure, email, migration]);
  assert.deepEqual(moveUnreadPremises(reply), []);
  assert.equal(reply.findings.length, 3);
  assert.deepEqual(reply.not_reviewed, []);
});

test('a review whose only blocking finding rests on unread code is not capped at 2', async () => {
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const content = JSON.stringify(answer([finding({})], 4));
    return new Response(JSON.stringify({ model: body.model, provider: 'Fake', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }));
  }) as typeof globalThis.fetch;
  const logs: string[] = [];
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey: 'k', fetch, log: (m) => logs.push(m) });
  assert.deepEqual(result.findings, []);
  assert.equal(result.score, 4);
  assert.match(result.answer.not_reviewed.join('\n'), /requireOwner can be reached without the admin check\. To check: /);
  assert.match(logs.join('\n'), /finding moved to not reviewed, its premise is code that the review did not read/);
});
