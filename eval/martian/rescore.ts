/**
 * The profiles of Martian for result files that the judge already scored, with no new judge call:
 *
 *     node eval/martian/rescore.ts --subset eval/martian/subset-ts.json ../results/*.json
 *
 * With `--min-confidence 50,60,70`, a line for each minimum: the scores of the findings at that
 * confidence or more (KNT-111). It needs the `confidences` that run.ts writes since KNT-111.
 *
 * A file needs `matches` in its rows (run.ts writes them since REV-67); the others are skipped.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { atMinConfidence, PROFILES, profileMetrics, type Profile, type ScoredRow } from './profiles.ts';
import { readSubset } from './subset.ts';

const { values, positionals } = parseArgs({ options: { subset: { type: 'string' }, 'min-confidence': { type: 'string' } }, allowPositionals: true });
const minimums = values['min-confidence']?.split(',').map(Number) ?? [];
if (minimums.some((m) => !Number.isInteger(m) || m < 0 || m > 100)) throw new Error('--min-confidence takes integers from 0 to 100, separated by commas');

function line(rows: readonly ScoredRow[]): string {
  return Object.keys(PROFILES)
    .map((name) => {
      const m = profileMetrics(rows, name as Profile);
      return `${name} F1 ${m.f1.toFixed(2)} R ${(m.recall * 100).toFixed(0)} % P ${(m.precision * 100).toFixed(0)} % (${m.found}/${m.golden}, ${m.findings} findings, ${m.matched_excluded} excluded)`;
    })
    .join(' · ');
}
const prs = readSubset<{ url: string; golden: { category: string }[] }>(values.subset!);
const categories = new Map(prs.map((pr) => [pr.url, pr.golden.map((g) => g.category)]));
for (const file of positionals) {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  if (!result.rows.every((row: { matches?: unknown }) => Array.isArray(row.matches))) {
    console.log(`${basename(file)}: no matches, skipped`);
    continue;
  }
  const rows = result.rows.map((row: { url: string; categories?: string[]; matches: number[][]; confidences?: number[] }) => ({
    categories: row.categories ?? categories.get(row.url)!,
    matches: row.matches,
    ...(row.confidences ? { confidences: row.confidences } : {}),
  }));
  console.log(`${basename(file)}: ${line(rows)}`);
  for (const minimum of minimums) {
    const kept = atMinConfidence(rows, minimum);
    console.log(kept ? `  confidence >= ${minimum}: ${line(kept)}` : `  confidence >= ${minimum}: no confidences in this file (written before KNT-111)`);
  }
}
