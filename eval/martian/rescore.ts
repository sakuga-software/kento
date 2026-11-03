/**
 * The profiles of Martian for result files that the judge already scored, with no new judge call:
 *
 *     node eval/martian/rescore.ts --subset eval/martian/subset-ts.json ../results/*.json
 *
 * A file needs `matches` in its rows (run.ts writes them since REV-67); the others are skipped.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { PROFILES, profileMetrics, type Profile } from './profiles.ts';

const { values, positionals } = parseArgs({ options: { subset: { type: 'string' } }, allowPositionals: true });
const prs: { url: string; golden: { category: string }[] }[] = JSON.parse(readFileSync(values.subset!, 'utf8'));
const categories = new Map(prs.map((pr) => [pr.url, pr.golden.map((g) => g.category)]));
for (const file of positionals) {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  if (!result.rows.every((row: { matches?: unknown }) => Array.isArray(row.matches))) {
    console.log(`${basename(file)}: no matches, skipped`);
    continue;
  }
  const rows = result.rows.map((row: { url: string; matches: number[][] }) => ({ categories: categories.get(row.url)!, matches: row.matches }));
  const cells = Object.keys(PROFILES).map((name) => {
    const m = profileMetrics(rows, name as Profile);
    return `${name} F1 ${m.f1.toFixed(2)} R ${(m.recall * 100).toFixed(0)} % P ${(m.precision * 100).toFixed(0)} % (${m.found}/${m.golden}, ${m.matched_excluded} excluded)`;
  });
  console.log(`${basename(file)}: ${cells.join(' · ')}`);
}
