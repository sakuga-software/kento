// The patterns of paths that an admin writes: the paths of the trigger of a repository (REV-12) and
// the paths of a rule (REV-19). The web service and the engine read them in the same way.

/**
 * A pattern as a regular expression: `**` matches any number of folders, `*` and `?` stay in one
 * name. A pattern with no `*`, `?` or final `/` also matches the files under it, as a folder.
 */
export function patternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      // `**/` matches zero or more folders; a final `**` matches the rest.
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const folder = pattern.endsWith('/') || !/[*?]/.test(pattern);
  return new RegExp(`^${source}${folder ? (pattern.endsWith('/') ? '.*' : '(?:/.*)?') : ''}$`);
}

/** Whether one of the changed files is under one of the patterns. No pattern: every path counts. */
export function pathsMatch(patterns: readonly string[], files: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  const regexps = patterns.map(patternToRegExp);
  return files.some((file) => regexps.some((re) => re.test(file)));
}
