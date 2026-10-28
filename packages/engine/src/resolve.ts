// The answer to the open threads: the pack of each thread with its code now and its diff since.
import { git } from './git.ts';
import { diffStart, fileDiff } from './history.ts';

export type ThreadComment = { id: number; author: string; isBot: boolean; body: string; commit?: string };
export type OpenThread = { id: string; path: string; line: number | null; comments: ThreadComment[] };
export type ThreadVerdict = { id: string; verdict: 'fixed' | 'answered' | 'open'; reply: string };

export const MAX_THREADS = 20;
const MAX_THREAD_COMMENT_CHARS = 2000;
const MAX_THREAD_DIFF_BYTES = 6000;
const THREAD_CODE_RADIUS = 25;
export const MAX_RESOLVE_PACK_BYTES = 150_000;
// A minified or generated line can hold thousands of characters.
const MAX_CODE_LINE_CHARS = 400;
export const markerResolve = (head: string) => `<!-- sakuga-review:resolve ${head.slice(0, 12)} -->`;

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

const TRUNCATED = '[… coupé ici]';

/** The text cut to a size, with a mark that the model sees when the cut drops something. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n${TRUNCATED}` : text;
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const DETAILS_BLOCK = /<details>[\s\S]*?<\/details>/g;
const MEDIA_TAG = /<(img|a|picture|source)\b[^>]*>/g;

/** A removal can join the text around it into a new match: `<!<!---->-- x -->`. Repeat until the text is stable. */
function removeAll(text: string, pattern: RegExp): string {
  let current = text;
  for (let previous = ''; previous !== current;) {
    previous = current;
    current = current.replace(pattern, '');
  }
  return current;
}

export const cleanBody = (body: string) =>
  cut(
    removeAll(removeAll(removeAll(body, HTML_COMMENT), DETAILS_BLOCK), MEDIA_TAG)
      .trim(),
    MAX_THREAD_COMMENT_CHARS,
  );

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
    parts.push(`\n## Thread ${t.id}\n\n\`${t.path}:${t.line ?? '?'}\`, opened by ${opener.author} (${opener.isBot ? 'a bot' : 'a person'})\n\n### Comments\n`);
    for (const c of t.comments) parts.push(`\n**${c.author}** (${c.isBot ? 'bot' : 'person'}):\n\n${cleanBody(c.body)}\n`);
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
