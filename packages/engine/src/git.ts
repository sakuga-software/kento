// Git, read only: the engine reads the checkout and never runs its code.
import { execFileSync } from 'node:child_process';

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
