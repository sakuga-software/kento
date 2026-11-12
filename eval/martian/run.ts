/**
 * A slice of the Martian Code Review Bench for Sakuga Review: each model reviews the selected pull
 * requests with the engine of packages/engine, as the Action does, and the judge of Martian matches
 * each finding against the golden comments. See README.md.
 *
 *     OPENROUTER_API_KEY=... node eval/martian/run.ts --subset subset.json --repos <dir> --out <dir> \
 *       --label run1 --models z-ai/glm-5.3,xiaomi/mimo-v2.6-pro
 *
 * `--level` gives the level (lite by default). `--passes` reviews in passes (REV-20): each model of
 * `--models` runs the passes, and the model of the level checks their findings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isLevel, levelConfig, providerLevelConfig, reviewInPasses, reviewPullRequest, type Level } from '../../packages/engine/src/index.ts';
import { costFromTable } from '../../packages/engine/src/prices.ts';
import { mergeSamples } from './merge.ts';
import { PROFILES, profileMetrics, type Profile } from './profiles.ts';

/**
 * `--provider anthropic` calls the Messages API of Anthropic with `ANTHROPIC_API_KEY`, as the runner
 * does with a provider of kind `anthropic`: the models take their Anthropic ids (`claude-haiku-5-5`),
 * and the judge is the same model, Claude Sonnet 5.5, at Anthropic.
 */
let ANTHROPIC = false;
let JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'anthropic/claude-sonnet-5.5';
const REVIEWS_AT_ONCE = 6;
const KENTO_REVIEWERS = /^(kento-review|sakuga-claude-review)\[bot\]$/;
const JUDGE_CALLS_AT_ONCE = 12;

// The judge prompt of Martian (offline/code_review_benchmark/step3_judge_comments.py), unchanged.
const JUDGE_PROMPT = `You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Golden Comment (the issue we're looking for):
{golden_comment}

Candidate Issue (from the tool's review):
{candidate}

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue

Respond with ONLY a JSON object:
{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}`;

type Golden = { comment: string; severity: string; category: string; reviewers?: string[] };
type Pr = {
  source: 'martian' | 'internal' | 'feedback';
  repo: string;
  url: string;
  owner?: string;
  name?: string;
  repo_dir?: string;
  base: string;
  head: string;
  golden: Golden[];
  /** REV-69, internal cases: comments whose premise the author showed false. A finding that matches one is a sure false positive. */
  false_positives?: { comment: string; reviewer: string }[];
};
type Review = {
  findings: string[];
  cost: number;
  seconds: number;
  model?: string;
  error?: string;
  /** REV-68: the tokens of the review, and what its tools used (REVIEW_TOOLS=1). */
  tokens?: { prompt: number; completion: number; cacheRead: number };
  tools?: { rounds: number; calls: number; bytes: number };
  /** REV-20, in passes: the findings of each pass, the passes that failed, and the findings that the check dropped. */
  passes?: { id: string; findings: number; cost: number; error?: string }[];
  dropped?: string[];
  /** The candidates of the dropped findings, as the judge reads the kept ones. */
  droppedCandidates?: string[];
  verification?: string;
  verificationCost?: number;
  /** REV-67, with --samples: the findings that the merge dropped as duplicates of another sample. */
  merged?: number;
  /** REV-104, in one pass: the P0 and P1 findings, those with a suggestion that GitHub shows, and those with a patch. */
  fixes?: Fixes;
};
type Fixes = { p01: number; suggestions: number; patches: number };

function fixesOf(findings: { severity: string; suggestion_range: [number, number] | null; patch?: string }[]): Fixes {
  const p01 = findings.filter((f) => f.severity !== 'minor');
  return { p01: p01.length, suggestions: p01.filter((f) => f.suggestion_range).length, patches: p01.filter((f) => f.patch).length };
}
type Mode = { level: Level; passes: boolean; samples: number };


async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index]);
      }
    }),
  );
  return out;
}

async function review(pr: Pr, model: string, repoDir: string, mode: Mode): Promise<Review> {
  const start = Date.now();
  // The failed attempts of the engine: a fallback to the next model shows here.
  const failures: string[] = [];
  const timeout = process.env.REVIEW_TIMEOUT_MS ?? '480000';
  // The candidate that the judge reads: what a reader of the review reads.
  const candidate = (f: { path: string; line: number; title: string; scenario: string; fix: string }) => `${f.path}:${f.line} — ${f.title}. ${f.scenario} Fix: ${f.fix}`;
  const input = {
    repoDir,
    base: pr.base,
    head: pr.head,
    level: mode.level,
    ...(ANTHROPIC ? { kind: 'anthropic' as const, apiKey: process.env.ANTHROPIC_API_KEY } : { apiKey: process.env.OPENROUTER_API_KEY }),
    log: (message: string) => failures.push(message),
  };
  try {
    if (mode.passes) {
      // REV-20. The passes at the lite level with the model under test, the check with the model of the level.
      // The check reads no REVIEW_* but the time limit: REVIEW_MODELS names the model under test, and
      // the check must stay the same from one run to the next, as the judge does.
      const passConfig = levelConfig('lite', { ...process.env, REVIEW_MODELS: model, REVIEW_TIMEOUT_MS: timeout });
      const verifyConfig = ANTHROPIC
        ? providerLevelConfig(mode.level, 'anthropic', undefined, { REVIEW_TIMEOUT_MS: timeout })
        : levelConfig(mode.level, { REVIEW_TIMEOUT_MS: timeout });
      const out = await reviewInPasses(input, { passConfig, verifyConfig });
      return {
        findings: out.findings.map(candidate),
        cost: out.usage.cost ?? 0,
        seconds: Math.round((Date.now() - start) / 1000),
        model: out.passes.find((p) => p.model)?.model ?? undefined,
        error: failures[0],
        passes: out.passes.map(({ id, findings, cost, error }) => ({ id, findings, cost, ...(error ? { error } : {}) })),
        dropped: out.dropped.map((f) => `${candidate(f)} [${f.pass}: ${f.reason}]`),
        droppedCandidates: out.dropped.map(candidate),
        verification: out.verification,
        verificationCost: out.verificationUsage?.cost ?? 0,
      };
    }
    // A review in one pass, with the variables REVIEW_* of the environment, as the Action reads them.
    const config = levelConfig(mode.level, { ...process.env, REVIEW_MODELS: model, REVIEW_TIMEOUT_MS: timeout });
    if (mode.samples > 1) {
      const outs = await Promise.all(Array.from({ length: mode.samples }, () => reviewPullRequest({ ...input, config })));
      const { findings, merged } = mergeSamples(outs.map((out) => out.findings));
      const cost = outs.reduce((total, out) => total + (out.usage.cost ?? 0), 0);
      return { findings: findings.map(candidate), cost, seconds: Math.round((Date.now() - start) / 1000), model: outs[0].usage.model, error: failures[0], merged };
    }
    const out = await reviewPullRequest({ ...input, config });
    return {
      findings: out.findings.map(candidate),
      cost: out.usage.cost ?? 0,
      seconds: Math.round((Date.now() - start) / 1000),
      model: out.usage.model,
      error: failures[0],
      tokens: { prompt: out.usage.prompt_tokens ?? 0, completion: out.usage.completion_tokens ?? 0, cacheRead: out.usage.cache_read_tokens ?? 0 },
      fixes: fixesOf(out.findings),
      ...(out.toolUse ? { tools: out.toolUse } : {}),
    };
  } catch (error) {
    const message = [...failures, String(error)].join('\n').slice(-600);
    return { findings: [], cost: 0, seconds: Math.round((Date.now() - start) / 1000), error: message };
  }
}

let judgeCost = 0;
let judgeErrors = 0;

async function judgeAtAnthropic(golden: string, candidate: string): Promise<{ match: boolean; confidence: number }> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: JUDGE_PROMPT.replace('{golden_comment}', golden).replace('{candidate}', candidate) }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const out = await response.json();
  if (!response.ok) throw new Error(`judge answered ${response.status}`);
  const usage = out.usage ?? {};
  judgeCost +=
    costFromTable('anthropic', JUDGE_MODEL, {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    }) ?? 0;
  const text: string = (out.content ?? []).filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('');
  const verdict = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return { match: verdict.match === true, confidence: Number(verdict.confidence) || 0 };
}

/** Gives null when the judge does not answer three times: the caller reports it as an error. */
async function judge(golden: string, candidate: string): Promise<{ match: boolean; confidence: number } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (ANTHROPIC) return await judgeAtAnthropic(golden, candidate);
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          max_tokens: 400,
          usage: { include: true },
          messages: [{ role: 'user', content: JUDGE_PROMPT.replace('{golden_comment}', golden).replace('{candidate}', candidate) }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const out = await response.json();
      judgeCost += out.usage?.cost ?? 0;
      const text: string = out.choices?.[0]?.message?.content ?? '';
      const verdict = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      return { match: verdict.match === true, confidence: Number(verdict.confidence) || 0 };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  judgeErrors++;
  return null;
}

/**
 * The counts of Martian (step3_judge_comments.py): a golden comment is found if one finding matches
 * it. Precision is the found golden comments over all findings, so two findings on one defect count
 * once.
 */
async function score(pr: Pr, findings: string[]) {
  const pairs = pr.golden.flatMap((g) => findings.map((f, index) => ({ g, f, index })));
  const verdicts = await pool(pairs, JUDGE_CALLS_AT_ONCE, ({ g, f }) => judge(g.comment, f));
  const found = new Set(pairs.filter((_, i) => verdicts[i]?.match).map(({ g }) => g.comment));
  return {
    found: pr.golden.filter((g) => found.has(g.comment)).map((g) => ({ severity: g.severity, category: g.category })),
    golden: pr.golden.length,
    categories: pr.golden.map((g) => g.category),
    severities: pr.golden.map((g) => g.severity),
    // A golden comment that Kentō alone found would measure Kentō against itself.
    independent: pr.golden.map((g) => !g.reviewers || g.reviewers.some((r) => !KENTO_REVIEWERS.test(r))),
    comments: [...found],
    // For each finding, the indexes in pr.golden of the golden comments that it matches: [] is a finding with no match.
    matches: findings.map((_, index) => pairs.flatMap(({ g, index: other }, i) => (other === index && verdicts[i]?.match ? [pr.golden.indexOf(g)] : []))),
    known_false: await knownFalse(pr, findings),
  };
}

/** The findings that match a known false positive of the pull request. */
async function knownFalse(pr: Pr, findings: string[]): Promise<number> {
  const known = pr.false_positives ?? [];
  const pairs = known.flatMap((k) => findings.map((f, index) => ({ k, f, index })));
  const verdicts = await pool(pairs, JUDGE_CALLS_AT_ONCE, ({ k, f }) => judge(k.comment, f));
  return new Set(pairs.filter((_, i) => verdicts[i]?.match).map(({ index }) => index)).size;
}

type Row = { source: string; findings: string[]; found: unknown[]; golden: number };

function metrics(rows: Row[]) {
  const found = rows.reduce((total, row) => total + row.found.length, 0);
  const golden = rows.reduce((total, row) => total + row.golden, 0);
  const findings = rows.reduce((total, row) => total + row.findings.length, 0);
  const recall = found / Math.max(golden, 1);
  const precision = found / Math.max(findings, 1);
  return { recall, precision, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, found, golden, findings };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function main() {
  const { values } = parseArgs({
    options: {
      subset: { type: 'string' },
      repos: { type: 'string' },
      out: { type: 'string' },
      label: { type: 'string' },
      models: { type: 'string' },
      level: { type: 'string', default: 'lite' },
      passes: { type: 'boolean', default: false },
      samples: { type: 'string', default: '1' },
      provider: { type: 'string', default: 'openrouter' },
    },
  });
  if (values.provider !== 'openrouter' && values.provider !== 'anthropic') throw new Error(`--provider must be openrouter or anthropic, not "${values.provider}"`);
  ANTHROPIC = values.provider === 'anthropic';
  if (ANTHROPIC) JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'claude-sonnet-5-5';
  if (!isLevel(values.level)) throw new Error(`--level must be lite, balanced or heavy, not "${values.level}"`);
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`--samples must be a whole number of 1 or more, not "${values.samples}"`);
  if (samples > 1 && values.passes) throw new Error('--samples and --passes cannot go together');
  const mode: Mode = { level: values.level, passes: values.passes === true, samples };
  const prs: Pr[] = JSON.parse(readFileSync(values.subset!, 'utf8'));
  const out = values.out!;
  mkdirSync(out, { recursive: true });
  const dirs = prs.map((pr) => pr.repo_dir ?? join(values.repos!, `${pr.owner}__${pr.name}`));
  for (const model of values.models!.split(',')) {
    // The level and the passes are in the name of the file of a run that is not lite in one pass.
    const tag = (mode.level === 'lite' && !mode.passes ? '' : `-${mode.level}${mode.passes ? '-passes' : ''}`) + (mode.samples > 1 ? `-x${mode.samples}` : '');
    const file = join(out, `${values.label}${tag}-${model.replace('/', '_')}.json`);
    if (existsSync(file)) continue;
    judgeCost = 0;
    judgeErrors = 0;
    const reviews = await pool(prs, REVIEWS_AT_ONCE, (pr) => review(pr, model, dirs[prs.indexOf(pr)], mode));
    const scores = await pool(prs, 4, (pr) => score(pr, reviews[prs.indexOf(pr)].findings));
    // In passes, the judge reads the dropped findings too: a golden comment that only a dropped finding
    // matches is a defect that the check removed.
    const droppedScores = mode.passes ? await pool(prs, 4, (pr) => score(pr, reviews[prs.indexOf(pr)].droppedCandidates ?? [])) : [];
    const rows = prs.map((pr, i) => {
      const lost = (droppedScores[i]?.comments ?? []).filter((comment) => !scores[i].comments.includes(comment));
      return { url: pr.url, source: pr.source, ...reviews[i], ...scores[i], ...(mode.passes ? { dropped_true: lost.length } : {}) };
    });
    const all = metrics(rows);
    const martian = metrics(rows.filter((row) => row.source === 'martian'));
    const internal = metrics(rows.filter((row) => row.source === 'internal'));
    const bySource = (source?: string) => {
      const scored = rows.filter((row) => !source || row.source === source);
      return Object.fromEntries(Object.keys(PROFILES).map((name) => [name, profileMetrics(scored, name as Profile)]));
    };
    const profiles = { all: bySource(), martian: bySource('martian'), internal: bySource('internal'), feedback: bySource('feedback') };
    // Core on the golden comments of severity Medium or more: the defects that the prompt aims at.
    const blockingRows = rows.map((row) => ({
      categories: row.categories.map((category, i) => (row.severities[i] === 'Low' ? 'low' : category)),
      matches: row.matches,
    }));
    const coreMediumUp = profileMetrics(blockingRows, 'core');
    // The Core recall on the golden comments that a reviewer other than Kentō found.
    const independentRows = rows.map((row) => ({
      categories: row.categories.map((category, i) => (row.independent[i] ? category : 'not-independent')),
      matches: row.matches,
    }));
    const independentRecall = profileMetrics(independentRows, 'core');
    const result = {
      model,
      label: values.label,
      level: mode.level,
      passes: mode.passes,
      ...all,
      failures: rows.filter((row) => row.error && !row.findings.length).length,
      fallbacks: rows.filter((row) => row.model && !row.model.startsWith(model)).length,
      judge_errors: judgeErrors,
      review_cost: rows.reduce((total, row) => total + row.cost, 0),
      judge_cost: judgeCost,
      median_seconds: median(rows.map((row) => row.seconds)),
      // REV-20, in passes: the findings that the check dropped, and the passes that failed.
      dropped: rows.reduce((total, row) => total + (row.dropped?.length ?? 0), 0),
      // The golden comments that only a dropped finding matched: the recall that the check cost.
      dropped_true: rows.reduce((total, row) => total + (row.dropped_true ?? 0), 0),
      verification_cost: rows.reduce((total, row) => total + (row.verificationCost ?? 0), 0),
      failed_passes: rows.reduce((total, row) => total + (row.passes?.filter((p) => p.error).length ?? 0), 0),
      merged: rows.reduce((total, row) => total + (row.merged ?? 0), 0),
      fixes: {
        p01: rows.reduce((total, row) => total + (row.fixes?.p01 ?? 0), 0),
        suggestions: rows.reduce((total, row) => total + (row.fixes?.suggestions ?? 0), 0),
        patches: rows.reduce((total, row) => total + (row.fixes?.patches ?? 0), 0),
      },
      martian,
      internal,
      profiles,
      independent_recall: independentRecall.recall,
      core_medium_up: coreMediumUp,
      known_false: rows.reduce((total, row) => total + row.known_false, 0),
      known_false_total: prs.reduce((total, pr) => total + (pr.false_positives?.length ?? 0), 0),
      rows,
    };
    writeFileSync(file, JSON.stringify(result, null, 2));
    const percent = (value: number) => `${(value * 100).toFixed(0)} %`;
    console.log(
      `${model}${tag}: F1 core ${profiles.all.core.f1.toFixed(2)} (martian ${profiles.martian.core.f1.toFixed(2)}, internal ${profiles.internal.core.f1.toFixed(2)}, feedback ${profiles.feedback.core.f1.toFixed(2)}) · F1 martian ${martian.f1.toFixed(2)} · recall ${percent(all.recall)} · precision ${percent(all.precision)} · ` +
        `${all.findings} findings · ${result.failures} failures · ${judgeErrors} judge errors · review $${result.review_cost.toFixed(3)} · ` +
        `judge $${judgeCost.toFixed(3)} · median ${result.median_seconds}s · martian ${martian.found}/${martian.golden} · internal ${internal.found}/${internal.golden}` +
        (mode.passes
          ? ` · ${result.dropped} dropped by the check (${result.dropped_true} true) · check $${result.verification_cost.toFixed(3)} · ${result.failed_passes} failed passes`
          : '') +
        (mode.samples > 1 ? ` · ${result.merged} duplicates merged` : '') +
        (mode.passes || mode.samples > 1 ? '' : ` · P0/P1 ${result.fixes.p01}, with a suggestion ${result.fixes.suggestions}, with a patch ${result.fixes.patches}`) +
        ` · F1 core medium+ ${coreMediumUp.f1.toFixed(2)} · independent recall ${percent(independentRecall.recall)} · ${result.known_false} findings repeat one of ${result.known_false_total} known false positives`,
    );
  }
}

await main();
