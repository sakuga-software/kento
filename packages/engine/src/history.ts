// The commit that a thread names, read against the head of the pull request.
//
// A force-push or a rebase can remove that commit. The checkout then does not hold it, or holds it
// on another line of history. A diff from it fails, or compares two unrelated trees. Each function
// here first checks that the commit is in the history of the head. If it is not, the diff starts at
// the merge base: the review of the whole pull request.

import { execFileSync } from 'node:child_process';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function succeeds(repo: string, ...args: string[]): boolean {
  try {
    git(repo, ...args);
    return true;
  } catch {
    return false;
  }
}

/** Whether the commit is in the checkout and is an ancestor of the head (or the head itself). */
export function inHistory(repo: string, commit: string, head: string): boolean {
  return succeeds(repo, 'cat-file', '-e', `${commit}^{commit}`) && succeeds(repo, 'merge-base', '--is-ancestor', commit, head);
}

/**
 * Where a diff for a thread starts: its commit, or the merge base when a force-push removed that
 * commit from the history of the head. `gone` is true in the second case.
 */
export function diffStart(repo: string, since: string | undefined, base: string, head: string): { from: string; gone: boolean } | null {
  if (!since) return null;
  return inHistory(repo, since, head) ? { from: since, gone: false } : { from: base, gone: true };
}

/**
 * Whether a file changed between the commit of a thread and the head. The answer is null when that
 * commit is not in the history of the head: nobody can tell what changed since the comment.
 */
export function fileChangedSince(repo: string, since: string | undefined, head: string, path: string): boolean | null {
  if (!since) return false;
  if (!inHistory(repo, since, head)) return null;
  return git(repo, 'diff', '--name-only', `${since}..${head}`, '--', path).trim() !== '';
}

/** The diff of a file from the start that `diffStart` gives to the head. */
export function fileDiff(repo: string, start: { from: string; gone: boolean }, head: string, path: string): string {
  // From the merge base, the three dots give the change of the pull request alone.
  return git(repo, 'diff', start.gone ? `${start.from}...${head}` : `${start.from}..${head}`, '--', path);
}
