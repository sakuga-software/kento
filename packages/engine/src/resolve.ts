// The answer to the open threads: the pack of each thread with its code now and its diff since.
import { MAX_RESOLVE_PACK_BYTES } from '../../protocol/src/index.ts';
import { git } from './git.ts';
import { diffStart, fileDiff } from './history.ts';
import { cleanBody, cut, markerResolve } from './threads.ts';

export { cleanBody, markerResolve };

export type ThreadComment = { id: number; author: string; isBot: boolean; body: string; commit?: string };
export type OpenThread = { id: string; path: string; line: number | null; comments: ThreadComment[] };
export type ThreadVerdict = { id: string; verdict: 'fixed' | 'answered' | 'open'; reply: string };

const MAX_THREAD_DIFF_BYTES = 6000;
/**
 * KNT-197. The diffs of the other files changed since a thread opened, for that thread: a fix can be
 * in another file (a helper, the store). At most this many bytes a thread, each diff cut at
 * MAX_THREAD_DIFF_BYTES, the files that the thread names first.
 */
export const MAX_OTHER_FILES_BYTES = 12_000;
const THREAD_CODE_RADIUS = 25;
// A minified or generated line can hold thousands of characters.
const MAX_CODE_LINE_CHARS = 400;

export const RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['fixed', 'answered', 'open'] },
          reply: { type: 'string' },
        },
        required: ['id', 'verdict', 'reply'],
        additionalProperties: false,
      },
    },
  },
  required: ['threads'],
  additionalProperties: false,
};

/**
 * The comments of a thread as the model reads them: where it is, who opened it, then each comment
 * cleaned and cut. `resolve` and the review (answered.ts, REV-71) both show a thread this way.
 */
export function threadComments(t: OpenThread, heading: string): string {
  const opener = t.comments[0];
  const parts = [`\`${t.path}:${t.line ?? '?'}\`, opened by ${opener.author} (${opener.isBot ? 'a bot' : 'a person'})\n\n${heading} Comments\n`];
  for (const c of t.comments) parts.push(`\n**${c.author}** (${c.isBot ? 'bot' : 'person'}):\n\n${cleanBody(c.body)}\n`);
  return parts.join('');
}

/**
 * The message that the model reads: each thread, the code at the head around it, and its diff since.
 * It stops before MAX_RESOLVE_PACK_BYTES, and gives the threads that it holds.
 */
/** KNT-197. At most this many other files are read for one thread: the smallest diffs come first. */
const MAX_OTHER_FILES = 100;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * KNT-197. Whether the comments of a thread name a file: its path, its file name, or the stem of its
 * file name (`store` for `app/findings/store.ts`, 4 letters or more) as a word.
 */
function names(text: string, path: string): boolean {
  const file = path.split('/').pop() ?? path;
  const stem = file.replace(/\.[^.]+$/, '');
  return text.includes(path) || new RegExp(`\\b${escape(file)}\\b`).test(text) || (stem.length >= 4 && new RegExp(`\\b${escape(stem)}\\b`, 'i').test(text));
}

/**
 * KNT-197. The diffs of the files other than the file of the thread that changed since `start`, each
 * cut at MAX_THREAD_DIFF_BYTES: the files that the comments of the thread name first, then the
 * smallest diffs first, so that a fix in a helper comes before a large generated file.
 */
function otherDiffs(repo: string, start: { from: string; gone: boolean }, head: string, t: OpenThread): { path: string; diff: string }[] {
  let paths: string[];
  try {
    paths = git(repo, 'diff', '--name-only', start.gone ? `${start.from}...${head}` : `${start.from}..${head}`).split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const text = t.comments.map((c) => c.body).join('\n');
  const read: { path: string; diff: string; named: boolean }[] = [];
  for (const path of paths.filter((p) => p !== t.path).slice(0, MAX_OTHER_FILES)) {
    try {
      read.push({ path, diff: cut(fileDiff(repo, start, head, path), MAX_THREAD_DIFF_BYTES), named: names(text, path) });
    } catch {
      // A file that git cannot diff (a submodule, a path gone meanwhile): left out.
    }
  }
  return read.filter((d) => d.diff).sort((a, b) => Number(b.named) - Number(a.named) || a.diff.length - b.diff.length || a.path.localeCompare(b.path));
}

/**
 * The message that the model reads: each thread, the code at the head around it, and its diff since.
 * It stops before MAX_RESOLVE_PACK_BYTES, and gives the threads that it holds.
 */
/**
 * KNT-197. The files other than `path` that changed since `start`, those that the comments of the
 * thread name first (by path or by file name), then by name.
 */
function otherFiles(repo: string, start: { from: string; gone: boolean }, head: string, t: OpenThread): string[] {
  let names: string[];
  try {
    names = git(repo, 'diff', '--name-only', start.gone ? `${start.from}...${head}` : `${start.from}..${head}`).split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const text = t.comments.map((c) => c.body).join('\n');
  const named = (p: string) => text.includes(p) || new RegExp(`\\b${(p.split('/').pop() ?? p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
  const others = names.filter((p) => p !== t.path).sort();
  return [...others.filter(named), ...others.filter((p) => !named(p))];
}

/**
 * The message that the model reads: each thread, the code at the head around it, its diff since, and
 * (KNT-197) the diffs of the other files changed since it opened, within MAX_OTHER_FILES_BYTES. It
 * stops before MAX_RESOLVE_PACK_BYTES, and gives the threads that it holds, and for each one the other
 * files whose diff it shows (`others`): a thread whose own file did not change can be fixed by them.
 */
export function resolvePack(
  repo: string,
  base: string,
  head: string,
  threads: OpenThread[],
): { pack: string; held: OpenThread[]; others: Map<string, string[]> } {
  const header = `# Open review threads at the head ${head.slice(0, 9)}\n`;
  const sections: string[] = [];
  const held: OpenThread[] = [];
  const others = new Map<string, string[]>();
  let size = header.length;
  for (const t of threads) {
    const parts: string[] = [];
    const opener = t.comments[0];
    parts.push(`\n## Thread ${t.id}\n\n`, threadComments(t, '###'));
    let lines: string[] = [];
    try {
      lines = git(repo, 'show', `${head}:${t.path}`).split('\n');
    } catch {
      parts.push('\n### The code now\n\nThe file does not exist at the head.\n');
    }
    if (lines.length) {
      const center = t.line ?? 1;
      const start = Math.max(1, center - THREAD_CODE_RADIUS);
      const end = Math.min(lines.length, center + THREAD_CODE_RADIUS);
      const code = lines.slice(start - 1, end).map((l, i) => `${start + i}| ${cut(l, MAX_CODE_LINE_CHARS)}`).join('\n');
      parts.push(`\n### The code now, lines ${start}-${end}\n\n\`\`\`\n${code}\n\`\`\`\n`);
    }
    // A force-push can remove the commit of the thread: the diff then starts at the merge base.
    const start = diffStart(repo, opener.commit, base, head);
    let diff = '';
    if (start) {
      try {
        diff = cut(fileDiff(repo, start, head, t.path), MAX_THREAD_DIFF_BYTES);
      } catch {
        diff = '';
      }
    }
    const title = start?.gone
      ? '### The diff of this file in the whole pull request (a force-push removed the commit of the thread)'
      : '### The diff of this file since the thread opened';
    parts.push(diff ? `\n${title}\n\n\`\`\`diff\n${diff}\n\`\`\`\n` : `\n${title}\n\nNo change.\n`);
    let section = parts.join('');
    if (size + section.length > MAX_RESOLVE_PACK_BYTES) break;
    // KNT-197. The other files changed since the thread, in what is left of the two budgets.
    const shown: string[] = [];
    if (start) {
      const room = Math.min(MAX_OTHER_FILES_BYTES, MAX_RESOLVE_PACK_BYTES - size - section.length);
      const files = otherDiffs(repo, start, head, t);
      const diffs: string[] = [];
      let used = 0;
      for (const { path, diff: other } of files) {
        const block = `\n#### \`${path}\`\n\n\`\`\`diff\n${other}\n\`\`\`\n`;
        if (used + block.length > room - 400) continue;
        diffs.push(block);
        shown.push(path);
        used += block.length;
      }
      const left = files.map((f) => f.path).filter((p) => !shown.includes(p));
      if (diffs.length || left.length) {
        const heading = start.gone
          ? '### The other files of the whole pull request (a force-push removed the commit of the thread)'
          : '### The other files changed since the thread opened';
        const rest = left.length ? `\nOther files changed, not shown: ${left.slice(0, 30).map((p) => `\`${p}\``).join(', ')}${left.length > 30 ? ', …' : ''}.\n` : '';
        const block = `\n${heading}\n${diffs.join('')}${rest}`;
        if (size + section.length + block.length <= MAX_RESOLVE_PACK_BYTES) section += block;
        else shown.length = 0;
      }
    }
    sections.push(section);
    held.push(t);
    others.set(t.id, start?.gone ? [] : shown);
    size += section.length;
  }
  return { pack: header + sections.join(''), held, others };
}
