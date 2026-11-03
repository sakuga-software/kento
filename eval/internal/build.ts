/**
 * Internal cases of the bench from the labels of label.ts: one case is a pull request at the commit
 * that the reviewers read.
 *
 *     node eval/internal/build.ts <labels.jsonl> <out.json> [--max-per-repo 8]
 *
 * - The golden comments are the defects that exist: applied, partly applied, left out of scope, or
 *   kept on purpose. Two labels on one file at 3 lines or less are one defect, with all its reviewers.
 * - The known false positives are the comments whose premise the answer showed false.
 * - A case needs a TypeScript, JavaScript or CSS file, and one golden comment of the Core profile or
 *   one known false positive. The cases with the most golden comments that a reviewer other than
 *   Kentō found, and the most known false positives, come first.
 * - `gh` gives the base and the size of each pull request. A pull request of more than
 *   MAX_CHANGED_LINES changed lines is left out: its review costs too much for the bench.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PROFILES } from '../martian/profiles.ts';
import type { Label } from './label.ts';

const { values, positionals } = parseArgs({ options: { 'max-per-repo': { type: 'string', default: '8' } }, allowPositionals: true });
const [labelsFile, out] = positionals;
const maxPerRepo = Number(values['max-per-repo']);

const EXISTS = new Set(['applied', 'partly', 'out_of_scope', 'accepted']);
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|css|scss)$/;
const MAX_CHANGED_LINES = 2000;
const KENTO = /^(kento-review|sakuga-claude-review)\[bot\]$/;
const SAME_DEFECT_LINES = 3;
const CORE = new Set<string>(PROFILES.core);

type Golden = { comment: string; severity: string; category: string; reviewers: string[] };
const labels: Label[] = readFileSync(labelsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

const cases = new Map<string, Label[]>();
for (const label of labels) {
  const key = `${label.repo}#${label.pr}@${label.commit}`;
  cases.set(key, [...(cases.get(key) ?? []), label]);
}

function golden(group: Label[]): Golden[] {
  const out: (Golden & { path: string; line: number })[] = [];
  const rank = { High: 0, Medium: 1, Low: 2 };
  for (const label of group.filter((l) => EXISTS.has(l.outcome)).sort((a, b) => rank[a.severity] - rank[b.severity])) {
    const line = label.line ?? 0;
    const same = out.find((g) => g.path === label.path && Math.abs(g.line - line) <= SAME_DEFECT_LINES);
    if (same) {
      if (!same.reviewers.includes(label.reviewer)) same.reviewers.push(label.reviewer);
      continue;
    }
    out.push({ comment: label.defect, severity: label.severity, category: label.category, reviewers: [label.reviewer], path: label.path, line });
  }
  return out.map(({ path: _path, line: _line, ...g }) => g);
}

const candidates = [...cases.entries()]
  .map(([key, group]) => {
    const [repo, pr, commit] = [group[0].repo, group[0].pr, group[0].commit];
    const g = golden(group);
    return {
      key,
      repo,
      pr,
      commit,
      golden: g,
      false_positives: group.filter((l) => l.outcome === 'wrong').map((l) => ({ comment: l.defect, reviewer: l.reviewer })),
      code: group.every((l) => CODE.test(l.path)),
      // The golden comments of the Core profile that a reviewer other than Kentō found.
      others: g.filter((x) => CORE.has(x.category) && x.reviewers.some((r) => !KENTO.test(r))).length,
      core: g.filter((x) => CORE.has(x.category)).length,
    };
  })
  .filter((c) => c.code && (c.core > 0 || c.false_positives.length > 0))
  .sort((a, b) => b.others + b.false_positives.length - (a.others + a.false_positives.length) || b.core - a.core);

const picked: (typeof candidates[number] & { base: string })[] = [];
const perRepo = new Map<string, number>();
const prsTaken = new Set<string>();
for (const c of candidates) {
  // One commit a pull request: two commits of one pull request share most of their diff.
  if (prsTaken.has(`${c.repo}#${c.pr}`) || (perRepo.get(c.repo) ?? 0) >= maxPerRepo) continue;
  const [base, changed] = execFileSync('gh', ['api', `repos/sakuga-software/${c.repo}/pulls/${c.pr}`, '--jq', '"\\(.base.sha) \\(.additions + .deletions)"'], { encoding: 'utf8' }).trim().split(' ');
  if (Number(changed) > MAX_CHANGED_LINES) continue;
  picked.push({ ...c, base });
  prsTaken.add(`${c.repo}#${c.pr}`);
  perRepo.set(c.repo, (perRepo.get(c.repo) ?? 0) + 1);
}

const subset = picked.map(({ base, ...c }) => {
  return {
    source: 'feedback',
    repo: c.repo,
    url: `feedback:${c.repo}#${c.pr}@${c.commit.slice(0, 7)}`,
    owner: 'sakuga-software',
    name: c.repo,
    base,
    head: c.commit,
    golden: c.golden.map(({ comment, severity, category, reviewers }) => ({ comment, severity, category, reviewers })),
    false_positives: c.false_positives,
  };
});
writeFileSync(out, `${JSON.stringify(subset, null, 2)}\n`);
console.log(`${candidates.length} candidate cases, ${subset.length} picked: ${[...perRepo].map(([repo, n]) => `${repo} ${n}`).join(', ')}`);
