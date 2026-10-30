// The review of a pull request, from the checkout to the findings, the score and the verdict.
import { fingerprint } from './fingerprint.ts';
import { anchor, answerSchema, changedLines, deeperReview, diagram, isBlocking, score, suggestionRange, verdict, type Answer, type ChangedLines, type Finding, type Usage } from './findings.ts';
import { git } from './git.ts';
import { levelConfig, type Level, type LevelConfig } from './levels.ts';
import { askModel, type ModelClient } from './model.ts';
import { buildPack } from './pack.ts';
import { applyRule, type PackedRule, type Rule } from './rules.ts';

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
};

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
  const base = mergeBase(input.repoDir, input.base, input.head);
  const { pack, skipped, rules } = buildPack(input.repoDir, base, input.head, config.context, input.rules);
  const lines = changedLines(input.repoDir, base, input.head);
  const { answer, usage } = await askModel(input, config, pack, answerSchema(rules.map((r) => r.ref)));
  // A finding cites a rule of the pack, or none; the floor of the rule sets its lowest severity. It
  // runs before the anchors and the fingerprint, so that the score, the verdict and the fingerprint
  // see the rule.
  answer.findings = answer.findings.map((f) => applyRule(f, rules));
  const fileAt = headFiles(input.repoDir, input.head, input.log ?? ((message) => process.stderr.write(`${message}\n`)));
  const findings = answer.findings.map((f) => ({
    ...f,
    anchor: anchor(f, lines),
    blocking: isBlocking(f, lines),
    suggestion_range: anchor(f, lines) === f.line ? suggestionRange(f, lines) : null,
    fingerprint: fingerprint(f, fileAt(f.path)),
  }));
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
