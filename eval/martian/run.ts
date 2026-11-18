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
 *
 * REV-109: `--repeats N` writes one file for each repeat. `--prompt <file>` replaces prompts/review.md.
 * The reviews and the verdicts of the judge stay in `--out` (`reviews/`, `judge-cache.jsonl`): a run
 * that stops pays again only for what it did not finish. `--judge-batch` sends the judge through the
 * Message Batches API of Anthropic, at half the price. `--prefilter` skips the pairs of a golden
 * comment that names a file with the findings on another file (prefilter.ts). `--estimate` stops
 * after the reviews and gives the number of judge calls left, and their cost.
 *
 * REV-117: `--rules <file>` gives the rules of a JSON file (an array of rules, as rules.ts reads
 * them) to every review: the pack then holds a Rules section, and the link call runs.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { isLevel, levelConfig, providerLevelConfig, reviewInPasses, reviewPullRequest, type Level } from '../../packages/engine/src/index.ts';
import type { Usage } from '../../packages/engine/src/findings.ts';
import type { Rule } from '../../packages/engine/src/rules.ts';
import { costFromTable } from '../../packages/engine/src/prices.ts';
import { requestTokens } from '../../packages/engine/src/providers.ts';
import { failureCounts, failureKind } from './failures.ts';
import { mergeSamples } from './merge.ts';
import { prefilterKeeps } from './prefilter.ts';
import { PROFILES, profileMetrics, type Profile } from './profiles.ts';

/**
 * `--provider anthropic` calls the Messages API of Anthropic with `ANTHROPIC_API_KEY`, as the runner
 * does with a provider of kind `anthropic`: the models take their Anthropic ids (`claude-haiku-5-5`),
 * and the judge is the same model, Claude Sonnet 5.5, at Anthropic.
 */
let ANTHROPIC = false;
let JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'anthropic/claude-sonnet-5.5';
let REVIEWS_AT_ONCE = 6;
let PREFILTER = false;
let PROMPTS: Record<string, string> | undefined;
let RULES: Rule[] | undefined;
const KENTO_REVIEWERS = /^(kento-review|sakuga-claude-review)\[bot\]$/;
const JUDGE_CALLS_AT_ONCE = 12;
/**
 * The effort of the judge is set here: a change of the default effort of the model must not change
 * the verdicts. A verdict is short JSON, so `low` is enough. The reasoning counts in the output
 * tokens, so the cap leaves room for it.
 */
const JUDGE_EFFORT = 'low';
const JUDGE_MAX_TOKENS = 1024;
const BATCH_DISCOUNT = 0.5;
const BATCH_POLL_MS = 30_000;
/** Far below the limits of one batch (100,000 requests, 256 MB): a judge request is about 3 KB. */
const BATCH_MAX_REQUESTS = 10_000;
const ANTHROPIC_VERSION = '2023-06-01';

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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const JUDGE_PROMPT_VERSION = sha256(JUDGE_PROMPT).slice(0, 12);

type Golden = { comment: string; severity: string; category: string; reviewers?: string[] };
type Pr = {
  /** REV-112: `kento` cases come from the findings of Kentō (apps/web scripts/bench-cases.ts), apart from the recall. */
  source: 'martian' | 'internal' | 'feedback' | 'kento';
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
  /**
   * REV-68: the tokens of the review, and what its tools used (REVIEW_TOOLS=1). REV-113: the cache
   * writes by TTL, at Anthropic.
   */
  tokens?: { prompt: number; completion: number; cacheRead: number; cacheWrite5m?: number; cacheWrite1h?: number };
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
  /**
   * REV-108, in one pass at Anthropic: how the model stopped, its thinking, and a request without
   * thinking. REV-113: the hashes of the system prompt and of the schema, the effort and the thinking.
   */
  stop?: Pick<Usage, 'stop_reason' | 'thinking_tokens' | 'first_token_ms' | 'first_text_ms' | 'retried_without_thinking' | 'system_hash' | 'schema_hash' | 'effort' | 'thinking'>;
  /**
   * REV-117, in one pass: the link call, and the findings that it linked to a rule or to an earlier
   * finding, with the title of the rule.
   */
  link?: { status: string; model?: string; cost: number; tokens: { prompt: number; completion: number }; error?: string; linked: string[] };
};
type Fixes = { p01: number; suggestions: number; patches: number };

function fixesOf(findings: { severity: string; suggestion_range: [number, number] | null; patch?: string }[]): Fixes {
  const p01 = findings.filter((f) => f.severity !== 'minor');
  return { p01: p01.length, suggestions: p01.filter((f) => f.suggestion_range).length, patches: p01.filter((f) => f.patch).length };
}
type Mode = { level: Level; passes: boolean; samples: number };

function pickStop({ stop_reason, thinking_tokens, first_token_ms, first_text_ms, retried_without_thinking, system_hash, schema_hash, effort, thinking }: Usage): Review['stop'] {
  return { stop_reason, thinking_tokens, first_token_ms, first_text_ms, retried_without_thinking, system_hash, schema_hash, effort, thinking };
}

/** The tokens of a review. REV-113: the cache writes by TTL, when the provider gives them. */
function tokensOf(usage: Usage): NonNullable<Review['tokens']> {
  return {
    prompt: usage.prompt_tokens ?? 0,
    completion: usage.completion_tokens ?? 0,
    cacheRead: usage.cache_read_tokens ?? 0,
    ...(usage.cache_write_5m_tokens !== undefined ? { cacheWrite5m: usage.cache_write_5m_tokens } : {}),
    ...(usage.cache_write_1h_tokens !== undefined ? { cacheWrite1h: usage.cache_write_1h_tokens } : {}),
  };
}

/** REV-117. The link call of a review, and its linked findings as `candidate [rule: title] [follows: key]`. */
function linkOf(out: Awaited<ReturnType<typeof reviewPullRequest>>): NonNullable<Review['link']> {
  const usage = out.link.usage;
  const titles = new Map(out.rules.map((r) => [r.id, r.title]));
  const linked = out.findings
    .filter((f) => f.rule_id || f.follows)
    .map((f) => `${f.path}:${f.line} [${f.severity}] ${f.title}${f.rule_id ? ` [rule: ${titles.get(f.rule_id) ?? f.rule_id}]` : ''}${f.follows ? ` [follows: ${f.follows}]` : ''}`);
  return {
    status: out.link.status,
    ...(usage?.model ? { model: usage.model } : {}),
    cost: usage?.cost ?? 0,
    tokens: { prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0 },
    ...(out.link.error ? { error: out.link.error } : {}),
    linked,
  };
}

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
    ...(PROMPTS ? { prompts: PROMPTS } : {}),
    ...(RULES ? { rules: RULES } : {}),
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
      tokens: tokensOf(out.usage),
      fixes: fixesOf(out.findings),
      ...(out.usage.stop_reason ? { stop: pickStop(out.usage) } : {}),
      ...(out.toolUse ? { tools: out.toolUse } : {}),
      ...(out.link.status !== 'none' ? { link: linkOf(out) } : {}),
    };
  } catch (error) {
    const message = [...failures, String(error)].join('\n').slice(-600);
    return { findings: [], cost: 0, seconds: Math.round((Date.now() - start) / 1000), error: message };
  }
}

/**
 * The review of one pull request in one repeat, from the cache of `--out` when a run already paid
 * for it. A review that failed for another cause than a truncation is not kept: the next run tries
 * again.
 */
async function cachedReview(file: string, work: () => Promise<Review>): Promise<Review & { cached?: boolean }> {
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), cached: true };
  const out = await work();
  if (failureKind(out) !== 'error') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out));
  }
  return out;
}

type Verdict = { match: boolean; confidence: number; reasoning?: string };
type Pair = { golden: string; candidate: string; key: string };

/** The verdicts of the judge, by pair: from `judge-cache.jsonl`, then from this run. */
const verdicts = new Map<string, Verdict>();
/** The pairs that this run paid for, with their cost. */
const bought = new Map<string, number>();
let judgeCacheFile = '';

function judgeKey(golden: string, candidate: string): string {
  return sha256(JSON.stringify([JUDGE_MODEL, JUDGE_PROMPT_VERSION, JUDGE_EFFORT, golden, candidate]));
}

function loadJudgeCache(file: string) {
  judgeCacheFile = file;
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { key, match, confidence, reasoning } = JSON.parse(line);
    verdicts.set(key, { match, confidence, reasoning });
  }
}

function remember(pair: Pair, verdict: Verdict, cost: number) {
  verdicts.set(pair.key, verdict);
  bought.set(pair.key, cost);
  appendFileSync(judgeCacheFile, `${JSON.stringify({ key: pair.key, model: JUDGE_MODEL, prompt: JUDGE_PROMPT_VERSION, effort: JUDGE_EFFORT, ...verdict, cost })}\n`);
}

function judgeMessage(pair: Pair): string {
  return JUDGE_PROMPT.replace('{golden_comment}', pair.golden).replace('{candidate}', pair.candidate);
}

function anthropicJudgeBody(pair: Pair) {
  return {
    model: JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    output_config: { effort: JUDGE_EFFORT },
    messages: [{ role: 'user', content: judgeMessage(pair) }],
  };
}

/** The verdict in an answer of the Messages API. A cut answer has no verdict: the pair stays unjudged. */
function anthropicVerdict(message: { stop_reason?: string; content?: { type: string; text?: string }[] }): Verdict {
  if (message.stop_reason === 'max_tokens') throw new Error('the judge reached max_tokens');
  const text = (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
  return parseVerdict(text);
}

function parseVerdict(text: string): Verdict {
  const verdict = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return { match: verdict.match === true, confidence: Number(verdict.confidence) || 0, ...(typeof verdict.reasoning === 'string' ? { reasoning: verdict.reasoning } : {}) };
}

function anthropicCost(usage: Record<string, unknown> = {}, factor = 1): number {
  return (costFromTable('anthropic', JUDGE_MODEL, requestTokens(usage)) ?? 0) * factor;
}

const anthropicHeaders = () => ({ 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' });

async function judgeOnce(pair: Pair): Promise<{ verdict: Verdict; cost: number }> {
  if (ANTHROPIC) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicJudgeBody(pair)),
      signal: AbortSignal.timeout(120_000),
    });
    const out = await response.json();
    if (!response.ok) throw new Error(`judge answered ${response.status}`);
    // The cost of a cut answer is spent too, but it has no verdict to keep it with.
    const cost = anthropicCost(out.usage);
    return { verdict: anthropicVerdict(out), cost };
  }
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      reasoning: { effort: JUDGE_EFFORT },
      usage: { include: true },
      messages: [{ role: 'user', content: judgeMessage(pair) }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const out = await response.json();
  return { verdict: parseVerdict(out.choices?.[0]?.message?.content ?? ''), cost: out.usage?.cost ?? 0 };
}

/** Three tries. A pair with no answer after them stays unjudged: compare.ts leaves its golden comment out of both arms. */
async function judgeSync(pair: Pair): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { verdict, cost } = await judgeOnce(pair);
      remember(pair, verdict, cost);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
    }
  }
}

async function anthropicJson(method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await fetch(url, { method, headers: anthropicHeaders(), ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`the Batches API answered ${response.status} to ${method} ${new URL(url).pathname}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

/**
 * The judge through the Message Batches API. The id of a batch that is not finished stays in
 * `judge-batch.json`: a run that stops then reads its results, and does not pay for it again.
 */
async function judgeInBatch(pairs: Pair[], out: string): Promise<void> {
  const pendingFile = join(out, 'judge-batch.json');
  const byKey = new Map(pairs.map((pair) => [pair.key, pair]));
  let pending: { id: string; pairs: Pair[] } | null = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')) : null;
  if (pending) for (const pair of pending.pairs) byKey.set(pair.key, pair);
  if (!pending) {
    const chunk = pairs.slice(0, BATCH_MAX_REQUESTS);
    const requests = chunk.map((pair) => ({ custom_id: pair.key, params: anthropicJudgeBody(pair) }));
    try {
      const created = await (await anthropicJson('POST', 'https://api.anthropic.com/v1/messages/batches', { requests })).json();
      pending = { id: created.id, pairs: chunk };
    } catch (error) {
      // resolve() then judges these pairs one call at a time.
      console.log(`judge batch: not created (${String(error).slice(0, 200)})`);
      return;
    }
    writeFileSync(pendingFile, JSON.stringify(pending));
  }
  console.log(`judge batch ${pending.id}: ${pending.pairs.length} pairs`);
  let batch: { processing_status: string; results_url?: string; request_counts?: Record<string, number> };
  for (;;) {
    batch = await (await anthropicJson('GET', `https://api.anthropic.com/v1/messages/batches/${pending.id}`)).json();
    if (batch.processing_status === 'ended') break;
    console.log(`judge batch ${pending.id}: ${batch.processing_status}, ${JSON.stringify(batch.request_counts ?? {})}`);
    await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_MS));
  }
  const results = await (await anthropicJson('GET', batch.results_url!)).text();
  let failed = 0;
  for (const line of results.split('\n')) {
    if (!line.trim()) continue;
    const { custom_id, result } = JSON.parse(line);
    const pair = byKey.get(custom_id);
    if (!pair) continue;
    try {
      if (result.type !== 'succeeded') throw new Error(result.type);
      remember(pair, anthropicVerdict(result.message), anthropicCost(result.message.usage, BATCH_DISCOUNT));
    } catch {
      failed++;
    }
  }
  rmSync(pendingFile);
  console.log(`judge batch ${pending.id}: ended, ${failed} pairs without a verdict`);
  // The next batch takes the pairs that this batch did not hold. The pairs that it held with no
  // verdict go to judgeSync in resolve().
  const sent = new Set(pending.pairs.map((pair) => pair.key));
  const left = pairs.filter((pair) => !verdicts.has(pair.key) && !sent.has(pair.key));
  if (left.length) await judgeInBatch(left, out);
}

/** The pairs of the judge that a pull request needs: each golden comment and known false positive, with each finding. */
function pairsOf(pr: Pr, findings: string[]): Pair[] {
  const comments = [...pr.golden.map((g) => g.comment), ...(pr.false_positives ?? []).map((k) => k.comment)];
  return comments.flatMap((golden) => findings.filter((candidate) => !skipped(golden, candidate)).map((candidate) => ({ golden, candidate, key: judgeKey(golden, candidate) })));
}

function skipped(golden: string, candidate: string): boolean {
  return PREFILTER && !prefilterKeeps(golden, candidate);
}

/** True or false from the judge, false for a pair that the prefilter skips, null for a pair with no verdict. */
function lookup(golden: string, candidate: string): boolean | null {
  if (skipped(golden, candidate)) return false;
  return verdicts.get(judgeKey(golden, candidate))?.match ?? null;
}

/** The verdicts that the cache does not hold, by the batch or one call at a time. */
async function resolve(pairs: Pair[], batch: boolean, out: string): Promise<void> {
  const todo = [...new Map(pairs.filter((pair) => !verdicts.has(pair.key)).map((pair) => [pair.key, pair])).values()];
  if (batch && (todo.length || existsSync(join(out, 'judge-batch.json')))) await judgeInBatch(todo, out);
  const left = todo.filter((pair) => !verdicts.has(pair.key));
  await pool(left, JUDGE_CALLS_AT_ONCE, judgeSync);
}

/**
 * The counts of Martian (step3_judge_comments.py): a golden comment is found if one finding matches
 * it. Precision is the found golden comments over all findings, so two findings on one defect count
 * once.
 */
function score(pr: Pr, findings: string[]) {
  const matches = findings.map((f) => pr.golden.flatMap((g, index) => (lookup(g.comment, f) ? [index] : [])));
  const foundIndexes = new Set(matches.flat());
  const unanswered = (comment: string, f: string) => lookup(comment, f) === null;
  const known = pr.false_positives ?? [];
  return {
    found: pr.golden.filter((_, index) => foundIndexes.has(index)).map((g) => ({ severity: g.severity, category: g.category })),
    golden: pr.golden.length,
    categories: pr.golden.map((g) => g.category),
    severities: pr.golden.map((g) => g.severity),
    // A golden comment that Kentō alone found would measure Kentō against itself.
    independent: pr.golden.map((g) => !g.reviewers || g.reviewers.some((r) => !KENTO_REVIEWERS.test(r))),
    comments: pr.golden.filter((_, index) => foundIndexes.has(index)).map((g) => g.comment),
    // For each finding, the indexes in pr.golden of the golden comments that it matches: [] is a finding with no match.
    matches,
    // REV-109. The golden comments and the findings with a pair that the judge did not answer, and no match.
    unjudged: pr.golden.flatMap((g, index) => (!foundIndexes.has(index) && findings.some((f) => unanswered(g.comment, f)) ? [index] : [])),
    unjudged_findings: findings.flatMap((f, index) => (!matches[index].length && pr.golden.some((g) => unanswered(g.comment, f)) ? [index] : [])),
    // The findings that match a known false positive of the pull request.
    known_false: findings.filter((f) => known.some((k) => lookup(k.comment, f))).length,
    judge_errors: [...pr.golden, ...known].reduce((total, g) => total + findings.filter((f) => unanswered(g.comment, f)).length, 0),
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

/** About 3.5 characters a token; the output holds the reasoning at low effort and the verdict. */
function judgeEstimate(pairs: Pair[], batch: boolean): number {
  const factor = batch ? BATCH_DISCOUNT : 1;
  return pairs.reduce((total, pair) => total + anthropicCost({ input_tokens: Math.ceil(judgeMessage(pair).length / 3.5), output_tokens: 250 }, factor), 0);
}

/** REV-117. The rules of `--rules`: an array of rules, each with an id, a title, a text and its paths. */
function readRules(file: string): Rule[] {
  const rules: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const valid = (r: any) => typeof r?.id === 'string' && typeof r.title === 'string' && typeof r.text === 'string' && Array.isArray(r.paths);
  if (!Array.isArray(rules) || !rules.every(valid)) throw new Error(`--rules must name a JSON array of rules with id, title, text and paths: ${file}`);
  return rules.map((r) => ({ scope: 'repo', severityFloor: null, ...r }));
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
      repeats: { type: 'string', default: '1' },
      prompt: { type: 'string' },
      concurrency: { type: 'string', default: String(REVIEWS_AT_ONCE) },
      'judge-batch': { type: 'boolean', default: false },
      prefilter: { type: 'boolean', default: false },
      estimate: { type: 'boolean', default: false },
      rules: { type: 'string' },
    },
  });
  if (values.provider !== 'openrouter' && values.provider !== 'anthropic') throw new Error(`--provider must be openrouter or anthropic, not "${values.provider}"`);
  ANTHROPIC = values.provider === 'anthropic';
  if (ANTHROPIC) JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'claude-sonnet-5-5';
  if (values['judge-batch'] && !ANTHROPIC) throw new Error('--judge-batch needs --provider anthropic');
  if (!isLevel(values.level)) throw new Error(`--level must be lite, balanced or heavy, not "${values.level}"`);
  const wholeNumber = (name: string, value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number of 1 or more, not "${value}"`);
    return n;
  };
  const samples = wholeNumber('samples', values.samples);
  const repeats = wholeNumber('repeats', values.repeats);
  REVIEWS_AT_ONCE = wholeNumber('concurrency', values.concurrency);
  PREFILTER = values.prefilter === true;
  if (samples > 1 && values.passes) throw new Error('--samples and --passes cannot go together');
  const mode: Mode = { level: values.level, passes: values.passes === true, samples };
  const promptText = values.prompt ? readFileSync(values.prompt, 'utf8') : undefined;
  if (promptText) PROMPTS = { 'review.md': promptText };
  if (values.rules) RULES = readRules(values.rules);
  const promptId = sha256(promptText ?? readFileSync(join(import.meta.dirname, '..', '..', 'packages', 'engine', 'prompts', 'review.md'), 'utf8')).slice(0, 12);
  const prs: Pr[] = JSON.parse(readFileSync(values.subset!, 'utf8'));
  const out = values.out!;
  mkdirSync(out, { recursive: true });
  loadJudgeCache(join(out, 'judge-cache.jsonl'));
  const dirs = prs.map((pr) => pr.repo_dir ?? join(values.repos!, `${pr.owner}__${pr.name}`));
  for (const model of values.models!.split(',')) {
    // The level and the passes are in the name of the file of a run that is not lite in one pass.
    const tag = (mode.level === 'lite' && !mode.passes ? '' : `-${mode.level}${mode.passes ? '-passes' : ''}`) + (mode.samples > 1 ? `-x${mode.samples}` : '');
    const fileOf = (k: number) => join(out, `${values.label}${tag}${repeats > 1 ? `-r${k}` : ''}-${model.replace('/', '_')}.json`);
    const runs = Array.from({ length: repeats }, (_, i) => i + 1).filter((k) => !existsSync(fileOf(k)));
    if (!runs.length) continue;
    const reviewDir = join(out, 'reviews', `${values.label}${tag}-${promptId}`, model.replace('/', '_'));
    const reviewsByRun = new Map<number, Review[]>();
    for (const k of runs) {
      const reviews = await pool(prs, REVIEWS_AT_ONCE, (pr) =>
        cachedReview(join(reviewDir, `${sha256(pr.url).slice(0, 16)}-r${k}.json`), () => review(pr, model, dirs[prs.indexOf(pr)], mode)),
      );
      reviewsByRun.set(k, reviews);
      const fresh = reviews.filter((r) => !('cached' in r && r.cached));
      console.log(`${model}${tag} r${k}: ${reviews.length} reviews (${reviews.length - fresh.length} from the cache), review $${fresh.reduce((t, r) => t + r.cost, 0).toFixed(3)} spent now`);
    }
    // In passes, the judge reads the dropped findings too: a golden comment that only a dropped finding
    // matches is a defect that the check removed.
    const pairs = runs.flatMap((k) => prs.flatMap((pr, i) => pairsOf(pr, [...reviewsByRun.get(k)![i].findings, ...(reviewsByRun.get(k)![i].droppedCandidates ?? [])])));
    const todo = [...new Map(pairs.filter((pair) => !verdicts.has(pair.key)).map((pair) => [pair.key, pair])).values()];
    console.log(`judge: ${pairs.length} pairs, ${todo.length} without a verdict in the cache, about $${judgeEstimate(todo, values['judge-batch'] === true).toFixed(3)}`);
    if (values.estimate) continue;
    await resolve(pairs, values['judge-batch'] === true, out);
    const claimed = new Set<string>();
    for (const k of runs) {
      const reviews = reviewsByRun.get(k)!;
      const scores = prs.map((pr, i) => score(pr, reviews[i].findings));
      const droppedScores = mode.passes ? prs.map((pr, i) => score(pr, reviews[i].droppedCandidates ?? [])) : [];
      // The judge cost of this repeat: the pairs that this run paid for, each one counted once.
      let judgeCost = 0;
      for (const pair of prs.flatMap((pr, i) => pairsOf(pr, [...reviews[i].findings, ...(reviews[i].droppedCandidates ?? [])]))) {
        if (claimed.has(pair.key) || !bought.has(pair.key)) continue;
        claimed.add(pair.key);
        judgeCost += bought.get(pair.key)!;
      }
      const rows = prs.map((pr, i) => {
        const { cached: _cached, ...reviewed } = reviews[i] as Review & { cached?: boolean };
        const lost = (droppedScores[i]?.comments ?? []).filter((comment) => !scores[i].comments.includes(comment));
        const truncated = failureKind(reviewed) === 'truncated';
        return { url: pr.url, source: pr.source, ...reviewed, ...(truncated ? { truncated } : {}), ...scores[i], ...(mode.passes ? { dropped_true: lost.length } : {}) };
      });
      const judgeErrors = rows.reduce((total, row) => total + row.judge_errors, 0) + droppedScores.reduce((total, s) => total + s.judge_errors, 0);
      const all = metrics(rows);
      const martian = metrics(rows.filter((row) => row.source === 'martian'));
      const internal = metrics(rows.filter((row) => row.source === 'internal'));
      const bySource = (source?: string) => {
        const scored = rows.filter((row) => !source || row.source === source);
        return Object.fromEntries(Object.keys(PROFILES).map((name) => [name, profileMetrics(scored, name as Profile)]));
      };
      const profiles = { all: bySource(), martian: bySource('martian'), internal: bySource('internal'), feedback: bySource('feedback'), kento: bySource('kento') };
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
      const failed = failureCounts(rows, model);
      const result = {
        model,
        label: values.label,
        level: mode.level,
        passes: mode.passes,
        repeat: k,
        prompt: promptId,
        ...(values.prompt ? { prompt_file: values.prompt } : {}),
        judge: { model: JUDGE_MODEL, prompt: JUDGE_PROMPT_VERSION, effort: JUDGE_EFFORT, batch: values['judge-batch'] === true, prefilter: PREFILTER },
        ...all,
        failures: failed.errors + failed.truncated,
        errors: failed.errors,
        truncated: failed.truncated,
        fallbacks: failed.fallbacks,
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
      writeFileSync(fileOf(k), JSON.stringify(result, null, 2));
      const percent = (value: number) => `${(value * 100).toFixed(0)} %`;
      console.log(
        `${model}${tag}${repeats > 1 ? ` r${k}` : ''}: F1 core ${profiles.all.core.f1.toFixed(2)} (martian ${profiles.martian.core.f1.toFixed(2)}, internal ${profiles.internal.core.f1.toFixed(2)}, feedback ${profiles.feedback.core.f1.toFixed(2)}) · F1 martian ${martian.f1.toFixed(2)} · recall ${percent(all.recall)} · precision ${percent(all.precision)} · ` +
          `${all.findings} findings · ${failed.errors} errors · ${failed.truncated} truncated · ${failed.fallbacks} fallbacks · ${judgeErrors} unjudged pairs · review $${result.review_cost.toFixed(3)} · ` +
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
}

await main();
