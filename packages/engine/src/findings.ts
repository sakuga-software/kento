// The findings of a review: the answer schema, the lines that a finding anchors on, the score and the verdict.
import { createHash } from 'node:crypto';
import { git } from './git.ts';
import { CATEGORIES, SEVERITIES, type Category, type CostSource, type Level, type Severity } from '../../protocol/src/index.ts';

// A finding blocks the merge at this severity and confidence.
export const BLOCKING_SEVERITIES = new Set(['critical', 'major']);
export const BLOCKING_CONFIDENCE = 70;

// A finding can anchor on a changed line this far from the line the model named.
const ANCHOR_DISTANCE = 10;

export type Finding = {
  path: string;
  start_line: number;
  line: number;
  severity: Severity;
  category: Category;
  confidence: number;
  title: string;
  scenario: string;
  fix: string;
  suggestion: string;
  /**
   * REV-104. A short unified diff of the fix, when the fix does not fit a suggestion: several places,
   * or lines outside the hunks. Absent from a finding of an earlier release.
   */
  patch?: string;
  /**
   * REV-19. The rule that the finding applies. REV-117: the link call gives the reference of a rule
   * of the pack (`R1`, link.ts); the engine replaces it with the id of the rule, or removes it (rules.ts).
   */
  rule_id?: string | null;
  /** The title of that rule, that the service adds when it stores the review. */
  rule_title?: string;
  /**
   * REV-99. The earlier finding that this one continues. REV-117: the link call gives the reference
   * of the pack (`E1`, link.ts); the engine replaces it with the key of that finding, or removes it
   * (earlier.ts).
   */
  follows?: string | null;
  /**
   * REV-100. The code of the finding did not change since the last commit that a review of Kentō read
   * on the pull request (seen.ts). The engine sets it; the model never gives it.
   */
  seen?: boolean;
};
export type Answer = {
  confidence_score: number;
  risk: string;
  summary: string;
  diagram: string;
  findings: Finding[];
  not_reviewed: string[];
  /** Whether a stronger level would review this pull request better, and why. */
  deeper_review: { recommended: boolean; reason: string };
  /** REV-71. The verdict of the model on each answered thread of the pack (answered.ts). */
  threads?: ThreadVerdict[] | null;
};

/** REV-71. Whether a reply in a thread refutes its finding (answered.ts). */
export const THREAD_VERDICTS = ['refuted', 'upheld'] as const;
/** `pass`: the pass that gave the verdict, in a review in passes (passes.ts). */
export type ThreadVerdict = { id: string; verdict: (typeof THREAD_VERDICTS)[number]; reason: string; pass?: string };

/**
 * The model that answered, its tokens and its cost in dollars. `cost_source` says where the cost
 * comes from (see prices.ts); with `unknown`, the cost is 0 and the review says that it is not known.
 */
export type Usage = {
  model?: string;
  provider?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  cost_source?: CostSource;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** REV-113, Anthropic only. The part of `cache_write_tokens` written with the TTL of 5 minutes. */
  cache_write_5m_tokens?: number;
  /** REV-113, Anthropic only. The part of `cache_write_tokens` written with the TTL of 1 hour. */
  cache_write_1h_tokens?: number;
  /**
   * REV-113, Anthropic only. Short hashes of the system prompt and of the answer schema: the two
   * must be the same for every review of a level, or the review misses the prompt cache.
   */
  system_hash?: string;
  schema_hash?: string;
  /** REV-113, Anthropic only. The effort, and the thinking of each request (`adaptive+disabled`). */
  effort?: string;
  thinking?: string;
  /** REV-108, Anthropic only. The `stop_reason` of the request that gave the answer. */
  stop_reason?: string;
  /** REV-108, Anthropic only, when the API gives them: the output tokens of the thinking. */
  thinking_tokens?: number;
  /** REV-108, Anthropic only, from the start of the call: the first content block of any type. */
  first_token_ms?: number;
  /** REV-108, Anthropic only, from the start of the call: the first text block of the answer. */
  first_text_ms?: number;
  /** REV-108. Why the call asked the model again without thinking (thinkingOff in providers.ts). */
  retried_without_thinking?: 'max_tokens' | 'no_answer_in_time';
};
export type ChangedLines = Map<string, Set<number>>;
/**
 * REV-104. The lines of each file at the head that a hunk of the diff shows: the changed lines and
 * the context lines around them. GitHub accepts a comment on each of these lines.
 */
export type HunkLines = Map<string, Set<number>>;
/**
 * Where each finding anchors: the changed lines of the checkout, or the anchor that a runner already
 * computed. The web service has no checkout: it reads the anchor of each finding in the result.
 */
export type Anchors = ChangedLines | ((finding: Finding) => number | null);

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    start_line: { type: 'integer' },
    line: { type: 'integer' },
    severity: { type: 'string', enum: SEVERITIES },
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

/**
 * REV-71. The verdicts on the answered threads of the pack, or null. The id is a free string: an id
 * that names no thread is ignored (answered.ts).
 */
const THREADS_SCHEMA = {
  anyOf: [
    {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: [...THREAD_VERDICTS] },
          reason: { type: 'string' },
        },
        required: ['id', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
    { type: 'null' },
  ],
};

type ObjectSchema = { properties: Record<string, unknown>; required: string[] };

/** REV-104. The answer schema of a level with `patch` (levels.ts): each finding then gives a `patch`. */
export function withPatch(schema: object): object {
  const answer = schema as ObjectSchema & { properties: { findings: { items: ObjectSchema } } };
  const items = answer.properties.findings.items;
  const finding = { ...items, properties: { ...items.properties, patch: { type: 'string' } }, required: [...items.required, 'patch'] };
  return { ...answer, properties: { ...answer.properties, findings: { ...answer.properties.findings, items: finding } } };
}

/** The answer schema of a pack with no Answered threads section. */
export const ANSWER_SCHEMA = {
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

/**
 * The answer schema of a review: `threads` only when the pack holds an Answered threads section
 * (REV-71). A level has at most 2 schemas, and each one stays in the prompt cache of Anthropic (REV-113).
 * REV-117: a finding never gives `rule_id` or `follows`. On the bench of REV-113, a finding with
 * these fields almost never gave an applicable suggestion. A separate call links the findings to the
 * rules and to the earlier findings (link.ts).
 */
export function answerSchema(sections: { threads: boolean }): typeof ANSWER_SCHEMA {
  if (!sections.threads) return ANSWER_SCHEMA;
  return { ...ANSWER_SCHEMA, properties: { ...ANSWER_SCHEMA.properties, threads: THREADS_SCHEMA }, required: [...ANSWER_SCHEMA.required, 'threads'] } as typeof ANSWER_SCHEMA;
}

/** The line numbers, in the new version of each file, that the pull request adds or changes. */
export function changedLines(repo: string, base: string, head: string): ChangedLines {
  return diffLines(repo, base, head, 0);
}

// The context lines of a hunk in the diff of a pull request on GitHub.
const GITHUB_CONTEXT = 3;

/**
 * REV-104. The lines of the hunks of the diff of the pull request on GitHub, at the head. Git joins
 * two hunks when the gap between them is small, as GitHub does.
 */
export function hunkLines(repo: string, base: string, head: string): HunkLines {
  return diffLines(repo, base, head, GITHUB_CONTEXT);
}

function diffLines(repo: string, base: string, head: string, context: number): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let path: string | null = null;
  for (const row of git(repo, 'diff', `-U${context}`, `${base}...${head}`).split('\n')) {
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
export function anchor(finding: Finding, lines: Anchors): number | null {
  if (typeof lines === 'function') return lines(finding);
  const candidates = [...(lines.get(finding.path.replace(/^\/+/, '')) ?? [])];
  if (!candidates.length) return null;
  if (candidates.includes(finding.line)) return finding.line;
  const nearest = candidates.reduce((a, b) => (Math.abs(b - finding.line) < Math.abs(a - finding.line) ? b : a));
  return Math.abs(nearest - finding.line) <= ANCHOR_DISTANCE ? nearest : null;
}

/**
 * REV-100. A new finding on code that an earlier review already read, not critical: the earlier
 * review saw that code and did not report it. It does not block, and the summary lists it apart
 * ("To consider"). It gets a thread only when `raisesToConsider` of publish.ts says so (REV-103).
 * A critical one blocks as before, and so does a finding that follows an earlier finding (REV-99):
 * that defect was already reported.
 */
export function toConsider(finding: Finding): boolean {
  return finding.seen === true && !finding.follows && finding.severity !== 'critical';
}

/**
 * A finding blocks only on a line that the pull request changes: the bench saw the model block a
 * clean pull request for code that the pull request did not touch. REV-100: a finding to consider
 * never blocks.
 */
export function isBlocking(finding: Finding, lines: Anchors): boolean {
  return (
    !toConsider(finding) &&
    BLOCKING_SEVERITIES.has(finding.severity) &&
    finding.confidence >= BLOCKING_CONFIDENCE &&
    anchor(finding, lines) !== null
  );
}

export function findingKey(finding: Finding): string {
  const title = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${finding.path.replace(/^\/+/, '')}\n${title}`).digest('hex').slice(0, 12);
}

/**
 * REV-88. The findings without those that are settled. A settled finding is found by its fingerprint
 * when one of the findings has it: only that one goes, and another finding with the same path and
 * title stays. Otherwise (no fingerprint, or its lines moved) it is found by its key, the path and
 * the title. `print` gives the fingerprint of a finding.
 */
export function withoutSettled<F extends Finding>(
  findings: readonly F[],
  settled: readonly { key: string; fingerprint: string }[],
  print: (finding: F) => string | undefined,
): F[] {
  const printed = new Set(findings.map(print).filter((p): p is string => Boolean(p)));
  const byPrint = new Set(settled.filter((s) => printed.has(s.fingerprint)).map((s) => s.fingerprint));
  const byKey = new Set(settled.filter((s) => !printed.has(s.fingerprint)).map((s) => s.key));
  return findings.filter((f) => {
    const p = print(f);
    return !(p && byPrint.has(p)) && !byKey.has(findingKey(f));
  });
}

/**
 * The score that the reader sees. A blocking finding caps it at 2: a review that asks for changes
 * and calls the pull request safe would contradict itself.
 */
export function score(answer: Answer, lines: Anchors): number {
  const raw = Math.min(5, Math.max(1, Math.round(answer.confidence_score || 3)));
  return answer.findings.some((f) => isBlocking(f, lines)) ? Math.min(raw, 2) : raw;
}

/** The diagram, or null when the model gave none or a shape that GitHub could fail to render. */
export function diagram(answer: Answer): string | null {
  const text = answer.diagram.replace(/^```(mermaid)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!/^(flowchart|graph)\s+(LR|RL|TD|TB)\b/.test(text)) return null;
  const rows = text.split('\n');
  // `click` can open a link, and `style`/`classDef` fight the theme of the reader.
  if (rows.length > 40 || text.length > 3000 || rows.some((r) => /^\s*(click|style|classDef|class)\b/.test(r))) return null;
  // GitHub reads `<` and `>` in a label as HTML and can drop the diagram.
  return text.replace(/"([^"]*)"/g, (_, label: string) => `"${label.replace(/</g, '‹').replace(/>/g, '›')}"`);
}

/**
 * A suggestion goes on the exact lines the model named, when all of them are lines of one hunk. REV-104:
 * a context line counts. The caller gives a range only to a finding that anchors on its `line`, so
 * `line` stays a changed line, and only the lines before it can be context lines.
 */
export function suggestionRange(finding: Finding, hunks: HunkLines): [number, number] | null {
  // KNT-159. A placeholder would replace the lines of the PR with the word: no suggestion.
  if (!finding.suggestion.trim() || isPlaceholder(finding.suggestion)) return null;
  const shown = hunks.get(finding.path.replace(/^\/+/, '')) ?? new Set<number>();
  const start = Math.min(finding.start_line || finding.line, finding.line);
  if (finding.line - start > 30) return null;
  for (let n = start; n <= finding.line; n++) if (!shown.has(n)) return null;
  return [start, finding.line];
}

/** REV-104. The longest patch that a reader sees: a reader does not check a longer one. */
export const MAX_PATCH_LINES = 40;

/**
 * KNT-159. The words that a model writes in a field when it has no value for it: `follows` (a field of
 * the link call), `none`, `n/a`, or the reference of an earlier finding (`E1`). Case, quotes and a final
 * dot do not count.
 */
const PLACEHOLDERS = new Set(['follows', 'none', 'null', 'n/a', 'nothing', 'no patch', 'no suggestion', 'no fix', 'not applicable', 'tbd', 'todo', '-', '...', '…']);

/** The quotes around a placeholder, and the dot after it. */
const QUOTES = `"'\``;

/**
 * KNT-159. Whether a text is only a placeholder word, or empty after trim. No regular expression on
 * the ends: the text comes from the model, and a run of quotes would make one slow.
 */
export function isPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  // The longest placeholder has 14 characters: a longer text is code or a sentence.
  if (trimmed.length > 40) return false;
  let start = 0;
  let end = trimmed.length;
  while (start < end && QUOTES.includes(trimmed[start]!)) start++;
  while (end > start && (QUOTES.includes(trimmed[end - 1]!) || trimmed[end - 1] === '.')) end--;
  const word = trimmed.slice(start, end).trim().toLowerCase();
  return word === '' || PLACEHOLDERS.has(word) || /^e\d+$/.test(word);
}

/** The lines of a git diff header, before the first hunk of a file. */
const GIT_HEADER = /^(diff --git |index |(?:new|deleted) file mode |old mode |new mode |similarity index |dissimilarity index |rename (?:from|to) |copy (?:from|to) )/;

/**
 * KNT-159. True when `patch` reads as a unified diff, and adds or removes more than a placeholder.
 *
 * - The header of a file (`diff --git`, `index`, `new file mode`, `rename from`…, then the pair
 *   `--- a/…` and `+++ b/…`) is read only before its first `@@`. Elsewhere, `--- note` is a removed
 *   line (a SQL comment).
 * - Each other line starts with `+`, `-`, a space, `@@` or `\` ("No newline at end of file"), or is empty.
 * - At least one added or removed line holds more than a placeholder: `+follows` alone is not a fix.
 */
function readsAsDiff(patch: string): boolean {
  const rows = patch.split('\n');
  let header = true;
  const changed: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.startsWith('diff --git ')) {
      header = true;
      continue;
    }
    if (header && GIT_HEADER.test(row)) continue;
    if (header && row.startsWith('--- ') && rows[i + 1]?.startsWith('+++ ')) {
      i++;
      continue;
    }
    header = false;
    if (row === '' || row.startsWith(' ') || row.startsWith('@@') || row.startsWith('\\')) continue;
    if (!/^[+-]/.test(row)) return false;
    changed.push(row.slice(1));
  }
  return changed.some((text) => !isPlaceholder(text));
}

/**
 * REV-104. The patch of a finding as a reader sees it, or null when it has none, it is too long,
 * or it is not a diff (KNT-159).
 */
export function shownPatch(finding: Finding): string | null {
  // The fence around the patch goes: its first line, and the backquotes at its end. trimEnd and
  // endsWith, not a regular expression on the end: a long run of spaces would make one slow.
  let patch = (finding.patch ?? '').replaceAll('\r', '').replace(/^\s*```(diff)?[^\n]*\n/i, '').trimEnd();
  if (patch.endsWith('```')) patch = patch.slice(0, -3).trimEnd();
  // A fence in the patch would close the code block of the comment.
  if (!patch.trim() || patch.includes('```') || patch.split('\n').length > MAX_PATCH_LINES) return null;
  return readsAsDiff(patch) ? patch : null;
}



// The score from which a review with no blocking finding approves the pull request.
const APPROVE_SCORE = 4;

/** The reason to ask for a stronger level, or null. Only a lite review recommends one. */
export function deeperReview(answer: Answer, level: Level): string | null {
  const deeper = answer.deeper_review;
  if (level !== 'lite' || !deeper?.recommended) return null;
  return deeper.reason?.trim() || 'the model gave no reason.';
}

/**
 * REQUEST_CHANGES on a sure blocking finding, APPROVE on a score of 4 or 5, COMMENT otherwise. A
 * review that recommends a deeper review does not approve: it says that it could not check enough.
 */
export function verdict(answer: Answer, lines: Anchors, level: Level): 'REQUEST_CHANGES' | 'APPROVE' | 'COMMENT' {
  if (answer.findings.some((f) => isBlocking(f, lines))) return 'REQUEST_CHANGES';
  if (deeperReview(answer, level)) return 'COMMENT';
  return score(answer, lines) >= APPROVE_SCORE ? 'APPROVE' : 'COMMENT';
}

