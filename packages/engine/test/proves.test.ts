import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { earlierFindingsSection, MAX_EARLIER_BYTES } from '../src/earlier.ts';
import { buildPack, MAX_TEST_HUNK_BYTES } from '../src/pack.ts';
import type { EarlierFinding } from '../../protocol/src/index.ts';

// KNT-156. A review reads a test for what it proves: the whole test of a changed test file, the
// question "which change makes this assertion fail", and the neighbour cases of a fix.

let repo = '';
let base = '';
let head = '';
let fixHead = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

// A test that asserts the absence of an element after the code replaced the page: the assertion
// sits 20 lines above the changed line.
const pageTest = (wait: string) =>
  [
    "import { test, expect } from './fixture.ts';",
    '',
    "test('saving shows no error toast', async ({ page }) => {",
    "  await page.goto('/settings');",
    "  await page.fill('#name', 'acme');",
    "  await page.click('text=Save');",
    "  await expect(page.locator('.toast-error')).toHaveCount(0);",
    ...Array.from({ length: 20 }, (_, i) => `  // step ${i + 1} of the journey`),
    `  ${wait}`,
    '});',
    '',
  ].join('\n');

// A file of long tests: its whole tests pass the limit of the pack.
const longTests = (marker: string) =>
  [
    "test('a long table', () => {",
    ...Array.from({ length: Math.ceil(MAX_TEST_HUNK_BYTES / 40) + 50 }, (_, i) => `  expect(row(${i})).toEqual([${i}, ${i * 2}]);`),
    `  expect(${marker}).toBe(true);`,
    '});',
    '',
  ].join('\n');

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-proves-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('e2e/settings.spec.ts', pageTest("await page.waitForURL('/settings');"));
  write('test/table.test.ts', longTests('before'));
  write('src/names.ts', 'export function names(list: string[]) {\n  return list;\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write('e2e/settings.spec.ts', pageTest("await page.waitForURL('/home');"));
  write('test/table.test.ts', longTests('after'));
  write('src/names.ts', 'export function names(list: string[]) {\n  return list.slice(0, 1);\n}\n');
  git('commit', '-q', '-am', 'test: saving goes home');
  head = git('rev-parse', 'HEAD');
  write('src/names.ts', 'export function names(list: string[]) {\n  return list.slice(-1);\n}\n');
  git('commit', '-q', '-am', 'fix: keep the last name');
  fixHead = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('a changed test shows its whole test, with the assertion far from the change', () => {
  const { pack } = buildPack(repo, base, head, 'definitions');
  assert.match(pack, / {2}await expect\(page\.locator\('\.toast-error'\)\)\.toHaveCount\(0\);/, 'the assertion 20 lines above the change');
  assert.match(pack, /\+ {2}await page\.waitForURL\('\/home'\);/);
  assert.match(pack, /the whole test for a test file/);
});

test('a test file whose whole tests pass the limit shows three lines of context', () => {
  const { pack } = buildPack(repo, base, head, 'definitions');
  const table = pack.slice(pack.indexOf('test/table.test.ts'), pack.indexOf('diff --git', pack.indexOf('test/table.test.ts')));
  assert.match(table, /\+ {2}expect\(after\)\.toBe\(true\);/);
  assert.doesNotMatch(table, /expect\(row\(0\)\)/, 'the start of the long test is out of the pack');
  assert.ok(table.length < MAX_TEST_HUNK_BYTES);
});

const earlier = (status: EarlierFinding['status'], commit: string): EarlierFinding => ({
  key: 'f'.repeat(12),
  path: 'src/names.ts',
  line: 2,
  title: 'The first name is dropped when the list has two names',
  severity: 'major',
  category: 'bug',
  status,
  reason: null,
  commit,
});

test('the section of earlier findings asks to probe the neighbour cases of a fix', () => {
  const { section } = earlierFindingsSection(repo, fixHead, [earlier('fixed', head)]);
  assert.match(section, /E1 was fixed by a later commit\. Read each fix in the diff, and check the cases next to it that the fix can break/);
  assert.match(section, /a type and a value of the same name, an import and a local name, the first and the last definition, an empty value and a missing one/);
  // No fix since: no probe.
  assert.doesNotMatch(earlierFindingsSection(repo, fixHead, [earlier('open', head)]).section, /was fixed by a later commit/);
  assert.doesNotMatch(earlierFindingsSection(repo, fixHead, [earlier('fixed', fixHead)]).section, /was fixed by a later commit/, 'the file did not change since');
});

test('the prompt asks which change of the code makes an assertion fail, apart from "no test"', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'prompts', 'review.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /- tests: new non-trivial logic with no test, only if the repository has tests\. - what a test proves:/);
  assert.match(text, /name the change of the code under test that makes its assertion fail/);
  assert.match(text, /name the test that fails when it goes/);
  assert.match(text, /A checker or a lint rule that misses a form of its target/);
});

test('the note of the neighbour cases fits in the size of the section', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ ...earlier('fixed', head), key: `${i}`.padStart(12, '0'), title: `${'A long title of a fixed finding, '.repeat(6)}${i}` }));
  const { section, held } = earlierFindingsSection(repo, fixHead, many);
  // The rows and the note count in MAX_EARLIER_BYTES; the fixed text of the intro does not.
  const body = section.slice(section.indexOf('- E1 '));
  assert.ok(body.length <= MAX_EARLIER_BYTES + 2, `${body.length} bytes`);
  assert.match(section, /E1, E2, E3, E4, E5, E6, E7, E8, E9, E10 and \d+ more were fixed by a later commit/);
  assert.ok(held.length > 10);
});

test('over the budget, whole tests go back to three lines of context before a test file is dropped', () => {
  // Five test files of about 35 kB of whole tests each, the largest files, and four sources of about
  // 20 kB of diff: 255 kB pass the budget of the pack.
  const big = mkdtempSync(join(tmpdir(), 'engine-proves-budget-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: big, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  const tests = (marker: string) => ["test('a table', () => {", ...Array.from({ length: 1100 }, (_, i) => `  expect(row(${i})).toEqual([${i}]);`), `  expect(${marker}).toBe(true);`, '});', ''].join('\n');
  const source = (n: number) => Array.from({ length: 450 }, (_, i) => `export const v${i} = ${n + i};`).join('\n');
  mkdirSync(join(big, 'test'));
  for (let i = 0; i < 5; i++) writeFileSync(join(big, `test/t${i}.test.ts`), tests('before'));
  for (let i = 0; i < 4; i++) writeFileSync(join(big, `s${i}.ts`), source(0));
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const from = g('rev-parse', 'HEAD');
  for (let i = 0; i < 5; i++) writeFileSync(join(big, `test/t${i}.test.ts`), tests('after'));
  for (let i = 0; i < 4; i++) writeFileSync(join(big, `s${i}.ts`), source(1));
  g('commit', '-q', '-am', 'change');
  const to = g('rev-parse', 'HEAD');
  try {
    const { pack, skipped } = buildPack(big, from, to, 'definitions');
    assert.deepEqual(skipped.filter((s) => s.startsWith('test/')), [], 'no test file is dropped');
    for (let i = 0; i < 5; i++) assert.match(pack, new RegExp(`test/t${i}\\.test\\.ts`));
    assert.match(pack, /\+ {2}expect\(after\)\.toBe\(true\);/);
  } finally {
    rmSync(big, { recursive: true, force: true });
  }
});
