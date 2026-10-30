import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeAround, fingerprint, FINGERPRINT, normalizeTitle } from '../src/fingerprint.ts';

const FILE = ['import x from "x";', '', 'export function sum(a, b) {', '  return a - b;', '}', ''];
const finding = { path: 'src/sum.ts', line: 4, title: 'La somme soustrait' };

test('a finding whose lines move keeps its fingerprint (line 4 → 7)', () => {
  const moved = ['// one', '// two', '// three', ...FILE];
  const before = fingerprint(finding, FILE);
  assert.match(before, FINGERPRINT);
  assert.equal(fingerprint({ ...finding, line: 7 }, moved), before);
});

test('a change of the code around the line, of the path or of the title gives another fingerprint', () => {
  const before = fingerprint(finding, FILE);
  const fixed = FILE.map((l) => l.replace('a - b', 'a + b'));
  assert.notEqual(fingerprint(finding, fixed), before);
  assert.notEqual(fingerprint({ ...finding, path: 'src/other.ts' }, FILE), before);
  assert.notEqual(fingerprint({ ...finding, title: 'Un autre défaut' }, FILE), before);
});

test('the title counts without case, accents, punctuation or extra spaces', () => {
  assert.equal(normalizeTitle('  Écrit  la SOMME, faux ! '), 'ecrit la somme faux');
  assert.equal(fingerprint({ ...finding, title: 'la somme  soustrait.' }, FILE), fingerprint(finding, FILE));
  assert.equal(fingerprint({ ...finding, path: '/src/sum.ts' }, FILE), fingerprint(finding, FILE));
});

test('with a rule, the fingerprint reads the rule instead of the title', () => {
  const rule = '0b6f6c1e-3f0a-4a52-9a43-0d3c1f7a2b11';
  assert.equal(
    fingerprint({ ...finding, rule_id: rule, title: 'Un titre' }, FILE),
    fingerprint({ ...finding, rule_id: rule, title: 'Un autre titre' }, FILE),
  );
  assert.notEqual(fingerprint({ ...finding, rule_id: rule }, FILE), fingerprint(finding, FILE));
});

test('the code around a line skips the blank lines and collapses the spaces; no file or a line outside it reads nothing', () => {
  assert.equal(codeAround(FILE, 3), 'export function sum(a, b) {\nreturn a - b;');
  assert.equal(codeAround(FILE, 0), '');
  assert.equal(codeAround(FILE, 99), '');
  assert.equal(codeAround(null, 3), '');
});
