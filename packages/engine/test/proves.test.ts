import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { earlierFindingsSection, isNewDefect, linkEarlier, MAX_EARLIER_BYTES } from '../src/earlier.ts';
import { findingKey, type Answer, type Finding } from '../src/findings.ts';
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

const NOTE = /changed since the last review that reported/;

test('the section of earlier findings asks to probe the neighbour cases of a fix', () => {
  // The review that can see the fix: the finding is still open, and its file changed since.
  const { section } = earlierFindingsSection(repo, fixHead, [earlier('open', head)]);
  const flat = section.replace(/\s+/g, ' ');
  assert.match(flat, /The file of E1 changed since the last review that reported it\. When the code at the head no longer has that defect, read the code at the head near its line, and check the cases next to the fix that the fix can break/);
  assert.match(flat, /a type and a value of the same name, an import and a local name, the first and the last definition, an empty value and a missing one/);
  assert.doesNotMatch(flat, /in the diff/, 'the diff of the pack does not show a fix as such');
  // The file did not change since: no probe.
  assert.doesNotMatch(earlierFindingsSection(repo, fixHead, [earlier('open', fixHead)]).section, NOTE);
  // A finding already `fixed`: an earlier review saw the fix, and the note does not come back.
  assert.doesNotMatch(earlierFindingsSection(repo, fixHead, [earlier('fixed', head)]).section, NOTE);
});

test('the note names an open finding whose commit is not in the history (after a force push)', () => {
  const { section, held } = earlierFindingsSection(repo, fixHead, [earlier('open', 'f'.repeat(40))]);
  assert.equal(held[0]!.changed, null);
  assert.match(section, /The file of E1 changed since/);
});

test('the net links a finding near a fixed finding only on its key: a case that the fix broke is a new defect', () => {
  const near: Finding = {
    path: 'src/config.ts',
    start_line: 11,
    line: 11,
    severity: 'major',
    category: 'bug',
    confidence: 90,
    title: 'The fix of the duplicate Config declaration drops the value Config',
    scenario: 'The scenario.',
    fix: 'The fix.',
    suggestion: '',
  };
  const fixedOne = (status: EarlierFinding['status']) => ({
    key: 'a'.repeat(12),
    path: 'src/config.ts',
    line: 10,
    title: 'Duplicate declaration of Config keeps only the first one',
    severity: 'major' as const,
    category: 'bug' as const,
    status,
    reason: null,
    commit: head,
    ref: 'E1',
    changed: true,
  });
  const answer = (): Answer & { findings: Finding[] } => ({ confidence_score: 5, risk: '', summary: '', diagram: '', findings: [{ ...near }], not_reviewed: [], deeper_review: { recommended: false, reason: '' } });
  const fixed = answer();
  const out = linkEarlier(fixed, [fixedOne('fixed')], () => 11);
  assert.equal(out.byNet, 0);
  assert.equal(fixed.findings[0]!.follows, undefined);
  assert.equal(isNewDefect(fixed.findings[0]!, [fixedOne('fixed')]), true);
  // The same words near an open finding: the net still links them.
  const open = answer();
  assert.equal(linkEarlier(open, [fixedOne('open')], () => 11).byNet, 1);
  // A fixed finding with its very key is that defect back.
  const back = answer();
  back.findings[0] = { ...near, title: 'Duplicate declaration of Config keeps only the first one', line: 10 };
  const key = findingKey(back.findings[0]!);
  linkEarlier(back, [{ ...fixedOne('fixed'), key }], () => 10);
  assert.equal(back.findings[0]!.follows, key);
});

test('the prompt asks which change of the code makes an assertion fail, apart from "no test"', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'prompts', 'review.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /- tests: new non-trivial logic with no test, only if the repository has tests\. - what a test proves:/);
  assert.match(text, /name the change of the code under test that makes its assertion fail/);
  assert.match(text, /Only if the repository has tests: for a guard, a listener or a class that the diff adds, name the test that fails when it goes/);
  // The severity follows the impact, as § Severity says.
  assert.match(text, /a finding of category `test`: `major` when the behaviour that it means to check is on a path that users take, else `minor`/);
  assert.match(text, /A checker or a lint rule that misses a form of its target/);
});

test('the note of the neighbour cases fits in the size of the section', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ ...earlier('open', head), key: `${i}`.padStart(12, '0'), title: `${'A long title of an open finding, '.repeat(6)}${i}` }));
  const { section, held } = earlierFindingsSection(repo, fixHead, many);
  // The rows and the note count in MAX_EARLIER_BYTES; the fixed text of the intro does not.
  const body = section.slice(section.indexOf('- E1 '));
  assert.ok(body.length <= MAX_EARLIER_BYTES + 2, `${body.length} bytes`);
  assert.match(section, /The file of E1, E2, E3, E4, E5, E6, E7, E8, E9, E10 and \d+ more changed since/);
  assert.ok(held.length > 10);
});

test('the note never takes the place of a row, even the row of the one finding that it names (Kentō #e95c92)', () => {
  // Closed findings fill the section; the last row that fits is the only open one.
  const closed = (i: number) => ({ ...earlier('dismissed', fixHead), key: `${i}`.padStart(12, '0'), title: `${'A long title of a closed finding, '.repeat(5)}${i}` });
  const fill = (n: number) => [...Array.from({ length: n }, (_, i) => closed(i)), { ...earlier('open', head), key: 'e'.repeat(12) }];
  // The largest list whose open finding still gets a row.
  let n = 1;
  while (earlierFindingsSection(repo, fixHead, fill(n + 1)).held.some((h) => h.status === 'open')) n++;
  const { section, held } = earlierFindingsSection(repo, fixHead, fill(n));
  const last = held.at(-1)!;
  assert.equal(last.status, 'open');
  assert.match(section, new RegExp(`The file of ${last.ref} changed since`));
  const body = section.slice(section.indexOf('- E1 '));
  assert.ok(body.length <= MAX_EARLIER_BYTES + 2, `${body.length} bytes`);
  // One closed row more pushes the open finding out, and nothing else: no row goes for the note.
  const more = earlierFindingsSection(repo, fixHead, fill(n + 1));
  assert.equal(more.held.length, n + 1);
  assert.doesNotMatch(more.section, NOTE);
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

test('a file dropped from the pack leaves room: the narrowed test files show their whole tests again (Kentō #0b630a)', () => {
  // One source file of about 500 kB of diff, and five test files of about 26 kB of whole tests.
  const big = mkdtempSync(join(tmpdir(), 'engine-proves-widen-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: big, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  const tests = (marker: string) => ["test('a table', () => {", ...Array.from({ length: 800 }, (_, i) => `  expect(row(${i})).toEqual([${i}]);`), `  expect(${marker}).toBe(true);`, '});', ''].join('\n');
  const source = (n: number) => Array.from({ length: 450 }, (_, i) => `export const v${i} = '${String(n).repeat(600)}';`).join('\n');
  mkdirSync(join(big, 'test'));
  for (let i = 0; i < 5; i++) writeFileSync(join(big, `test/t${i}.test.ts`), tests('before'));
  writeFileSync(join(big, 'big.ts'), source(0));
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const from = g('rev-parse', 'HEAD');
  for (let i = 0; i < 5; i++) writeFileSync(join(big, `test/t${i}.test.ts`), tests('after'));
  writeFileSync(join(big, 'big.ts'), source(1));
  g('commit', '-q', '-am', 'change');
  const to = g('rev-parse', 'HEAD');
  try {
    const { pack, skipped } = buildPack(big, from, to, 'definitions');
    assert.ok(skipped.some((s) => s.startsWith('big.ts: removed to fit')), 'the source goes');
    assert.deepEqual(skipped.filter((s) => s.startsWith('test/')), [], 'no test file is dropped');
    // The whole tests are back: a line 800 lines away from the change.
    assert.equal(pack.match(/ {3}expect\(row\(0\)\)\.toEqual\(\[0\]\);/g)?.length, 5);
  } finally {
    rmSync(big, { recursive: true, force: true });
  }
});
