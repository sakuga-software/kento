// The review of a pull request, from the checkout to the findings, the score and the verdict.
import { answeredSection, dropRefuted, type AnsweredThread } from './answered.ts';
import { fingerprint } from './fingerprint.ts';
import { anchor, answerSchema, changedLines, deeperReview, diagram, isBlocking, score, suggestionRange, verdict, type Answer, type ChangedLines, type Finding, type Usage } from './findings.ts';
import { git } from './git.ts';
import { checkMissingNames } from './imports.ts';
import type { Level } from '../../protocol/src/index.ts';
import { levelConfig, type LevelConfig } from './levels.ts';
import { askModel, type ModelClient } from './model.ts';
import { buildPack } from './pack.ts';
import type { OpenThread } from './resolve.ts';
import { applyRule, type PackedRule, type Rule } from './rules.ts';
import { diffHash, reuseKey } from './reuse.ts';
import { RepoTools, type ToolUse } from './tools.ts';

export type ReviewInput = ModelClient & {
  /** A checkout of the repository with the history of the base and the head. */
  repoDir: string;
  /** The tip of the base branch: the diff starts at the merge base of it and the head. */
  base: string;
  head: string;
  level: Level;
  /** The configuration of the level: `levelConfig(level)` when it is not given. */
  config?: LevelConfig;
  /**
   * REV-19. The rules of the repository and of its org, from the caller only: never from the
   * checkout. The pack holds those whose paths the change touches.
   */
  rules?: readonly Rule[];
  /**
   * REV-71. The open threads of the pull request, from the caller, with their comments. The pack
   * holds those that a bot opened and someone else answered (answered.ts).
   */
  threads?: readonly OpenThread[];
  /**
   * REV-89. The reuse key of the last review of the pull request, from the caller. When the key of
   * this head is the same, `reviewUnlessUnchanged` calls no model.
   */
  previousKey?: string | null;
};

/**
 * A finding with where it goes: the changed line it anchors on, and the lines of its suggestion. Its
 * fingerprint finds it again on the next push, when its lines moved (fingerprint.ts).
 */
export type ReviewedFinding = Finding & {
  anchor: number | null;
  blocking: boolean;
  suggestion_range: [number, number] | null;
  fingerprint: string;
};

export type ReviewResult = {
  level: Level;
  /** The merge base of the base and the head. */
  base: string;
  head: string;
  /** The answer of the model, with the findings that have no path removed. */
  answer: Answer;
  findings: ReviewedFinding[];
  /** The score that the reader sees, from 1 to 5. */
  score: number;
  verdict: 'REQUEST_CHANGES' | 'APPROVE' | 'COMMENT';
  /** The diagram that GitHub can render, or null. */
  diagram: string | null;
  /** The reason to ask for a stronger level, or null. */
  deeperReview: string | null;
  /** The model that answered and the cost of the call. */
  usage: Usage;
  /** The files that the pack left out, with their reason. */
  skipped: string[];
  pack: string;
  /** The rules that the pack held, with the reference that the model cites. */
  rules: PackedRule[];
  /** The changed lines of each file at the head: a comment can go on these lines only. */
  lines: ChangedLines;
  /** REV-71. The answered threads that the pack held. */
  threads: AnsweredThread[];
  /** REV-71. The findings that a refuted thread removed. */
  refutedInThread: Finding[];
  /** REV-68. What the tools used, when the level had tools. */
  toolUse?: ToolUse;
  /** REV-89. The hash of the reviewed files of the diff (reuse.ts). */
  diffHash: string;
  /** REV-89. The key of the whole input of the model (reuse.ts). */
  reuseKey: string;
};

/** REV-89. A head whose input is the one of the last review: no model call. */
export type UnchangedReview = { unchanged: true; level: Level; base: string; head: string; diffHash: string; reuseKey: string };

/** The merge base of the tip of the base branch and the head. */
export function mergeBase(repoDir: string, base: string, head: string): string {
  return git(repoDir, 'merge-base', base, head).trim();
}

/**
 * The review of a pull request: the pack, one model call, then the findings with their anchors, the
 * score and the verdict. It reads the checkout with git and calls the model; it never calls GitHub.
 */
export async function reviewPullRequest(input: ReviewInput): Promise<ReviewResult> {
  const config = input.config ?? levelConfig(input.level);
  return askAndFinish(input, config, prepareReview(input, config));
}

async function askAndFinish(input: ReviewInput, config: LevelConfig, prepared: PreparedReview): Promise<ReviewResult> {
  const tools = reviewTools(input, config);
  const { answer, usage } = await askModel(input, config, prepared.pack, answerSchema(prepared.rules.map((r) => r.ref), prepared.threads.map((t) => t.ref)), undefined, tools);
  return { ...finishReview(input, prepared, answer, usage), ...(tools ? { toolUse: tools.used } : {}) };
}

/**
 * REV-89. The review of the head, or nothing when its reuse key is `input.previousKey`: the pack
 * reads the same diff, the same rules and the same threads as the last review, and the model would
 * answer the same. A merge of the base branch or a rebase with no conflict gives such a head.
 */
export async function reviewUnlessUnchanged(input: ReviewInput): Promise<ReviewResult | UnchangedReview> {
  const config = input.config ?? levelConfig(input.level);
  const prepared = prepareReview(input, config);
  if (input.previousKey && prepared.reuseKey === input.previousKey) {
    return { unchanged: true, level: input.level, base: prepared.base, head: input.head, diffHash: prepared.diffHash, reuseKey: prepared.reuseKey };
  }
  return askAndFinish(input, config, prepared);
}

/** REV-68. The tools of one review on the head, when the level has a tool budget. */
export function reviewTools(input: ReviewInput, config: LevelConfig): RepoTools | undefined {
  return config.tools ? new RepoTools(input.repoDir, input.head, config.tools) : undefined;
}

/** What a review reads before its model call: the merge base, the pack and the changed lines. */
export type PreparedReview = {
  base: string;
  pack: string;
  skipped: string[];
  rules: PackedRule[];
  lines: ChangedLines;
  threads: AnsweredThread[];
  diffHash: string;
  reuseKey: string;
};

export function prepareReview(input: ReviewInput, config: LevelConfig): PreparedReview {
  const base = mergeBase(input.repoDir, input.base, input.head);
  const answered = answeredSection(input.repoDir, input.head, input.threads ?? []);
  const { pack, skipped, rules, body } = buildPack(input.repoDir, base, input.head, config.context, input.rules, answered.section);
  const key = reuseKey({ packBody: body, level: input.level, provider: input.kind ?? 'openrouter', models: config.models, toolsAt: config.tools ? input.head : null });
  return {
    base,
    pack,
    skipped,
    rules,
    lines: changedLines(input.repoDir, base, input.head),
    threads: answered.held,
    diffHash: diffHash(input.repoDir, base, input.head),
    reuseKey: key,
  };
}

/** The review from the answer of the model: the rules, the anchors, the fingerprints, the score and the verdict. */
export function finishReview<F extends Finding>(
  input: ReviewInput,
  prepared: PreparedReview,
  answer: Answer & { findings: F[] },
  usage: Usage,
): ReviewResult & { findings: (ReviewedFinding & F)[] } {
  const { base, pack, skipped, rules, lines, threads, diffHash, reuseKey } = prepared;
  // A finding cites a rule of the pack, or none; the floor of the rule sets its lowest severity. It
  // runs before the anchors and the fingerprint, so that the score, the verdict and the fingerprint
  // see the rule.
  // The fields that a caller added (the pass of a finding, REV-20) stay.
  answer.findings = answer.findings.map((f) => {
    const { rule_id: _cited, ...rest } = f;
    return { ...rest, ...applyRule(f, rules) } as F;
  });
  const log = input.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const fileAt = headFiles(input.repoDir, input.head, log);
  // REV-70. A finding that says a name is not imported or not defined is checked against its file.
  const { refuted } = checkMissingNames(answer, fileAt);
  for (const f of refuted) log(`finding dropped, its file at the head holds the name: ${f.path}: ${f.title}`);
  // REV-71. A finding that a reply refuted in its thread, on a file that did not change since.
  const answeredAway = dropRefuted(answer, threads, (f) => anchor(f, lines));
  for (const f of answeredAway) log(`finding dropped, a reply refuted it in its thread and its file did not change: ${f.path}: ${f.title}`);
  const findings = answer.findings.map((f) => ({
    ...f,
    anchor: anchor(f, lines),
    blocking: isBlocking(f, lines),
    suggestion_range: anchor(f, lines) === f.line ? suggestionRange(f, lines) : null,
    fingerprint: fingerprint(f, fileAt(f.path)),
  })) as (ReviewedFinding & F)[];
  return {
    level: input.level,
    base,
    head: input.head,
    answer,
    findings,
    score: score(answer, lines),
    verdict: verdict(answer, lines, input.level),
    diagram: diagram(answer),
    deeperReview: deeperReview(answer, input.level),
    usage,
    skipped,
    pack,
    rules,
    lines,
    threads,
    refutedInThread: answeredAway,
    diffHash,
    reuseKey,
  };
}

/**
 * The lines of a file at the head, read once per path. Null: the file is not at the head (a path that
 * the model made up, or a file that the pull request deleted), or git could not read it. The
 * fingerprint then reads the path and the rule or title only; any failure other than a missing file
 * (a file over the buffer of git, a broken checkout) is logged, so that it is never silent.
 */
export function headFiles(
  repoDir: string,
  head: string,
  log: (message: string) => void,
  read: (repo: string, ...args: string[]) => string = git,
): (path: string) => string[] | null {
  const cache = new Map<string, string[] | null>();
  return (path) => {
    const clean = path.replace(/^\/+/, '');
    if (!cache.has(clean)) {
      let lines: string[] | null = null;
      try {
        lines = read(repoDir, 'show', `${head}:${clean}`).split('\n');
      } catch (error) {
        const message = String((error as { stderr?: unknown }).stderr || error);
        if (!/does not exist in|exists on disk, but not in/.test(message)) {
          log(`fingerprint of ${clean} without its code: git show failed: ${message.trim().slice(0, 300)}`);
        }
      }
      cache.set(clean, lines);
    }
    return cache.get(clean)!;
  };
}
