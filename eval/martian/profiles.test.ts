import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atMinConfidence, profileMetrics } from './profiles.ts';

test('atMinConfidence: drops the findings below the minimum with their matches (KNT-111)', () => {
  const rows = [
    { categories: ['bug', 'bug'], matches: [[0], [], [1]], confidences: [80, 55, 60] },
    { categories: ['bug'], matches: [[]], confidences: [50] },
  ];
  const at60 = atMinConfidence(rows, 60)!;
  assert.deepEqual(at60.map((row) => row.matches), [[[0], [1]], []]);
  const m = profileMetrics(at60, 'strict');
  assert.equal(m.findings, 2);
  assert.equal(m.found, 2);
  assert.equal(profileMetrics(atMinConfidence(rows, 70)!, 'strict').found, 1);
  assert.deepEqual(atMinConfidence(rows, 0)!.map((row) => row.matches), rows.map((row) => row.matches));
});

test('atMinConfidence: a file written before KNT-111 has no confidences, and gives null', () => {
  assert.equal(atMinConfidence([{ categories: ['bug'], matches: [[0]] }], 60), null);
  assert.equal(atMinConfidence([{ categories: ['bug'], matches: [[0], []], confidences: [90] }], 60), null, 'one confidence for each finding');
});

test('atMinConfidence: a row with no finding needs no confidences, so a failed review keeps the file scorable', () => {
  const rows = [
    { categories: ['bug'], matches: [[0], []], confidences: [80, 50] },
    { categories: ['bug'], matches: [] },
  ];
  assert.deepEqual(atMinConfidence(rows, 60)!.map((row) => row.matches), [[[0]], []]);
});
