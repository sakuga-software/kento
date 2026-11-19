// REV-121. The bench in this repository holds only public pull requests. The cases of private
// repositories are in the internal bench, apart from this repository; `--subset` reads both.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSubset } from './subset.ts';

const ROOT = join(import.meta.dirname, '..', '..');
/** The repositories whose pull requests can be in the public bench: Martian, and the public repositories of the org. */
const PUBLIC = new Set(['calcom/cal.com', 'grafana/grafana', 'ai-code-review-evaluation/sentry-greptile']);
const PUBLIC_OF_ORG = new Set(['fruitback', 'boo', 'git8n', 'sakuga-review']);
const ORG = 'sakuga-software';

type Pr = { url: string; source: string; owner: string; name: string; golden: unknown[] };

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'eval'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
}

test('readSubset: the files of a list separated by commas, in order', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'subset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a.json'), b = join(dir, 'b.json'), c = join(dir, 'c.json'), bad = join(dir, 'bad.json');
  writeFileSync(a, JSON.stringify([{ url: 'one' }, { url: 'two' }]));
  writeFileSync(b, JSON.stringify([{ url: 'three' }]));
  writeFileSync(c, JSON.stringify([{ url: 'two' }]));
  writeFileSync(bad, JSON.stringify({ url: 'one' }));
  assert.deepEqual(readSubset(a).map((pr) => pr.url), ['one', 'two']);
  assert.deepEqual(readSubset(`${a},${b}`).map((pr) => pr.url), ['one', 'two', 'three']);
  assert.throws(() => readSubset(`${a},${c}`), /two is in .*a\.json and in .*c\.json/);
  assert.throws(() => readSubset(bad), /JSON array/);
  assert.throws(() => readSubset(','), /one JSON file or more/);
});

test('subset-ts-v2.json is subset-ts.json, then the cases of internal/subset-feedback.json', () => {
  const read = (file: string): Pr[] => JSON.parse(readFileSync(join(ROOT, 'eval', file), 'utf8'));
  const v2 = read('martian/subset-ts-v2.json');
  assert.deepEqual(v2, [...read('martian/subset-ts.json'), ...read('internal/subset-feedback.json')]);
  assert.equal(v2.length, 38);
  const bySource = Object.groupBy(v2, (pr) => pr.source);
  assert.deepEqual(Object.fromEntries(Object.entries(bySource).map(([source, prs]) => [source, prs!.length])), { martian: 13, feedback: 25 });
});

test('each case of a JSON file of eval/ is a pull request of a public repository', () => {
  const files = trackedFiles().filter((file) => file.endsWith('.json') && !file.endsWith('package.json') && !file.endsWith('schema.json'));
  assert.ok(files.length >= 4, `the subsets are tracked: ${files.join(', ')}`);
  for (const file of files) {
    const prs: Pr[] = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    for (const pr of prs) {
      const repo = `${pr.owner}/${pr.name}`;
      const isPublic = PUBLIC.has(repo) || (pr.owner === ORG && PUBLIC_OF_ORG.has(pr.name));
      assert.ok(isPublic, `${file}: ${pr.url} is a pull request of ${repo}, which is not a public repository`);
      assert.notEqual(pr.source, 'internal', `${file}: ${pr.url} is an internal case`);
    }
  }
});

test('the files of eval/ name no repository of the org but the public ones', () => {
  for (const file of trackedFiles()) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [, name] of text.matchAll(new RegExp(`${ORG}/([A-Za-z0-9_.-]+)`, 'g'))) {
      assert.ok(PUBLIC_OF_ORG.has(name.replace(/\.git$/, '')), `${file} names ${ORG}/${name}`);
    }
    for (const [, name] of text.matchAll(/feedback:([A-Za-z0-9_.-]+)#/g)) {
      assert.ok(PUBLIC_OF_ORG.has(name), `${file} holds the case feedback:${name}`);
    }
    // The files and campaigns of one customer were named rcNN-…; such a token names the customer.
    assert.doesNotMatch(text, /\brc\d{2}-/, `${file} holds a token rcNN-`);
  }
});
