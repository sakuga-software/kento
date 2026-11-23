// The review of a pull request, from the checkout to the findings, the score and the verdict.
import { answeredSection, dropRefuted, refutedThreadIds, type AnsweredThread } from './answered.ts';
import { fingerprint } from './fingerprint.ts';
import { changedFiles, criticality, criticalSection, namesChecks, areasText, type CheckContext, type Criticality } from './critical.ts';
import { anchor, answerSchema, toConsider, changedLines, deeperReview, diagram, hunkLines, isBlocking, score, shownPatch, suggestionRange, verdict, type Answer, type ChangedLines, type CriticalReview, type Finding, type HunkLines, type Usage } from './findings.ts';
import { git } from './git.ts';
import { checkMissingNames } from './imports.ts';
import { moveUnreadPremises } from './premise.ts';
import { splitNonFindings } from './nonfindings.ts';
import { withoutMergeAdvice } from './risk.ts';
import { splitUntracedTiming } from './timing.ts';
import type { JobEarlier, Level, RejectedFinding } from '../../protocol/src/index.ts';
import { earlierFindingsSection, followedBy, isNewDefect, linkEarlier, type HeldEarlier } from './earlier.ts';
import { publicLabels } from './labels.ts';
import { inHistory } from './history.ts';
import { changedZonesSection, isSeen, seenCode, type SeenCode } from './seen.ts';
import { levelConfig, type LevelConfig } from './levels.ts';
import { askModel, type MessagePart, type ModelClient } from './model.ts';
import { linkFindings, NO_LINK, withLinkUsage, type LinkReport } from './link.ts';
import { applyCoverage } from './coverage.ts';
import { buildPack, type Coverage } from './pack.ts';
import type { OpenThread } from './resolve.ts';
import { dropRejected, rejectedSection, type HeldRejection } from './rejected.ts';
import { applyRule, type PackedRule, type Rule } from './rules.ts';
import { broughtByMerges, earlierSection, mergeDelta, planDelta, type Delta, type DeltaPlan } from './delta.ts';
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
  /** REV-95. The findings of the pull request that a person set aside, from the caller. */
  rejected?: readonly RejectedFinding[];
  /**
   * REV-89. The reuse key of the last review of the pull request, from the caller. When the key of
   * this head is the same, `reviewUnlessUnchanged` calls no model.
   */
  previousKey?: string | null;
  /**
   * REV-88. The last review of the pull request: when its head is in the history of this head, the
   * pack holds only the files of the pull request that changed since, and the review keeps the
   * findings of the others.
   */
  delta?: Delta | null;
  /**
   * REV-99. Every finding of the pull request, whatever its status, and the last review at this
   * level, from the caller. A finding that continues one of them follows it, and does not count again
   * in the score.
   */
  earlier?: JobEarlier | null;
  /**
   * REV-100. The last commit that a review of Kentō read on the pull request, of any level, from the
   * caller. A finding whose code did not change since is marked `seen` (seen.ts).
   */
  reviewed?: string | null;
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
  /** The changed lines of each file at the head: a finding anchors on these lines only. */
  lines: ChangedLines;
  /** REV-104. The lines of the hunks of each file at the head: a suggestion can start on these lines. */
  hunks: HunkLines;
  /** REV-71. The answered threads that the pack held. */
  threads: AnsweredThread[];
  /** REV-71. The findings that a refuted thread removed. */
  refutedInThread: Finding[];
  /** REV-96. The ids of the answered threads that the model called refuted. */
  refutedThreads: string[];
  /** REV-95. The rejected findings that the pack held. */
  rejected: HeldRejection[];
  /** REV-95. The findings that a rejection on an unchanged file removed. */
  droppedAsRejected: Finding[];
  /** REV-68. What the tools used, when the level had tools. */
  toolUse?: ToolUse;
  /** REV-89. The hash of the reviewed files of the diff (reuse.ts). */
  diffHash: string;
  /** REV-89. The key of the whole input of the model (reuse.ts). */
  reuseKey: string;
  /** REV-88. The incremental review: the last reviewed head and the files read again; null for a whole review. */
  delta: DeltaPlan | null;
  /** REV-88. The findings that a person dismissed or kept, which the model raised again and the review dropped. */
  settledAgain: Finding[];
  /** REV-88. The score that the model gave and the one that the floor kept, when the floor lifted it. */
  scoreFloor: { model: number; kept: number } | null;
  /** REV-99. The earlier findings that the pack held. */
  earlier: HeldEarlier[];
  /** REV-99. The findings that the model and the net linked to an earlier finding. */
  followed: { byModel: number; byNet: number };
  /** REV-99. The findings that continued a dismissed or kept finding whose file did not change. */
  droppedAsSettled: Finding[];
  /** REV-100. The last reviewed commit that the review compared with, or null (first review, force-push). */
  seenSince: string | null;
  /** REV-113. A short hash of the rules, the imports and the context of the pack (pack.ts). */
  contextHash: string;
  /** REV-117. The call that linked the findings to the rules and to the earlier findings (link.ts). */
  link: LinkReport;
  /** KNT-166. The changed files that the pack did not read, or read with less context. */
  coverage: Coverage | null;
  /**
   * KNT-151. The findings moved to « Not reviewed » (premise.ts), with their anchor and fingerprint:
   * the service matches them to its open findings and leaves their threads open, never `fixed`.
   */
  moved?: ReviewedFinding[];
  /** KNT-154. The change is critical, and whether the review named what it checked; null otherwise. */
  critical: CriticalReview | null;
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
  const { answer, usage } = await askModel(input, config, prepared.parts, undefined, tools, undefined, packSchema(prepared));
  const linked = await linkFindings(input, config, answer.findings, prepared.rules, prepared.earlier);
  answer.findings = linked.findings;
  return { ...finishReview(input, prepared, answer, withLinkUsage(usage, linked.report), linked.report), ...(tools ? { toolUse: tools.used } : {}) };
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

/** REV-113. The answer schema for the sections that the pack holds, whatever their references. */
export function packSchema(prepared: Pick<PreparedReview, 'threads'>): object {
  return answerSchema({ threads: prepared.threads.length > 0 });
}

/**
 * KNT-166. The coverage of an incremental review: the files that its pack cut, and those of the pull
 * request that the whole pack cuts and that it did not read again.
 */
export function deltaCoverage(whole: Coverage, incremental: Coverage, reread: readonly string[]): Coverage {
  const unreadNow = new Set([...incremental.cut, ...incremental.large]);
  const readNow = new Set(reread.filter((p) => !unreadNow.has(p)));
  const notRead = (p: string) => !readNow.has(p);
  const merge = (a: string[], b: string[]) => [...new Set([...a, ...b.filter(notRead)])];
  return {
    files: whole.files,
    cut: merge(incremental.cut, whole.cut),
    large: merge(incremental.large, whole.large),
    narrowed: incremental.narrowed,
    logic: merge(incremental.logic, whole.logic),
    core: merge(incremental.core, whole.core),
  };
}

/** What a review reads before its model call: the merge base, the pack and the changed lines. */
export type PreparedReview = {
  base: string;
  pack: string;
  /** REV-113. The pack in the parts that a prompt cache can mark. */
  parts: MessagePart[];
  contextHash: string;
  skipped: string[];
  rules: PackedRule[];
  lines: ChangedLines;
  hunks: HunkLines;
  threads: AnsweredThread[];
  rejected: HeldRejection[];
  earlier: HeldEarlier[];
  diffHash: string;
  reuseKey: string;
  delta: DeltaPlan | null;
  /** REV-100. What changed since the last reviewed commit, or null. */
  seen: SeenCode | null;
  /** KNT-166. The changed files that the pack did not read, or read with less context. */
  coverage?: Coverage;
  /** KNT-154. Why the whole pull request is a critical change, or null. */
  critical: Criticality | null;
  /** KNT-154. What a path of `checked` is verified against, for a critical change; null otherwise. */
  checkContext: CheckContext | null;
};

export function prepareReview(input: ReviewInput, config: LevelConfig): PreparedReview {
  const base = mergeBase(input.repoDir, input.base, input.head);
  const answered = answeredSection(input.repoDir, input.head, input.threads ?? []);
  // REV-95. The rejected findings follow the answered threads, in the same place of the pack (and so
  // in the body that the reuse key of REV-89 reads: a new rejection gives a new key).
  const rejected = rejectedSection(input.repoDir, input.head, input.rejected ?? []);
  const sections = answered.section + rejected.section;
  // REV-99. The earlier findings follow, out of the reuse key: each review changes them.
  const earlierFindings = earlierFindingsSection(input.repoDir, input.head, input.earlier?.findings ?? []);
  // REV-88. With the last review, the pack reads only what changed since, when that head is still
  // in the history of this one. A force-push or a rebase reads the whole pull request again.
  // No file of the pull request changed since then, and yet the key differs (a rule, a reply, a doc
  // or the context changed): the change is not in the diff, so the review reads the whole pull request.
  // KNT-158. The merges since the last reviewed head, read once (Kentō on #48): the plan of REV-88
  // and the zones of REV-100 read them, from the same head most of the time.
  const broughtSince = new Map<string, Set<string> | null>();
  const brought = (since: string) => {
    if (!broughtSince.has(since)) broughtSince.set(since, broughtByMerges(input.repoDir, since, input.head));
    return broughtSince.get(since)!;
  };
  const planned = input.delta ? planDelta(input.repoDir, base, input.head, input.delta.since, brought(input.delta.since)) : null;
  const delta = planned && planned.files.length > 0 ? planned : null;
  // REV-100. The zones that changed since the last reviewed commit, for a whole review: an
  // incremental one (REV-88) shows only them already. Out of the reuse key, as the earlier findings.
  const lines = changedLines(input.repoDir, base, input.head);
  // KNT-158. After a merge of the base branch, the zones that changed since the last review are those
  // of the pull request only: the lines that the base brought are no change to look at first.
  const merged = input.reviewed ? brought(input.reviewed) : null;
  const seen = seenCode(input.repoDir, input.reviewed, input.head, merged?.size ? lines : undefined);
  const unkeyed = earlierFindings.section + (delta ? '' : changedZonesSection(seen, [...lines.keys()]));
  // REV-89. The key reads the pack of the whole pull request, incremental or not: a head with the
  // same input gets the same key.
  const whole = buildPack(input.repoDir, base, input.head, config.context, input.rules, sections, undefined, unkeyed);
  const key = reuseKey({ packBody: whole.body, level: input.level, provider: input.kind ?? 'openrouter', models: config.models, toolsAt: config.tools ? input.head : null });
  const earlier = input.delta ? earlierSection(input.delta, delta, new Set(earlierFindings.held.map((e) => e.key))) : '';
  const built =
    delta || earlier
      ? buildPack(input.repoDir, delta ? delta.since : base, input.head, config.context, input.rules, sections + earlier, delta?.files, unkeyed)
      : whole;
  const { skipped, rules, contextHash } = built;
  // KNT-166. An incremental pack reads only the files that changed since the last review. A file of
  // the pull request that the whole pack cuts, and that this pack does not read, was most likely cut
  // then too: it counts as not read.
  const coverage = delta ? deltaCoverage(whole.coverage, built.coverage, delta.files) : built.coverage;
  // « Not reviewed » lists the same files as the summary and the cap: those of the whole pull request
  // that this incremental pack did not read again.
  const skippedAll = delta ? [...skipped, ...whole.skipped.filter((s) => coverage.cut.concat(coverage.large).some((p) => s.startsWith(`${p}: `)) && !skipped.includes(s))] : skipped;
  // KNT-154. The whole pull request decides whether the change is critical, an incremental review
  // too. Its checklist ends the pack: the system prompt stays the same for every review (REV-113).
  // The diff decides it, so the reuse key of the diff covers it.
  const changed = changedFiles(input.repoDir, base, input.head);
  const critical = criticality(changed);
  const checkContext = critical ? criticalCheckContext(input.repoDir, input.head, changed, critical) : null;
  const checklist = critical ? criticalSection(critical, input.prompts) : '';
  const pack = built.pack + checklist;
  const parts = checklist ? [...built.parts, { text: checklist }] : built.parts;
  return {
    base,
    pack,
    parts,
    contextHash,
    skipped: skippedAll,
    rules,
    lines,
    hunks: hunkLines(input.repoDir, base, input.head),
    threads: answered.held,
    rejected: rejected.held,
    earlier: earlierFindings.held,
    diffHash: diffHash(input.repoDir, base, input.head),
    reuseKey: key,
    delta,
    seen,
    coverage,
    critical,
    checkContext,
  };
}

// The most bytes of a critical file at the head that a check of a route or a library reads.
const MAX_CHECK_FILE_BYTES = 200_000;

/**
 * KNT-154. What a path of `checked` must name: a file of the diff (or its old path) or a critical
 * file; and the texts where a route or a library must appear: the changed lines and the critical
 * files at the head.
 */
function criticalCheckContext(repo: string, head: string, changed: ReturnType<typeof changedFiles>, critical: Criticality): CheckContext {
  const files = new Set(changed.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])));
  for (const f of critical.files) files.add(f.path);
  const texts = [changed.flatMap((f) => [...f.added, ...f.removed]).join('\n')];
  for (const { path } of critical.files) {
    try {
      texts.push(git(repo, 'show', `${head}:${path}`).slice(0, MAX_CHECK_FILE_BYTES));
    } catch {
      // A deleted file is not at the head: its changed lines are in the first text.
    }
  }
  return { files, texts };
}

/**
 * The review from the answer of the model: the rules, the anchors, the fingerprints, the score and
 * the verdict. REV-117: the findings carry the references of the link call (linkFindings), and
 * `link` reports that call.
 */
export function finishReview<F extends Finding>(
  input: ReviewInput,
  prepared: PreparedReview,
  answer: Answer & { findings: F[] },
  usage: Usage,
  link: LinkReport = NO_LINK,
): ReviewResult & { findings: (ReviewedFinding & F)[] } {
  const { base, pack, skipped, rules, lines, hunks, threads, rejected, earlier, diffHash, reuseKey, delta, seen, contextHash, coverage } = prepared;
  const log = input.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const fileAt = headFiles(input.repoDir, input.head, log);
  // KNT-154. A critical change, what the answer named that the engine can verify, and whether the
  // score is capped. A review in passes is checked pass by pass. The score, the verdict and the
  // deeper review read it.
  const critical = prepared.critical && prepared.checkContext ? criticalReview(prepared.critical, prepared.checkContext, answer, input.level) : null;
  answer = critical ? withCriticalText({ ...answer, critical }, critical) : { ...answer, critical: null };
  // A finding cites a rule of the pack, or none; the floor of the rule sets its lowest severity. It
  // runs before the anchors and the fingerprint, so that the score, the verdict and the fingerprint
  // see the rule.
  // The fields that a caller added (the pass of a finding, REV-20) stay.
  answer.findings = answer.findings.map((f) => {
    const { rule_id: _cited, ...rest } = f;
    return { ...rest, ...applyRule(f, rules) } as F;
  });
  // KNT-153. A minor finding whose fix says no change is needed goes; one that only asks to confirm
  // becomes a question. After the rules: a rule's severity floor can make a finding major, and then
  // it stays (applyRule).
  answer = withoutNonFindings(answer, log);
  // KNT-152. A race with no traced steps, or a timing claim with no number, becomes a question. After
  // the rules too: a rule's floor of `critical` keeps the finding.
  const timing = splitUntracedTiming(answer, (p) => fileAt(p) !== null);
  answer = timing.answer;
  for (const f of timing.asked) log(`finding moved to the questions, it traces no interleaving or gives no number: ${f.path}: ${f.title}`);
  // REV-99. Each finding that continues an earlier finding names it; one that continues a dismissed
  // or kept finding whose file did not change goes.
  const linked = linkEarlier(answer, earlier, (f) => anchor(f, lines));
  // KNT-196. No label of the pack (`E1`) in the published text: the public id of an open earlier
  // finding, and no sentence on one that is not open.
  if (publicLabels(answer, earlier)) log('labels of earlier findings written as their public ids, or removed');
  for (const f of linked.dropped) log(`finding dropped, it continues a finding that a person set aside and its file did not change: ${f.path}: ${f.title}`);
  // REV-100. A finding whose code did not change since the last reviewed commit is `seen`; the model
  // never sets it.
  answer.findings = answer.findings.map((f) => {
    const { seen: _given, ...rest } = f;
    return (seen && isSeen(f, seen) ? { ...rest, seen: true } : rest) as F;
  });
  // A rewording of an earlier finding, or a new finding to consider (REV-100), is no new defect.
  const isVariant = (f: F) => !isNewDefect(f, earlier);
  // KNT-151. A finding whose premise is code that the review did not read goes to « Not reviewed ».
  // Before the merge of REV-88: a moved finding is no new defect, so the floor of the score holds.
  const moved = moveUnreadPremises(answer);
  for (const f of moved) log(`finding moved to not reviewed, its premise is code that the review did not read: ${f.path}: ${f.title}`);
  // REV-88. The findings of the last review on the files not read again, the settled findings
  // dropped, and the score kept without a new finding.
  let settledAgain: F[] = [];
  let scoreFloor: { model: number; kept: number } | null = null;
  if (input.delta) {
    const merged = mergeDelta(answer, input.delta, delta, fileAt, isVariant);
    answer = merged.answer;
    settledAgain = merged.dropped;
    for (const f of settledAgain) log(`finding dropped, a person settled it: ${f.path}: ${f.title}`);
    // Every lift of the score by the floor is in the log, to check it against the reviews.
    scoreFloor = merged.floored;
    if (merged.floored) {
      log(`score kept at ${merged.floored.kept} by the floor: the model said ${merged.floored.model} with no new finding on ${delta?.files.length ?? 0} files read again`);
    }
    // KNT-151. A finding carried from the last review goes through the same check (Kentō on #44): the
    // same defect is not a finding in one review and « Not reviewed » in the next.
    for (const f of moveUnreadPremises(answer)) {
      moved.push(f);
      log(`finding moved to not reviewed, its premise is code that the review did not read: ${f.path}: ${f.title}`);
    }
  }
  // KNT-153. The findings that an incremental review carries from the last review go through the
  // same filter: a review of an earlier release kept its non-findings. The filter gives the same
  // answer when it runs twice.
  if (input.delta) answer = withoutNonFindings(answer, log);
  // REV-70. A finding that says a name is not imported or not defined is checked against its file.
  const { refuted } = checkMissingNames(answer, fileAt);
  for (const f of refuted) log(`finding dropped, its file at the head holds the name: ${f.path}: ${f.title}`);
  // REV-71. A finding that a reply refuted in its thread, on a file that did not change since.
  const refutedThreads = refutedThreadIds(answer, threads);
  const answeredAway = dropRefuted(answer, threads, (f) => anchor(f, lines));
  for (const f of answeredAway) log(`finding dropped, a reply refuted it in its thread and its file did not change: ${f.path}: ${f.title}`);
  // REV-95. A finding of a rejected defect, on a file that did not change since the rejection, or
  // (KNT-197) that changed away from it. It goes before the score: a rejected defect does not lower it.
  const rejectedDrops = dropRejected(answer, rejected, (f) => anchor(f, lines));
  const rejectedAway = rejectedDrops.map((d) => d.finding);
  for (const { finding: f, why } of rejectedDrops) {
    const reason = why === 'unchanged' ? 'its file did not change' : 'its file did not change near it';
    log(`finding dropped, a person rejected it and ${reason}: ${f.path}: ${f.title}`);
  }
  // REV-99. A whole review (no incremental plan) whose findings all continue earlier findings keeps
  // at least the score of the last review at this level, when that head is in the history of this
  // one: the defect was counted then. A new defect, or a more severe one, lowers it as before.
  // REV-100: so does a finding to consider. With no earlier finding and no finding to consider, the
  // floor has nothing to count once, and the score is the one of the model.
  const last = input.earlier?.last ?? null;
  if (!delta && last && (earlier.length > 0 || answer.findings.some(toConsider)) && answer.findings.every((f) => !isNewDefect(f, earlier)) && inHistory(input.repoDir, last.head, input.head)) {
    const said = Number(answer.confidence_score) || 0;
    if (said < last.score) {
      answer = { ...answer, confidence_score: last.score };
      scoreFloor = { model: said, kept: last.score };
      log(`score kept at ${last.score} by the floor: the model said ${said}, and each of its ${answer.findings.length} findings continues an earlier finding`);
    }
  }
  // KNT-166. Last, after the floors: a review that did not read a file of logic says so, and its score
  // cannot pass what it read.
  const said = Number(answer.confidence_score) || 0;
  const cap = applyCoverage(answer, coverage);
  if (cap !== null && said > cap) log(`score capped at ${cap}: the model said ${said}, and the review did not read ${coverage!.logic.length} changed file${coverage!.logic.length === 1 ? '' : 's'} of logic`);
  const reviewed = (f: F) => ({ ...f, anchor: anchor(f, lines), blocking: isBlocking(f, lines), suggestion_range: null, fingerprint: fingerprint(f, fileAt(f.path)) });
  const findings = answer.findings.map(({ patch: given, ...f }) => {
    const range = anchor(f, lines) === f.line ? suggestionRange(f, hunks) : null;
    // REV-104. An applicable suggestion wins over the patch.
    const patch = range ? null : shownPatch({ ...f, patch: given });
    return {
      ...f,
      ...(patch ? { patch } : {}),
      anchor: anchor(f, lines),
      blocking: isBlocking(f, lines),
      suggestion_range: range,
      fingerprint: fingerprint(f, fileAt(f.path)),
    };
  }) as (ReviewedFinding & F)[];
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
    hunks,
    threads,
    refutedInThread: answeredAway,
    refutedThreads,
    rejected,
    droppedAsRejected: rejectedAway,
    diffHash,
    reuseKey,
    delta,
    settledAgain,
    scoreFloor,
    earlier,
    followed: { byModel: linked.byModel, byNet: linked.byNet },
    droppedAsSettled: linked.dropped,
    seenSince: seen?.since ?? null,
    contextHash,
    link,
    coverage: coverage ?? null,
    moved: moved.map(({ patch: _patch, ...f }) => reviewed(f as F)) as (ReviewedFinding & F)[],
    critical,
  };
}

/**
 * KNT-154. The review of a critical change: what the engine verified of `checked`, pass by pass for a
 * review in passes (the first pass that names a verified path and a real role wins, else the pass
 * that named the most), and whether the score is capped: when no pass named both, or at lite.
 */
export function criticalReview(critical: Criticality, context: CheckContext, answer: Pick<Answer, 'checked' | 'checkedByPass'>, level: Level): CriticalReview {
  const given = answer.checkedByPass?.length ? answer.checkedByPass : [answer.checked ?? { paths: [], roles: [] }];
  const results = given.map((c) => namesChecks(c, context));
  const best = results.find((r) => r.checked) ?? [...results].sort((a, b) => b.paths.length + b.roles.length - (a.paths.length + a.roles.length))[0]!;
  const lite = level === 'lite';
  return { ...critical, checked: best.checked, checks: best, lite, capped: lite || !best.checked };
}

/**
 * KNT-154. The risk and the summary of a critical change, as the reader sees them. The risk names the
 * areas; when the score is capped, it drops each sentence of the model that calls the change safe.
 * The summary lists the paths that the engine verified, the others marked "(not in the diff)", the
 * roles, and says what is missing when the score is capped.
 */
export function withCriticalText<A extends Answer>(answer: A, critical: CriticalReview): A {
  const areas = `Critical change (${areasText(critical.areas)}).`;
  const quote = (item: string) => `\`${item.replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
  // A capped score drops the sentences of the model that advise a merge (risk.ts); a warning stays.
  const kept = critical.capped ? withoutMergeAdvice(answer.risk ?? '') : (answer.risk ?? '').trim();
  const risk = kept ? `${areas} ${kept}` : `${areas} It needs a review that names the paths and the roles that it checked.`;
  const { paths, others, roles, missing } = critical.checks;
  const lines: string[] = [];
  if (paths.length || others.length) lines.push(`Paths checked: ${[...paths.map(quote), ...others.map((p) => `${quote(p)} (not in the diff)`)].join(', ')}.`);
  if (roles.length) lines.push(`Roles checked: ${roles.map(quote).join(', ')}.`);
  if (missing.length) {
    const what =
      missing.length === 2
        ? 'no file of the diff and no role'
        : missing[0] === 'paths'
          ? 'no file of the diff, route or library endpoint of the change'
          : 'no role (a placeholder such as "none" or "all" is none)';
    lines.push(`The review named ${what} that it checked, so the score of this critical change is 3 at most.`);
  } else if (critical.lite) {
    lines.push('A lite review of a critical change scores 3 at most. A balanced or heavy review that names its checks can score more.');
  }
  return { ...answer, risk, summary: [answer.summary, lines.join(' ')].filter((t) => t?.trim()).join('\n\n') };
}

/** KNT-153. The answer without its non-findings, each one in the log. */
function withoutNonFindings<A extends Answer>(answer: A, log: (message: string) => void): A {
  const { answer: out, dropped, asked } = splitNonFindings(answer);
  for (const f of dropped) log(`finding dropped, its fix says that no change is needed: ${f.path}: ${f.title}`);
  for (const f of asked) log(`finding moved to the questions, it asks to confirm and names no defect: ${f.path}: ${f.title}`);
  return out;
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
