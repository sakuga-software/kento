/**
 * The pull requests of `--subset` (REV-121). The value is one JSON file, or several files separated
 * by commas: the public subset of this folder and the same subset of the internal bench, which is
 * not in this repository. The files are read in order, and a pull request must not be in two.
 *
 *     --subset eval/martian/subset-ts-v2.json,$INTERNAL_BENCH/martian/subset-ts-v2.json
 */
import { readFileSync } from 'node:fs';

export function readSubset<T extends { url: string }>(spec: string): T[] {
  const files = spec.split(',').map((file) => file.trim()).filter(Boolean);
  if (!files.length) throw new Error('--subset must name one JSON file or more, separated by commas');
  const prs: T[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const read: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(read)) throw new Error(`a subset is a JSON array of pull requests: ${file}`);
    for (const pr of read as T[]) {
      const first = seen.get(pr.url);
      if (first) throw new Error(`${pr.url} is in ${first} and in ${file}`);
      seen.set(pr.url, file);
      prs.push(pr);
    }
  }
  return prs;
}
