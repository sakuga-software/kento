import assert from 'node:assert/strict';
import { test } from 'node:test';
import { align, bootstrap, equivalent, mcnemar, metrics, verdict, type Interval, type ResultRow } from './compare.ts';
import { failureKind } from './failures.ts';

/** A row with two blocking golden comments (bug, Medium) and one Low comment. */
function row(url: string, matches: number[][], extra: Partial<ResultRow> = {}): ResultRow {
  return { url, findings: matches.map((_, i) => `f${i}`), categories: ['bug', 'bug', 'bug'], severities: ['Medium', 'High', 'Low'], matches, ...extra };
}

const cut = { findings: [], matches: [], error: 'Anthropic gave no JSON object (stop_reason max_tokens, 32000 output tokens)' };

test('align: pairs by url, keeps the repeats that did not fail, drops a pull request that one arm lost', () => {
  const a = [row('pr1', [[0], []]), row('pr1', [[]], cut), row('pr2', [[1]]), row('pr3', [[0]])];
  const b = [row('pr1', [[0], [1]]), row('pr2', [], cut), row('pr4', [[0]])];
  const out = align(a, b);
  assert.deepEqual(out.prs.map((pr) => pr.url), ['pr1']);
  assert.deepEqual(out.dropped, { a: 0, b: 1 });
  assert.equal(out.unpaired, 2);
  const core = out.prs[0].views.core;
  // A: one repeat survives, it finds golden 0 and has one false finding.
  assert.deepEqual(core.a, { found: 1, golden: 3, trueFindings: 1, findings: 2 });
  assert.deepEqual(core.b, { found: 2, golden: 3, trueFindings: 2, findings: 2 });
  const medium = out.prs[0].views['core medium+'];
  assert.equal(medium.a.golden, 2);
});

test('align: the found share is the mean over repeats, and an unjudged golden comment leaves both arms', () => {
  const a = [row('pr1', [[0]]), row('pr1', [[]])];
  const b = [row('pr1', [[0]], { unjudged: [1] })];
  const view = align(a, b).prs[0].views['core medium+'];
  assert.deepEqual(view.rates, [{ a: 0.5, b: 1 }]);
  assert.equal(view.a.golden, 1);
  assert.deepEqual([view.a.trueFindings, view.a.findings], [0.5, 1]);
});

test('a finding that matches only a Low golden comment is neither true nor false in core medium+', () => {
  const view = align([row('pr1', [[2]])], [row('pr1', [[2]])]).prs[0].views;
  assert.equal(view['core medium+'].a.findings, 0);
  assert.equal(view.core.a.trueFindings, 1);
});

test('bootstrap: one seed gives one interval, and identical arms give a zero interval', () => {
  const a = Array.from({ length: 20 }, (_, i) => row(`pr${i}`, i % 3 ? [[0], []] : [[]]));
  const b = Array.from({ length: 20 }, (_, i) => row(`pr${i}`, i % 2 ? [[0], [1]] : [[]]));
  const prs = align(a, b).prs;
  const first = bootstrap(prs, 'core', 2000, 7);
  assert.deepEqual(bootstrap(prs, 'core', 2000, 7), first);
  assert.notDeepEqual(bootstrap(prs, 'core', 2000, 8).recall, first.recall);
  assert.ok(first.recall.low <= first.recall.delta && first.recall.delta <= first.recall.high);
  const same = bootstrap(align(a, a).prs, 'core', 500, 1);
  assert.deepEqual([same.recall.low, same.recall.high, same.recall.delta], [0, 0, 0]);
});

test('metrics: recall over golden comments, precision over findings', () => {
  const m = metrics([
    { found: 1, golden: 4, trueFindings: 1, findings: 2 },
    { found: 1, golden: 0, trueFindings: 1, findings: 2 },
  ]);
  assert.equal(m.recall, 0.5);
  assert.equal(m.precision, 0.5);
});

test('mcnemar: counts the discordant golden comments, with an exact p-value', () => {
  const a = [row('pr1', [[0, 1]]), row('pr2', [[0, 1]]), row('pr3', [[0, 1]])];
  const b = [row('pr1', [[]]), row('pr2', [[]]), row('pr3', [[]])];
  const m = mcnemar(align(a, b).prs, 'core medium+');
  assert.deepEqual([m.onlyA, m.onlyB, m.n], [6, 0, 6]);
  assert.equal(m.d, 1);
  assert.ok(Math.abs(m.p - 2 / 64) < 1e-12);
});

const interval = (low: number, high: number): Interval => ({ delta: (low + high) / 2, low, high, se: 0 });

test('verdict: the decision rule of REV-109', () => {
  assert.equal(verdict(interval(0.01, 0.1), interval(-0.04, 0.05)).winner, 'B');
  assert.equal(verdict(interval(0.01, 0.1), interval(-0.08, 0.05)).winner, null, 'precision can fall by more than the margin');
  assert.equal(verdict(interval(-0.03, 0.06), interval(0.02, 0.2)).winner, 'B', 'more precise, and recall holds');
  assert.equal(verdict(interval(-0.1, -0.01), interval(-0.05, 0.04)).winner, 'A');
  assert.equal(verdict(interval(-0.06, 0.06), interval(0.02, 0.2)).winner, null);
  const none = verdict(interval(-0.02, 0.06), interval(-0.03, 0.04));
  assert.equal(none.winner, null);
  assert.equal(none.text, 'No detectable difference.');
  assert.ok(equivalent(interval(-0.04, 0.04)));
  assert.ok(!equivalent(interval(-0.06, 0.04)));
});

test('failureKind: a cut answer is truncated, another failure is an error, a review with findings did not fail', () => {
  assert.equal(failureKind({ findings: [], error: cut.error }), 'truncated');
  assert.equal(failureKind({ findings: [], error: 'fetch failed' }), 'error');
  assert.equal(failureKind({ findings: [], error: 'x', usage: { stop_reason: 'max_tokens' } }), 'truncated');
  assert.equal(failureKind({ findings: ['f'], error: cut.error }), null);
});
