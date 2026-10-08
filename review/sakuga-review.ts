/**
 * Sakuga Review: one model call reviews a pull request, then the script posts the review. A comment
 * command asks for a review at another level, or for an answer to the open threads.
 *
 *     node review/sakuga-review.ts --repo-dir <checkout> --base <sha> --head <sha> [--level heavy] --dry-run
 *     node review/sakuga-review.ts --repo-dir <checkout> --repository <owner/name> --pr <n> --base <sha> --head <sha>
 *
 * Environment: OPENROUTER_API_KEY, and GITHUB_TOKEN to post. See README.md.
 * Node 24 or later runs this file as is: no package, no build. Keep to erasable TypeScript syntax.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const HERE = import.meta.dirname;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GITHUB_API = 'https://api.github.com';

const BOT_LOGIN = process.env.REVIEW_BOT_LOGIN ?? 'sakuga-review[bot]';

// The pack that the model reads, at most. A larger pull request loses its largest files first.
const MAX_PACK_BYTES = 240_000;
const MAX_FILE_CHANGED_LINES = 1000;
const MAX_DOC_LINES = 400;
const MAX_CONTEXT_BYTES = 60_000;

// A finding blocks the merge at this severity and confidence.
const BLOCKING_SEVERITIES = new Set(['critical', 'major']);
const BLOCKING_CONFIDENCE = 70;
// Each inline comment is a thread that a person must resolve, so only the sure findings get one.
const INLINE_CONFIDENCE = 70;
const MAX_INLINE = 5;

type Level = 'lite' | 'balanced' | 'heavy';
type ContextKind = 'full' | 'definitions';
type LevelConfig = {
  /** The model that answers, then the one that takes over when it fails. */
  models: string[];
  /** The time limit of each attempt, in the order of `models`. */
  timeoutsMs: number[];
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  /** The most a provider can charge, in dollars a million tokens. */
  maxPrice: { prompt: number; completion: number };
  /**
   * The code around the change that the pack holds (see buildContext): `full` adds the callers of
   * the changed code, `definitions` only the definitions that the change uses and the SQL names.
   */
  context: ContextKind;
};

/**
 * The levels of a review. A push gets `lite`; a person asks for another level with a command.
 *
 * - lite: Claude Haiku 5.5 at medium reasoning answers in 20 to 45 seconds for about 1 cent. On
 *   the bench of 2026-10-08 it found as much as GLM-5.3 or more, two to three times faster, with
 *   no failed review. GLM-5.3 takes over when it fails; the price cap keeps GLM-5.3 off the
 *   providers at $1.4 / $4.4, one of which reasons less. The reasoning counts in the output
 *   tokens: at 16,000, a long reasoning left no room for the answer, which came back empty.
 *   The bench measured no gain from the callers at this level (2026-10-04), so lite sends only the
 *   definitions that the change uses: they are small, and they answer what the model otherwise
 *   lists as not reviewed.
 * - balanced: Claude Sonnet 5.5 with the context, about 5 cents. On the bench it found a defect
 *   in a caller that GLM-5.3 missed with the same context.
 * - heavy: Claude Opus 5.5 with the context and more reasoning, about 10 to 50 cents.
 */
const LEVELS: Record<Level, LevelConfig> = {
  lite: {
    models: ['anthropic/claude-haiku-5.5', 'z-ai/glm-5.3'],
    timeoutsMs: [180_000, 240_000],
    effort: 'medium',
    maxTokens: 32_000,
    maxPrice: { prompt: 0.5, completion: 3.5 },
    context: 'definitions',
  },
  balanced: {
    models: ['anthropic/claude-sonnet-5.5'],
    timeoutsMs: [480_000],
    effort: 'medium',
    maxTokens: 24_000,
    maxPrice: { prompt: 3, completion: 15 },
    context: 'full',
  },
  heavy: {
    models: ['anthropic/claude-opus-5.5'],
    timeoutsMs: [720_000],
    effort: 'high',
    maxTokens: 32_000,
    maxPrice: { prompt: 5, completion: 25 },
    context: 'full',
  },
};

/**
 * The configuration of a level. The bench sets REVIEW_MODELS, REVIEW_EFFORT, REVIEW_MAX_TOKENS,
 * REVIEW_TIMEOUT_MS and REVIEW_MAX_PRICE ("prompt,completion").
 */
function levelConfig(level: Level): LevelConfig {
  const config = { ...LEVELS[level] };
  if (process.env.REVIEW_MODELS) config.models = process.env.REVIEW_MODELS.split(',');
  const effort = process.env.REVIEW_EFFORT;
  if (effort === 'low' || effort === 'medium' || effort === 'high') config.effort = effort;
  if (process.env.REVIEW_MAX_TOKENS) config.maxTokens = Number(process.env.REVIEW_MAX_TOKENS);
  if (process.env.REVIEW_TIMEOUT_MS) config.timeoutsMs = config.models.map(() => Number(process.env.REVIEW_TIMEOUT_MS));
  if (process.env.REVIEW_MAX_PRICE) {
    const [prompt, completion] = process.env.REVIEW_MAX_PRICE.split(',').map(Number);
    config.maxPrice = { prompt, completion };
  }
  return config;
}

function isLevel(value: string | undefined): value is Level {
  return value === 'lite' || value === 'balanced' || value === 'heavy';
}
// A finding can anchor on a changed line this far from the line the model named.
const ANCHOR_DISTANCE = 10;

const SKIP =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$|\.snap$|(^|\/)(dist|build|vendor|\.next|\.react-router)\/|drizzle\/migrations\/meta\/|\.gen\.[a-z]+$|\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|mp4|webm|woff2?|ttf|otf|zip|tgz)$/;
const TEST_FILE = /\.test\.|\.spec\.|(^|\/)(tests?|__tests__)\//;

const MARKER_SUMMARY = '<!-- sakuga-review:summary -->';
const FINDING_KEY = /<!-- sakuga-review:finding ([0-9a-f]{12}) -->/;
const MARKER_GONE = '<!-- sakuga-review:gone -->';
const BLOCK_START = '<!-- sakuga-review:start -->';
const BLOCK_END = '<!-- sakuga-review:end -->';
const REVIEW_COUNT = /<!-- sakuga-review:count (\d+) -->/;

const SEVERITY_ORDER = ['critical', 'major', 'minor'] as const;
const CATEGORIES = ['bug', 'security', 'data', 'contract', 'test'] as const;
// The priority that a reader sees: P0 blocks hardest. The colours follow the score labels.
const PRIORITY = { critical: ['P0', 'b60205'], major: ['P1', 'e67e22'], minor: ['P2', '6c757d'] } as const;
const SCORE_COLOUR = ['', 'b60205', 'd93f0b', 'fbca04', 'a2d9a5', '0e8a16'];
const LABEL_PREFIX = 'review: ';

type Severity = (typeof SEVERITY_ORDER)[number];
type Finding = {
  path: string;
  start_line: number;
  line: number;
  severity: Severity;
  category: (typeof CATEGORIES)[number];
  confidence: number;
  title: string;
  scenario: string;
  fix: string;
  suggestion: string;
};
type Answer = {
  confidence_score: number;
  risk: string;
  summary: string;
  diagram: string;
  findings: Finding[];
  not_reviewed: string[];
  /** Whether a stronger level would review this pull request better, and why. */
  deeper_review: { recommended: boolean; reason: string };
};
type Usage = { model?: string; provider?: string; prompt_tokens?: number; completion_tokens?: number; cost?: number };
type ChangedLines = Map<string, Set<number>>;
type Thread = {
  id: string;
  resolved: boolean;
  path: string;
  /** The line of the thread at the head, or null when its line is gone. */
  line: number | null;
  key: string;
  commit?: string;
  commentId: number;
  answered: boolean;
};

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    start_line: { type: 'integer' },
    line: { type: 'integer' },
    severity: { type: 'string', enum: SEVERITY_ORDER },
    category: { type: 'string', enum: CATEGORIES },
    confidence: { type: 'integer' },
    title: { type: 'string' },
    scenario: { type: 'string' },
    fix: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['path', 'start_line', 'line', 'severity', 'category', 'confidence', 'title', 'scenario', 'fix', 'suggestion'],
  additionalProperties: false,
};
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    confidence_score: { type: 'integer' },
    risk: { type: 'string' },
    summary: { type: 'string' },
    diagram: { type: 'string' },
    findings: { type: 'array', items: FINDING_SCHEMA },
    not_reviewed: { type: 'array', items: { type: 'string' } },
    deeper_review: {
      type: 'object',
      properties: { recommended: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['recommended', 'reason'],
      additionalProperties: false,
    },
  },
  required: ['confidence_score', 'risk', 'summary', 'diagram', 'findings', 'not_reviewed', 'deeper_review'],
  additionalProperties: false,
};

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const log = (message: string) => process.stderr.write(`${message}\n`);

// The context: unchanged code that the change uses or that uses the change

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs)$/;
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs'];
const IMPORT = /import\s+(type\s+)?([\w*\s{},$]+?)\s+from\s+['"]([^'"]+)['"]/g;
const DECLARATION = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const MAX_SYMBOLS = 12;
const MAX_SITES = 4;
// A call site shows more lines after the match than before: the arguments and the body of a request follow it.
const LINES_BEFORE_SITE = 6;
const LINES_AFTER_SITE = 16;
const MAX_SNIPPET_LINES = 60;

type Snippet = { path: string; start: number; end: number; reason: string };

function fileAt(repo: string, head: string, path: string, cache: Map<string, string[]>): string[] {
  if (!cache.has(path)) cache.set(path, git(repo, 'show', `${head}:${path}`).split('\n'));
  return cache.get(path)!;
}

/** The lines `git grep` finds at the head, as path and line number. It gives none on no match. */
function grep(repo: string, head: string, args: string[], globs = SOURCE_GLOBS): { path: string; line: number; text: string }[] {
  let out = '';
  try {
    out = git(repo, 'grep', '-n', '-I', ...args, head, '--', ...globs);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [, path, line, text] = /^[^:]+:([^:]+):(\d+):(.*)$/.exec(row) ?? [];
      return { path, line: Number(line), text };
    })
    .filter((m) => m.path && !TEST_FILE.test(m.path));
}

/** The exported declarations of a name at the head. `git grep -E` knows POSIX classes, not `\s` or `\b`. */
function definitionsOf(repo: string, head: string, name: string) {
  const keyword = '(default[[:space:]]+)?(declare[[:space:]]+)?(async[[:space:]]+)?(function\\*?|const|let|class|type|interface|enum)';
  const pattern = `^[[:space:]]*export[[:space:]]+${keyword}[[:space:]]+${name.replace('$', '\\$')}([^[:alnum:]_$]|$)`;
  return grep(repo, head, ['-E', '-e', pattern]);
}

/**
 * The URL of a React Router route file under `routes/api/`, and an ERE that matches the string of a
 * request to that route only. `routes/api/radio/channels/$id/route.ts` gives `/api/radio/channels/:id`
 * and matches `/api/radio/channels/${id}`, but not `/api/radio/channels/${id}/ads`.
 */
function apiRoute(path: string): { url: string; pattern: string } | null {
  const match = /(?:^|\/)routes\/(api\/.+)\.[jt]sx?$/.exec(path);
  if (!match) return null;
  const segments = match[1].split('/');
  if (segments.at(-1) === 'route') segments.pop();
  if (segments.length < 2 || segments.some((s) => s.startsWith('('))) return null;
  const end = '[\'"`?]';
  const pattern = segments.map((s) => (s.startsWith('$') ? '[^/\'"`]+' : s.replace(/[.^$*+?()[{|\\]/g, '\\$&'))).join('/');
  return { url: `/${segments.map((s) => (s.startsWith('$') ? `:${s.slice(1)}` : s)).join('/')}`, pattern: `/${pattern}${end}` };
}

/** The packages of the repository (`@acme/db` → `packages/db/`): their code is in it. */
function workspacePackages(repo: string, head: string): Map<string, string> {
  const packages = new Map<string, string>();
  for (const m of grep(repo, head, ['-E', '-e', '"name":[[:space:]]*"@[^/"]+/[^"]+"'], ['package.json', '*/package.json'])) {
    const name = /"name":\s*"(@[^/"]+\/[^"]+)"/.exec(m.text)?.[1];
    if (name && !packages.has(name)) packages.set(name, m.path.replace(/package\.json$/, ''));
  }
  return packages;
}

/** The names that the changed files import from the code of the repository, and that the added lines use. */
function usedImports(repo: string, base: string, head: string, paths: string[], cache: Map<string, string[]>): { name: string; from: string; path: string }[] {
  const found: { name: string; from: string; path: string }[] = [];
  const packages = workspacePackages(repo, head);
  for (const path of paths) {
    const added = git(repo, 'diff', '-U0', `${base}...${head}`, '--', path)
      .split('\n')
      .filter((row) => row.startsWith('+') && !row.startsWith('+++'))
      .join('\n');
    for (const [, , names, from] of fileAt(repo, head, path, cache).join('\n').matchAll(IMPORT)) {
      // A package of the repository resolves to its folder: `@acme/db/schema` → `packages/db/`.
      const workspace = [...packages].find(([name]) => from === name || from.startsWith(`${name}/`))?.[1];
      const local = from.startsWith('.') || from.startsWith('~') || from.startsWith('@/') || workspace !== undefined;
      if (!local) continue;
      for (const raw of names.replace(/[{}]/g, ',').split(',')) {
        const name = raw.replace(/^\s*(type\s+)?(\*\s+as\s+)?/, '').split(/\s+as\s+/).pop()!.trim();
        // Several files of a pull request import the same names: each one counts once.
        if (found.some((f) => f.name === name && f.from === from)) continue;
        if (name && new RegExp(`\\b${name.replace('$', '\\$')}\\b`).test(added)) found.push({ name, from, path: workspace ?? path });
      }
    }
  }
  return found;
}

/** The exported names that the changed lines declare, or whose declaration encloses a changed line. */
function changedExports(repo: string, base: string, head: string, paths: string[]): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  for (const path of paths) {
    for (const row of git(repo, 'diff', '-U0', `${base}...${head}`, '--', path).split('\n')) {
      const text = row.startsWith('@@') ? row.replace(/^@@[^@]*@@\s?/, '') : row.startsWith('+') && !row.startsWith('+++') ? row.slice(1) : '';
      const name = DECLARATION.exec(text)?.[1];
      if (name && !found.some((f) => f.name === name)) found.push({ name, path });
    }
  }
  return found;
}

// A name of a constraint or an index that the code writes in a string: `product_sku_unique`.
const SQL_NAME = /['"`]([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:unique|uniq|key|pkey|fkey|idx|index|check|excl))['"`]/g;
const SQL_GLOBS = ['*.sql', '*.prisma', ...SOURCE_GLOBS];
const MAX_SQL_NAMES = 12;

/** The SQL names that the added lines of the changed source files write, with the files that write each one. */
function addedSqlNames(repo: string, base: string, head: string, paths: string[]): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  for (const path of paths) {
    for (const row of git(repo, 'diff', '-U0', `${base}...${head}`, '--', path).split('\n')) {
      if (!row.startsWith('+') || row.startsWith('+++')) continue;
      for (const [, name] of row.matchAll(SQL_NAME)) {
        if (!names.has(name) && names.size >= MAX_SQL_NAMES) continue;
        names.set(name, (names.get(name) ?? new Set()).add(path));
      }
    }
  }
  return names;
}

/**
 * Unchanged code around the change, found with `git grep` at the head: the definitions of the
 * imported names that the change uses, the callers of the exported names that it changes, and the
 * callers of the API routes that it changes (`full` only), and where the SQL names that the change
 * writes are defined. A SQL name that no file outside the diff holds is listed as absent. The model
 * has no tool, so this is all it sees outside the diff.
 */
function buildContext(repo: string, base: string, head: string, paths: string[], budget: number, kind: ContextKind): string {
  const atHead = new Set(git(repo, 'ls-tree', '-r', '--name-only', head, '--', ...paths).split('\n'));
  const sources = paths.filter((p) => atHead.has(p) && SOURCE_FILE.test(p) && !TEST_FILE.test(p));
  const cache = new Map<string, string[]>();
  const snippets: Snippet[] = [];
  const add = (path: string, line: number, reason: string, wholeDeclaration: boolean) => {
    if (snippets.some((s) => s.path === path && line >= s.start && line <= s.end)) return;
    const lines = fileAt(repo, head, path, cache);
    let start = Math.max(1, line - LINES_BEFORE_SITE);
    let end = Math.min(lines.length, line + LINES_AFTER_SITE);
    if (wholeDeclaration) {
      start = line;
      end = line;
      // A declaration ends at the next line that starts at column 0 and is not a closing bracket.
      while (end < lines.length && end - start < MAX_SNIPPET_LINES && !(end > start && /^[^\s})\]]/.test(lines[end]))) end++;
    }
    // Two sites a few lines apart in one file make one snippet, not two that repeat lines.
    const near = snippets.find((s) => s.path === path && start <= s.end + 1 && end >= s.start - 1);
    if (near && Math.max(end, near.end) - Math.min(start, near.start) < MAX_SNIPPET_LINES) {
      near.start = Math.min(start, near.start);
      near.end = Math.max(end, near.end);
      return;
    }
    snippets.push({ path, start, end, reason });
  };
  const absent: string[] = [];

  for (const [name, writers] of addedSqlNames(repo, base, head, sources)) {
    const sites = grep(repo, head, ['-F', '-w', '-e', name], SQL_GLOBS).filter((m) => !writers.has(m.path));
    // A migration says best what the name is: it comes before a mention in the code. A file of the
    // diff that holds the name (a migration of this pull request) is in the diff already.
    const outside = sites.filter((m) => !paths.includes(m.path));
    const best = outside.find((m) => m.path.endsWith('.sql')) ?? outside[0];
    if (best) add(best.path, best.line, `définition de \`${name}\`, que la PR écrit`, false);
    else if (!sites.length) absent.push(name);
  }

  for (const path of kind === 'full' ? sources : []) {
    const route = apiRoute(path);
    if (!route) continue;
    // A path to a route file (`routes/api/x/route.ts'`) looks like a request to it.
    const sites = grep(repo, head, ['-E', '-e', route.pattern]).filter((m) => !paths.includes(m.path) && !m.text.includes('routes/api/'));
    for (const site of sites.slice(0, MAX_SITES)) {
      add(site.path, site.line, `appel de la route \`${route.url}\` que la PR modifie`, false);
    }
  }

  for (const { name } of kind === 'full' ? changedExports(repo, base, head, sources).slice(0, MAX_SYMBOLS) : []) {
    // A name that several files export (`loader`, `action`, `default`) has callers that a grep cannot tell apart.
    if (new Set(definitionsOf(repo, head, name).map((d) => d.path)).size > 1) continue;
    // A caller in a file of the diff is in the diff already.
    const sites = grep(repo, head, ['-w', '-e', name]).filter((m) => !paths.includes(m.path) && !/^\s*(import|export\s+\{|export\s+\*)/.test(m.text));
    for (const site of sites.slice(0, MAX_SITES)) add(site.path, site.line, `appel de \`${name}\`, que la PR modifie`, false);
  }

  for (const { name, from, path } of usedImports(repo, base, head, sources, cache).slice(0, MAX_SYMBOLS)) {
    const moduleName = from.split('/').pop()!;
    // `path` is the importing file, or the folder of a package of the repository (it ends with `/`).
    const root = path.endsWith('/') ? path : `${path.split('/').slice(0, 2).join('/')}/`;
    // Without the resolution of the bundler: an import stays in its app or its package, and the file
    // named as the module comes first.
    const named = new RegExp(`/${moduleName.replace(/[.$]/g, '\\$&')}(/index)?\\.[a-z]+$`);
    const best = definitionsOf(repo, head, name)
      .filter((d) => d.path.startsWith(root))
      .sort((a, b) => Number(named.test(b.path)) - Number(named.test(a.path)))[0];
    if (best && !sources.includes(best.path)) add(best.path, best.line, `définition de \`${name}\`, que la PR utilise`, true);
  }

  const parts: string[] = [];
  let size = 0;
  if (absent.length) {
    const note =
      `### SQL names that no other file holds\n\n${absent.map((n) => `- \`${n}\``).join('\n')}\n\n` +
      'No migration, schema or code of the repository, in the diff or outside it, defines or mentions these names at the head.\n\n';
    parts.push(note);
    size += note.length;
  }
  for (const s of snippets) {
    const lines = fileAt(repo, head, s.path, cache).slice(s.start - 1, s.end);
    const text = `### ${s.path}:${s.start}-${s.end} · ${s.reason}\n\n\`\`\`\n${lines.map((l, i) => `${s.start + i}| ${l}`).join('\n')}\n\`\`\`\n\n`;
    if (size + text.length > budget) break;
    parts.push(text);
    size += text.length;
  }
  return parts.join('');
}

// The pack

/**
 * The changed files with their counts of added and removed lines (`-` for a binary file). Without
 * `-z`, git writes a rename as `dir/{a => b}/file.ts`, which no git command takes as a path.
 */
function numstat(repo: string, base: string, head: string): { added: string; removed: string; path: string; from?: string }[] {
  const fields = git(repo, 'diff', '--numstat', '-z', `${base}...${head}`).split('\0');
  const rows: { added: string; removed: string; path: string; from?: string }[] = [];
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const [added, removed, ...rest] = fields[i].split('\t');
    // A path can hold a tab: with -z, git writes it as is.
    const path = rest.join('\t');
    if (path) rows.push({ added, removed, path });
    else rows.push({ added, removed, from: fields[++i], path: fields[++i] });
  }
  return rows;
}

/** The first message of the review, and the files left out with their reason. */
function buildPack(repo: string, base: string, head: string, contextKind: ContextKind): { pack: string; skipped: string[] } {
  const reviewed: string[] = [];
  const skipped: string[] = [];
  // The old path of each renamed file: the diff of a rename needs both paths.
  const renamedFrom = new Map<string, string>();
  for (const { added, removed, path, from } of numstat(repo, base, head)) {
    if (SKIP.test(path)) skipped.push(`${path} : fichier généré ou binaire`);
    else if (added !== '-' && Number(added) + Number(removed) > MAX_FILE_CHANGED_LINES)
      skipped.push(`${path} : plus de ${MAX_FILE_CHANGED_LINES} lignes modifiées`);
    else reviewed.push(path);
    if (from) renamedFrom.set(path, from);
  }

  const hunks = new Map<string, string>();
  for (const path of reviewed) {
    const paths = renamedFrom.has(path) ? [renamedFrom.get(path)!, path] : [path];
    hunks.set(path, git(repo, 'diff', TEST_FILE.test(path) ? '-U3' : '-W', `${base}...${head}`, '--', ...paths));
  }

  let docs = '';
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    if (!git(repo, 'ls-tree', '--name-only', head, '--', doc).trim()) continue;
    const text = git(repo, 'show', `${head}:${doc}`);
    if (text.split('\n').length <= MAX_DOC_LINES) docs += `## ${doc}\n\n${text}\n\n`;
  }

  const commits = git(repo, 'log', '--format=- %h %s', `${base}..${head}`);
  const budget = MAX_PACK_BYTES - docs.length - commits.length - 2000;
  const size = () => [...hunks.values()].reduce((sum, hunk) => sum + hunk.length, 0);
  // Drop the largest diffs first: the small ones are where most of the logic of a change sits.
  for (const [path] of [...hunks].sort((a, b) => b[1].length - a[1].length)) {
    if (size() <= budget) break;
    skipped.push(`${path} : retiré pour tenir dans la taille maximale de la revue`);
    hunks.delete(path);
  }

  const parts = [`# Pull request ${base.slice(0, 9)}...${head.slice(0, 9)}\n\n## Commits\n\n${commits}\n`];
  if (skipped.length) parts.push(`## Not reviewed\n\n${skipped.map((s) => `- ${s}\n`).join('')}\n`);
  parts.push(docs);
  parts.push(
    '## Diff\n\nEach hunk of a source file shows the whole function around the change. ' +
      'A test file shows three lines of context.\n\n```diff\n',
  );
  for (const path of reviewed) if (hunks.has(path)) parts.push(hunks.get(path)!);
  parts.push('```\n');
  const room = Math.min(MAX_CONTEXT_BYTES, budget - size());
  const context = room > 0 ? buildContext(repo, base, head, [...hunks.keys()], room, contextKind) : '';
  if (context) {
    parts.push(
      '\n## Context\n\nUnchanged code at the head of the pull request, from other files: definitions that the ' +
        (contextKind === 'full' ? 'change uses, and callers of the code that it changes. ' : 'change uses. ') +
        'Each line starts with its line number. The repository holds more code than this.\n\n',
      context,
    );
  }
  return { pack: parts.join(''), skipped };
}

/** The line numbers, in the new version of each file, that the pull request adds or changes. */
function changedLines(repo: string, base: string, head: string): ChangedLines {
  const lines: ChangedLines = new Map();
  let path: string | null = null;
  for (const row of git(repo, 'diff', '-U0', `${base}...${head}`).split('\n')) {
    if (row.startsWith('+++ ')) {
      path = row.startsWith('+++ b/') ? row.slice(6) : null;
      if (path && !lines.has(path)) lines.set(path, new Set());
    } else if (row.startsWith('@@') && path) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(row)!;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let n = start; n < start + count; n++) lines.get(path)!.add(n);
    }
  }
  return lines;
}

/** The changed line to comment on, or null when the finding sits outside the diff. */
function anchor(finding: Finding, lines: ChangedLines): number | null {
  const candidates = [...(lines.get(finding.path.replace(/^\/+/, '')) ?? [])];
  if (!candidates.length) return null;
  if (candidates.includes(finding.line)) return finding.line;
  const nearest = candidates.reduce((a, b) => (Math.abs(b - finding.line) < Math.abs(a - finding.line) ? b : a));
  return Math.abs(nearest - finding.line) <= ANCHOR_DISTANCE ? nearest : null;
}

/**
 * A finding blocks only on a line that the pull request changes: the bench saw the model block a
 * clean pull request for code that the pull request did not touch.
 */
function isBlocking(finding: Finding, lines: ChangedLines): boolean {
  return (
    BLOCKING_SEVERITIES.has(finding.severity) &&
    finding.confidence >= BLOCKING_CONFIDENCE &&
    anchor(finding, lines) !== null
  );
}

function findingKey(finding: Finding): string {
  const title = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${finding.path.replace(/^\/+/, '')}\n${title}`).digest('hex').slice(0, 12);
}

// The model

type Reply = { answer: Answer; usage: Usage };

type Schema = { name: string; schema: object };

/** One call to one model. It throws on an error, a timeout or an answer that is not the schema. */
async function callJson<T>(
  model: string,
  config: LevelConfig,
  prompt: string,
  message: string,
  schema: Schema,
  timeoutMs: number,
): Promise<{ answer: T; usage: Usage }> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Sakuga Review',
    },
    body: JSON.stringify({
      model,
      max_tokens: config.maxTokens,
      reasoning: { effort: config.effort },
      usage: { include: true },
      // The diff goes only to a provider that keeps nothing and trains on nothing, and that honours
      // the answer schema. Of those, the cheapest under MAX_PRICE answers first.
      provider: { zdr: true, data_collection: 'deny', require_parameters: true, sort: 'price', max_price: config.maxPrice },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: message },
      ],
      response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenRouter answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const out = await response.json();
  const content: string = out.choices?.[0]?.message?.content ?? '';
  const answer: T = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  return { answer, usage: { model: out.model, provider: out.provider, ...out.usage } };
}

/** The answer of the first model of the level that gives one. */
async function askJson<T>(config: LevelConfig, promptFile: string, message: string, schema: Schema): Promise<{ answer: T; usage: Usage }> {
  const prompt = readFileSync(join(HERE, promptFile), 'utf8');
  let lastError: unknown;
  for (const [attempt, model] of config.models.entries()) {
    try {
      return await callJson<T>(model, config, prompt, message, schema, config.timeoutsMs[attempt] ?? config.timeoutsMs.at(-1)!);
    } catch (error) {
      lastError = error;
      log(`attempt ${attempt + 1} with ${model} failed: ${error}`);
    }
  }
  throw new Error(`no model gave a usable answer: ${lastError}`);
}

async function askModel(config: LevelConfig, pack: string): Promise<Reply> {
  const reply = await askJson<Answer>(config, 'prompt.md', pack, { name: 'review', schema: ANSWER_SCHEMA });
  reply.answer.findings = (reply.answer.findings ?? []).filter((f) => f && typeof f.path === 'string' && f.path);
  return reply;
}

// GitHub

async function github(method: string, path: string, payload?: unknown, token = process.env.GITHUB_TOKEN): Promise<any> {
  const response = await fetch(path.startsWith('http') ? path : GITHUB_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function graphql(query: string, variables: Record<string, unknown>, token = process.env.GITHUB_TOKEN): Promise<any> {
  const out = await github('POST', '/graphql', { query, variables }, token);
  if (out.errors) throw new Error(`GraphQL: ${JSON.stringify(out.errors)}`);
  return out.data;
}

/** The review threads that this bot opened on the pull request. */
async function botThreads(owner: string, name: string, number: number): Promise<Thread[]> {
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id isResolved path line
              comments(first: 50) { nodes { databaseId body author { login } commit { oid } } }
            }
          }
        }
      }
    }`;
  const logins = new Set([BOT_LOGIN, BOT_LOGIN.replace(/\[bot\]$/, '')]);
  const threads: Thread[] = [];
  let after: string | null = null;
  for (;;) {
    const data = await graphql(query, { owner, name, number, after });
    const page = data.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const first = node.comments.nodes[0];
      if (!first || !logins.has(first.author?.login)) continue;
      const key = FINDING_KEY.exec(first.body);
      if (key) {
        threads.push({
          id: node.id,
          resolved: node.isResolved,
          path: node.path,
          line: node.line ?? null,
          key: key[1],
          commit: first.commit?.oid,
          commentId: first.databaseId,
          // A later comment of the bot in the thread is its reply that the finding is gone.
          answered: node.comments.nodes
            .slice(1)
            .some((c: { body: string; author?: { login: string } }) => c.body.includes(MARKER_GONE) || logins.has(c.author?.login ?? '')),
        });
      }
    }
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
}

// The review

const badge = (label: string, colour: string) =>
  `<img alt="${label}" src="https://img.shields.io/badge/${encodeURIComponent(label)}-${colour}?style=flat-square" align="top">`;

function badges(finding: Finding): string {
  const [priority, colour] = PRIORITY[finding.severity];
  return badge(priority, colour) + (finding.category === 'security' ? ` ${badge('sécurité', '8e44ad')}` : '');
}

/**
 * The score that the reader sees. A blocking finding caps it at 2: a review that asks for changes
 * and calls the pull request safe would contradict itself.
 */
function score(answer: Answer, lines: ChangedLines): number {
  const raw = Math.min(5, Math.max(1, Math.round(answer.confidence_score || 3)));
  return answer.findings.some((f) => isBlocking(f, lines)) ? Math.min(raw, 2) : raw;
}

/** The diagram, or null when the model gave none or a shape that GitHub could fail to render. */
function diagram(answer: Answer): string | null {
  const text = answer.diagram.replace(/^```(mermaid)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!/^(flowchart|graph)\s+(LR|RL|TD|TB)\b/.test(text)) return null;
  const rows = text.split('\n');
  // `click` can open a link, and `style`/`classDef` fight the theme of the reader.
  if (rows.length > 40 || text.length > 3000 || rows.some((r) => /^\s*(click|style|classDef|class)\b/.test(r))) return null;
  // GitHub reads `<` and `>` in a label as HTML and can drop the diagram.
  return text.replace(/"([^"]*)"/g, (_, label: string) => `"${label.replace(/</g, '‹').replace(/>/g, '›')}"`);
}

/** A suggestion goes on the exact lines the model named, when all of them are changed lines. */
function suggestionRange(finding: Finding, lines: ChangedLines): [number, number] | null {
  if (!finding.suggestion.trim()) return null;
  const changed = lines.get(finding.path.replace(/^\/+/, '')) ?? new Set<number>();
  const start = Math.min(finding.start_line || finding.line, finding.line);
  if (finding.line - start > 30) return null;
  for (let n = start; n <= finding.line; n++) if (!changed.has(n)) return null;
  return [start, finding.line];
}

function inlineBody(finding: Finding, withSuggestion: boolean): string {
  const out = [`${badges(finding)} **${finding.title}**`, '', finding.scenario, '', `**Correction :** ${finding.fix}`];
  if (withSuggestion) out.push('', '```suggestion', finding.suggestion.replace(/\n$/, ''), '```');
  out.push('', `<!-- sakuga-review:finding ${findingKey(finding)} -->`);
  return out.join('\n');
}

// The score from which a review with no blocking finding approves the pull request.
const APPROVE_SCORE = 4;

/** The reason to ask for a stronger level, or null. Only a lite review recommends one. */
function deeperReview(answer: Answer, level: Level): string | null {
  const deeper = answer.deeper_review;
  if (level !== 'lite' || !deeper?.recommended) return null;
  return deeper.reason?.trim() || "le modèle n'a pas donné sa raison.";
}

/**
 * REQUEST_CHANGES on a sure blocking finding, APPROVE on a score of 4 or 5, COMMENT otherwise. A
 * review that recommends a deeper review does not approve: it says that it could not check enough.
 */
function verdict(answer: Answer, lines: ChangedLines, level: Level): 'REQUEST_CHANGES' | 'APPROVE' | 'COMMENT' {
  if (answer.findings.some((f) => isBlocking(f, lines))) return 'REQUEST_CHANGES';
  if (deeperReview(answer, level)) return 'COMMENT';
  return score(answer, lines) >= APPROVE_SCORE ? 'APPROVE' : 'COMMENT';
}

const LEVEL_LABEL: Record<Level, string> = { lite: 'lite', balanced: 'balanced', heavy: 'heavy' };

/** The level, the model and the cost of a review, as the reader sees them. */
function costLine(level: Level, usage: Usage): string {
  const cost = typeof usage.cost === 'number' ? ` · ${usage.cost.toFixed(3).replace('.', ',')} $` : '';
  return `Niveau \`${LEVEL_LABEL[level]}\` · \`${usage.model ?? '?'}\`${cost}`;
}

function deeperReviewNote(reason: string): string {
  return (
    `🔍 **Une revue plus poussée est conseillée :** ${reason}\n` +
    'Commentez `@sakuga-review review balanced` (environ 5 centimes) ou `@sakuga-review review heavy` (10 centimes à 1 dollar).'
  );
}

function reviewBody(answer: Answer, lines: ChangedLines, level: Level, usage: Usage): string {
  const blocking = answer.findings.filter((f) => isBlocking(f, lines)).length;
  const head = blocking
    ? `⛔ ${blocking} point${blocking > 1 ? 's' : ''} bloquant${blocking > 1 ? 's' : ''}`
    : answer.findings.length
      ? '⚠️ Rien de bloquant'
      : '✅ Rien de bloquant';
  const deeper = deeperReview(answer, level);
  return (
    `${MARKER_SUMMARY}\n**Score de confiance : ${score(answer, lines)}/5** · ${head} · ${answer.risk}\n\n` +
    (deeper ? `${deeperReviewNote(deeper)}\n\n` : '') +
    `<sub>${costLine(level, usage)} · Le résumé, le diagramme et la liste des constats sont à la fin de la description de la PR.</sub>`
  );
}

type Link = { finding: Finding; url: string | null };

function descriptionBlock(
  answer: Answer,
  links: Link[],
  skipped: string[],
  resolved: number,
  usage: Usage,
  lines: ChangedLines,
  context: { count: number; head: string; subject: string; commitUrl: string; level: Level },
): string {
  const out = [BLOCK_START, '', '---', '', `<h2>Sakuga Review · Score de confiance : ${score(answer, lines)}/5</h2>`, '', answer.risk, ''];
  const deeper = deeperReview(answer, context.level);
  if (deeper) out.push(deeperReviewNote(deeper), '');
  if (links.length) {
    out.push('<h3>Constats</h3>', '');
    links.forEach(({ finding: f, url }, i) => {
      // The line of the thread: the nearest changed line when the model named one outside the diff.
      const line = anchor(f, lines);
      let where = `\`${f.path}:${line ?? f.line}\``;
      // A finding outside the diff has no thread: link the line in the file at the reviewed commit.
      if (line === null && context.commitUrl.startsWith('http')) {
        where = `[${where}](${context.commitUrl.replace('/commit/', '/blob/')}/${f.path.replace(/^\/+/, '')}#L${f.line})`;
      }
      out.push(`${i + 1}. ${badges(f)}&nbsp;**${f.title}** ${where}${url ? ` <a href="${url}">▶</a>` : ''}`);
      // A finding with no thread shows its scenario here: this is the only place it appears.
      if (!url) out.push(`   ${f.scenario} **Correction :** ${f.fix}`);
    });
    out.push('');
  }
  out.push('<details><summary>Résumé</summary>', '', answer.summary, '');
  if (resolved) {
    out.push(`${resolved} constat${resolved > 1 ? 's' : ''} d'une revue précédente n'apparai${resolved > 1 ? 'ssent' : 't'} plus : le fil peut être résolu.`, '');
  }
  out.push('</details>', '');
  const flow = diagram(answer);
  if (flow) out.push('<details><summary>Diagramme</summary>', '', '```mermaid', "%%{init: {'theme': 'neutral'}}%%", flow, '```', '</details>', '');
  const notReviewed = [...skipped, ...answer.not_reviewed.filter((n) => !skipped.includes(n))];
  if (notReviewed.length) out.push('<details><summary>Non relu</summary>', '', ...notReviewed.map((n) => `- ${n}`), '', '</details>', '');
  const subject = context.subject.length > 50 ? `${context.subject.slice(0, 47)}...` : context.subject;
  out.push(
    `<sub>Revues (${context.count}) · Dernier commit relu : [${subject.replace(/[[\]]/g, '')}](${context.commitUrl}) · ${costLine(context.level, usage)}</sub>`,
    '',
    `<!-- sakuga-review:count ${context.count} -->`,
    BLOCK_END,
  );
  return out.join('\n');
}

/** The body of the pull request with the block of the review at its end, in place of the earlier one. */
function withBlock(body: string, block: string): string {
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (start !== -1 && end > start) return body.slice(0, start) + block + body.slice(end + BLOCK_END.length);
  return `${body.replace(/\s+$/, '')}\n\n${block}`;
}

/** One label `review: N/5` on the pull request, created on the first use in a repository. */
async function setScoreLabel(owner: string, name: string, pr: number, value: number) {
  const label = `${LABEL_PREFIX}${value}/5`;
  const repo = `/repos/${owner}/${name}`;
  try {
    await github('GET', `${repo}/labels/${encodeURIComponent(label)}`);
  } catch {
    await github('POST', `${repo}/labels`, {
      name: label,
      color: SCORE_COLOUR[value],
      description: 'Score de confiance de Sakuga Review (5 : prête à merger)',
    });
  }
  const current: { name: string }[] = (await github('GET', `${repo}/issues/${pr}/labels`)) ?? [];
  for (const old of current) {
    if (old.name.startsWith(LABEL_PREFIX) && old.name !== label) {
      await github('DELETE', `${repo}/issues/${pr}/labels/${encodeURIComponent(old.name)}`);
    }
  }
  await github('POST', `${repo}/issues/${pr}/labels`, { labels: [label] });
}

type Args = { repoDir: string; repository: string; pr: number; head: string; level: Level };

async function post(args: Args, answer: Answer, usage: Usage, skipped: string[], lines: ChangedLines) {
  const [owner, name] = args.repository.split('/');
  const threads = await botThreads(owner, name, args.pr);
  const openThreads = new Map(threads.filter((t) => !t.resolved).map((t) => [t.key, t]));
  const threadUrl = (commentId: number) => `https://github.com/${owner}/${name}/pull/${args.pr}#discussion_r${commentId}`;

  // Two models word one defect differently, so the key of the title differs. An open thread of this
  // bot a few lines away on the same file already carries the finding.
  const NEAR_THREAD_LINES = 3;
  const nearThread = (f: Finding) => {
    const line = anchor(f, lines);
    const path = f.path.replace(/^\/+/, '');
    return threads.find((t) => !t.resolved && !t.answered && t.path === path && t.line !== null && line !== null && Math.abs(t.line - line) <= NEAR_THREAD_LINES);
  };
  // The threads that a finding of this review still carries: by its key, or by its position. A thread
  // outside this set can be declared gone.
  const keysNow = new Set(answer.findings.flatMap((f) => [findingKey(f), nearThread(f)?.key ?? '']).filter(Boolean));

  const ordered = [...answer.findings].sort(
    (a, b) =>
      Number(isBlocking(b, lines)) - Number(isBlocking(a, lines)) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.confidence - a.confidence,
  );
  const inline: Finding[] = [];
  const comments: { path: string; line: number; start_line?: number; side: 'RIGHT'; start_side?: 'RIGHT'; body: string }[] = [];
  for (const f of ordered) {
    if (openThreads.has(findingKey(f)) || nearThread(f)) continue;
    const line = anchor(f, lines);
    if (line === null || f.confidence < INLINE_CONFIDENCE || inline.length >= MAX_INLINE) continue;
    const range = line === f.line ? suggestionRange(f, lines) : null;
    const comment: (typeof comments)[number] = { path: f.path.replace(/^\/+/, ''), line, side: 'RIGHT', body: inlineBody(f, range !== null) };
    if (range && range[0] < range[1]) Object.assign(comment, { start_line: range[0], start_side: 'RIGHT' });
    inline.push(f);
    comments.push(comment);
  }

  // A thread closes only when its file changed since the comment and the finding did not come back.
  // A finding that the model did not repeat is not a fixed finding: the same code can be read twice.
  let resolved = 0;
  for (const t of threads) {
    if (t.resolved || t.answered || keysNow.has(t.key) || !t.commit) continue;
    if (!git(args.repoDir, 'diff', '--name-only', `${t.commit}..${args.head}`, '--', t.path).trim()) continue;
    try {
      await graphql('mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }', { id: t.id });
    } catch (error) {
      // GitHub refuses this mutation to an App that cannot write the contents. The reply tells the
      // person who resolves the thread why it can go.
      log(`cannot resolve thread ${t.id}: ${error}`);
      await github('POST', `/repos/${owner}/${name}/pulls/${args.pr}/comments/${t.commentId}/replies`, {
        body:
          `Ce constat n'apparaît plus au commit \`${args.head.slice(0, 9)}\`, et le fichier a changé depuis. ` +
          `Le fil peut être résolu.\n\n${MARKER_GONE}`,
      });
    }
    resolved++;
  }

  const review = { commit_id: args.head, body: reviewBody(answer, lines, args.level, usage), event: verdict(answer, lines, args.level), comments };
  const path = `/repos/${owner}/${name}/pulls/${args.pr}/reviews`;
  let posted;
  try {
    posted = await github('POST', path, review);
  } catch (error) {
    if (!String(error).includes('422') || !comments.length) throw error;
    // A line that the API refuses drops the inline comments, never the review.
    log(`the inline comments were refused, the review goes without them: ${error}`);
    comments.length = 0;
    inline.length = 0;
    posted = await github('POST', path, { ...review, comments: [] });
  }

  // A COMMENT does not lift an earlier REQUEST_CHANGES, so the review of the previous head would keep
  // the pull request blocked after its findings are fixed. An APPROVE lifts it, and the dismissal
  // also clears it from the list of reviews.
  for (const previous of (await github('GET', `${path}?per_page=100`)) ?? []) {
    if (previous.user.login === BOT_LOGIN && previous.state === 'CHANGES_REQUESTED' && previous.id !== posted.id) {
      await github('PUT', `${path}/${previous.id}/dismissals`, { message: 'Remplacée par la revue du dernier commit.', event: 'DISMISS' });
    }
  }

  // Each finding links to its thread: a new comment of this review, or the open thread that carries it.
  const postedComments: { id: number; body: string }[] = inline.length
    ? ((await github('GET', `${path}/${posted.id}/comments?per_page=100`)) ?? [])
    : [];
  const newThreads = new Map(
    postedComments.flatMap((c) => {
      const key = FINDING_KEY.exec(c.body);
      return key ? [[key[1], c.id] as const] : [];
    }),
  );
  const links: Link[] = ordered.map((f) => {
    const key = findingKey(f);
    const id = newThreads.get(key) ?? openThreads.get(key)?.commentId ?? nearThread(f)?.commentId;
    return { finding: f, url: id ? threadUrl(id) : null };
  });

  // The block goes at the end of the description, read again just before the write: the author can
  // edit the description while the review runs.
  const prPath = `/repos/${owner}/${name}/pulls/${args.pr}`;
  const current = (await github('GET', prPath)).body ?? '';
  const count = Number(REVIEW_COUNT.exec(current)?.[1] ?? 0) + 1;
  const subject = git(args.repoDir, 'log', '-1', '--format=%s', args.head).trim();
  const block = descriptionBlock(answer, links, skipped, resolved, usage, lines, {
    count,
    head: args.head,
    subject,
    commitUrl: `https://github.com/${owner}/${name}/commit/${args.head}`,
    level: args.level,
  });
  await github('PATCH', prPath, { body: withBlock(current, block) });
  await setScoreLabel(owner, name, args.pr, score(answer, lines));
  return { posted, inlineCount: comments.length, resolved, score: score(answer, lines) };
}

// Commands

type Command = { kind: 'review' | 'resolve'; level: Level } | { kind: 'unknown'; text: string } | { kind: 'other-mention' };

const COMMAND = /^\s*@sakuga-review\b[ \t]*([\w-]*)[ \t]*([\w-]*)/i;

const USAGE = [
  'Commandes de Sakuga Review, dans un commentaire de la PR :',
  '',
  '- `@sakuga-review review [lite|balanced|heavy]` : une revue de la PR au niveau donné (`lite` par défaut).',
  '- `@sakuga-review resolve [lite|balanced|heavy]` : répondre aux fils ouverts, et résoudre ceux que le code règle.',
  '',
  '`lite` : Claude Haiku 5.5, environ 1 centime. `balanced` : Claude Sonnet 5.5 avec le code autour de la diff, environ 5 centimes. ' +
    '`heavy` : Claude Opus 5.5 avec le même contexte et plus de réflexion, de 10 centimes à 1 dollar.',
].join('\n');

/**
 * The command at the start of a comment. `@sakuga-review` alone asks for a lite review. A comment
 * that starts with another name (`@sakuga-reviewer`) is not for this bot.
 */
function parseCommand(text: string): Command {
  const match = COMMAND.exec(text);
  if (!match) return { kind: 'other-mention' };
  const verb = match[1].toLowerCase();
  const level = match[2].toLowerCase();
  if (verb !== '' && verb !== 'review' && verb !== 'resolve') return { kind: 'unknown', text };
  if (level && !isLevel(level)) return { kind: 'unknown', text };
  return { kind: verb === 'resolve' ? 'resolve' : 'review', level: isLevel(level) ? level : 'lite' };
}

async function react(repository: string, commentId: number, content: 'eyes' | 'rocket' | 'confused') {
  try {
    await github('POST', `/repos/${repository}/issues/comments/${commentId}/reactions`, { content });
  } catch (error) {
    log(`cannot react to comment ${commentId}: ${error}`);
  }
}

/**
 * A command costs money: only a person who can write to the repository, or a bot of TRUSTED_BOTS,
 * can give one. The API of collaborators does not know the bots of an App, and GitHub keeps the
 * `[bot]` suffix to Apps, so a person cannot take the login of one.
 */
async function canCommand(repository: string, login: string): Promise<boolean> {
  const trustedBots = (process.env.TRUSTED_BOTS ?? '').split(',').map((bot) => bot.trim()).filter(Boolean);
  if (login.endsWith('[bot]')) return trustedBots.includes(login);
  try {
    const out = await github('GET', `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`);
    return ['admin', 'maintain', 'write'].includes(out.permission);
  } catch (error) {
    log(`cannot read the permission of ${login}: ${error}`);
    return false;
  }
}

async function comment(repository: string, pr: number, body: string) {
  await github('POST', `/repos/${repository}/issues/${pr}/comments`, { body });
}

// Resolve

type ThreadComment = { id: number; author: string; isBot: boolean; body: string; commit?: string };
type OpenThread = { id: string; path: string; line: number | null; comments: ThreadComment[] };
type ThreadVerdict = { id: string; verdict: 'fixed' | 'answered' | 'open'; reply: string };

const MAX_THREADS = 20;
const MAX_THREAD_COMMENT_CHARS = 2000;
const MAX_THREAD_DIFF_BYTES = 6000;
const THREAD_CODE_RADIUS = 25;
const MAX_RESOLVE_PACK_BYTES = 150_000;
// A minified or generated line can hold thousands of characters.
const MAX_CODE_LINE_CHARS = 400;
const markerResolve = (head: string) => `<!-- sakuga-review:resolve ${head.slice(0, 12)} -->`;

const RESOLVE_SCHEMA = {
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

/** The unresolved review threads of the pull request, of every author. */
async function openThreads(owner: string, name: string, number: number): Promise<OpenThread[]> {
  // A long thread keeps its first comment and its newest ones: the reply of a resolve, with its
  // marker, is among the newest.
  const query = `
    fragment threadComment on PullRequestReviewComment { databaseId body author { login __typename } originalCommit { oid } }
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id isResolved path line originalLine
              opener: comments(first: 1) { nodes { ...threadComment } }
              recent: comments(last: 29) { nodes { ...threadComment } }
            }
          }
        }
      }
    }`;
  const threads: OpenThread[] = [];
  let after: string | null = null;
  for (;;) {
    const data = await graphql(query, { owner, name, number, after });
    const page = data.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const nodes = [...node.opener.nodes, ...node.recent.nodes.filter((c: any) => c.databaseId !== node.opener.nodes[0]?.databaseId)];
      if (node.isResolved || !nodes.length) continue;
      threads.push({
        id: node.id,
        path: node.path,
        line: node.line ?? node.originalLine ?? null,
        comments: nodes.map((c: any) => ({
          id: c.databaseId,
          author: c.author?.login ?? 'ghost',
          isBot: c.author?.__typename === 'Bot' || /\[bot\]$/.test(c.author?.login ?? ''),
          body: c.body,
          commit: c.originalCommit?.oid,
        })),
      });
    }
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
}

const TRUNCATED = '[… coupé ici]';

/** The text cut to a size, with a mark that the model sees when the cut drops something. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n${TRUNCATED}` : text;
}

const cleanBody = (body: string) =>
  cut(
    body
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<details>[\s\S]*?<\/details>/g, '')
      .replace(/<(img|a|picture|source)\b[^>]*>/g, '')
      .trim(),
    MAX_THREAD_COMMENT_CHARS,
  );

/** Whether the file of a thread changed between the commit of its first comment and the head. */
function changedSince(repo: string, thread: OpenThread, head: string): boolean {
  const since = thread.comments[0].commit;
  if (!since) return false;
  try {
    return git(repo, 'diff', '--name-only', `${since}..${head}`, '--', thread.path).trim() !== '';
  } catch {
    return false;
  }
}

/**
 * The message that the model reads: each thread, the code at the head around it, and its diff since.
 * It stops before MAX_RESOLVE_PACK_BYTES, and gives the threads that it holds.
 */
function resolvePack(repo: string, head: string, threads: OpenThread[]): { pack: string; held: OpenThread[] } {
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
    const since = opener.commit;
    let diff = '';
    if (since) {
      try {
        diff = cut(git(repo, 'diff', `${since}..${head}`, '--', t.path), MAX_THREAD_DIFF_BYTES);
      } catch {
        diff = '';
      }
    }
    parts.push(
      diff
        ? `\n### The diff of this file since the thread opened\n\n\`\`\`diff\n${diff}\n\`\`\`\n`
        : '\n### The diff of this file since the thread opened\n\nNo change.\n',
    );
    const section = parts.join('');
    if (size + section.length > MAX_RESOLVE_PACK_BYTES) break;
    sections.push(section);
    held.push(t);
    size += section.length;
  }
  return { pack: header + sections.join(''), held };
}

async function resolve(args: Args) {
  const [owner, name] = args.repository.split('/');
  const marker = markerResolve(args.head);
  const all = await openThreads(owner, name, args.pr);
  // A thread that this command already answered at this head waits for a new push.
  const waiting = all.filter((t) => !t.comments.some((c) => c.body.includes(marker)));
  const { pack, held: threads } = resolvePack(args.repoDir, args.head, waiting.slice(0, MAX_THREADS));
  if (!threads.length) {
    const at = `au commit \`${args.head.slice(0, 9)}\``;
    const text = waiting.length
      ? `Le premier fil à traiter dépasse à lui seul la taille d'une commande (${MAX_RESOLVE_PACK_BYTES / 1000} ko) : aucun fil n'a été relu ${at}.`
      : all.length
        ? `Les ${all.length} fils ouverts ont déjà reçu une réponse ${at}. Poussez un commit pour qu'ils soient relus.`
        : `Aucun fil ouvert ${at}.`;
    await comment(args.repository, args.pr, `${text}\n\n${marker}`);
    return { resolved: 0, open: 0 };
  }
  const config = levelConfig(args.level);
  const { answer, usage } = await askJson<{ threads: ThreadVerdict[] }>(config, 'resolve.md', pack, {
    name: 'resolve',
    schema: RESOLVE_SCHEMA,
  });
  log(`model=${usage.model} provider=${usage.provider} tokens=${usage.prompt_tokens}+${usage.completion_tokens} cost=${usage.cost} threads=${threads.length}`);

  const byId = new Map(answer.threads.map((v) => [v.id, v]));
  const writeToken = process.env.GITHUB_TOKEN_RESOLVE || process.env.GITHUB_TOKEN;
  const lines: string[] = [];
  let resolved = 0;
  for (const t of threads) {
    const v = byId.get(t.id);
    if (!v) continue;
    const opener = t.comments[0];
    // A thread of a person closes only on a change of its file: an answer of the bot is not enough.
    // A finding of a bot that the file did not change since is not fixed.
    const changed = changedSince(args.repoDir, t, args.head);
    const close = v.verdict === 'fixed' ? changed : v.verdict === 'answered' && opener.isBot;
    let status = '';
    if (close) {
      try {
        await graphql('mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }', { id: t.id }, writeToken);
        status = 'Fil résolu.';
        resolved++;
      } catch (error) {
        log(`cannot resolve thread ${t.id}: ${error}`);
        status = "Le fil peut être résolu : l'App n'a pas encore le droit de le faire.";
      }
    }
    await github('POST', `/repos/${owner}/${name}/pulls/${args.pr}/comments/${opener.id}/replies`, {
      body: [v.reply.trim(), status, marker].filter(Boolean).join('\n\n'),
    });
    const url = `https://github.com/${owner}/${name}/pull/${args.pr}#discussion_r${opener.id}`;
    const label = close ? (status === 'Fil résolu.' ? '✅ résolu' : '☑️ à résoudre') : '💬 reste ouvert';
    lines.push(`- ${label} · [\`${t.path}:${t.line ?? '?'}\`](${url}) · ${opener.author}`);
  }
  const skipped = waiting.length - threads.length;
  await comment(
    args.repository,
    args.pr,
    [
      `**Sakuga Review · résolution des fils** au commit \`${args.head.slice(0, 9)}\``,
      '',
      ...lines,
      '',
      ...(skipped
        ? [`${skipped} autre${skipped > 1 ? 's' : ''} fil${skipped > 1 ? 's' : ''} ouvert${skipped > 1 ? 's' : ''} attend${skipped > 1 ? 'ent' : ''} : une commande traite au plus ${MAX_THREADS} fils et ${MAX_RESOLVE_PACK_BYTES / 1000} ko. Relancez \`@sakuga-review resolve\`.`, '']
        : []),
      `<sub>${costLine(args.level, usage)}</sub>`,
      '',
      marker,
    ].join('\n'),
  );
  return { resolved, open: threads.length - resolved };
}

// Entry

async function review(args: Args & { base: string }, dryRun: boolean, packOnly: boolean) {
  const config = levelConfig(args.level);
  const { pack, skipped } = buildPack(args.repoDir, args.base, args.head, config.context);
  if (packOnly) {
    console.log(pack);
    return;
  }
  const lines = changedLines(args.repoDir, args.base, args.head);
  const { answer, usage } = await askModel(config, pack);
  log(
    `level=${args.level} model=${usage.model} provider=${usage.provider} tokens=${usage.prompt_tokens}+${usage.completion_tokens} ` +
      `cost=${usage.cost} score=${score(answer, lines)}/5 verdict=${verdict(answer, lines, args.level)} findings=${answer.findings.length} ` +
      `diagram=${diagram(answer) ? 'yes' : 'no'} deeper=${deeperReview(answer, args.level) ? 'yes' : 'no'}`,
  );

  if (dryRun) {
    const findings = answer.findings.map((f) => ({
      ...f,
      anchor: anchor(f, lines),
      blocking: isBlocking(f, lines),
      suggestion_range: anchor(f, lines) === f.line ? suggestionRange(f, lines) : null,
    }));
    const block = descriptionBlock(
      answer,
      answer.findings.map((finding) => ({ finding, url: null })),
      skipped,
      0,
      usage,
      lines,
      { count: 1, head: args.head, subject: git(args.repoDir, 'log', '-1', '--format=%s', args.head).trim(), commitUrl: '#', level: args.level },
    );
    const body = reviewBody(answer, lines, args.level, usage);
    console.log(JSON.stringify({ answer: { ...answer, findings }, usage, skipped, pack_bytes: pack.length, body, block }, null, 2));
    return;
  }
  const { posted, inlineCount, resolved, score: value } = await post(args, answer, usage, skipped, lines);
  log(`posted review ${posted.id} (${posted.state}) with ${inlineCount} inline comments, ${resolved} threads resolved, score ${value}/5`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'repo-dir': { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      repository: { type: 'string' },
      pr: { type: 'string' },
      level: { type: 'string', default: 'lite' },
      // A command from a comment: its text, its id and its author.
      command: { type: 'string' },
      'comment-id': { type: 'string' },
      commenter: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'pack-only': { type: 'boolean', default: false },
    },
  });
  const repoDir = values['repo-dir'];
  if (!repoDir || !values.base || !values.head) throw new Error('--repo-dir, --base and --head are required');
  if (!isLevel(values.level)) throw new Error(`--level must be lite, balanced or heavy, not ${values.level}`);
  // --base is the tip of the base branch: the diff starts at the merge base.
  const base = git(repoDir, 'merge-base', values.base, values.head).trim();
  const args = { repoDir, repository: values.repository ?? '', pr: Number(values.pr), head: values.head, base, level: values.level };

  if (values.command === undefined) {
    if (!values['dry-run'] && !values['pack-only'] && (!values.repository || !values.pr)) {
      throw new Error('--repository and --pr are required to post');
    }
    await review(args, values['dry-run'], values['pack-only']);
    return;
  }

  if (!values.repository || !values.pr || !values['comment-id'] || !values.commenter) {
    throw new Error('--repository, --pr, --comment-id and --commenter are required with --command');
  }
  const commentId = Number(values['comment-id']);
  const command = parseCommand(values.command);
  if (command.kind === 'other-mention') return;
  if (!(await canCommand(values.repository, values.commenter))) {
    await comment(values.repository, args.pr, `@${values.commenter} Seule une personne qui peut écrire dans le dépôt peut lancer Sakuga Review.`);
    return;
  }
  if (command.kind === 'unknown') {
    await react(values.repository, commentId, 'confused');
    await comment(values.repository, args.pr, USAGE);
    return;
  }
  await react(values.repository, commentId, 'eyes');
  try {
    if (command.kind === 'review') await review({ ...args, level: command.level }, false, false);
    else {
      const { resolved, open } = await resolve({ ...args, level: command.level });
      log(`resolve: ${resolved} threads resolved, ${open} left open`);
    }
    await react(values.repository, commentId, 'rocket');
  } catch (error) {
    await react(values.repository, commentId, 'confused');
    throw error;
  }
}

main().catch((error) => {
  log(String(error?.stack ?? error));
  process.exit(1);
});
