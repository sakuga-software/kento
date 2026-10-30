/**
 * The permissions on a repository that let a person give a command or dismiss a finding with a 👎.
 * `maintain` reads as `write` in `permission`.
 */
export const WRITERS: ReadonlySet<string> = new Set(['admin', 'maintain', 'write'])
