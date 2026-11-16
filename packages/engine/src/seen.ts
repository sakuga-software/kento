// REV-100. The code that an earlier review of Kentō already read.
//
// A finding of a later review on code that did not change since the earlier review is a defect that
// the earlier review saw and did not report: 74 of the 357 late findings of the analysis of
// 2026-11-09, such as "STUDIO_HOST is not in .env.example and has no documentation" at the second review of
// dojo#91. Each one kept the pull request in CHANGES_REQUESTED for one more loop. Such a finding,
// when it is not critical, now goes in a list "To consider" and does not block (findings.ts).
//
// A line is new when the diff from the last reviewed commit to the head touches its zone: the lines
// of the finding and SEEN_MARGIN lines around them. A file that the last reviewed commit did not
// hold is new. A last reviewed commit that a force-push removed makes everything new.
import { git } from './git.ts';
import { inHistory } from './history.ts';
import type { Finding } from './findings.ts';

/** The lines around a finding that must not have changed for its code to count as already read. */
export const SEEN_MARGIN = 5;
/** The section of the changed zones holds at most this many bytes. */
export const MAX_CHANGED_ZONES_BYTES = 6_000;

/**
 * What changed since the last reviewed commit: the lines of each file at the head that the diff
 * adds or changes, or next to which it removes lines. Null when the commit is not in the history of
 * the head: nothing can tell what changed since.
 */
export type SeenCode = { since: string; changed: Map<string, Set<number>>; existed: (path: string) => boolean };

export function seenCode(repo: string, since: string | null | undefined, head: string): SeenCode | null {
  if (!since || !inHistory(repo, since, head)) return null;
  const changed = new Map<string, Set<number>>();
  // The paths come from `-z`, one diff per path: git quotes a path that is not ASCII in the header of
  // a patch (`+++ "b/caf\303\251.ts"`), and a parser of the headers would miss that file.
  const paths = git(repo, 'diff', '--name-only', '-z', '--no-renames', `${since}..${head}`).split('\0').filter(Boolean);
  for (const path of paths) {
    const lines = new Set<number>();
    changed.set(path, lines);
    for (const row of git(repo, '--literal-pathspecs', 'diff', '-U0', '--no-renames', `${since}..${head}`, '--', path).split('\n')) {
      if (!row.startsWith('@@')) continue;
      const match = /\+(\d+)(?:,(\d+))?/.exec(row)!;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      // A hunk that only removes lines sits between `start` and the next line.
      if (count === 0) lines.add(start).add(start + 1);
      for (let n = start; n < start + count; n++) lines.add(n);
    }
  }
  const atSince = new Set(git(repo, 'ls-tree', '-r', '-z', '--name-only', since).split('\0').filter(Boolean));
  return { since, changed, existed: (p) => atSince.has(p) };
}

/** Whether the code of a finding did not change since the last reviewed commit. */
export function isSeen(finding: Finding, seen: SeenCode): boolean {
  const path = finding.path.replace(/^\/+/, '');
  if (!seen.existed(path)) return false;
  const lines = seen.changed.get(path);
  if (!lines) return true;
  const from = Math.min(finding.start_line || finding.line, finding.line) - SEEN_MARGIN;
  const to = finding.line + SEEN_MARGIN;
  for (const n of lines) if (n >= from && n <= to) return false;
  return true;
}

/** Consecutive line numbers as ranges: `12–18, 40`. */
function ranges(lines: Set<number>): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/**
 * The section of the pack that names the zones that changed since the last reviewed commit, in the
 * files of the pull request. Empty without a last reviewed commit in the history of the head.
 */
export function changedZonesSection(seen: SeenCode | null, pullFiles: readonly string[]): string {
  if (!seen) return '';
  const files = new Set(pullFiles);
  const rows: string[] = [];
  let size = 0;
  for (const [path, lines] of [...seen.changed].sort(([a], [b]) => a.localeCompare(b))) {
    if (!files.has(path) || !lines.size) continue;
    const row = `- \`${path.replace(/[`<>]/g, "'")}\`: ${seen.existed(path) ? `lines ${ranges(lines)}` : 'new file'}\n`;
    if (size + row.length > MAX_CHANGED_ZONES_BYTES) {
      rows.push('- (more zones: the list stops here)\n');
      break;
    }
    rows.push(row);
    size += row.length;
  }
  const intro =
    `## Changed since the last review\n\nAn earlier review of Kentō read this pull request at commit ${seen.since.slice(0, 9)}. ` +
    'These zones of the head changed since then; the rest of the code was read by that review. Look at these zones first.\n\n';
  return `${intro}${rows.length ? rows.join('') : '- No file of the pull request changed since then.\n'}\n`;
}
