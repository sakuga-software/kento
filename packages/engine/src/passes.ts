// REV-20. A review in several passes: each pass reads the same pack from one angle, then a stronger
// model keeps or drops each finding with its code. The bench (eval/martian) compares it with the
// review in one pass; no level of production uses it yet.
import type { Answer, Finding, Usage } from './findings.ts';
import type { LevelConfig } from './levels.ts';
import { linkFindings, withLinkUsage } from './link.ts';
import { askJson, askModel } from './model.ts';
import { MAX_QUESTIONS } from './nonfindings.ts';
import { finishReview, packSchema, prepareReview, reviewTools, type ReviewedFinding, type ReviewInput, type ReviewResult } from './review.ts';

/** The angle of a pass: its id, and the text that the prompt of the review gets at its end. */
export type Pass = { id: string; focus: string };

/** The passes of base of REV-20: security, data and migrations, contracts and logic. */
export const BASE_PASSES: readonly Pass[] = [
  {
    id: 'security',
    focus: `# Focus of this pass

This pass looks for security defects only: an input that reaches a query, a
command, a path, a URL or HTML without a check; a missing check of who may act;
a secret in the code or in a log; a token or a session that lives too long or
leaks. Report no other kind of defect: other passes cover them.`,
  },
  {
    id: 'data',
    focus: `# Focus of this pass

This pass looks for defects of data only: a migration that loses or locks data,
or that the code of the previous release cannot run on; a write that is not in
the transaction it needs; a race between two writers; a query that reads or
updates the wrong rows; a missing index, constraint or null check that lets a
bad row in. Report no other kind of defect: other passes cover them.`,
  },
  {
    id: 'contracts',
    focus: `# Focus of this pass

This pass looks for defects of contracts and logic only: a changed signature,
response, schema or event that a caller still uses the old way; a condition, a
boundary or a branch that gives the wrong result; an error that is swallowed or
reported as a success. Report no other kind of defect: other passes cover them.`,
  },
];

export type PassedFinding = Finding & { pass: string };

export type PassReport = {
  id: string;
  /** The model that answered, or null when the pass failed. */
  model: string | null;
  /** The findings that the pass gave, before the merge and the check. */
  findings: number;
  cost: number;
  /** Why the pass failed; the review goes on with the other passes. */
  error?: string;
};

export type PassesResult = Omit<ReviewResult, 'findings'> & {
  findings: (ReviewedFinding & PassedFinding)[];
  passes: PassReport[];
  /** The findings that the check dropped, with its reason. */
  dropped: (PassedFinding & { reason: string })[];
  /** How the check went: `done`, or `failed` (every finding is kept), or `none` (nothing to check). */
  verification: 'done' | 'failed' | 'none';
  verificationUsage: Usage | null;
};

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, keep: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['index', 'keep', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

/**
 * The review of a pull request in passes. `passConfig` is the level of each pass (`lite` for
 * `balanced`), `verifyConfig` the level of the check. The passes run at once; one that fails is
 * reported in `passes` and the review goes on with the others. All of them failing throws, as a
 * review in one pass does.
 */
export async function reviewInPasses(
  input: ReviewInput,
  options: { passConfig: LevelConfig; verifyConfig: LevelConfig; passes?: readonly Pass[] },
): Promise<PassesResult> {
  const passes = options.passes ?? BASE_PASSES;
  const prepared = prepareReview(input, options.passConfig, passes.map((pass) => pass.focus));
  // REV-68. One budget for the review: the passes share it.
  const tools = reviewTools(input, options.passConfig);
  const schema = packSchema(prepared);
  // REV-113. The passes send the same pack within seconds: its end carries a cache mark of 5 minutes,
  // and the focus of each pass follows it.
  const pack = prepared.parts.map((part, i, all) => (i === all.length - 1 ? { ...part, cache: '5m' as const } : part));
  const settled = await afterFirstStart(passes, (pass, onStart) => askModel(input, options.passConfig, pack, pass.focus, tools, onStart, schema));

  const reports: PassReport[] = [];
  const answers: { pass: Pass; answer: Answer }[] = [];
  let cost = 0;
  settled.forEach((outcome, i) => {
    const pass = passes[i]!;
    if (outcome.status === 'rejected') {
      reports.push({ id: pass.id, model: null, findings: 0, cost: 0, error: String(outcome.reason).slice(0, 300) });
      return;
    }
    const { answer, usage } = outcome.value;
    cost += usage.cost ?? 0;
    reports.push({ id: pass.id, model: usage.model ?? null, findings: answer.findings.length, cost: usage.cost ?? 0 });
    answers.push({ pass, answer });
  });
  if (answers.length === 0) throw new Error(`every pass failed: ${reports.map((r) => `${r.id}: ${r.error}`).join('; ')}`);

  const candidates: PassedFinding[] = answers.flatMap(({ pass, answer }) => answer.findings.map((f) => ({ ...f, pass: pass.id })));
  const checked = await verify(input, options.verifyConfig, prepared.pack, candidates);
  cost += checked.usage?.cost ?? 0;
  // REV-117. One link call for the findings that the check kept.
  const linked = await linkFindings(input, options.passConfig, checked.kept, prepared.rules, prepared.earlier);

  // The text of the review comes from the pass of contracts and logic, the broadest one, or from the
  // first pass that answered.
  const lead = answers.find((a) => a.pass.id === 'contracts') ?? answers[0]!;
  const answer: Answer & { findings: PassedFinding[] } = {
    ...lead.answer,
    confidence_score: passesScore(answers, checked.kept),
    not_reviewed: [...new Set(answers.flatMap((a) => a.answer.not_reviewed ?? []))],
    deeper_review: answers.map((a) => a.answer.deeper_review).find((d) => d?.recommended) ?? lead.answer.deeper_review,
    // KNT-153. The questions of every pass, once each.
    // A pass can give a null or a malformed item: only a question with a text goes on.
    questions: [
      ...new Map(
        answers
          .flatMap((a) => (Array.isArray(a.answer.questions) ? a.answer.questions : []))
          .filter((q) => q && typeof q.question === 'string')
          .map((q) => [`${q.path}\n${q.question}`, q]),
      ).values(),
    ].slice(0, MAX_QUESTIONS),
    // KNT-154. What each pass checked: one pass must name both a path and a role (finishReview).
    checkedByPass: answers.map((a) => a.answer.checked ?? { paths: [], roles: [] }),
    findings: linked.findings,
    // REV-71. The verdicts of every pass, with their pass: only the pass of a finding can uphold its
    // thread against a refutation (answered.ts).
    threads: answers.flatMap(({ pass, answer }) => (Array.isArray(answer.threads) ? answer.threads : []).map((v) => ({ ...v, pass: pass.id }))),
  };
  const usage: Usage = withLinkUsage(
    {
      model: `passes(${reports.map((r) => r.model ?? `${r.id} failed`).join(', ')}) + ${checked.usage?.model ?? 'no check'}`,
      cost,
      cost_source: 'provider',
    },
    linked.report,
  );
  return {
    ...finishReview(input, prepared, answer, usage, linked.report),
    passes: reports,
    dropped: checked.dropped,
    verification: checked.status,
    verificationUsage: checked.usage,
    ...(tools ? { toolUse: tools.used } : {}),
  };
}

/**
 * REV-113. Sends the first call, then the others when the answer of the first starts, or when it
 * fails. A cache entry exists only after the answer of its request starts: calls sent at once all
 * write the system prompt and the pack, and none reads them.
 */
export async function afterFirstStart<T, R>(items: readonly T[], call: (item: T, onStart?: () => void) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const first = call(items[0]!, start);
  first.then(() => start(), () => start());
  await started;
  return Promise.allSettled([first, ...items.slice(1).map((item) => call(item))]);
}

/**
 * A review in passes is as sure as its least sure pass, among the passes that still count: a pass
 * whose findings the check all dropped no longer counts, and a score out of 1 to 5 (0, missing) is
 * not one. With none left, 0: `score()` reads it as 3, as for a review in one pass.
 */
export function passesScore(answers: { pass: Pass; answer: Answer }[], kept: PassedFinding[]): number {
  const counts = answers.filter(({ pass, answer }) => answer.findings.length === 0 || kept.some((f) => f.pass === pass.id));
  const scores = counts.map(({ answer }) => answer.confidence_score).filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  return scores.length ? Math.min(...scores) : 0;
}

/**
 * The check: one call that keeps or drops each finding, with the pack. A finding that the answer
 * does not name is kept. A failed call keeps every finding: the check must never lose a defect by
 * failing.
 */
async function verify(input: ReviewInput, config: LevelConfig, pack: string, findings: PassedFinding[]) {
  const log = input.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  if (findings.length === 0) return { kept: [], dropped: [], status: 'none' as const, usage: null };
  const list = findings.map((f, index) => ({
    index,
    pass: f.pass,
    path: f.path,
    start_line: f.start_line,
    line: f.line,
    severity: f.severity,
    category: f.category,
    title: f.title,
    scenario: f.scenario,
    fix: f.fix,
    // KNT-152. The check reads the steps of a race first (verify.md).
    ...(f.interleaving?.length ? { interleaving: f.interleaving } : {}),
  }));
  const message = `${pack}\n\n# Findings to check\n\n${JSON.stringify(list, null, 2)}\n`;
  try {
    const { answer, usage } = await askJson<{ verdicts: { index: number; keep: boolean; reason: string }[] }>(
      input,
      config,
      'verify.md',
      message,
      { name: 'verification', schema: VERDICTS_SCHEMA },
    );
    // A finding is dropped only when every verdict that names it drops it: two verdicts that disagree
    // keep it. A verdict whose index names no finding is logged.
    const verdicts = answer.verdicts ?? [];
    const stray = verdicts.filter((v) => !Number.isInteger(v.index) || v.index < 0 || v.index >= findings.length);
    if (stray.length) log(`the check named ${stray.length} finding(s) that the list does not hold: ${stray.map((v) => v.index).join(', ')}`);
    const kept: PassedFinding[] = [];
    const dropped: (PassedFinding & { reason: string })[] = [];
    findings.forEach((f, index) => {
      const mine = verdicts.filter((v) => v.index === index);
      if (mine.length > 0 && mine.every((v) => v.keep === false)) dropped.push({ ...f, reason: mine[0]!.reason });
      else kept.push(f);
    });
    return { kept, dropped, status: 'done' as const, usage };
  } catch (error) {
    log(`the check of the findings failed, every finding is kept: ${error}`);
    return { kept: findings, dropped: [], status: 'failed' as const, usage: null };
  }
}
