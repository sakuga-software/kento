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
import { isLevel, levelConfig, reviewInPasses, reviewPullRequest, type Level } from '../../packages/engine/src/index.ts';

const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'anthropic/claude-sonnet-5.5';
const REVIEWS_AT_ONCE = 6;
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

type Golden = { comment: string; severity: string; category: string };
type Pr = {
  source: 'martian' | 'internal';
  repo: string;
  url: string;
  owner?: string;
  name?: string;
  repo_dir?: string;
  base: string;
  head: string;
  golden: Golden[];
};
type Review = {
  findings: string[];
  cost: number;
  seconds: number;
  model?: string;
  error?: string;
  /** REV-20, in passes: the findings of each pass, the passes that failed, and the findings that the check dropped. */
  passes?: { id: string; findings: number; error?: string }[];
  dropped?: string[];
  verification?: string;
};
type Mode = { level: Level; passes: boolean };

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
  const input = { repoDir, base: pr.base, head: pr.head, level: mode.level, apiKey: process.env.OPENROUTER_API_KEY, log: (message: string) => failures.push(message) };
  try {
    if (mode.passes) {
      // REV-20. The passes at the lite level with the model under test, the check with the model of the level.
      // The check reads no REVIEW_* but the time limit: REVIEW_MODELS names the model under test, and
      // the check must stay the same from one run to the next, as the judge does.
      const passConfig = levelConfig('lite', { ...process.env, REVIEW_MODELS: model, REVIEW_TIMEOUT_MS: timeout });
      const verifyConfig = levelConfig(mode.level, { REVIEW_TIMEOUT_MS: timeout });
      const out = await reviewInPasses(input, { passConfig, verifyConfig });
      return {
        findings: out.findings.map(candidate),
        cost: out.usage.cost ?? 0,
        seconds: Math.round((Date.now() - start) / 1000),
        model: out.passes.find((p) => p.model)?.model ?? undefined,
        error: failures[0],
        passes: out.passes.map(({ id, findings, error }) => ({ id, findings, ...(error ? { error } : {}) })),
        dropped: out.dropped.map((f) => `${candidate(f)} [${f.pass}: ${f.reason}]`),
        verification: out.verification,
      };
    }
    // A review in one pass, with the variables REVIEW_* of the environment, as the Action reads them.
    const config = levelConfig(mode.level, { ...process.env, REVIEW_MODELS: model, REVIEW_TIMEOUT_MS: timeout });
    const out = await reviewPullRequest({ ...input, config });
    return { findings: out.findings.map(candidate), cost: out.usage.cost ?? 0, seconds: Math.round((Date.now() - start) / 1000), model: out.usage.model, error: failures[0] };
  } catch (error) {
    const message = [...failures, String(error)].join('\n').slice(-600);
    return { findings: [], cost: 0, seconds: Math.round((Date.now() - start) / 1000), error: message };
  }
}

let judgeCost = 0;
let judgeErrors = 0;

/** Gives null when the judge does not answer three times: the caller reports it as an error. */
async function judge(golden: string, candidate: string): Promise<{ match: boolean; confidence: number } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
  const pairs = pr.golden.flatMap((g) => findings.map((f) => ({ g, f })));
  const verdicts = await pool(pairs, JUDGE_CALLS_AT_ONCE, ({ g, f }) => judge(g.comment, f));
  const found = new Set(pairs.filter((_, i) => verdicts[i]?.match).map(({ g }) => g.comment));
  return {
    found: pr.golden.filter((g) => found.has(g.comment)).map((g) => ({ severity: g.severity, category: g.category })),
    golden: pr.golden.length,
  };
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
    },
  });
  if (!isLevel(values.level)) throw new Error(`--level must be lite, balanced or heavy, not "${values.level}"`);
  const mode: Mode = { level: values.level, passes: values.passes === true };
  const prs: Pr[] = JSON.parse(readFileSync(values.subset!, 'utf8'));
  const out = values.out!;
  mkdirSync(out, { recursive: true });
  const dirs = prs.map((pr) => pr.repo_dir ?? join(values.repos!, `${pr.owner}__${pr.name}`));
  for (const model of values.models!.split(',')) {
    // The level and the passes are in the name of the file of a run that is not lite in one pass.
    const tag = mode.level === 'lite' && !mode.passes ? '' : `-${mode.level}${mode.passes ? '-passes' : ''}`;
    const file = join(out, `${values.label}${tag}-${model.replace('/', '_')}.json`);
    if (existsSync(file)) continue;
    judgeCost = 0;
    judgeErrors = 0;
    const reviews = await pool(prs, REVIEWS_AT_ONCE, (pr) => review(pr, model, dirs[prs.indexOf(pr)], mode));
    const scores = await pool(prs, 4, (pr) => score(pr, reviews[prs.indexOf(pr)].findings));
    const rows = prs.map((pr, i) => ({ url: pr.url, source: pr.source, ...reviews[i], ...scores[i] }));
    const all = metrics(rows);
    const martian = metrics(rows.filter((row) => row.source === 'martian'));
    const internal = metrics(rows.filter((row) => row.source === 'internal'));
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
      failed_passes: rows.reduce((total, row) => total + (row.passes?.filter((p) => p.error).length ?? 0), 0),
      martian,
      internal,
      rows,
    };
    writeFileSync(file, JSON.stringify(result, null, 2));
    const percent = (value: number) => `${(value * 100).toFixed(0)} %`;
    console.log(
      `${model}${tag}: F1 martian ${martian.f1.toFixed(2)} · recall ${percent(all.recall)} · precision ${percent(all.precision)} · ` +
        `${all.findings} findings · ${result.failures} failures · ${judgeErrors} judge errors · review $${result.review_cost.toFixed(3)} · ` +
        `judge $${judgeCost.toFixed(3)} · median ${result.median_seconds}s · martian ${martian.found}/${martian.golden} · internal ${internal.found}/${internal.golden}` +
        (mode.passes ? ` · ${result.dropped} dropped by the check · ${result.failed_passes} failed passes` : ''),
    );
  }
}

await main();
