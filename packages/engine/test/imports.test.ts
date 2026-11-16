import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { reviewPullRequest, type Answer, type Finding } from '../src/index.ts';
import { buildPack } from '../src/pack.ts';
import { checkMissingNames, importStatements } from '../src/imports.ts';

// REV-70. The replay of gallery-app#13 at c85aa470: `app/routes/regie/account.tsx` imports `data` on
// line 3, far from the hunks of the pull request. The diff showed a hunk of the imports (line 19) and
// the new branch of the action that calls `data(...)`. Kentō reported « `data` utilisé sans import »
// as a P1, and the score went from 4/5 to 2/5.

const PATH = 'app/routes/regie/account.tsx';
let repo = '';
let base = '';
let head = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

const IMPORTS = [
  'import { asc, desc, eq, sql } from "drizzle-orm";',
  'import { useState } from "react";',
  'import { data, Form, useActionData, useNavigation, useSearchParams } from "react-router";',
  'import { IconEye } from "~/components/icons";',
  'import {',
  '  Avatar,',
  '  Breadcrumbs,',
  '  Button,',
  '} from "~/components/ui";',
  'import { db } from "~/db/client.server";',
  'import { adminNote, auditLog, studio, user } from "~/db/schema";',
  'import { audit } from "~/lib/accounts.server";',
  'import { authPost, redirectWithCookies } from "~/lib/auth-call.server";',
  'import { env } from "~/lib/env.server";',
  'import { dayMonthYear, formatBytes } from "~/lib/format";',
  'import { galleryAdminStatus } from "~/lib/gallery-status";',
  'import { notifyStudio } from "~/lib/notify.server";',
  'import { can } from "~/lib/permissions";',
  'import { changePlan, remindNow } from "~/lib/regie-actions.server";',
  'import { requireStaff } from "~/lib/session.server";',
  'import type { Route } from "./+types/account";',
];

/** The file: its imports, then filler functions, so that a hunk at its end is far from line 3. */
function account(importLine19: string, action: string[]): string {
  const imports = [...IMPORTS];
  imports[18] = importLine19;
  const filler = Array.from({ length: 40 }, (_, i) => `export function helper${i}() {\n  return ${i};\n}\n`);
  return [...imports, '', ...filler, 'export async function action({ request }: Route.ActionArgs) {', ...action, '}', ''].join('\n');
}

const ACTION_BEFORE = ['  const form = await request.formData();', '  return changePlan(String(form.get("plan")));'];
const ACTION_AFTER = [
  '  const form = await request.formData();',
  '  const result = await changePlan(String(form.get("plan")));',
  '  if (result === "refused") throw data("Droit insuffisant", { status: 403 });',
  '  if (result === "missing") throw json({ error: "missing" });',
  '  return result;',
];

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-imports-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(join(repo, 'app', 'routes', 'regie'), { recursive: true });
  writeFileSync(join(repo, PATH), account(IMPORTS[18]!, ACTION_BEFORE));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  writeFileSync(join(repo, PATH), account('import { changePlan, remindNow, requestDeletion } from "~/lib/regie-actions.server";', ACTION_AFTER));
  git('commit', '-q', '-am', 'fix(regie): bulk actions keep to role rights');
  head = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const lineOf = (text: string) => account('import { changePlan, remindNow, requestDeletion } from "~/lib/regie-actions.server";', ACTION_AFTER).split('\n').findIndex((l) => l.includes(text)) + 1;

const finding = (over: Partial<Finding>): Finding => ({
  path: PATH,
  start_line: lineOf('throw data('),
  line: lineOf('throw data('),
  severity: 'major',
  category: 'bug',
  confidence: 90,
  title: '`data` utilisé sans import dans account.tsx',
  scenario:
    "Le diff de account.tsx importe depuis plan-change et regie-actions mais pas `data` de react-router. Quand le rôle n'a pas le droit entier, l'appel `data(...)` lève une ReferenceError, d'où un 500 au lieu du 403 attendu.",
  fix: 'Ajouter `import { data } from "react-router";` dans account.tsx.',
  suggestion: '',
  ...over,
});

const answer = (findings: Finding[], score = 2): Answer => ({
  confidence_score: score,
  risk: 'Risque',
  summary: 'Résumé',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

/** A model that answers as OpenRouter with this answer, and records the pack it reads. */
function fakeModel(reply: Answer) {
  const packs: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    packs.push(body.messages[1].content);
    const content = JSON.stringify(reply);
    return new Response(JSON.stringify({ model: body.model, provider: 'Fake', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }));
  }) as typeof globalThis.fetch;
  return { fetch, packs };
}

test('gallery-app#13: the pack shows the imports of the file, line 3 included, though no hunk holds it', async () => {
  const { fetch } = fakeModel(answer([]));
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: () => {} });
  const diff = /## Diff\n([\s\S]*?)\n```\n/.exec(result.pack)![1]!;
  assert.doesNotMatch(diff, /import \{ data,/, 'the diff alone does not show line 3');
  assert.match(diff, /\+import \{ changePlan, remindNow, requestDeletion \}/, 'the diff shows the hunk of line 19');
  const imports = /## Imports\n([\s\S]*?)(\n## |$)/.exec(result.pack)?.[1] ?? '';
  assert.match(imports, /### app\/routes\/regie\/account\.tsx/);
  assert.match(imports, /\n3\| import \{ data, Form, useActionData, useNavigation, useSearchParams \} from "react-router";\n/);
  // A statement on several lines comes whole, each line with its number.
  assert.match(imports, /\n5\| import \{\n6\|   Avatar,\n7\|   Breadcrumbs,\n8\|   Button,\n9\| \} from "~\/components\/ui";\n/);
});

test('gallery-app#13: a P1 « `data` utilisé sans import » goes away, and no longer caps the score at 2', async () => {
  // The model scores 4/5, as on gallery-app#13 before the false P1. Without the check, the P1 blocks and caps the score at 2.
  const { fetch } = fakeModel(answer([finding({})], 4));
  const logs: string[] = [];
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: (m) => logs.push(m) });
  assert.deepEqual(result.findings, []);
  assert.equal(result.score, 4);
  assert.notEqual(result.verdict, 'REQUEST_CHANGES');
  assert.deepEqual(result.answer.not_reviewed, []);
  assert.match(logs.join('\n'), /finding dropped, its file at the head holds the name: app\/routes\/regie\/account\.tsx: `data` utilisé sans import/);
});

test('a name that the file does not import stays a blocking finding', async () => {
  const missing = finding({ line: lineOf('throw json('), start_line: lineOf('throw json('), title: '`json` utilisé sans import', scenario: "`json` n'est importé nulle part." });
  const { fetch } = fakeModel(answer([missing], 2));
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: () => {} });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.blocking, true);
  assert.equal(result.score, 2);
  assert.equal(result.verdict, 'REQUEST_CHANGES');
});

test('gallery-app#12: `and` and `isNull` imported on line 1 refute « peut-être non importés »', () => {
  const lines = ['import { and, eq, isNull } from "drizzle-orm";', 'export const where = and(eq(a, b), isNull(c));'];
  const reply = answer([finding({ path: 'team.tsx', title: '`and` et `isNull` peut-être non importés' })], 3);
  const { refuted, unchecked } = checkMissingNames(reply, () => lines);
  assert.equal(refuted.length, 1);
  assert.equal(unchecked.length, 0);
  assert.deepEqual(reply.findings, []);
  assert.equal(reply.confidence_score, 3, 'the check never changes the score of the model');
});

test('a finding that the engine cannot check goes to « Not reviewed »', () => {
  // No name in backquotes: the engine cannot tell which name the finding means.
  const reply = answer([finding({ title: 'Fonction utilisée sans import', scenario: 'La route appelle une fonction que le diff ne montre pas importée.' }), finding({ severity: 'minor', title: 'Libellé en dur', line: 1 })], 3);
  const { unchecked } = checkMissingNames(reply, () => ['export const x = 1;']);
  assert.equal(unchecked.length, 1);
  assert.deepEqual(reply.findings.map((f) => f.title), ['Libellé en dur']);
  assert.deepEqual(reply.not_reviewed, [`${PATH}: Fonction utilisée sans import. Kentō could not check it in the file at the head.`]);
  assert.equal(reply.confidence_score, 3, 'the check never changes the score of the model');
});

test('the check leaves alone the other findings, an import under another name, and a major finding left', () => {
  const lines = ['import { data as payload } from "react-router";', 'const helper = () => 1;', 'export function loadStudio() {}'];
  const reply = answer(
    [
      // `import { data as payload }` imports `payload`, not `data`: the finding stays.
      finding({ title: '`data` utilisé sans import' }),
      // A declaration does not refute: it can sit in another scope, or come after the use.
      finding({ title: '`helper` non défini dans la route' }),
      // An import as a value refutes.
      finding({ title: '`payload` non défini' }),
      // A finding that only quotes a message is not a claim about a name.
      finding({ title: '`loadStudio` renvoie 500 au lieu de 404', scenario: '« Compte introuvable » sans import de rien.' }),
    ],
    2,
  );
  const { refuted } = checkMissingNames(reply, () => lines);
  assert.deepEqual(refuted.map((f) => f.title), ['`payload` non défini']);
  assert.deepEqual(reply.findings.map((f) => f.title), ['`data` utilisé sans import', '`helper` non défini dans la route', '`loadStudio` renvoie 500 au lieu de 404']);
  // The module string binds no name: `from "react-router"` and `import "./side.css"` import no `react` and no `side`.
  for (const title of ['`react` non importé', '`router` non importé', '`side` non importé', '`import` non défini']) {
    const one = answer([finding({ title })], 2);
    checkMissingNames(one, () => ['import { data } from "react-router";', 'import "./side.css";', 'from react import side_effects']);
    assert.equal(one.findings.length, 1, `${title} stays`);
  }
  // A type is no value: `data(...)` still fails at run time, so these findings stay.
  for (const file of [['import type { data } from "x";'], ['import { type data } from "x";'], ['type data = string;'], ['export interface data {}']]) {
    const one = answer([finding({ title: '`data` non défini' })], 2);
    checkMissingNames(one, () => file);
    assert.equal(one.findings.length, 1, `${file[0]} does not refute`);
  }
  // The names of the scenario do not count: the title names none, so the finding goes to « Not reviewed ».
  const vague = answer([finding({ title: 'Fonction utilisée sans import', scenario: 'La route appelle `data` puis `json`.' })], 2);
  const { unchecked } = checkMissingNames(vague, () => ['import { data, json } from "react-router";']);
  assert.equal(unchecked.length, 1);
  assert.deepEqual(vague.findings, []);
  const python = answer([finding({ title: '`name` non importé' })], 2);
  checkMissingNames(python, () => ['from pkg.mod import name']);
  assert.deepEqual(python.findings, [], 'a Python import binds its name');
  const multi = answer([finding({ title: '`b` non importé' })], 2);
  checkMissingNames(multi, () => ['from pkg import (', '    a,', '    b,', ')']);
  assert.deepEqual(multi.findings, [], 'a Python import between parentheses binds each name');
});

test('importStatements reads JS, TS and Python imports, on one line or several', () => {
  const text = ['"use client";', 'import x from "x";', 'import type {', '  A,', '} from "./a";', "import './side.css';", 'from pkg.mod import name', 'const later = import("lazy");', 'from pkg import (', '    a,', ')'].join('\n');
  assert.deepEqual(
    importStatements(text).map((s) => s.line),
    [2, 3, 6, 7, 9],
  );
  assert.equal(importStatements(text).at(-1)!.text, 'from pkg import (\n    a,\n)');
});

test('a changed file whose path is not ASCII gets its imports too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-imports-path-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    const path = 'app/routes/équipe.tsx';
    mkdirSync(join(dir, 'app', 'routes'), { recursive: true });
    writeFileSync(join(dir, path), 'import { and, isNull } from "drizzle-orm";\n\nexport const a = 1;\n');
    run('add', '.');
    run('commit', '-q', '-m', 'base');
    const from = run('rev-parse', 'HEAD');
    writeFileSync(join(dir, path), 'import { and, isNull } from "drizzle-orm";\n\nexport const a = 2;\n');
    run('commit', '-q', '-am', 'change');
    const { pack } = buildPack(dir, from, run('rev-parse', 'HEAD'), 'definitions');
    assert.match(pack, /## Imports\n[\s\S]*### app\/routes\/équipe\.tsx\n\n```\n1\| import \{ and, isNull \} from "drizzle-orm";/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
