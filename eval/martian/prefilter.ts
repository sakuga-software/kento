/**
 * The prefilter of the judge (REV-109). Most golden comments of `internal` and `feedback` start with
 * the file of the defect (`job.ts:215 …`, `banner-variant.js line 301: …`). With `--prefilter`,
 * run.ts sends such a golden comment to the judge only with the findings on a file of that name, or
 * with the findings whose text names that file.
 *
 * The prefilter can lose a match: a finding on the caller of the defective function can match a
 * golden comment on the function. Measure the loss on scored files, with no judge call:
 *
 *     node eval/martian/prefilter.ts --subset eval/martian/subset-ts-v2.json ../results/*.json
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { readSubset } from './subset.ts';

const NAMED_FILE = /^\s*`?([\w@.$\-[\]()+~]+(?:\/[\w@.$\-[\]()+~]+)*\.[A-Za-z0-9]{1,6})`?(?=[\s:,(]|$)/;

/** The name of the file that a golden comment starts with, without its directories. */
export function namedFile(golden: string): string | null {
  const match = NAMED_FILE.exec(golden);
  return match ? basename(match[1]) : null;
}

/** False when the golden comment names a file that the candidate (`path:line — …`) neither is on nor names. */
export function prefilterKeeps(golden: string, candidate: string): boolean {
  const file = namedFile(golden);
  if (!file) return true;
  const path = candidate.slice(0, Math.max(candidate.indexOf(':'), 0));
  return basename(path) === file || candidate.includes(file.replace(/\.[^.]+$/, ''));
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { subset: { type: 'string' } }, allowPositionals: true });
  const prs = readSubset<{ url: string; golden: { comment: string }[] }>(values.subset!);
  const golden = new Map(prs.map((pr) => [pr.url, pr.golden.map((g) => g.comment)]));
  for (const file of positionals) {
    const result: { rows: { url: string; findings: string[]; matches?: number[][] }[] } = JSON.parse(readFileSync(file, 'utf8'));
    let pairs = 0, kept = 0, matches = 0, lost = 0;
    for (const row of result.rows) {
      const comments = golden.get(row.url) ?? [];
      row.findings.forEach((finding, index) => {
        comments.forEach((comment, g) => {
          const keep = prefilterKeeps(comment, finding);
          pairs++;
          if (keep) kept++;
          if (!row.matches?.[index]?.includes(g)) return;
          matches++;
          if (!keep) lost++;
        });
      });
    }
    console.log(`${basename(file)}: the prefilter keeps ${kept} of ${pairs} pairs (${((kept / Math.max(pairs, 1)) * 100).toFixed(0)} %) and loses ${lost} of ${matches} matches`);
  }
}
