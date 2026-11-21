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
import { buildContext, buildPack, declarationEnd } from '../src/pack.ts';
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
  scenario: 'A member who is not an admin calls the route. The definition of requireOwner is not in the pack, so the check of the role cannot be verified from the diff, and the invoice is paid.',
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

test('a finding that says its code is not in the pack goes to « Not reviewed », with what to check', () => {
  const reply = answer([finding({}), finding({ title: 'Paid twice on a retry', scenario: 'Two clicks send two requests, and both update the row.', line: 8 })]);
  const moved = moveUnreadPremises(reply);
  assert.deepEqual(moved.map((f) => f.title), ['requireOwner can be reached without the admin check']);
  assert.deepEqual(reply.findings.map((f) => f.title), ['Paid twice on a retry']);
  assert.deepEqual(reply.not_reviewed, [
    `${PAY}: requireOwner can be reached without the admin check. To check: The definition of requireOwner is not in the pack, so the check of the role cannot be verified from the diff, and the invoice is paid.`,
  ]);
  assert.equal(reply.confidence_score, 4, 'the check never changes the score of the model');
});

test('a sure finding, or a defect about a check that the code lacks, stays a finding', () => {
  const sure = finding({ confidence: 90 });
  const email = finding({ title: 'An email not verified can pay', scenario: 'The route never reads emailVerified, so a user whose email is not verified pays an invoice.' });
  const migration = finding({ title: 'The column has no migration', scenario: 'The schema adds paid_at, but the migration is not in the diff, so the update fails on the database.' });
  // Kentō on #44: a defect that the model states in the first person.
  const lock = finding({ title: 'Paid twice on a retry', scenario: 'I could not see a lock here, so two requests both update the row.' });
  const reply = answer([sure, email, migration, lock]);
  assert.deepEqual(moveUnreadPremises(reply), []);
  assert.equal(reply.findings.length, 4);
  const unread = answer([finding({ scenario: 'I could not confirm the implementation of requireOwner, so a member may pay.' })]);
  assert.equal(moveUnreadPremises(unread).length, 1, 'a hedge that names the code it did not read moves');
});

test('`context`, `message` and `review` are words of the code: a defect that uses them stays a finding', () => {
  // The four counter-examples of the critique of #44, at confidence 75.
  const at75 = (title: string, scenario: string) => finding({ confidence: 75, title, scenario });
  const reply = answer([
    at75('The loader reads orgId that the middleware never sets', 'When the request skips the auth middleware, orgId is not available in the context, so the query reads every org.'),
    at75('The error log drops the request id', 'The request id is not included in the message, so the logs of a failed payment cannot be traced.'),
    at75('No score on the PR', 'The score is not shown in the review when the model returns no findings, so the gauge reads 0/5.'),
    at75('Cross-tenant write', 'payInvoice updates by id only, so any user pays the invoice of another org. The callers are not shown in the pack, but the route passes params.id as is.'),
  ]);
  assert.deepEqual(moveUnreadPremises(reply).map((f) => f.title), []);
  assert.equal(reply.findings.length, 4);
  // The phrases of a reviewer about what it read move a finding.
  for (const scenario of [
    'The callers of payInvoice are not in the pack, so a member may reach it.',
    'I could not read the body of requireOwner, so the role may not be checked.',
    'The schema of invoices is not provided, so org_id may be null.',
    'The role check cannot be verified from the diff, so a member may pay.',
  ]) {
    assert.equal(moveUnreadPremises(answer([at75('A member may pay', scenario)])).length, 1, scenario);
  }
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

// The critique of #44: a body behind a signature on several lines, the declaration that the diff
// shows only in part, tables that noise or a second app hides, migrations in the order of their
// numbers, a method of another class or of a package, and the room of the context on a large PR.

const others: string[] = [];
after(() => others.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function repoWith(baseFiles: Record<string, string>, headFiles: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-context-'));
  others.push(dir);
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const put = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'dev@example.com');
  run('config', 'user.name', 'Dev');
  put(baseFiles);
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  const from = run('rev-parse', 'HEAD');
  put(headFiles);
  run('add', '-A');
  run('commit', '-q', '-m', 'change');
  return { repo: dir, base: from, head: run('rev-parse', 'HEAD') };
}
const comments = (n: number) => Array.from({ length: n }, (_, i) => `  // step ${i}`).join('\n');

test('E1: a method whose signature takes several lines (Prettier) comes with its body', () => {
  const billing = (call: string) =>
    ['export class Billing {', '  run(id: string) {', `    ${call}`, '  }', comments(40), '  async chargeCustomer(', '    customerId: string,', '    amount: number,', '  ): Promise<void> {', "    if (amount <= 0) throw new Error('BODY_MARKER');", '    await this.store(customerId, amount);', '  }', '}', ''].join('\n');
  const r = repoWith({ 'src/billing.ts': billing('return id;') }, { 'src/billing.ts': billing('void this.chargeCustomer(id, 1);') });
  const out = buildContext(r.repo, r.base, r.head, ['src/billing.ts'], 60_000, 'definitions');
  assert.match(out, /### src\/billing\.ts:45-51 · definition of `this\.chargeCustomer`, which the PR calls/);
  assert.match(out, /BODY_MARKER/);
});

test('an indented member on one line ends on its line; a block ends at its closing bracket', () => {
  const lines = ['const handlers = {', '  double: (a: number) => a * 2,', '  async save(row: { id: string }) {', "    const sql = 'select { from';", '    return row.id;', '  },', '  next: 1,', '};'];
  assert.equal(declarationEnd(lines, 2, 60), 2);
  assert.equal(declarationEnd(lines, 3, 60), 6, 'a bracket in a string does not count');
  assert.equal(declarationEnd(lines, 1, 60), 8);
});

test('a declaration whose first lines are in the diff, and not its body, stays in the context', () => {
  const file = ['export function caller() {', '  return helper();', '}', '', 'function helper() {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}', ''].join('\n');
  const r = repoWith({ 'src/a.ts': file.replace('return helper();', 'return 0;') }, { 'src/a.ts': file });
  // The diff that the pack shows holds lines 1 to 5: the head of `helper`, not its body.
  const shown = new Map([['src/a.ts', '@@ -1,5 +1,5 @@\n']]);
  assert.match(buildContext(r.repo, r.base, r.head, ['src/a.ts'], 60_000, 'definitions', shown), /### src\/a\.ts:5-9 · definition of `helper`/);
  // Shown whole, it is left out.
  const whole = new Map([['src/a.ts', '@@ -1,10 +1,10 @@\n']]);
  assert.doesNotMatch(buildContext(r.repo, r.base, r.head, ['src/a.ts'], 60_000, 'definitions', whole), /definition of `helper`/);
});

const invoicesSchema = "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const invoices = pgTable('invoices', {\n  id: text('id').notNull(),\n});\n";

test('E3: double-quoted imports and words of comments do not push a table of the migration out', () => {
  const imports = Array.from({ length: 45 }, (_, i) => `import { x${i} } from "pkg${i}";`).join('\n');
  const r = repoWith(
    { 'src/a.ts': 'export const a = 1;\n', 'db/schema.ts': invoicesSchema, 'migrations/0001.sql': 'CREATE TABLE invoices (id text NOT NULL);\n' },
    { 'src/a.ts': `${imports}\n// update state from cache\nexport const a = 1;\n`, 'migrations/0002.sql': 'ALTER TABLE invoices ADD COLUMN paid_at timestamptz;\n' },
  );
  assert.match(buildContext(r.repo, r.base, r.head, ['src/a.ts', 'migrations/0002.sql'], 60_000, 'definitions'), /db\/schema\.ts:\d+-\d+ · table `invoices`/);
});

test('E4: a table that two apps declare resolves to the schema and the migration of the app of the change', () => {
  const schema = (col: string) => `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', {\n  id: text('id'),\n  ${col}: text('${col}'),\n});\n`;
  const code = (body: string) => `import { sql } from './db';\nexport async function f(id: string) {\n  ${body}\n}\n`;
  const r = repoWith(
    {
      'apps/admin/db/schema.ts': schema('admin_only'),
      'apps/web/db/schema.ts': schema('web_only'),
      'apps/web/db.ts': 'export const sql = 1;\n',
      'apps/web/q.ts': code('return id;'),
      'apps/admin/migrations/0001.sql': 'CREATE TABLE users (id text, admin_only text);\n',
      'apps/web/migrations/0001.sql': 'CREATE TABLE users (id text, web_only text NOT NULL);\n',
    },
    { 'apps/web/q.ts': code('return sql`select * from users where id = ${id}`;') },
  );
  const out = buildContext(r.repo, r.base, r.head, ['apps/web/q.ts'], 60_000, 'definitions');
  assert.match(out, /### apps\/web\/db\/schema\.ts:\d+-\d+ · table `users`/);
  assert.match(out, /### apps\/web\/migrations\/0001\.sql:1-1 · migration that creates the table `users`/);
  assert.doesNotMatch(out, /apps\/admin/);
});

test('migrations go by their numbers, and a middle one that alters a column that the PR uses comes too', () => {
  const r = repoWith(
    {
      'src/pay.ts': 'export const pay = 1;\n',
      'migrations/1_init.sql': 'CREATE TABLE invoices (id text, paid_at timestamptz);\n',
      'migrations/2_paid.sql': 'ALTER TABLE invoices ALTER COLUMN paid_at SET NOT NULL;\n',
      'migrations/10_label.sql': 'ALTER TABLE invoices ADD COLUMN label text;\n',
      'migrations/3_other.sql': 'ALTER TABLE invoices ADD COLUMN note text;\n',
    },
    { 'src/pay.ts': 'export const pay = (sql: any, id: string) => sql`update invoices set paid_at = now() where id = ${id}`;\n' },
  );
  const out = buildContext(r.repo, r.base, r.head, ['src/pay.ts'], 60_000, 'definitions');
  assert.match(out, /### migrations\/10_label\.sql:1-1 · last migration that alters the table `invoices`/);
  assert.match(out, /### migrations\/2_paid\.sql:1-1 · migration that alters a column of `invoices` that the PR uses/);
  assert.doesNotMatch(out, /3_other/, 'a migration on another column stays out');
});

test('E6/E7: `this.send` reads the method of its own class; a method of a package type gets no body of the repository', () => {
  const file = (call: string) =>
    ["import amqp from 'amqplib';", 'export class Mailer {', '  send(to: string) {', "    return 'MAILER_SEND';", '  }', '}', comments(30), 'export class Queue {', '  send(job: string) {', "    return 'QUEUE_SEND';", '  }', '  async run(channel: amqp.Channel) {', `    ${call}`, '  }', '}', ''].join('\n');
  const r = repoWith(
    { 'src/q.ts': file('return 1;'), 'src/events.ts': "export class Bus {\n  publish(topic: string) {\n    return 'OWN_BUS_PUBLISH';\n  }\n}\n" },
    { 'src/q.ts': file("this.send('x'); channel.publish('ex', 'k', Buffer.from('m'));") },
  );
  const out = buildContext(r.repo, r.base, r.head, ['src/q.ts'], 60_000, 'definitions');
  assert.match(out, /QUEUE_SEND/);
  assert.doesNotMatch(out, /MAILER_SEND/);
  assert.doesNotMatch(out, /OWN_BUS_PUBLISH/);
});

test('a method of an object of unknown type, which one file declares, comes labelled as such', () => {
  const r = repoWith(
    { 'src/run.ts': 'export function run(bus: any) {\n  return 1;\n}\n', 'src/events.ts': "export class Bus {\n  publishEvent(topic: string) {\n    return 'OWN_BUS_PUBLISH';\n  }\n}\n" },
    { 'src/run.ts': "export function run(bus: any) {\n  return bus.publishEvent('x');\n}\n" },
  );
  assert.match(buildContext(r.repo, r.base, r.head, ['src/run.ts'], 60_000, 'definitions'), /### src\/events\.ts:2-4 · the one method `publishEvent` of the repository, which `bus\.publishEvent` may call \(its type is unknown\)/);
});

test('on a large pull request, the context keeps its room: the diff gives up a file for the definition', () => {
  // About 234 kB of diff: it fits in the budget of the pack, and leaves the context less room than
  // the definition of `settle` needs.
  const rows: string[] = [];
  while (rows.join('\n').length < 233_000) rows.push(`export const row${rows.length} = 'the row ${rows.length} of the large table of the invoices, with its total, its tax, its date and its label, as the billing page shows them to the owner of the organization, and as the export to the accountant writes them';`);
  assert.ok(rows.length < 1000);
  const big = rows.join('\n');
  const helper = ['export function pay(id: string) {', '  return settle(id);', '}', '', ...Array.from({ length: 40 }, (_, i) => `// note ${i}`), 'function settle(id: string) {', ...Array.from({ length: 55 }, (_, i) => `  const step${i} = id.length + ${i}; // the step ${i} of the settlement of an invoice`), '  return id;', '}', ''].join('\n');
  const r = repoWith({ 'src/pay.ts': helper.replace('return settle(id);', 'return id;') }, { 'src/pay.ts': helper, 'src/big.ts': `${big}\n` });
  const { pack, skipped } = buildPack(r.repo, r.base, r.head, 'definitions');
  assert.ok(skipped.includes('src/big.ts: removed to fit in the maximum size of the review'), skipped.join('\n'));
  assert.match(pack, /### src\/pay\.ts:\d+-\d+ · definition of `settle`, which the PR calls/);
});
