// The providers of models: one call that gives an answer held by a JSON schema, its tokens and its
// cost. OpenRouter, Anthropic, a server with the API of OpenAI, and Ollama each have their adapter.
import { createHash } from 'node:crypto';
import type { Usage } from './findings.ts';
import type { LevelConfig } from './levels.ts';
import type { CostSource, ProviderKind } from '../../protocol/src/index.ts';
import { presetOf } from './presets.ts';
import { bedrockClaude, costFromTable, type Tokens } from './prices.ts';
import { anthropicTools, chatTools, type RepoTools } from './tools.ts';

/** The API of OpenRouter. A caller can give another base with the same API, for example a proxy. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** Ollama on the machine of the runner. */
export const OLLAMA_BASE_URL = 'http://localhost:11434';
const ANTHROPIC_VERSION = '2023-06-01';

/** The base URL of a provider when the caller gives none. A server of the OpenAI API has none. */
export function defaultBaseUrl(kind: ProviderKind): string | null {
  switch (kind) {
    case 'openrouter':
      return OPENROUTER_BASE_URL;
    case 'anthropic':
      return ANTHROPIC_BASE_URL;
    case 'ollama':
      return OLLAMA_BASE_URL;
    case 'openai_compatible':
      return null;
  }
}

/**
 * The provider refused a call, or gave an answer that cannot be used. `status` is the HTTP status of
 * the provider, or null when the call got an answer that is not the schema. A 401 or a 403 means
 * that the provider refused the key: the service shows it on the screen of the provider.
 */
export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/**
 * KNT-161. The provider refused the call on a usage limit of the key: a quota, spent credits, a spend
 * limit, or a limit that ends more than RATE_LIMIT_MAX_MS away. The other models of the same key get
 * the same refusal. `resetAt`: when the provider says that the limit ends (ISO 8601, UTC), or null
 * when it does not say.
 */
export class UsageLimitError extends ProviderError {
  override name = 'UsageLimitError';
  readonly kind = 'usage' as const;
  readonly resetAt: string | null;
  constructor(message: string, status: number | null, resetAt: string | null) {
    super(message, status);
    this.resetAt = resetAt;
  }
}

/**
 * KNT-161. The provider refused the call on a short rate limit: a 429 with no words of a usage limit,
 * that ends within RATE_LIMIT_MAX_MS or does not say when. Such a limit is often per model or per
 * upstream host, so the next model of the level is tried. When every model gets one, the service
 * queues the job again after `resetAt`.
 */
export class RateLimitError extends ProviderError {
  override name = 'RateLimitError';
  readonly kind = 'rate' as const;
  readonly resetAt: string | null;
  constructor(message: string, status: number | null, resetAt: string | null) {
    super(message, status);
    this.resetAt = resetAt;
  }
}

/** Whether the provider refused the key: the call can never work until an admin replaces it. */
export function refusedKey(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    !(error instanceof UsageLimitError) &&
    !(error instanceof RateLimitError) &&
    (error.status === 401 || error.status === 403)
  );
}

/** KNT-161. Whether the call failed on a usage limit of the provider. */
export function usageLimited(error: unknown): error is UsageLimitError {
  return error instanceof UsageLimitError;
}

/** KNT-161. Whether the call failed on a short rate limit of the provider. */
export function rateLimited(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

/** KNT-161. A limit that ends later than this is a usage limit: a retry of the job would fail too. */
export const RATE_LIMIT_MAX_MS = 10 * 60_000;

/**
 * KNT-161. The words of an error body that name a usage limit of the key, whatever its status.
 * KNT-204: with `_` or `-` between the words too, as in the codes of OpenAI
 * (`organization_spend_limit_exceeded`, `credit_balance_exhausted`, `billing_hard_limit_reached`),
 * and `blocked_api_access`, the code of Groq at the spend limit of the org (a 400).
 */
const USAGE_WORDS =
  /usage[ _-]limits?(?![a-z])|\bcredits?(?![a-z])|insufficient[ _-](?:balance|funds|quota)|spend(?:ing)?[ _-]limit|key[ _-]limit|billing[ _-]hard[ _-]limit|blocked_api_access/i;
/**
 * KNT-204. « quota » names a usage limit, except a quota of a minute or a second: Cerebras answers
 * `token_quota_exceeded` to the tokens of a minute, and Gemini names its quotas per minute.
 * KNT-206: as a word only. The 429 of Azure OpenAI names a rate limit and links to
 * aka.ms/oai/quotaincrease.
 */
const QUOTA_WORDS = /(?<![a-z])quotas?(?![a-z])/i;
const SHORT_WINDOW = /per[ _-]?min(?:ute)?\b|PerMinute|per[ _-]?second|PerSecond|\b[RT]P[MS]\b/i;

/** KNT-161. The words of a rate limit. A 403 does not count them: a moderation 403 echoes the input. */
const RATE_WORDS = /rate[ _-]?limit/i;

/**
 * KNT-161. The texts of the errors of a limit: the service finds them in the reason of a failed job
 * (`limitOfReason`). Keep them as they are: a runner of one release talks to a service of the next.
 */
export const USAGE_LIMIT_TEXT = 'refused the call on a usage limit';
export const RATE_LIMIT_TEXT = 'refused the call on a rate limit';

/** KNT-161. A limit of the provider: `usage` stops the review, `rate` queues the job again. */
export type ProviderLimit = { kind: 'usage' | 'rate'; resetAt: string | null };

/**
 * KNT-161. Whether an error answer of a provider is a limit, and when it ends. A usage limit: a 402,
 * a 4xx whose body names a quota (not one of a minute or a second), credits, a spend limit or a key
 * limit, or a limit that ends more than RATE_LIMIT_MAX_MS away. A rate limit: another 429, or a 4xx (not a 403) that names a rate
 * limit. Null for another error. A 401 is never a limit.
 */
export function limitOf(status: number, text: string, headers?: Headers, now: number = Date.now()): ProviderLimit | null {
  // A 401 is a key that the provider does not know, whatever its words: an admin must replace it.
  if (status < 400 || status > 499 || status === 401) return null;
  const usage = status === 402 || USAGE_WORDS.test(text) || (QUOTA_WORDS.test(text) && !SHORT_WINDOW.test(text));
  const rate = status === 429 || (status !== 403 && RATE_WORDS.test(text));
  if (!usage && !rate) return null;
  const resetAt = resetOf(text, headers, now);
  const far = resetAt !== null && Date.parse(resetAt) - now > RATE_LIMIT_MAX_MS;
  return { kind: usage || far ? 'usage' : 'rate', resetAt };
}

const DAY_MS = 86_400_000;

/**
 * A reset time as ISO 8601 at UTC, rounded up to the second. Null when it is not after `now`, or when
 * it is more than 90 days away: a reset header read in the wrong unit gives such a time.
 */
function resetIso(ms: number, now: number): string | null {
  if (!Number.isFinite(ms) || ms <= now || ms > now + 90 * DAY_MS) return null;
  return new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A number of a reset header: seconds from now when small, else seconds or milliseconds since the epoch. */
function epochMs(value: number, now: number): number {
  if (value < 1e7) return now + value * 1000;
  return value < 1e11 ? value * 1000 : value;
}

/** A duration of the OpenAI reset headers (`1s`, `6m0s`, `250ms`, `1h2m`), in milliseconds, or null. */
function durationMs(value: string): number | null {
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(value);
  if (!value || !match) return null;
  const [, h = '0', m = '0', s = '0', ms = '0'] = match;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

/** The value of a reset header in milliseconds since the epoch: a number, a duration or a date. */
function headerMs(value: string, now: number): number {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return epochMs(Number(text), now);
  const duration = durationMs(text);
  return duration !== null ? now + duration : Date.parse(text);
}

/** The latest of the times of `values` that is a reset (`resetIso`), or null. */
function latestReset(values: number[], now: number): string | null {
  const resets = values.map((value) => resetIso(value, now)).filter((reset): reset is string => reset !== null);
  return resets.length ? resets.sort().at(-1)! : null;
}

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/.source;

/**
 * When a limit ends, from the fields that say it, in this order: the sentence of Anthropic
 * (« You will regain access on 2026-12-01 at 00:00 UTC »), `retry-after` (seconds, decimals
 * included, or an HTTP date), `retry-after-ms` (KNT-206), the reset headers of Anthropic, of OpenRouter and of OpenAI, then a
 * date-time of the body that follows a reset word (« until », « reset », « try again »), then the
 * `X-RateLimit-Reset` that OpenRouter puts in the body, then the `retryDelay` of Google (KNT-204).
 * A time in the past, or more than 90 days
 * away, is skipped. Null when none says it. Any other date of the body is not read.
 */
function resetOf(text: string, headers: Headers | undefined, now: number): string | null {
  const spoken = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})(?::\d{2})? UTC/.exec(text);
  const fromSpoken = spoken ? resetIso(Date.parse(`${spoken[1]}T${spoken[2]}:00Z`), now) : null;
  if (fromSpoken) return fromSpoken;
  const after = headers?.get('retry-after')?.trim();
  if (after) {
    const reset = resetIso(/^\d+(?:\.\d+)?$/.test(after) ? now + Number(after) * 1000 : Date.parse(after), now);
    if (reset) return reset;
  }
  // KNT-206. Azure OpenAI gives the wait in milliseconds too.
  const afterMs = headers?.get('retry-after-ms')?.trim();
  if (afterMs && /^\d+(?:\.\d+)?$/.test(afterMs)) {
    const reset = resetIso(now + Number(afterMs), now);
    if (reset) return reset;
  }
  const names = [
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
    'anthropic-ratelimit-input-tokens-reset',
    'anthropic-ratelimit-output-tokens-reset',
    'x-ratelimit-reset',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
  ];
  const fromHeaders = latestReset(names.flatMap((name) => {
    const value = headers?.get(name);
    return value ? [headerMs(value, now)] : [];
  }), now);
  if (fromHeaders) return fromHeaders;
  const near = new RegExp(`(?:regain access|resets?|until|try again|retry)\\D{0,40}?(${ISO_TIME})`, 'i').exec(text);
  const fromBody = near ? resetIso(Date.parse(near[1]!), now) : null;
  if (fromBody) return fromBody;
  const window = /"X-RateLimit-Reset"\s*:\s*"?(\d+)/i.exec(text);
  const fromWindow = window ? resetIso(epochMs(Number(window[1]), now), now) : null;
  if (fromWindow) return fromWindow;
  // KNT-204. The RetryInfo of Google in the details of the error: `"retryDelay": "58s"`.
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  return delay ? resetIso(now + Number(delay[1]) * 1000, now) : null;
}

/**
 * KNT-161. The limit that the reason of a failed job names, or null for another failure: the text of
 * UsageLimitError or of RateLimitError, or, from a runner of an earlier release, « <provider>
 * answered <status>: <body> » with a body that is a limit (`limitOf`).
 */
export function limitOfReason(reason: string | null, now: number = Date.now()): ProviderLimit | null {
  if (!reason) return null;
  for (const [text, kind] of [[USAGE_LIMIT_TEXT, 'usage'], [RATE_LIMIT_TEXT, 'rate']] as const) {
    if (!reason.includes(text)) continue;
    const until = /until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(reason);
    return { kind, resetAt: until ? until[1]! : null };
  }
  const answered = / answered (\d{3}): /.exec(reason);
  if (!answered) return null;
  // The body of the provider follows the status: the reset time is in it, if anywhere.
  return limitOf(Number(answered[1]), reason.slice(answered.index + answered[0].length), undefined, now);
}

export type Schema = { name: string; schema: object };

/**
 * REV-113. A part of the user message. `cache`: the part ends a prefix that the next requests send
 * again within this time, so a provider with a prompt cache marks its end with this TTL.
 */
export type MessagePart = { text: string; cache?: '1h' | '5m' };

/** What an adapter needs for one call. */
export type Call = {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: typeof fetch;
  model: string;
  config: LevelConfig;
  prompt: string;
  /** The user message: the text of `parts`, joined. */
  message: string;
  /** REV-113. The parts of `message`, for the Anthropic adapter. */
  parts?: readonly MessagePart[];
  schema: Schema;
  timeoutMs: number;
  /**
   * REV-113. Called when the answer of the first request starts: a request that is sent after it
   * can read its prompt cache. Anthropic only.
   */
  onStart?: () => void;
  /**
   * REV-68. The tools of the review, or none. With tools, a call is a loop: the model may ask for
   * tools while `startRound` allows it, then must answer. The time limit covers the whole loop, and
   * past half of it the model gets no more tools. Anthropic and OpenRouter only.
   */
  tools?: RepoTools;
};

/** Whether the model may ask for tools in the request number `round` of the loop. */
function offerTools(call: Call, started: number, round: number): boolean {
  return !!call.tools && Date.now() - started < call.timeoutMs / 2 && call.tools.startRound(round);
}

/** A model that asks for a tool when the request offered none: the next model of the level takes over. */
function toolAfterLastRound(name: string): ProviderError {
  return new ProviderError(`${name} asked for a tool after its last round, with no answer`);
}

export type Called<T> = { answer: T; usage: Usage };

/** The adapter of each provider. */
export const ADAPTERS: Record<ProviderKind, <T>(call: Call) => Promise<Called<T>>> = {
  openrouter: callOpenRouter,
  anthropic: callAnthropic,
  openai_compatible: callOpenAiCompatible,
  ollama: callOllama,
};

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * KNT-204. How much of an error body the limits read. Gemini puts the window of its quota and the
 * `retryDelay` after a long message, in `details`. The error keeps the first 300 characters.
 */
const LIMIT_TEXT_MAX = 4096;

async function errorText(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, LIMIT_TEXT_MAX);
}

async function refused(response: Response, name: string): Promise<ProviderError> {
  return refusedWith(response.status, await errorText(response), response.headers, name);
}

function refusedWith(status: number, body: string, headers: Headers, name: string): ProviderError {
  const text = body.slice(0, 300);
  const limit = limitOf(status, body, headers);
  if (limit) {
    const until = limit.resetAt ? `, until ${limit.resetAt}` : '';
    const Limit = limit.kind === 'usage' ? UsageLimitError : RateLimitError;
    const words = limit.kind === 'usage' ? USAGE_LIMIT_TEXT : RATE_LIMIT_TEXT;
    return new Limit(`${name} ${words} (${status}${until}): ${text}`, status, limit.resetAt);
  }
  return new ProviderError(`${name} answered ${status}: ${text}`, status);
}

/** The JSON object of a text: from its first `{` to its last `}`. Throws when it is not JSON. */
export function parseObject<T>(content: string, name: string): T {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) throw new ProviderError(`${name} gave no JSON object`);
  try {
    return JSON.parse(content.slice(start, end + 1)) as T;
  } catch (error) {
    throw new ProviderError(`${name} gave JSON that does not parse: ${(error as Error).message}`);
  }
}

/**
 * REV-104. The reasoning counts in `max_tokens`, and a long reasoning cuts the JSON. The error then
 * gives the `stop_reason` and the output tokens after the message of parseObject. REV-108 adds the
 * length of the text, which shows where the tokens went, and whether the request without thinking
 * gave this text.
 */
function parseAnthropic<T>(text: string, stopReason: unknown, outputTokens: number, withoutThinking: boolean): T {
  try {
    return parseObject<T>(text, 'Anthropic');
  } catch (error) {
    if (!(error instanceof ProviderError) || stopReason === 'end_turn') throw error;
    const retry = withoutThinking ? ', after a request without thinking' : '';
    throw new ProviderError(`${error.message} (stop_reason ${String(stopReason)}, ${outputTokens} output tokens, ${text.length} characters of text${retry})`);
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The cost of a call: the one that the provider gave, else the table, else 0 and `unknown`. KNT-204:
 * the table knows a model of a server of the API of OpenAI by the host of `baseUrl`, and by the id
 * that the server answered, else by the id of the request (`asked`): a server can answer with the
 * dated id of an alias.
 */
function priced(kind: ProviderKind, model: string, tokens: Tokens, given?: unknown, baseUrl?: string, asked?: string): { cost: number; cost_source: CostSource } {
  if (typeof given === 'number' && Number.isFinite(given) && given >= 0) return { cost: given, cost_source: 'provider' };
  if (kind === 'ollama') return { cost: 0, cost_source: 'free' };
  const fromTable = costFromTable(kind, model, tokens, baseUrl) ?? (asked && asked !== model ? costFromTable(kind, asked, tokens, baseUrl) : null);
  return fromTable === null ? { cost: 0, cost_source: 'unknown' } : { cost: fromTable, cost_source: 'table' };
}

// --- OpenRouter --------------------------------------------------------------------------------

async function callOpenRouter<T>(call: Call): Promise<Called<T>> {
  const signal = AbortSignal.timeout(call.timeoutMs);
  const started = Date.now();
  // With tools, the pack is sent again at each round: a model of Anthropic reads it from the cache.
  const userContent = call.tools
    ? [{ type: 'text', text: call.message, ...(call.model.startsWith('anthropic/') ? { cache_control: { type: 'ephemeral' } } : {}) }]
    : call.message;
  const messages: object[] = [
    { role: 'system', content: call.prompt },
    { role: 'user', content: userContent },
  ];
  const total = { prompt: 0, completion: 0, cacheRead: 0, cost: 0, costKnown: true };
  let last: any;
  for (let round = 0; ; round++) {
    const offer = offerTools(call, started, round);
    const response = await call.fetch(endpoint(call.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${call.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Sakuga Review',
      },
      body: JSON.stringify({
        model: call.model,
        max_tokens: call.config.maxTokens,
        reasoning: { effort: call.config.effort },
        usage: { include: true },
        // The diff goes only to a provider that keeps nothing and trains on nothing, and that honours
        // the answer schema (and the tools, when there are). Of those, the cheapest under MAX_PRICE
        // answers first.
        provider: { zdr: true, data_collection: 'deny', require_parameters: true, sort: 'price', max_price: call.config.maxPrice },
        messages,
        ...(call.tools ? { tools: chatTools(), tool_choice: offer ? 'auto' : 'none' } : {}),
        response_format: { type: 'json_schema', json_schema: { name: call.schema.name, strict: true, schema: call.schema.schema } },
      }),
      signal,
    });
    if (!response.ok) throw await refused(response, 'OpenRouter');
    last = await response.json();
    if (!call.tools) {
      const answer = parseObject<T>(last.choices?.[0]?.message?.content ?? '', 'OpenRouter');
      const usage: Usage = { model: last.model, provider: last.provider, ...last.usage };
      // REV-89. OpenRouter gives the cached tokens of the prompt in `prompt_tokens_details`.
      const cached = count(last.usage?.prompt_tokens_details?.cached_tokens);
      if (cached !== undefined) usage.cache_read_tokens = cached;
      usage.cost_source = typeof usage.cost === 'number' ? 'provider' : 'unknown';
      if (usage.cost_source === 'unknown') usage.cost = 0;
      return { answer, usage };
    }
    total.prompt += count(last.usage?.prompt_tokens) ?? 0;
    total.completion += count(last.usage?.completion_tokens) ?? 0;
    total.cacheRead += count(last.usage?.prompt_tokens_details?.cached_tokens) ?? 0;
    if (typeof last.usage?.cost === 'number') total.cost += last.usage.cost;
    else total.costKnown = false;
    const message = last.choices?.[0]?.message ?? {};
    const toolCalls: { id: string; function?: { name?: string; arguments?: string } }[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (offer && toolCalls.length > 0) {
      call.tools.ranRound();
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: toolCalls });
      for (const c of toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.function?.arguments || '{}');
        } catch {
          // The tool answers that its input is missing, and the model can call again.
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: await call.tools.run({ name: c.function?.name ?? '', input }) });
      }
      continue;
    }
    let answer: T;
    try {
      answer = parseObject<T>(message.content ?? '', 'OpenRouter');
    } catch (error) {
      // Tool calls with no JSON answer, when the request offered no tool.
      if (toolCalls.length > 0) throw toolAfterLastRound('OpenRouter');
      throw error;
    }
    return {
      answer,
      usage: {
        model: last.model,
        provider: last.provider,
        prompt_tokens: total.prompt,
        completion_tokens: total.completion,
        cache_read_tokens: total.cacheRead,
        cost: total.costKnown ? total.cost : 0,
        cost_source: total.costKnown ? 'provider' : 'unknown',
      },
    };
  }
}

// --- Anthropic ---------------------------------------------------------------------------------

/**
 * REV-108. On the benches of REV-104 and REV-108, about 1 review of Haiku 5.5 in 6 to 10 stopped at
 * `max_tokens` (32,000 tokens) with no JSON that parses. Such a call asks the same model once more
 * with this `thinking`. On the bench of REV-108, the cut requests had 1,700 to 7,800 thinking
 * tokens: the answer text took the rest. The second request gave an answer 5 times in 7.
 * Opus 5.5 and Sonnet 5.5 refuse `disabled` (400): they get no second request. KNT-206: an id of
 * Amazon Bedrock (`global.anthropic.claude-haiku-5-5`) is the same model.
 */
export function thinkingOff(model: string): { type: 'disabled' } | null {
  return (bedrockClaude(model)?.id ?? model).startsWith('claude-haiku-5-5') ? { type: 'disabled' } : null;
}

/**
 * REV-108. The longest thinking before the call stops the request and asks again without thinking.
 * On the bench of REV-108, Haiku 5.5 thought at about 230 tokens a second, and its longest thinking
 * in an answer was 12,700 tokens: 60 s is about 14,000 tokens.
 */
export const MAX_THINKING_MS = 60_000;

/** REV-108. The time that the request without thinking keeps at the end of the time limit of a call. */
export const RETRY_ROOM_MS = 60_000;

/**
 * REV-108. How long the call waits for the answer after the thinking starts, at `thinkingAt` ms of a
 * call of `timeoutMs`: MAX_THINKING_MS, or less to keep the time of the request without thinking.
 * Null: the thinking started too late, and the call waits until its time limit.
 *
 * The clock starts at the first thinking block, not at the request: on the bench, the API held
 * some requests 50 to 99 s before their first block, and the request without thinking waits as long.
 */
export function thinkingWaitMs(timeoutMs: number, thinkingAt: number): number | null {
  const room = Math.min(RETRY_ROOM_MS, timeoutMs / 3);
  const wait = Math.min(MAX_THINKING_MS, timeoutMs - room - thinkingAt);
  return wait > 0 ? wait : null;
}

type Block = { type: string; cache_control?: object; [key: string]: unknown };
type Message = { model?: unknown; stop_reason?: unknown; stop_details?: { category?: string }; content: Block[]; usage: Record<string, any> };

/**
 * REV-113. The cache mark of the system prompt. A read renews the TTL. In production, 97 % of the
 * reviews come less than 1 hour after the last review of the same model, and 80 % less than 5
 * minutes. A mark with the TTL of 1 hour must come before a mark with the TTL of 5 minutes: the
 * system prompt comes first, so it takes 1 hour, and the pack can then use either TTL.
 */
const SYSTEM_MARK = { type: 'ephemeral', ttl: '1h' } as const;
/** With tools, the mark of the last block. It moves at each round, so it keeps the TTL of 5 minutes. */
const TAIL_MARK = { type: 'ephemeral' } as const;
/** The API takes 4 cache marks at most: the system prompt, the pack, and the last block with tools. */
export const MAX_PACK_MARKS = 2;

/** One request with the conversation of a call, and the request without thinking when it comes. */
type Run = {
  text: string;
  stopReason: unknown;
  model: string;
  /** The thinking of the requests: `adaptive` (the default of the model) or `disabled`. */
  thinking: string;
  tokens: Required<Tokens> & { thinking?: number };
  /** The sum of the cost of each request, from the table. Null when the table does not know a model. */
  cost: number | null;
  /** From the start of the call: the first content block of any type, and the first text block. */
  firstTokenMs?: number;
  firstTextMs?: number;
  /** The model thought for thinkingWaitMs with no answer block, and the call stopped the request. */
  late: boolean;
};

const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * The Messages API of Anthropic, with `stream`. The answer schema goes in `output_config.format`:
 * Claude Opus 5.5 and Sonnet 5.5 refuse a forced tool (`tool_choice` `tool` answers 400), and the
 * structured output holds the answer to the schema in the same way.
 *
 * REV-113. The API puts the schema in the system prompt. The system prompt and the schema are the
 * same for every review of a level, and the system prompt carries a cache mark. The docs of the
 * repository carry a mark too (MessagePart): the next review of the repository with the same model
 * within 1 hour reads them from the cache. In a review of one pass, the rest of the pack carries no
 * mark: a cache write costs more than the input, and nothing would read it. With tools (REV-68), each round sends the
 * conversation again, so the last block of each request carries a mark too (markLastBlock).
 *
 * REV-108. An answer cut at `max_tokens`, or a thinking longer than thinkingWaitMs, gets one more
 * request without thinking (thinkingOff), in the time that is left. The change of thinking empties
 * the cache of the messages, so that request cannot read the pack that the first request wrote.
 * It has no mark on the pack: nothing reads what it would write.
 */
async function callAnthropic<T>(call: Call): Promise<Called<T>> {
  const signal = AbortSignal.timeout(call.timeoutMs);
  const started = Date.now();
  const off = thinkingOff(call.model);
  // REV-117. A call with no thinking sends one request: a second request would be the same.
  const noThinking = call.config.thinking === false && off ? off : undefined;
  const first = await runAnthropic(call, signal, started, !!off && !noThinking, noThinking);
  const cause = first.late ? 'no_answer_in_time' : first.stopReason === 'max_tokens' ? 'max_tokens' : null;
  const runs = off && cause && !noThinking ? [first, await runAgain(call, signal, started, off, cause)] : [first];
  const last = runs.at(-1)!;
  const sum = (key: keyof Required<Tokens>) => runs.reduce((total, run) => total + run.tokens[key], 0);
  const thinking = runs.flatMap((run) => (run.tokens.thinking === undefined ? [] : [run.tokens.thinking]));
  const tokens = { input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), cacheWrite1h: sum('cacheWrite1h'), output: sum('output') };
  const written = tokens.cacheWrite + tokens.cacheWrite1h;
  const cost = runs.some((run) => run.cost === null) ? null : runs.reduce((total, run) => total + run.cost!, 0);
  const answer = parseAnthropic<T>(last.text, last.stopReason, last.tokens.output, runs.length > 1);
  return {
    answer,
    usage: {
      model: last.model,
      provider: 'Anthropic',
      // `input_tokens` is the part that the cache did not hold: the prompt is the sum.
      prompt_tokens: tokens.input + tokens.cacheRead + written,
      completion_tokens: tokens.output,
      cache_read_tokens: tokens.cacheRead,
      cache_write_tokens: written,
      cache_write_5m_tokens: tokens.cacheWrite,
      cache_write_1h_tokens: tokens.cacheWrite1h,
      ...(cost === null ? { cost: 0, cost_source: 'unknown' as const } : { cost: Math.round(cost * 1_000_000) / 1_000_000, cost_source: 'table' as const }),
      system_hash: shortHash(call.prompt),
      schema_hash: shortHash(JSON.stringify(call.schema.schema)),
      effort: call.config.effort,
      thinking: runs.map((run) => run.thinking).join('+'),
      ...(typeof last.stopReason === 'string' ? { stop_reason: last.stopReason } : {}),
      ...(thinking.length ? { thinking_tokens: thinking.reduce((a, b) => a + b, 0) } : {}),
      ...(first.firstTokenMs !== undefined ? { first_token_ms: first.firstTokenMs } : {}),
      ...(last.firstTextMs !== undefined ? { first_text_ms: last.firstTextMs } : {}),
      ...(runs.length > 1 && cause ? { retried_without_thinking: cause } : {}),
    },
  };
}

/** The request without thinking. Its failure names the cause of the second request. */
async function runAgain(call: Call, signal: AbortSignal, started: number, thinking: { type: string }, cause: string): Promise<Run> {
  try {
    return await runAnthropic(call, signal, started, false, thinking);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error instanceof UsageLimitError || error instanceof RateLimitError) throw error;
    throw new ProviderError(`${error.message} (in the request without thinking, after ${cause})`, error.status);
  }
}

/**
 * REV-113. The user message as text blocks, one for each part. With `marks`, a part with `cache`
 * carries a cache mark with its TTL, at most MAX_PACK_MARKS of them: the last ones. A mark of 1 hour
 * after a mark of 5 minutes becomes a mark of 5 minutes, as the API asks. The API refuses an empty
 * text block.
 */
export function userContent(parts: readonly MessagePart[], marks: boolean): Block[] {
  const kept = parts.filter((part) => part.text.trim());
  const cached = kept.flatMap((part, index) => (part.cache ? [index] : []));
  const marked = new Set(marks ? cached.slice(-MAX_PACK_MARKS) : []);
  let short = false;
  return kept.map((part, index) => {
    if (!marked.has(index)) return { type: 'text', text: part.text };
    short ||= part.cache === '5m';
    return { type: 'text', text: part.text, cache_control: short ? { ...TAIL_MARK } : { ...SYSTEM_MARK } };
  });
}

/** `stopLongThinking`: the call stops a thinking longer than thinkingWaitMs. */
async function runAnthropic(call: Call, signal: AbortSignal, started: number, stopLongThinking: boolean, thinking?: { type: string }): Promise<Run> {
  const messages: { role: string; content: Block[] }[] = [{ role: 'user', content: userContent(call.parts ?? [{ text: call.message }], !thinking) }];
  const run: Run = {
    text: '',
    stopReason: undefined,
    model: call.model,
    thinking: thinking?.type ?? 'adaptive',
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 },
    cost: 0,
    late: false,
  };
  let tail: Block | undefined;
  for (let round = 0; ; round++) {
    const offer = offerTools(call, started, round);
    if (call.tools) tail = markLastBlock(messages, tail);
    const late = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const message: Message = { content: [], usage: {} };
    try {
      const response = await call.fetch(endpoint(call.baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: {
          'x-api-key': call.apiKey ?? '',
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: call.model,
          max_tokens: call.config.maxTokens,
          stream: true,
          system: [{ type: 'text', text: call.prompt, cache_control: { ...SYSTEM_MARK } }],
          messages,
          ...(thinking ? { thinking } : {}),
          // `none` on the last request: the conversation holds tool calls, so the tools stay declared.
          ...(call.tools ? { tools: anthropicTools(), tool_choice: { type: offer ? 'auto' : 'none' } } : {}),
          output_config: { effort: call.config.effort, format: { type: 'json_schema', schema: call.schema.schema } },
        }),
        signal: AbortSignal.any([signal, late.signal]),
      });
      if (!response.ok) throw await refused(response, 'Anthropic');
      const onBlock = (type: string) => {
        const now = Date.now() - started;
        run.firstTokenMs ??= now;
        if (type === 'thinking' || type === 'redacted_thinking') {
          const wait = stopLongThinking && timer === undefined ? thinkingWaitMs(call.timeoutMs, now) : null;
          if (wait !== null) timer = setTimeout(() => late.abort(), wait);
          return;
        }
        clearTimeout(timer);
        if (type === 'text') run.firstTextMs ??= now;
      };
      await readMessage(response, message, onBlock, call.onStart);
    } catch (error) {
      if (!late.signal.aborted || signal.aborted) throw error;
      run.late = true;
    } finally {
      clearTimeout(timer);
    }
    if (typeof message.model === 'string') run.model = message.model;
    // The output tokens of a stopped request come only at its end: the cost does not count them.
    const request = requestTokens(message.usage);
    for (const key of Object.keys(request) as (keyof Required<Tokens>)[]) run.tokens[key] += request[key];
    // KNT-206. Bedrock bills the inference profile of the request (`eu.` costs 10 % more than
    // `global.`), whatever id the answer names.
    const cost = costFromTable('anthropic', bedrockClaude(call.model) ? call.model : run.model, request);
    run.cost = run.cost === null || cost === null ? null : run.cost + cost;
    const thought = count(message.usage.output_tokens_details?.thinking_tokens);
    if (thought !== undefined) run.tokens.thinking = (run.tokens.thinking ?? 0) + thought;
    if (run.late) return run;
    if (message.stop_reason === 'refusal') {
      throw new ProviderError(`Anthropic declined the request (${message.stop_details?.category ?? 'no category'})`);
    }
    const content = message.content.filter(Boolean);
    const uses = content.filter((block) => block.type === 'tool_use');
    if (call.tools && offer && message.stop_reason === 'tool_use' && uses.length > 0) {
      call.tools.ranRound();
      // The answer goes back whole, thinking blocks included, as the API asks.
      messages.push({ role: 'assistant', content });
      const results: Block[] = [];
      for (const use of uses) results.push({ type: 'tool_result', tool_use_id: use.id, content: await call.tools.run({ name: String(use.name), input: use.input }) });
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (message.stop_reason === 'tool_use') throw toolAfterLastRound('Anthropic');
    run.stopReason = message.stop_reason;
    run.text = content
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('');
    return run;
  }
}

/**
 * REV-113. The tokens of one request. `cache_creation` splits the cache writes by TTL. Without it,
 * every write counts at the TTL of 5 minutes.
 */
export function requestTokens(usage: Record<string, any>): Required<Tokens> {
  const written = count(usage.cache_creation_input_tokens) ?? 0;
  const fiveMinutes = count(usage.cache_creation?.ephemeral_5m_input_tokens);
  const oneHour = count(usage.cache_creation?.ephemeral_1h_input_tokens);
  const split = fiveMinutes !== undefined || oneHour !== undefined;
  return {
    input: count(usage.input_tokens) ?? 0,
    cacheRead: count(usage.cache_read_input_tokens) ?? 0,
    cacheWrite: split ? (fiveMinutes ?? 0) : written,
    cacheWrite1h: split ? (oneHour ?? 0) : 0,
    output: count(usage.output_tokens) ?? 0,
  };
}

/**
 * Fills `message` from the answer: the events of the stream, or one JSON body from a server that
 * does not stream. `message` keeps what came before an error. `onBlock` gets the type of each
 * content block when it starts. `onStart` runs when the answer starts.
 */
async function readMessage(response: Response, message: Message, onBlock: (type: string) => void, onStart?: () => void): Promise<void> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const out = await response.json();
    onStart?.();
    Object.assign(message, out, { content: Array.isArray(out.content) ? out.content : [], usage: out.usage ?? {} });
    return;
  }
  const toolInput = new Map<number, string>();
  for await (const event of serverEvents(response.body)) {
    switch (event?.type) {
      case 'message_start':
        onStart?.();
        message.model = event.message?.model;
        addUsage(message.usage, event.message?.usage);
        break;
      case 'content_block_start':
        message.content[event.index] = { ...event.content_block };
        onBlock(String(event.content_block?.type));
        break;
      case 'content_block_delta': {
        const block = message.content[event.index];
        const delta = event.delta ?? {};
        if (!block) break;
        if (delta.type === 'text_delta') block.text = String(block.text ?? '') + delta.text;
        else if (delta.type === 'thinking_delta') block.thinking = String(block.thinking ?? '') + delta.thinking;
        else if (delta.type === 'signature_delta') block.signature = delta.signature;
        else if (delta.type === 'input_json_delta') toolInput.set(event.index, (toolInput.get(event.index) ?? '') + delta.partial_json);
        break;
      }
      case 'content_block_stop': {
        const block = message.content[event.index];
        const input = toolInput.get(event.index);
        if (block?.type === 'tool_use' && input !== undefined) {
          try {
            block.input = JSON.parse(input || '{}');
          } catch {
            // The tool answers that its input is missing, and the model can call again.
            block.input = {};
          }
        }
        break;
      }
      case 'message_delta':
        message.stop_reason = event.delta?.stop_reason;
        if (event.delta?.stop_details) message.stop_details = event.delta.stop_details;
        addUsage(message.usage, event.usage);
        break;
      case 'error':
        throw new ProviderError(`Anthropic stopped the stream: ${event.error?.type ?? 'error'}: ${String(event.error?.message ?? '').slice(0, 300)}`);
    }
  }
}

/** The counts of `message_delta` add up from the start of the message: each one replaces the last. */
function addUsage(usage: Record<string, unknown>, more: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(more ?? {})) if (value !== null && value !== undefined) usage[key] = value;
}

/** The JSON data of each event of a stream of server-sent events. */
async function* serverEvents(body: ReadableStream<Uint8Array> | null): AsyncGenerator<any> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll('\r\n', '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data) yield JSON.parse(data);
    }
  }
}

/**
 * With tools, each request sends the conversation again. The last block carries a cache mark: the
 * next request reads the whole conversation up to it from the cache. The call removes the mark of
 * the previous round (`tail`) and keeps the marks of the pack. It returns the block that it marked.
 */
function markLastBlock(messages: { content: Block[] }[], tail: Block | undefined): Block | undefined {
  if (tail) delete tail.cache_control;
  const last = messages.at(-1)?.content.at(-1);
  if (!last || last.cache_control) return undefined;
  last.cache_control = { ...TAIL_MARK };
  return last;
}

// --- A server with the API of OpenAI -----------------------------------------------------------

/**
 * `/chat/completions` of a server with the API of OpenAI. It asks for the schema with
 * `response_format`; a server that refuses it (400 or 422) gets the call again without it, with the
 * schema in the prompt. An answer that is not JSON gets one more call that asks for the JSON only.
 *
 * KNT-204. On the base URL of a preset (presets.ts), the call takes the name of the provider in its
 * errors, the field of its answer cap (`max_completion_tokens` at OpenAI), and asks for no more
 * answer tokens than the model takes.
 */
async function callOpenAiCompatible<T>(call: Call): Promise<Called<T>> {
  const preset = presetOf('openai_compatible', call.baseUrl);
  const name = preset?.name ?? 'The OpenAI-compatible server';
  const cap = Object.hasOwn(preset?.maxOutputTokens ?? {}, call.model) ? preset!.maxOutputTokens![call.model]! : Infinity;
  const maxTokens = { [preset?.maxTokensField ?? 'max_tokens']: Math.min(call.config.maxTokens, cap) };
  const send = (messages: { role: string; content: string }[], withFormat: boolean) =>
    call.fetch(endpoint(call.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { ...(call.apiKey ? { Authorization: `Bearer ${call.apiKey}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: call.model,
        ...maxTokens,
        messages,
        ...(withFormat
          ? { response_format: { type: 'json_schema', json_schema: { name: call.schema.name, strict: true, schema: call.schema.schema } } }
          : {}),
      }),
      signal: AbortSignal.timeout(call.timeoutMs),
    });

  let messages = [
    { role: 'system', content: call.prompt },
    { role: 'user', content: call.message },
  ];
  let withFormat = true;
  let response = await send(messages, true);
  if (response.status === 400 || response.status === 422) {
    // KNT-204. A limit can come as a 400 (Groq: `blocked_api_access` at the spend limit of the org):
    // the call without the schema would get it too.
    const text = await errorText(response);
    if (limitOf(response.status, text, response.headers)) throw refusedWith(response.status, text, response.headers, name);
    withFormat = false;
    messages = [
      { role: 'system', content: `${call.prompt}\n\nAnswer with one JSON object only, that follows this JSON schema:\n${JSON.stringify(call.schema.schema)}` },
      { role: 'user', content: call.message },
    ];
    response = await send(messages, false);
  }
  if (!response.ok) throw await refused(response, name);
  let out = await response.json();
  let input = count(out.usage?.prompt_tokens) ?? 0;
  let output = count(out.usage?.completion_tokens) ?? 0;
  let cacheRead = count(out.usage?.prompt_tokens_details?.cached_tokens) ?? 0;
  let content: string = out.choices?.[0]?.message?.content ?? '';
  let answer: T;
  try {
    answer = parseObject<T>(content, name);
  } catch {
    const again = await send(
      [...messages, { role: 'assistant', content }, { role: 'user', content: 'Your answer is not one valid JSON object. Answer again with the JSON object only.' }],
      withFormat,
    );
    if (!again.ok) throw await refused(again, name);
    out = await again.json();
    input += count(out.usage?.prompt_tokens) ?? 0;
    output += count(out.usage?.completion_tokens) ?? 0;
    cacheRead += count(out.usage?.prompt_tokens_details?.cached_tokens) ?? 0;
    content = out.choices?.[0]?.message?.content ?? '';
    answer = parseObject<T>(content, name);
  }
  const model: string = typeof out.model === 'string' && out.model ? out.model : call.model;
  const cached = count(out.usage?.prompt_tokens_details?.cached_tokens);
  // `prompt_tokens` counts the cached tokens too: the table prices them apart.
  const read = Math.min(cacheRead, input);
  return {
    answer,
    usage: {
      model,
      ...(preset ? { provider: preset.name } : {}),
      prompt_tokens: input,
      completion_tokens: output,
      // REV-89. The cached tokens of the last call, when the server gives them.
      ...(cached !== undefined ? { cache_read_tokens: cached } : {}),
      ...priced('openai_compatible', model, { input: input - read, output, cacheRead: read }, out.usage?.cost, call.baseUrl, call.model),
    },
  };
}

// --- Ollama ------------------------------------------------------------------------------------

/** `/api/chat` of Ollama, with the schema in `format`. It runs on a machine of the runner: cost 0. */
async function callOllama<T>(call: Call): Promise<Called<T>> {
  const response = await call.fetch(endpoint(call.baseUrl, '/api/chat'), {
    method: 'POST',
    headers: { ...(call.apiKey ? { Authorization: `Bearer ${call.apiKey}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: call.model,
      stream: false,
      format: call.schema.schema,
      options: { num_predict: call.config.maxTokens },
      messages: [
        { role: 'system', content: call.prompt },
        { role: 'user', content: call.message },
      ],
    }),
    signal: AbortSignal.timeout(call.timeoutMs),
  });
  if (!response.ok) throw await refused(response, 'Ollama');
  const out = await response.json();
  const answer = parseObject<T>(out.message?.content ?? '', 'Ollama');
  const input = count(out.prompt_eval_count) ?? 0;
  const output = count(out.eval_count) ?? 0;
  return {
    answer,
    usage: { model: typeof out.model === 'string' ? out.model : call.model, provider: 'Ollama', prompt_tokens: input, completion_tokens: output, cost: 0, cost_source: 'free' },
  };
}
