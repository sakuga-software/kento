// REV-88. The review of a push as the change since the last reviewed head: the pack holds only the
// files of the pull request that changed since then, the findings of that review stay on the files
// that did not change, and the score does not go down without a new finding.
//
// A force-push or a rebase takes the last reviewed head out of the history of the new head: the
// review then reads the whole pull request again.
import { spawnSync } from 'node:child_process';
import { git } from './git.ts';
import { SEVERITIES } from '../../protocol/src/index.ts';
import { findingKey, withoutSettled, type Answer, type Finding } from './findings.ts';
import { fingerprint } from './fingerprint.ts';

/** A finding that a person or a review settled: it is not raised again. */
export type SettledFinding = { path: string; line: number; title: string; status: 'fixed' | 'dismissed' | 'wontfix'; key: string; fingerprint: string };

/** A finding of the last review, still open, as the service sends it. */
export type CarriedFinding = Finding & { fingerprint?: string };

/**
 * The last review of the pull request, from the caller: its head, its score, its open findings, and
 * the findings that are settled.
 */
export type Delta = { since: string; score: number; findings: readonly CarriedFinding[]; settled: readonly SettledFinding[] };

/**
 * The incremental review that the pack reads: the last reviewed head, the files read again, and the
 * files of the pull request at the head (a finding on another file does not come back).
 */
export type DeltaPlan = { since: string; files: string[]; pullFiles: string[] };

/** Whether `commit` is in the history of `head`. A commit that the clone does not have (a force-push) is not: git says so on stderr, which stays out of the log. */
function isAncestor(repo: string, commit: string, head: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', commit, head], { cwd: repo, stdio: 'ignore' }).status === 0;
}

/** The paths of `git diff --name-status -z <range>`, the old path of a rename too. */
function changedPaths(repo: string, range: string): Set<string> {
  const fields = git(repo, 'diff', '--name-status', '-z', range).split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      paths.add(fields[++i]!);
      paths.add(fields[++i]!);
    } else {
      paths.add(fields[++i]!);
    }
  }
  paths.delete('');
  return paths;
}

/**
 * The files to read again: the files that changed since the last reviewed head and that are files of
 * the pull request, at the head (`base...head`) or at that head (`base...since`: a change that the
 * pull request reverted since). A merge of the base branch brings changes to other files: those stay
 * out. Null when the last reviewed head is not in the history of the head (a force-push, a rebase):
 * the review reads the whole pull request.
 */
export function planDelta(repo: string, base: string, head: string, since: string): DeltaPlan | null {
  if (since === head || !isAncestor(repo, since, head)) return null;
  const now = changedPaths(repo, `${base}...${head}`);
  const then = changedPaths(repo, `${base}...${since}`);
  const files = [...changedPaths(repo, `${since}..${head}`)].filter((p) => now.has(p) || then.has(p)).sort();
  return { since, files, pullFiles: [...now].sort() };
}

const where = (f: { path: string; line: number }) => `\`${f.path}:${f.line}\``;

/**
 * The section of the pack that says what the last review found: its open findings (those on a file
 * read again are to be reported again only if the change leaves them), and the settled findings,
 * never to be raised again, except those whose key is in `listed`: the section of the earlier findings
 * lists them already (REV-99). Empty when there is nothing to say.
 */
export function earlierSection(delta: Delta, plan: DeltaPlan | null, listed: ReadonlySet<string> = new Set()): string {
  const out: string[] = [];
  if (plan) {
    const reread = new Set(plan.files);
    const open = delta.findings.filter((f) => reread.has(f.path.replace(/^\/+/, '')));
    out.push(
      `## Earlier review\n\nThis pull request was reviewed at commit ${plan.since.slice(0, 9)}. This pack shows only what changed since then, ` +
        'in the files of the pull request; the rest was reviewed and has not changed. Review this change only. ' +
        'Give the confidence score of the whole pull request: lower it only for a new defect of this change.\n',
    );
    if (open.length) {
      out.push(
        '\nThe findings of that review on the files of this diff. Report each one again, at its current line, ' +
          'only if the code still has the defect; leave it out if this change fixed it:\n\n',
        ...open.map((f) => `- ${where(f)} (${f.severity}) ${f.title.replace(/\s+/g, ' ')}\n`),
      );
    }
  }
  // REV-99. The section of the earlier findings lists some of the settled ones already, with their
  // status: only the others are listed here.
  const settled = delta.settled.filter((f) => !listed.has(f.key));
  if (settled.length) {
    out.push(
      `${out.length ? '\n' : '## Earlier review\n\n'}Findings that are settled: a person dismissed them or said that they stay, or a later commit fixed them. ` +
        'Do not report them again, unless this change brings the defect back:\n\n',
      ...settled.map((f) => `- ${where(f)} (${f.status}) ${f.title.replace(/\s+/g, ' ')}\n`),
    );
  }
  return out.length ? `${out.join('')}\n` : '';
}

/**
 * The answer of an incremental review, as the review of the whole pull request: the findings of the
 * last review on the files that did not change come back, a finding that a person dismissed or kept
 * is dropped, and with no new finding the score stays at least the score of the last review.
 * `newFindings`: the findings of the model that the last review did not have.
 */
export function mergeDelta<F extends Finding>(
  answer: Answer & { findings: F[] },
  delta: Delta,
  plan: DeltaPlan | null,
  fileAt: (path: string) => string[] | null,
  /** REV-99. A finding that continues an earlier finding, no more severe: not a new finding. */
  isVariant: (f: F) => boolean = () => false,
): { answer: Answer & { findings: F[] }; newFindings: number; dropped: F[]; floored: { model: number; kept: number } | null } {
  const print = (f: Finding) => fingerprint(f, fileAt(f.path));
  const refused = delta.settled.filter((s) => s.status !== 'fixed');
  const isRefused = (f: Finding) => refused.some((s) => s.key === findingKey(f) || s.fingerprint === print(f));
  const all: F[] = answer.findings;
  const dropped = all.filter(isRefused);
  let findings = all.filter((f) => !isRefused(f));
  if (!plan) return { answer: { ...answer, findings }, newFindings: findings.length, dropped, floored: null };

  const reread = new Set(plan.files);
  const ofPullRequest = new Set(plan.pullFiles);
  // A finding of the last review found again, no more severe than it was: a worse severity is a new fact.
  const rank = (f: Finding) => SEVERITIES.indexOf(f.severity);
  const known = (f: Finding) =>
    delta.findings.some((c) => (findingKey(c) === findingKey(f) || (c.fingerprint ?? print(c)) === print(f)) && rank(f) >= rank(c));
  const newFindings = findings.filter((f) => !known(f) && !isVariant(f)).length;
  // The findings of the last review on a file that did not change: the model did not read them again.
  // A finding settled since (fixed, dismissed or kept) does not come back (withoutSettled).
  const kept = withoutSettled(delta.findings, delta.settled, (c) => c.fingerprint ?? print(c))
    // Only a file at the head: the old path of a rename is in the diff of the pull request, not at the head.
    .filter((c) => ofPullRequest.has(c.path.replace(/^\/+/, '')) && !reread.has(c.path.replace(/^\/+/, '')) && fileAt(c.path) !== null)
    .filter((c) => !findings.some((f) => findingKey(f) === findingKey(c)))
    .map(({ fingerprint: _f, anchor: _a, blocking: _b, suggestion_range: _r, ...c }: CarriedFinding & Record<string, unknown>) => c as unknown as F);
  findings = [...findings, ...kept];
  const confidence = newFindings === 0 ? Math.max(Number(answer.confidence_score) || 0, delta.score) : answer.confidence_score;
  // The score that the floor lifted, for the log: the model said less, with no new finding.
  const said = Number(answer.confidence_score) || 0;
  const floored = newFindings === 0 && said < delta.score ? { model: said, kept: delta.score } : null;
  return { answer: { ...answer, confidence_score: confidence, findings }, newFindings, dropped, floored };
}
