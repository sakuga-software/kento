import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { changedLines, hunkLines, isPlaceholder, MAX_PATCH_LINES, shownPatch, suggestionRange, type Finding, type HunkLines } from '../src/findings.ts';
import { reviewPullRequest, type Answer } from '../src/index.ts';

let repo = '';
let base = '';
let head = '';

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const file = (changed: Record<number, string>) =>
  Array.from({ length: 20 }, (_, i) => changed[i + 1] ?? `  const v${i + 1} = ${i + 1};`).join('\n') + '\n';

// The pull request changes lines 10 and 18. With 3 lines of context, line 14 is in no hunk.
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'suggestion-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.ts'), file({}));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.ts'), file({ 10: '  const v10 = 100;', 18: '  const v18 = 180;' }));
  git('commit', '-q', '-am', 'change');
  head = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: 'a.ts',
  start_line: 10,
  line: 10,
  severity: 'major',
  category: 'bug',
  confidence: 90,
  title: 'The value overflows',
  scenario: 's',
  fix: 'f',
  suggestion: '  const v10 = 10;',
  ...overrides,
});

test('the hunks hold the changed lines and 3 context lines around each change (REV-104)', () => {
  assert.deepEqual([...changedLines(repo, base, head).get('a.ts')!], [10, 18]);
  assert.deepEqual([...hunkLines(repo, base, head).get('a.ts')!], [7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20]);
});

test('a suggestion can start on a context line of the hunk of its line, never outside the hunk (REV-104)', () => {
  const hunks = hunkLines(repo, base, head);
  assert.deepEqual(suggestionRange(finding({ start_line: 8 }), hunks), [8, 10]);
  assert.deepEqual(suggestionRange(finding({ start_line: 7 }), hunks), [7, 10]);
  assert.equal(suggestionRange(finding({ start_line: 6 }), hunks), null, 'line 6 is in no hunk');
  assert.equal(suggestionRange(finding({ start_line: 13, line: 18 }), hunks), null, 'line 14 is between two hunks');
  assert.equal(suggestionRange(finding({ start_line: 8, suggestion: ' ' }), hunks), null);
});

test('a patch shows up to its limit of lines, without its fence, and never with a fence inside', () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -10 +10 @@\n-  const v10 = 100;\n+  const v10 = 10;';
  assert.equal(shownPatch(finding({ patch: diff })), diff);
  assert.equal(shownPatch(finding({ patch: `\`\`\`diff\n${diff}\n\`\`\`\n` })), diff);
  assert.equal(shownPatch(finding({ patch: Array.from({ length: MAX_PATCH_LINES }, () => '+x').join('\n') }))?.split('\n').length, MAX_PATCH_LINES);
  assert.equal(shownPatch(finding({ patch: Array.from({ length: MAX_PATCH_LINES + 1 }, () => '+x').join('\n') })), null);
  assert.equal(shownPatch(finding({ patch: `${diff}\n+ \`\`\`md\n+ x` })), null);
  assert.equal(shownPatch(finding({ patch: '  \n' })), null);
  assert.equal(shownPatch(finding()), null);
});

test('a patch shows only when it reads as a unified diff (KNT-159)', () => {
  for (const text of ['follows', 'none', 'E1', 'The fix is in the next function.', '@@', '--- a/a.ts\n+++ b/a.ts', ' context only']) {
    assert.equal(shownPatch(finding({ patch: text })), null, text);
  }
  assert.equal(shownPatch(finding({ patch: '-  return true;\n+  return exp > now;' })), '-  return true;\n+  return exp > now;');
  const blank = '@@ -3,3 +3,3 @@\n a();\n\n-b();\n+c();\n\\ No newline at end of file';
  assert.equal(shownPatch(finding({ patch: blank })), blank, 'an empty context line and the no-newline mark stay');
  // A git header before the first hunk; `\r\n` line ends.
  const git = 'diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y';
  assert.equal(shownPatch(finding({ patch: git })), git);
  const created = 'diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+export const n = 1;';
  assert.equal(shownPatch(finding({ patch: created })), created);
  const renamed = 'diff --git a/o.ts b/p.ts\nsimilarity index 90%\nrename from o.ts\nrename to p.ts\n@@ -1 +1 @@\n-a\n+b';
  assert.equal(shownPatch(finding({ patch: renamed })), renamed);
  assert.equal(shownPatch(finding({ patch: '-x\r\n+y\r\n' })), '-x\n+y');
  // After a hunk, `--- note` is a removed SQL comment, not a header.
  assert.equal(shownPatch(finding({ patch: '@@ -4,2 +4,1 @@\n select 1;\n--- note' })), '@@ -4,2 +4,1 @@\n select 1;\n--- note');
  assert.equal(shownPatch(finding({ patch: 'index 1111111..2222222 100644' })), null, 'a header alone');
  assert.equal(shownPatch(finding({ patch: '@@ -1 +1 @@\nindex 1..2' })), null, 'a git header after a hunk is not a diff line');
  // An added or removed placeholder is not a fix.
  for (const text of ['+follows', '- none', '+E1', '@@ -1 +1 @@\n-follows\n+"none".']) assert.equal(shownPatch(finding({ patch: text })), null, text);
});

test('a placeholder in `suggestion` gives no applicable suggestion (KNT-159)', () => {
  const hunks: HunkLines = new Map([['src/a.ts', new Set([8, 9, 10])]]);
  const at = (suggestion: string) => suggestionRange(finding({ path: 'src/a.ts', start_line: 10, line: 10, suggestion }), hunks);
  for (const text of ['follows', ' n/a ', '"follows"', 'E2', 'Not applicable.']) assert.equal(at(text), null, text);
  assert.deepEqual(at('  return a + b;'), [10, 10]);
  // A word that can be a line of code stays a suggestion: `...` is a statement in Python.
  for (const text of ['    null', 'None', '  -', '    ...']) assert.deepEqual(at(text), [10, 10], text);
  assert.deepEqual(at('  none: true,'), [10, 10], 'code that holds the word stays');
  assert.equal(isPlaceholder('follows'), true);
  assert.equal(isPlaceholder('return null;'), false);
});

test('the review keeps a patch only for a finding without an applicable suggestion (REV-104)', async () => {
  const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -18 +18 @@\n-  const v18 = 180;\n+  const v18 = 18;';
  const answer: Answer = {
    confidence_score: 3,
    risk: 'r',
    summary: 's',
    diagram: '',
    findings: [
      finding({ title: 'Suggestion on the context', start_line: 8, suggestion: '  const v8 = 8;\n  const v9 = 9;\n  const v10 = 10;', patch }),
      finding({ title: 'Fix as a diff', start_line: 18, line: 18, suggestion: '', patch }),
      finding({ title: 'Diff trop long', start_line: 18, line: 18, suggestion: '', patch: Array.from({ length: MAX_PATCH_LINES + 1 }, () => '+x').join('\n') }),
    ],
    not_reviewed: [],
    deeper_review: { recommended: false, reason: '' },
  };
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch: answering(answer), log: () => {} });
  const [onContext, withPatch, tooLong] = result.findings;
  assert.deepEqual([onContext.anchor, onContext.suggestion_range, 'patch' in onContext], [10, [8, 10], false]);
  assert.deepEqual([withPatch.suggestion_range, withPatch.patch], [null, patch]);
  assert.equal('patch' in tooLong, false);
  assert.deepEqual([...result.hunks.get('a.ts')!].length, 13);
});

test('only the levels with `patch` ask for a patch, in the prompt and in the schema (REV-104)', async () => {
  const answer: Answer = { confidence_score: 4, risk: 'r', summary: 's', diagram: '', findings: [], not_reviewed: [], deeper_review: { recommended: false, reason: '' } };
  for (const [level, asked] of [['lite', false], ['balanced', true], ['heavy', true]] as const) {
    const bodies: { messages: { content: string }[]; response_format: unknown }[] = [];
    await reviewPullRequest({ repoDir: repo, base, head, level, apiKey: 'k', fetch: answering(answer, bodies), log: () => {} });
    const [body] = bodies;
    assert.equal(/"patch":\{"type":"string"\}/.test(JSON.stringify(body!.response_format)), asked, `schema at ${level}`);
    assert.equal(body!.messages[0]!.content.includes('# Patch'), asked, `prompt at ${level}`);
  }
});

function answering(answer: Answer, bodies: unknown[] = []): typeof globalThis.fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
}

test('a long run of spaces or quotes from the model is read in linear time (KNT-159, CodeQL)', () => {
  const started = performance.now();
  assert.equal(shownPatch(finding({ patch: `-a\n+${' '.repeat(100_000)}b` }))?.length, 100_005);
  assert.equal(shownPatch(finding({ patch: `${' '.repeat(100_000)}\n` })), null);
  assert.equal(isPlaceholder(`${'"'.repeat(100_000)}x`), false);
  assert.equal(isPlaceholder(`"${'.'.repeat(30)}follows`), false);
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
});
