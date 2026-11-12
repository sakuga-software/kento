/**
 * Compares two arms of the bench on the same pull requests (REV-109). An arm is one or more result
 * files of run.ts: one file for each repeat.
 *
 *     node eval/martian/compare.ts --a base-r1.json,base-r2.json --b variant-r1.json,variant-r2.json \
 *       [--subset eval/martian/subset-ts-hard.json] [--seed 1] [--draws 10000]
 *
 * - The rows align by `url`. A pull request stays if each arm has one review of it or more that
 *   did not fail. A golden comment that the judge did not answer for in one arm leaves both arms.
 * - For each arm and each pull request, a golden comment counts as found by the share of the
 *   repeats that find it.
 * - The paired bootstrap draws pull requests, not golden comments: the golden comments of one pull
 *   request are not independent.
 * - Δ is B − A. The verdict applies the rule of the README to Core medium+.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { failureCounts, failureKind, type FailureRow } from './failures.ts';
import { PROFILES } from './profiles.ts';

export type ResultRow = FailureRow & {
  url: string;
  findings: readonly unknown[];
  categories: string[];
  severities: string[];
  matches: number[][];
  /** Indexes of the golden comments with a pair that the judge did not answer, and no match. */
  unjudged?: number[];
  /** Indexes of the findings with a pair that the judge did not answer, and no match. */
  unjudged_findings?: number[];
};
export type ResultFile = { model?: string; label?: string; rows: ResultRow[] };

export const VIEWS = ['core', 'core medium+'] as const;
export type View = (typeof VIEWS)[number];
const CORE = new Set<string>(PROFILES.core);

function inView(view: View, category: string, severity: string): boolean {
  return CORE.has(category) && (view === 'core' || severity !== 'Low');
}

/** The sums of one arm on one pull request, for one view. The finding counts are means over the repeats. */
export type PrSums = { found: number; golden: number; trueFindings: number; findings: number };
/** The golden comments of one pull request, aligned: index → found share in A and in B. */
export type Aligned = {
  url: string;
  views: Record<View, { a: PrSums; b: PrSums; rates: { a: number; b: number }[] }>;
};

export type Alignment = {
  prs: Aligned[];
  /** Pull requests in both arms that one arm or both lose for lack of a review that did not fail. */
  dropped: { a: number; b: number };
  /** Pull requests that only one arm holds. */
  unpaired: number;
  unjudgedGoldens: number;
};

function armSums(rows: ResultRow[], kept: (index: number) => boolean): { sums: PrSums; rates: Map<number, number> } {
  const golden = rows[0].categories.map((_, index) => index).filter(kept);
  const rates = new Map(golden.map((index) => [index, rows.filter((row) => row.matches.flat().includes(index)).length / rows.length]));
  let trueFindings = 0, findings = 0;
  for (const row of rows) {
    const skip = new Set(row.unjudged_findings ?? []);
    row.matches.forEach((match, index) => {
      if (skip.has(index)) return;
      if (match.some(kept)) trueFindings++;
      // A finding that matches only golden comments out of the view is neither true nor false.
      else if (match.length) return;
      findings++;
    });
  }
  const found = [...rates.values()].reduce((total, rate) => total + rate, 0);
  return { sums: { found, golden: golden.length, trueFindings: trueFindings / rows.length, findings: findings / rows.length }, rates };
}

/** Pairs the rows of two arms by pull request. A repeat that failed does not count. */
export function align(a: ResultRow[], b: ResultRow[], urls?: Set<string>): Alignment {
  const group = (rows: ResultRow[]) => {
    const out = new Map<string, ResultRow[]>();
    for (const row of rows) if (!urls || urls.has(row.url)) out.set(row.url, [...(out.get(row.url) ?? []), row]);
    return out;
  };
  const byA = group(a), byB = group(b);
  const prs: Aligned[] = [];
  const dropped = { a: 0, b: 0 };
  let unpaired = 0, unjudgedGoldens = 0;
  for (const url of new Set([...byA.keys(), ...byB.keys()])) {
    const rowsA = byA.get(url), rowsB = byB.get(url);
    if (!rowsA || !rowsB) {
      unpaired++;
      continue;
    }
    const okA = rowsA.filter((row) => !failureKind(row)), okB = rowsB.filter((row) => !failureKind(row));
    if (!okA.length) dropped.a++;
    if (!okB.length) dropped.b++;
    if (!okA.length || !okB.length) continue;
    const { categories, severities } = okA[0];
    if (okB[0].categories.length !== categories.length) throw new Error(`${url}: the arms do not hold the same golden comments`);
    const unjudged = new Set([...okA, ...okB].flatMap((row) => row.unjudged ?? []));
    unjudgedGoldens += unjudged.size;
    const views = Object.fromEntries(
      VIEWS.map((view) => {
        const kept = (index: number) => !unjudged.has(index) && inView(view, categories[index], severities[index]);
        const sa = armSums(okA, kept), sb = armSums(okB, kept);
        const rates = [...sa.rates.keys()].map((index) => ({ a: sa.rates.get(index)!, b: sb.rates.get(index)! }));
        return [view, { a: sa.sums, b: sb.sums, rates }];
      }),
    ) as Aligned['views'];
    prs.push({ url, views });
  }
  return { prs, dropped, unpaired, unjudgedGoldens };
}

export type Metrics = { recall: number; precision: number; f1: number };

export function metrics(sums: PrSums[]): Metrics {
  const total = sums.reduce((t, s) => ({ found: t.found + s.found, golden: t.golden + s.golden, trueFindings: t.trueFindings + s.trueFindings, findings: t.findings + s.findings }), {
    found: 0,
    golden: 0,
    trueFindings: 0,
    findings: 0,
  });
  const recall = total.found / Math.max(total.golden, 1);
  const precision = total.trueFindings / Math.max(total.findings, 1);
  return { recall, precision, f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0 };
}

/** mulberry32: a seeded generator, so that one seed gives one interval. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Interval = { delta: number; low: number; high: number; se: number };
export type Deltas = Record<keyof Metrics, Interval>;

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** The paired bootstrap over pull requests: each draw takes the same pull requests in both arms. */
export function bootstrap(prs: Aligned[], view: View, draws: number, seed: number): Deltas {
  const a = prs.map((pr) => pr.views[view].a), b = prs.map((pr) => pr.views[view].b);
  const delta = (indexes: number[]) => {
    const ma = metrics(indexes.map((i) => a[i])), mb = metrics(indexes.map((i) => b[i]));
    return { recall: mb.recall - ma.recall, precision: mb.precision - ma.precision, f1: mb.f1 - ma.f1 };
  };
  const all = delta(prs.map((_, i) => i));
  const next = random(seed);
  const samples: Record<keyof Metrics, number[]> = { recall: [], precision: [], f1: [] };
  for (let draw = 0; draw < draws; draw++) {
    const d = delta(prs.map(() => Math.floor(next() * prs.length)));
    for (const key of ['recall', 'precision', 'f1'] as const) samples[key].push(d[key]);
  }
  const interval = (key: keyof Metrics): Interval => {
    const sorted = samples[key].sort((x, y) => x - y);
    const mean = sorted.reduce((t, v) => t + v, 0) / sorted.length;
    const se = Math.sqrt(sorted.reduce((t, v) => t + (v - mean) ** 2, 0) / Math.max(sorted.length - 1, 1));
    return { delta: all[key], low: quantile(sorted, 0.025), high: quantile(sorted, 0.975), se };
  };
  return { recall: interval('recall'), precision: interval('precision'), f1: interval('f1') };
}

/**
 * McNemar on the majority verdict of each golden comment: found when more than half of the repeats
 * find it. With an even number of repeats, a tie is "not found". The p-value is the exact binomial one.
 */
export function mcnemar(prs: Aligned[], view: View) {
  let onlyA = 0, onlyB = 0, n = 0;
  for (const pr of prs) {
    for (const { a, b } of pr.views[view].rates) {
      n++;
      const foundA = a > 0.5, foundB = b > 0.5;
      if (foundA && !foundB) onlyA++;
      if (foundB && !foundA) onlyB++;
    }
  }
  const discordant = onlyA + onlyB;
  let tail = 0;
  for (let k = 0; k <= Math.min(onlyA, onlyB); k++) tail += Math.exp(logChoose(discordant, k) - discordant * Math.LN2);
  return { onlyA, onlyB, n, d: discordant / Math.max(n, 1), p: discordant ? Math.min(1, 2 * tail) : 1 };
}

function logChoose(n: number, k: number): number {
  let out = 0;
  for (let i = 1; i <= k; i++) out += Math.log(n - k + i) - Math.log(i);
  return out;
}

/** The margin of the decision rule: a loss smaller than this on the other metric is acceptable. */
export const MARGIN = 0.05;

export type Verdict = { winner: 'A' | 'B' | null; text: string };

/**
 * The decision rule of REV-109. One arm wins if:
 * - its gain in recall has an interval that excludes 0, and the interval of precision does not
 *   show a loss of more than MARGIN; or
 * - its gain in precision has an interval that excludes 0, and the interval of recall does not
 *   show a loss of more than MARGIN.
 */
export function verdict(recall: Interval, precision: Interval): Verdict {
  const pct = (value: number) => `${(value * 100).toFixed(1)} points`;
  if (recall.low > 0 && precision.low > -MARGIN) return { winner: 'B', text: `B finds more (recall +${pct(recall.delta)}), and its precision holds.` };
  if (recall.high < 0 && precision.high < MARGIN) return { winner: 'A', text: `A finds more (recall +${pct(-recall.delta)}), and its precision holds.` };
  if (precision.low > 0 && recall.low > -MARGIN) return { winner: 'B', text: `B is more precise (precision +${pct(precision.delta)}), and its recall holds.` };
  if (precision.high < 0 && recall.high < MARGIN) return { winner: 'A', text: `A is more precise (precision +${pct(-precision.delta)}), and its recall holds.` };
  const moves = (name: string, i: Interval, other: string, o: Interval) => {
    const arm = i.low > 0 ? 'B' : 'A';
    const loss = arm === 'B' ? -o.low : o.high;
    return `${arm} has the higher ${name} (+${pct(Math.abs(i.delta))}), but its ${other} can be lower by up to ${pct(loss)}, more than the margin of ${pct(MARGIN)}. No arm wins.`;
  };
  if (recall.low > 0 || recall.high < 0) return { winner: null, text: moves('recall', recall, 'precision', precision) };
  if (precision.low > 0 || precision.high < 0) return { winner: null, text: moves('precision', precision, 'recall', recall) };
  return { winner: null, text: 'No detectable difference.' };
}

/** For a change of cost or speed: the recall of B stays within ±MARGIN of A. */
export function equivalent(recall: Interval): boolean {
  return recall.low > -MARGIN && recall.high < MARGIN;
}

function readArm(files: string[]) {
  const results = files.map((file) => JSON.parse(readFileSync(file, 'utf8')) as ResultFile);
  return { results, rows: results.flatMap((result) => result.rows) };
}

function main() {
  const { values } = parseArgs({
    options: {
      a: { type: 'string' },
      b: { type: 'string' },
      subset: { type: 'string' },
      seed: { type: 'string', default: '1' },
      draws: { type: 'string', default: '10000' },
    },
  });
  if (!values.a || !values.b) throw new Error('--a and --b each need one result file or more, separated by commas');
  const filesA = values.a.split(','), filesB = values.b.split(',');
  const armA = readArm(filesA), armB = readArm(filesB);
  const urls = values.subset ? new Set((JSON.parse(readFileSync(values.subset, 'utf8')) as { url: string }[]).map((pr) => pr.url)) : undefined;
  const alignment = align(armA.rows, armB.rows, urls);
  const draws = Number(values.draws), seed = Number(values.seed);
  const inSubset = (rows: ResultRow[]) => rows.filter((row) => !urls || urls.has(row.url));
  const tally = (arm: ReturnType<typeof readArm>) => {
    const counts = arm.results.map((result) => failureCounts(inSubset(result.rows), result.model));
    return `${counts.reduce((t, c) => t + c.errors, 0)} errors, ${counts.reduce((t, c) => t + c.truncated, 0)} truncated, ${counts.reduce((t, c) => t + c.fallbacks, 0)} fallbacks`;
  };
  const names = (files: string[]) => files.map((file) => basename(file)).join(', ');
  console.log(`A: ${names(filesA)} (${tally(armA)})`);
  console.log(`B: ${names(filesB)} (${tally(armB)})`);
  console.log(
    `${alignment.prs.length} pull requests compared · dropped for lack of a review that did not fail: ${alignment.dropped.a} in A, ${alignment.dropped.b} in B` +
      ` · ${alignment.unpaired} in one arm only · ${alignment.unjudgedGoldens} unjudged golden comments left out`,
  );
  console.log(`Paired bootstrap over pull requests, ${draws} draws, seed ${seed}. Δ = B − A, 95 % interval.\n`);
  const fmt = (value: number) => value.toFixed(3);
  const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(3)}`;
  const results = new Map<View, Deltas>();
  console.log('view          metric      A      B      Δ       95 % interval');
  for (const view of VIEWS) {
    const deltas = bootstrap(alignment.prs, view, draws, seed);
    results.set(view, deltas);
    const ma = metrics(alignment.prs.map((pr) => pr.views[view].a)), mb = metrics(alignment.prs.map((pr) => pr.views[view].b));
    for (const key of ['recall', 'precision', 'f1'] as const) {
      const i = deltas[key];
      console.log(`${view.padEnd(13)} ${key.padEnd(10)}  ${fmt(ma[key])}  ${fmt(mb[key])}  ${signed(i.delta)}  [${signed(i.low)}, ${signed(i.high)}]`);
    }
  }
  console.log('');
  for (const view of VIEWS) {
    const m = mcnemar(alignment.prs, view);
    console.log(`McNemar, ${view}: ${m.n} golden comments, found by A only ${m.onlyA}, by B only ${m.onlyB}, discordance d ${m.d.toFixed(3)}, p ${m.p.toFixed(3)}`);
  }
  const primary = results.get('core medium+')!;
  // 80 % power at α 0.05, two-sided: (1.96 + 0.84) × SE.
  console.log(`Minimum detectable Δrecall (core medium+, 80 % power): ${(2.8 * primary.recall.se).toFixed(3)}`);
  const decision = verdict(primary.recall, primary.precision);
  console.log(`\nVerdict (core medium+): ${decision.text}`);
  if (equivalent(primary.recall)) console.log(`For a change of cost or speed: the recall of B stays within ±${MARGIN} of A.`);
}

if (import.meta.main) main();
