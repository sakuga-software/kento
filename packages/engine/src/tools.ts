// REV-68. The tools that let the model read the repository during a review: `read_file` and `grep`.
//
// The pack stays the start of the review. When the model needs code that the pack does not hold (a
// file cut for the size, a caller, a convention), it asks for it. Both tools read the commit of the
// head through git objects (`git show`, `git grep <head>`): never the working tree, never a path out
// of the repository, and never a write. A budget per level caps the calls, the bytes and the rounds.
// REV-130: git runs asynchronously, so the heartbeat of the runner continues during a call. A time
// limit per call and per review, a memory limit on git, and a check of the grep pattern stop a
// pattern that blocks git or fills the memory of the runner.
import { execFile } from 'node:child_process';
import type { Level } from '../../protocol/src/index.ts';

/** What the tools of one review may use. */
export type ToolBudget = {
  /**
   * The requests of one conversation (one pass, one model) that may ask for tools; the request after
   * the last one must answer.
   */
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
/** The longest time of one git call. */
export const GIT_TIMEOUT_MS = 10_000;
/** The longest time of the git calls of one review, in all. */
export const TOOLS_TIME_MS = 60_000;
/**
 * The most copies that the repetitions of a grep pattern may make: see `unsafeGrepPattern`. It is a
 * cheap first filter only: a pattern under it can still use much memory on content that the author
 * of the pull request chose. GIT_MEMORY_KB bounds the memory (REV-130).
 */
export const MAX_GREP_COPIES = 1_000;
/**
 * The most virtual memory of one git process (`ulimit -v`, in kB). The runner has 2 GB in all, the
 * clone included: git stops with an error above this limit, and the kernel never has to choose a
 * process to kill (REV-130).
 */
export const GIT_MEMORY_KB = 512 * 1024;
/**
 * The settings that keep git under GIT_MEMORY_KB: small windows on the pack files, and 2 grep threads,
 * because each thread compiles its own copy of the pattern.
 */
const GIT_LIMITS = ['-c', 'core.packedGitWindowSize=32m', '-c', 'core.packedGitLimit=256m', '-c', 'grep.threads=2'];
/**
 * Sets the memory limit, then runs git with the arguments as they are: they never go through the
 * text of the script. Where the system refuses the limit (macOS), git runs without it.
 * MALLOC_ARENA_MAX keeps the memory that glibc reserves for each thread small.
 */
const LIMITED_GIT = 'ulimit -v "$1" 2>/dev/null; shift; MALLOC_ARENA_MAX=2 exec git "$@"';
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

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/** Why a git call failed, in the words that the model reads. */
export type GitFailure =
  /** The time limit of the call stopped it. */
  | 'time'
  /** It ran out of memory: an error of git, or a signal (the kernel, or a crash on a failed allocation). */
  | 'memory'
  /** It wrote more than MAX_GIT_OUTPUT. */
  | 'output'
  /** Another error: its exit code and its stderr. */
  | 'other';

const OUT_OF_MEMORY = /out of memory|memory exhausted|cannot allocate|malloc failed|mmap failed|unable to create thread/i;
/**
 * The signals of a process that ran out of memory: the kernel kills it (SIGKILL), or it crashes on a
 * failed allocation. Another signal, such as a SIGTERM when the runner stops, is no memory failure.
 */
const MEMORY_SIGNALS = new Set(['SIGKILL', 'SIGSEGV', 'SIGABRT', 'SIGBUS']);

/**
 * The cause of a failed git call, from the error of `execFile` and the stderr of git. `killed`: node
 * stopped it, at the time limit.
 */
export function gitFailure(error: { code?: number | string; killed?: boolean; signal?: string | null }, stderr: string): GitFailure {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output';
  if (error.killed === true) return 'time';
  if ((error.signal && MEMORY_SIGNALS.has(error.signal)) || OUT_OF_MEMORY.test(stderr)) return 'memory';
  return 'other';
}

/** A failed git call, with its cause. */
class GitError extends Error {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly failure: GitFailure;

  constructor(failure: GitFailure, status: number | null, signal: string | null, stderr: string) {
    const first = stderr.trim().split('\n')[0] ?? '';
    super(
      failure === 'time'
        ? 'git took too long'
        : failure === 'memory'
          ? first || `git stopped with ${signal ?? 'an error'}`
          : failure === 'output'
            ? `git wrote more than ${MAX_GIT_OUTPUT / 1024 / 1024} MB`
            : first || (signal ? `git stopped with ${signal}` : `git exited with ${status}`),
    );
    this.failure = failure;
    this.status = status;
    this.signal = signal;
    this.stderr = stderr;
  }
}

/** Runs git without blocking the event loop, under GIT_MEMORY_KB. `timeoutMs` stops it with SIGKILL. */
function git(repo: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-c', LIMITED_GIT, 'sh', String(GIT_MEMORY_KB), ...GIT_LIMITS, ...args],
      {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
        timeout: Math.max(1, timeoutMs),
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const failure = error as Error & { code?: number | string; killed?: boolean; signal?: string | null };
        const status = typeof failure.code === 'number' ? failure.code : null;
        const signal = failure.signal ?? null;
        const text = String(stderr ?? '');
        reject(new GitError(gitFailure(failure, text), status, signal, text));
      },
    );
  });
}

/**
 * Why a grep pattern can make git use too much time or memory, or null when it is safe (REV-130).
 * - A back reference `\1` to `\9` makes the matcher of git exponential.
 * - The matcher of `git grep -E` (glibc regex) copies a repeated part once for each count: `a{1,100}`
 *   holds 100 copies of `a`, and a repetition of a repetition multiplies the copies.
 *   `((a{1,100}){1,100}){1,100}b` holds 1,000,000 copies and fills 2 GB in 3 s. The check computes the
 *   copies and refuses more than MAX_GREP_COPIES. `*` and `?` make no copy, and `+` makes one.
 * It reads the pattern as POSIX ERE: `\` escapes the next character, and a bracket expression is one character.
 */
export function unsafeGrepPattern(pattern: string): string | null {
  // One frame for each open group: the copies that it holds, and the copies of its last part (for a quantifier after it).
  const groups: { copies: number; last: number }[] = [{ copies: 0, last: 0 }];
  for (let i = 0; i < pattern.length; i++) {
    const frame = groups[groups.length - 1]!;
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (next >= '1' && next <= '9') return 'grep does not accept a back reference (\\1 to \\9).';
      i++;
    } else if (c === '[') {
      // `[`, then `^` and `]` as the first members, then up to the closing `]`. `[:alpha:]`, `[=a=]` and `[.a.]` hold a `]`.
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') {
        const open = pattern[j] === '[' ? pattern[j + 1] : undefined;
        if (open === ':' || open === '=' || open === '.') {
          const close = pattern.indexOf(`${open}]`, j + 2);
          j = close < 0 ? pattern.length : close + 2;
        } else j++;
      }
      i = j;
    } else if (c === '(') {
      groups.push({ copies: 0, last: 0 });
      continue;
    } else if (c === ')' && groups.length > 1) {
      // An empty group, `()` or `(|)`, is a node of the matcher too: it counts 1.
      const copies = Math.max(1, groups.pop()!.copies);
      const parent = groups[groups.length - 1]!;
      parent.copies += copies;
      parent.last = copies;
      continue;
    } else if (c === '|') {
      frame.last = 0;
      continue;
    } else {
      const bound = c === '{' ? /^\{(\d*)(,?)(\d*)\}/.exec(pattern.slice(i)) : null;
      if (c === '*' || c === '+' || c === '?' || bound) {
        let times = c === '+' ? 2 : 1;
        if (bound) {
          // `{n}` has n copies, `{n,}` has n + 1 (n, then a star), `{n,m}` and `{,m}` have m.
          const low = Number(bound[1] || 0);
          times = Math.max(1, bound[3] ? Number(bound[3]) : bound[2] ? low + 1 : low);
          i += bound[0].length - 1;
        }
        frame.copies += frame.last * (times - 1);
        frame.last *= times;
        if (groups.some((g) => g.copies > MAX_GREP_COPIES)) break;
        continue;
      }
    }
    // One character, an escaped character or a bracket expression.
    frame.copies += 1;
    frame.last = 1;
  }
  const copies = groups.reduce((sum, g) => sum + g.copies, 0);
  if (copies > MAX_GREP_COPIES) {
    return `grep does not accept this pattern: its repetitions make more than ${MAX_GREP_COPIES} copies. Use smaller counts in {n,m}, and do not repeat a repeated group.`;
  }
  return null;
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
  /** The time limits of git: one call, and all the calls of the review. Tests make them small. */
  private readonly time: { callMs: number; totalMs: number };
  /** Whether grep checks its pattern first. Tests turn it off to reach the memory limit of git. */
  private readonly checkPattern: boolean;
  /** The milliseconds that the git calls of this review used. */
  private spentMs = 0;
  /** The calls run one at a time: the passes of a review run at once, and two git greps would use twice the memory. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(repo: string, head: string, budget: ToolBudget, options: { callMs?: number; totalMs?: number; checkPattern?: boolean } = {}) {
    this.repo = repo;
    this.head = head;
    this.budget = budget;
    this.time = { callMs: options.callMs ?? GIT_TIMEOUT_MS, totalMs: options.totalMs ?? TOOLS_TIME_MS };
    this.checkPattern = options.checkPattern ?? true;
  }

  /**
   * Whether a conversation may offer tools in its request number `round` (from 0). Each conversation
   * counts its own rounds: the passes of a review run at once, and one pass must not use the rounds
   * of another. The calls and the bytes stay one budget for the whole review: they are what the
   * review costs.
   */
  startRound(round: number): boolean {
    return round < this.budget.rounds && !this.exhausted();
  }

  /** Counts a round whose tool calls ran, for `used.rounds`. */
  ranRound(): void {
    this.used.rounds++;
  }

  /** Whether no call may run: no call left, less room than MIN_ROOM bytes, or no time left. */
  private exhausted(): boolean {
    return this.used.calls >= this.budget.calls || this.budget.bytes - this.used.bytes < MIN_ROOM || this.spentMs >= this.time.totalMs;
  }

  /** One git call, with the time that is left: the smaller of the limit of a call and the rest of the review. */
  private async git(args: string[]): Promise<string> {
    const start = performance.now();
    try {
      return await git(this.repo, args, Math.min(this.time.callMs, this.time.totalMs - this.spentMs));
    } finally {
      this.spentMs += performance.now() - start;
    }
  }

  /** Answers one call. The calls of a review run one after the other, in the order of `run`. */
  run(call: ToolCall): Promise<string> {
    const answer = this.queue.then(() => this.runOne(call));
    this.queue = answer.catch(() => undefined);
    return answer;
  }

  private async runOne(call: ToolCall): Promise<string> {
    if (this.exhausted()) {
      // This answer is not counted: it is the same short text every time, and no call runs.
      return 'Tool budget used: answer now with what you have read.';
    }
    this.used.calls++;
    let text: string;
    try {
      const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
      if (call.name === 'read_file') text = await this.readFile(input);
      else if (call.name === 'grep') text = await this.grep(input);
      else text = `Unknown tool ${JSON.stringify(call.name)}: the tools are read_file and grep.`;
    } catch (error) {
      text =
        error instanceof GitError && error.failure === 'time'
          ? 'The tool took too long and was stopped.'
          : `The tool failed: ${String((error as Error).message ?? error).split('\n')[0]}`;
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

  private async readFile(input: Record<string, unknown>): Promise<string> {
    const path = safePath(input.path);
    if (!path) return 'read_file needs a path from the root of the repository, with no "..".';
    // `ls-tree` gives the type from the tree: a submodule is a `commit` that the repository does not hold.
    const entry = (await this.git(['ls-tree', '-z', this.head, '--', path])).split('\0')[0] ?? '';
    const tab = entry.indexOf('\t');
    if (tab < 0 || entry.slice(tab + 1) !== path) return `${path} is not in the repository at the head.`;
    const kind = entry.split(' ')[1];
    if (kind === 'commit') return `${path} is a submodule: its code is not in this repository.`;
    if (kind !== 'blob') return `${path} is a folder: use grep with the glob "${path}/**" to list what it holds.`;
    const size = Number((await this.git(['cat-file', '-s', `${this.head}:${path}`])).trim());
    if (size > MAX_FILE_BYTES) return `${path} has ${size} bytes, more than the ${MAX_FILE_BYTES} that read_file reads. Use grep on it.`;
    const text = await this.git(['show', `${this.head}:${path}`]);
    if (text.includes('\0')) return `${path} is a binary file.`;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length === 0) return `${path} is empty.`;
    const from = positive(input.from) ?? 1;
    if (from > lines.length) return `${path} has ${lines.length} lines: line ${from} is past its end.`;
    const to = Math.min(positive(input.to) ?? from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1, lines.length);
    if (to < from) return `read_file needs from <= to.`;
    const body = lines.slice(from - 1, to).map((line, i) => `${from + i}| ${line}`).join('\n');
    const more = to < lines.length ? `\n[${path}: lines ${from}-${to} of ${lines.length}]` : '';
    return `${path}\n${body}${more}`;
  }

  private async grep(input: Record<string, unknown>): Promise<string> {
    const pattern = input.pattern;
    if (typeof pattern !== 'string' || !pattern || pattern.length > 500 || pattern.includes('\0')) return 'grep needs a pattern of 1 to 500 characters.';
    const unsafe = this.checkPattern ? unsafeGrepPattern(pattern) : null;
    if (unsafe) return unsafe;
    const glob = safeGlob(input.glob);
    if (glob === null) return 'grep needs a glob from the root of the repository, with no "..".';
    // `-e` keeps a pattern that starts with `-` a pattern. `:(glob)` reads `**` as any folders.
    const args = ['grep', '-n', '-I', '-E', '--no-color', '-e', pattern, this.head, '--'];
    if (glob) args.push(`:(glob)${glob}`);
    let out: string;
    try {
      out = await this.git(args);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      if (error.failure === 'time') return 'grep took too long and was stopped: use a simpler pattern or a narrower glob.';
      if (error.failure === 'memory') return `grep stopped: the pattern needs more memory than git may use (${error.message}). Use a simpler pattern, or plain text with no repetition.`;
      if (error.failure === 'output') return `grep failed: ${error.message}. Narrow the pattern or the glob.`;
      // git grep exits 1 when nothing matches.
      if (error.status === 1 && !error.stderr) return 'No match.';
      return `grep failed: ${error.message}`;
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

/** What the prompt of a review with tools adds: the pack first, the tools for what it lacks. */
export const TOOLS_NOTE = [
  '## Tools',
  '',
  'You can call `read_file` and `grep` on the repository at the head of the pull request. The pack above is your start: read it first.',
  'Call a tool only when a finding depends on code that the pack does not show: a file left out of the pack, a caller, a definition, a guard, a convention.',
  'Before you report that something is missing, undefined or not imported, check it with a tool.',
  'You have a small budget of calls. When a tool says that the budget is used, answer with what you have.',
].join('\n');

/** The tools in the form of the Messages API of Anthropic. */
export function anthropicTools(): object[] {
  return TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

/** The tools in the form of the chat completions API (OpenRouter). */
export function chatTools(): object[] {
  return TOOL_DEFINITIONS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}
