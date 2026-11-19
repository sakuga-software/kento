// REV-121. bench:cases writes the cases of the repositories that Kentō reviews, private ones too.
// This repository is public: the cases go outside its work tree (the internal bench), or to a
// file that git ignores.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The root of the git work tree that holds `dir`, or null when no work tree holds it. */
export function workTreeOf(dir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** The path with its links resolved, also when its last folders do not exist yet. */
function real(path: string): string {
  let rest: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(current), ...rest)
    } catch {
      let parent = dirname(current)
      if (parent === current) return resolve(path)
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/** True when `out` is in the work tree `root` and git does not ignore it: git would track the file. */
export function wouldTrack(out: string, root: string): boolean {
  let path = relative(real(root), real(out))
  // A folder of the work tree can start with two dots (`..cases`): only `..` itself goes up.
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return false
  try {
    // Exit code 0: git ignores the path. 1 (not ignored) or another error: refuse.
    execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' })
    return false
  } catch {
    return true
  }
}
