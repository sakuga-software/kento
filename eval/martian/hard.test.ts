import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hardSubset } from './hard.ts';
import { namedFile, prefilterKeeps } from './prefilter.ts';

const golden = (category: string, severity: string) => ({ comment: 'c', category, severity });

test('hardSubset: 2 Core golden comments above Low or more, or none at all', () => {
  const prs = [
    { url: 'two', golden: [golden('bug', 'Medium'), golden('security', 'High')] },
    { url: 'one-and-low', golden: [golden('bug', 'Medium'), golden('bug', 'Low')] },
    { url: 'style', golden: [golden('style', 'High'), golden('bug', 'High')] },
    { url: 'none', golden: [] },
  ];
  assert.deepEqual(hardSubset(prs).map((pr) => pr.url), ['two', 'none']);
});

test('subset-ts-hard.json is the rule applied to subset-ts-v2.json: 23 pull requests and 8 with no golden comment', () => {
  const read = (file: string) => JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8'));
  const hard = read('subset-ts-hard.json');
  assert.deepEqual(hard, hardSubset(read('subset-ts-v2.json')));
  assert.equal(hard.length, 23);
  assert.equal(hard.filter((pr: { golden: unknown[] }) => pr.golden.length === 0).length, 8);
});

test('prefilter: a golden comment that names a file goes only with the findings on that file or that name it', () => {
  assert.equal(namedFile('apps/runner/src/job.ts:215 retries ignore the signal'), 'job.ts');
  assert.equal(namedFile('banner-variant.js line 301: the banner'), 'banner-variant.js');
  assert.equal(namedFile('Backup code validation is case-sensitive.'), null);
  const g = 'job.ts:215 retries of the clone start without the signal';
  assert.ok(prefilterKeeps(g, 'apps/runner/src/job.ts:210 — Retry ignores the signal.'));
  assert.ok(prefilterKeeps(g, 'apps/runner/src/clone.ts:109 — `job` passes no signal to the retry in job.ts.'));
  assert.ok(!prefilterKeeps(g, 'apps/runner/src/clone.ts:109 — Retry ignores the signal.'));
  assert.ok(prefilterKeeps('Backup code validation is case-sensitive.', 'a.ts:1 — x'));
});
