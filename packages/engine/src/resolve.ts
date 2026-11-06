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
export function resolvePack(repo: string, base: string, head: string, threads: OpenThread[]): { pack: string; held: OpenThread[] } {
  const header = `# Open review threads at the head ${head.slice(0, 9)}\n`;
  const sections: string[] = [];
  const held: OpenThread[] = [];
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
    const section = parts.join('');
    if (size + section.length > MAX_RESOLVE_PACK_BYTES) break;
    sections.push(section);
    held.push(t);
    size += section.length;
  }
  return { pack: header + sections.join(''), held };
}
