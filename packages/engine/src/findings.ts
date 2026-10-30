// The findings of a review: the answer schema, the lines that a finding anchors on, the score and the verdict.
import { createHash } from 'node:crypto';
import { git } from './git.ts';
import { CATEGORIES, SEVERITIES, type Category, type CostSource, type Level, type Severity } from '../../protocol/src/index.ts';

// A finding blocks the merge at this severity and confidence.
const BLOCKING_SEVERITIES = new Set(['critical', 'major']);
const BLOCKING_CONFIDENCE = 70;

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
   * REV-19. The rule that the finding applies. The model gives the reference of a rule of the pack
   * (`R1`) or null; the engine replaces it with the id of the rule, or removes it (rules.ts).
   */
  rule_id?: string | null;
  /** The title of that rule, that the service adds when it stores the review. */
  rule_title?: string;
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
};
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
};
export type ChangedLines = Map<string, Set<number>>;
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
 * The answer schema. With the references of the rules of the pack (REV-19), each finding also gives
 * `rule_id`: one of these references, or null. Without rules, the schema stays as before.
 */
export function answerSchema(ruleRefs: readonly string[] = []) {
  if (!ruleRefs.length) return ANSWER_SCHEMA;
  const finding = {
    ...FINDING_SCHEMA,
    properties: { ...FINDING_SCHEMA.properties, rule_id: { anyOf: [{ type: 'string', enum: [...ruleRefs] }, { type: 'null' }] } },
    required: [...FINDING_SCHEMA.required, 'rule_id'],
  };
  return { ...ANSWER_SCHEMA, properties: { ...ANSWER_SCHEMA.properties, findings: { type: 'array', items: finding } } };
}

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

/** The line numbers, in the new version of each file, that the pull request adds or changes. */
export function changedLines(repo: string, base: string, head: string): ChangedLines {
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
export function anchor(finding: Finding, lines: Anchors): number | null {
  if (typeof lines === 'function') return lines(finding);
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
export function isBlocking(finding: Finding, lines: Anchors): boolean {
  return (
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

/** A suggestion goes on the exact lines the model named, when all of them are changed lines. */
export function suggestionRange(finding: Finding, lines: ChangedLines): [number, number] | null {
  if (!finding.suggestion.trim()) return null;
  const changed = lines.get(finding.path.replace(/^\/+/, '')) ?? new Set<number>();
  const start = Math.min(finding.start_line || finding.line, finding.line);
  if (finding.line - start > 30) return null;
  for (let n = start; n <= finding.line; n++) if (!changed.has(n)) return null;
  return [start, finding.line];
}



// The score from which a review with no blocking finding approves the pull request.
const APPROVE_SCORE = 4;

/** The reason to ask for a stronger level, or null. Only a lite review recommends one. */
export function deeperReview(answer: Answer, level: Level): string | null {
  const deeper = answer.deeper_review;
  if (level !== 'lite' || !deeper?.recommended) return null;
  return deeper.reason?.trim() || "le modèle n'a pas donné sa raison.";
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
