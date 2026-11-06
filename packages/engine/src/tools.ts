// REV-68. The tools that let the model read the repository during a review: `read_file` and `grep`.
//
// The pack stays the start of the review. When the model needs code that the pack does not hold (a
// file cut for the size, a caller, a convention), it asks for it. Both tools read the commit of the
// head through git objects (`git show`, `git grep <head>`): never the working tree, never a path out
// of the repository, and never a write. A budget per level caps the calls, the bytes and the rounds.
import { execFileSync } from 'node:child_process';
import type { Level } from '../../protocol/src/index.ts';

/** What the tools of one review may use. */
export type ToolBudget = {
  /** The model calls that may ask for tools; the call after the last one must answer. */
  rounds: number;
  /** The tool calls in all, across the rounds. */
  calls: number;
  /** The bytes of tool results in all. About 4 bytes a token. */
  bytes: number;
};

/**
 * The budget of each level. Each round sends the conversation again, pack included, so the rounds
 * cost most: the caps are low until the bench measures the gain (REV-68).
 * - lite: 3 rounds, 8 calls, 40 kB (about 10,000 tokens of results).
 * - balanced: 5 rounds, 16 calls, 80 kB.
 * - heavy: 8 rounds, 24 calls, 120 kB.
 */
export const TOOL_BUDGETS: Record<Level, ToolBudget> = {
  lite: { rounds: 3, calls: 8, bytes: 40_000 },
  balanced: { rounds: 5, calls: 16, bytes: 80_000 },
  heavy: { rounds: 8, calls: 24, bytes: 120_000 },
};

/** The most lines that one `read_file` gives. */
export const MAX_READ_LINES = 400;
/** The largest file that `read_file` reads: `git show` loads the whole file before the line window. */
export const MAX_FILE_BYTES = 2_000_000;
/** The most lines that one `grep` gives, and the most characters of each. */
export const MAX_GREP_LINES = 80;
const MAX_GREP_LINE_CHARS = 300;
const GIT_TIMEOUT_MS = 10_000;
const CUT_NOTE = '\n[cut: the tool budget of this review is used]';
/** Below this room, no call runs: a cut result always has room for its note and some text. */
const MIN_ROOM = 100;

/** A tool as the providers describe it: a name, a text for the model, and a JSON schema of its input. */
export type ToolDefinition = { name: 'read_file' | 'grep'; description: string; input_schema: object };

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      `Read lines of a file of the repository at the head of the pull request. Lines are numbered from 1. ` +
      `At most ${MAX_READ_LINES} lines a call. Use it for code that the pack does not show.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path from the root of the repository, for example src/app.ts.' },
        from: { type: 'integer', minimum: 1, description: 'The first line. Default 1.' },
        to: { type: 'integer', minimum: 1, description: `The last line. Default from + ${MAX_READ_LINES - 1}.` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description:
      `Search the repository at the head of the pull request with an extended regular expression (POSIX ERE). ` +
      `Gives path:line:text, at most ${MAX_GREP_LINES} lines. Use it to find a caller, a definition or a convention.`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regular expression, for example "function sendEmail|sendEmail\\(".' },
        glob: { type: 'string', description: 'The files to search, for example "src/**/*.ts". Default: every file.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
];

/** A tool call of the model, with its input as the provider gave it. */
export type ToolCall = { name: string; input: unknown };

/** What the tools used in one review: the review body and the bench report it. */
export type ToolUse = { rounds: number; calls: number; bytes: number };

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A path of the repository: relative, with no `..`, no `.`, no empty part and no control character. */
export function safePath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const clean = path.trim().replace(/^\.\//, '');
  if (!clean || clean.length > 1000 || clean.startsWith('/') || clean.startsWith(':') || /[\0-\x1f\\]/.test(clean)) return null;
  if (clean.split('/').some((part) => part === '..' || part === '.' || part === '')) return null;
  return clean;
}

/** A glob of paths: as a path, with `*`, `?` and `**` allowed. */
function safeGlob(glob: unknown): string | null {
  if (glob === undefined || glob === null || glob === '') return '';
  return safePath(glob);
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * The tools of one review on one checkout. `head` is the commit that the tools read. `run` answers
 * each call with a text for the model, and counts it against the budget: an error is an answer too,
 * so that the model can correct its call.
 */
export class RepoTools {
  readonly used: ToolUse = { rounds: 0, calls: 0, bytes: 0 };
  private readonly repo: string;
  private readonly head: string;
  readonly budget: ToolBudget;

  constructor(repo: string, head: string, budget: ToolBudget) {
    this.repo = repo;
    this.head = head;
    this.budget = budget;
  }

  /** Whether the model may get tools in its next call. Counts the round when it may. */
  startRound(): boolean {
    if (this.used.rounds >= this.budget.rounds || this.exhausted()) return false;
    this.used.rounds++;
    return true;
  }

  /** Whether no call may run: no call left, or less room than MIN_ROOM bytes. */
  private exhausted(): boolean {
    return this.used.calls >= this.budget.calls || this.budget.bytes - this.used.bytes < MIN_ROOM;
  }

  run(call: ToolCall): string {
    if (this.exhausted()) {
      // This answer is not counted: it is the same short text every time, and no call runs.
      return 'Tool budget used: answer now with what you have read.';
    }
    this.used.calls++;
    let text: string;
    try {
      const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
      if (call.name === 'read_file') text = this.readFile(input);
      else if (call.name === 'grep') text = this.grep(input);
      else text = `Unknown tool ${JSON.stringify(call.name)}: the tools are read_file and grep.`;
    } catch (error) {
      text = `The tool failed: ${String((error as Error).message ?? error).split('\n')[0]}`;
    }
    const room = this.budget.bytes - this.used.bytes;
    if (Buffer.byteLength(text) > room) {
      // `exhausted` keeps room >= MIN_ROOM, so the note fits.
      const bytes = Buffer.from(text);
      let cut = room - Buffer.byteLength(CUT_NOTE);
      // Back off to the start of a character: a UTF-8 continuation byte is 0b10xxxxxx.
      while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
      text = `${bytes.subarray(0, cut).toString('utf8')}${CUT_NOTE}`;
      // A cut result uses the rest of the budget: no call after it.
      this.used.bytes = this.budget.bytes;
      return text;
    }
    this.used.bytes += Buffer.byteLength(text);
    return text;
  }

  private readFile(input: Record<string, unknown>): string {
    const path = safePath(input.path);
    if (!path) return 'read_file needs a path from the root of the repository, with no "..".';
    // `ls-tree` gives the type from the tree: a submodule is a `commit` that the repository does not hold.
    const entry = git(this.repo, ['ls-tree', '-z', this.head, '--', path]).split('\0')[0] ?? '';
    const tab = entry.indexOf('\t');
    if (tab < 0 || entry.slice(tab + 1) !== path) return `${path} is not in the repository at the head.`;
    const kind = entry.split(' ')[1];
    if (kind === 'commit') return `${path} is a submodule: its code is not in this repository.`;
    if (kind !== 'blob') return `${path} is a folder: use grep with the glob "${path}/**" to list what it holds.`;
    const size = Number(git(this.repo, ['cat-file', '-s', `${this.head}:${path}`]).trim());
    if (size > MAX_FILE_BYTES) return `${path} has ${size} bytes, more than the ${MAX_FILE_BYTES} that read_file reads. Use grep on it.`;
    const text = git(this.repo, ['show', `${this.head}:${path}`]);
    if (text.includes('\0')) return `${path} is a binary file.`;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const from = positive(input.from) ?? 1;
    if (from > lines.length) return `${path} has ${lines.length} lines: line ${from} is past its end.`;
    const to = Math.min(positive(input.to) ?? from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1, lines.length);
    if (to < from) return `read_file needs from <= to.`;
    const body = lines.slice(from - 1, to).map((line, i) => `${from + i}| ${line}`).join('\n');
    const more = to < lines.length ? `\n[${path}: lines ${from}-${to} of ${lines.length}]` : '';
    return `${path}\n${body}${more}`;
  }

  private grep(input: Record<string, unknown>): string {
    const pattern = input.pattern;
    if (typeof pattern !== 'string' || !pattern || pattern.length > 500 || pattern.includes('\0')) return 'grep needs a pattern of 1 to 500 characters.';
    const glob = safeGlob(input.glob);
    if (glob === null) return 'grep needs a glob from the root of the repository, with no "..".';
    // `-e` keeps a pattern that starts with `-` a pattern. `:(glob)` reads `**` as any folders.
    const args = ['grep', '-n', '-I', '-E', '--no-color', '-e', pattern, this.head, '--'];
    if (glob) args.push(`:(glob)${glob}`);
    let out: string;
    try {
      out = git(this.repo, args);
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      // git grep exits 1 when nothing matches.
      if (failure.status === 1 && !failure.stderr) return 'No match.';
      return `grep failed: ${String(failure.stderr ?? error).trim().split('\n')[0]}`;
    }
    const prefix = `${this.head}:`;
    const rows = out.split('\n').filter(Boolean);
    const shown = rows.slice(0, MAX_GREP_LINES).map((row) => {
      const line = row.startsWith(prefix) ? row.slice(prefix.length) : row;
      return line.length > MAX_GREP_LINE_CHARS ? `${line.slice(0, MAX_GREP_LINE_CHARS)}…` : line;
    });
    const more = rows.length > MAX_GREP_LINES ? `\n[${rows.length - MAX_GREP_LINES} more lines: narrow the pattern or the glob]` : '';
    return `${shown.join('\n')}${more}`;
  }
}
