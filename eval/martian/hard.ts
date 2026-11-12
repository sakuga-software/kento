/**
 * The hard subset of the bench (REV-109), built from the labels of v2 only, never from past scores:
 *
 *     node eval/martian/hard.ts eval/martian/subset-ts-v2.json eval/martian/subset-ts-hard.json
 *
 * - The pull requests with 2 golden comments or more of the Core profile and of a severity above Low:
 *   recall moves on them.
 * - The pull requests with no golden comment: each finding on them is a false positive, so precision
 *   moves on them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PROFILES } from './profiles.ts';

const CORE = new Set<string>(PROFILES.core);
export const MIN_BLOCKING_GOLDEN = 2;

type Pr = { url: string; golden: { category: string; severity: string }[] };

export function blockingGolden(pr: Pr): number {
  return pr.golden.filter((g) => CORE.has(g.category) && g.severity !== 'Low').length;
}

export function hardSubset<T extends Pr>(prs: readonly T[]): T[] {
  return prs.filter((pr) => pr.golden.length === 0 || blockingGolden(pr) >= MIN_BLOCKING_GOLDEN);
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) throw new Error('usage: node eval/martian/hard.ts <subset-ts-v2.json> <subset-ts-hard.json>');
  const prs: Pr[] = JSON.parse(readFileSync(from, 'utf8'));
  const hard = hardSubset(prs);
  writeFileSync(to, `${JSON.stringify(hard, null, 2)}\n`);
  const empty = hard.filter((pr) => pr.golden.length === 0).length;
  const blocking = hard.reduce((total, pr) => total + blockingGolden(pr), 0);
  console.log(`${hard.length} pull requests: ${hard.length - empty} with ${MIN_BLOCKING_GOLDEN} Core golden comments above Low or more (${blocking} in all), ${empty} with none`);
}
