// The providers of models: one call that gives an answer held by a JSON schema, its tokens and its
// cost. OpenRouter, Anthropic, a server with the API of OpenAI, and Ollama each have their adapter.
import type { Usage } from './findings.ts';
import type { LevelConfig } from './levels.ts';
import type { CostSource, ProviderKind } from '../../protocol/src/index.ts';
import { costFromTable } from './prices.ts';

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

/** Whether the provider refused the key: the call can never work until an admin replaces it. */
export function refusedKey(error: unknown): boolean {
  return error instanceof ProviderError && (error.status === 401 || error.status === 403);
}

export type Schema = { name: string; schema: object };

/** What an adapter needs for one call. */
export type Call = {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: typeof fetch;
  model: string;
  config: LevelConfig;
  prompt: string;
  message: string;
  schema: Schema;
  timeoutMs: number;
};

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

async function refused(response: Response, name: string): Promise<ProviderError> {
  const text = (await response.text().catch(() => '')).slice(0, 300);
  return new ProviderError(`${name} answered ${response.status}: ${text}`, response.status);
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

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The cost of a call: the one that the provider gave, else the table, else 0 and `unknown`. */
function priced(kind: ProviderKind, model: string, tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, given?: unknown): { cost: number; cost_source: CostSource } {
  if (typeof given === 'number' && Number.isFinite(given) && given >= 0) return { cost: given, cost_source: 'provider' };
  if (kind === 'ollama') return { cost: 0, cost_source: 'free' };
  const fromTable = costFromTable(kind, model, tokens);
  return fromTable === null ? { cost: 0, cost_source: 'unknown' } : { cost: fromTable, cost_source: 'table' };
}

// --- OpenRouter --------------------------------------------------------------------------------

async function callOpenRouter<T>(call: Call): Promise<Called<T>> {
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
      // the answer schema. Of those, the cheapest under MAX_PRICE answers first.
      provider: { zdr: true, data_collection: 'deny', require_parameters: true, sort: 'price', max_price: call.config.maxPrice },
      messages: [
        { role: 'system', content: call.prompt },
        { role: 'user', content: call.message },
      ],
      response_format: { type: 'json_schema', json_schema: { name: call.schema.name, strict: true, schema: call.schema.schema } },
    }),
    signal: AbortSignal.timeout(call.timeoutMs),
  });
  if (!response.ok) throw await refused(response, 'OpenRouter');
  const out = await response.json();
  const answer = parseObject<T>(out.choices?.[0]?.message?.content ?? '', 'OpenRouter');
  const usage: Usage = { model: out.model, provider: out.provider, ...out.usage };
  usage.cost_source = typeof usage.cost === 'number' ? 'provider' : 'unknown';
  if (usage.cost_source === 'unknown') usage.cost = 0;
  return { answer, usage };
}

// --- Anthropic ---------------------------------------------------------------------------------

/**
 * The Messages API of Anthropic. The answer schema goes in `output_config.format`: Claude Opus 5.5
 * and Sonnet 5.5 refuse a forced tool (`tool_choice` `tool` answers 400), and the structured output
 * holds the answer to the schema in the same way. The system prompt is the same for every review of
 * a level: it carries the cache mark, so the next review with the same model within 5 minutes reads
 * it from the cache. The pack changes with each review and is sent once: it carries no mark, since
 * a cache write costs 1.25 times the input and would never be read.
 */
async function callAnthropic<T>(call: Call): Promise<Called<T>> {
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
      system: [{ type: 'text', text: call.prompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: call.message }],
      output_config: { effort: call.config.effort, format: { type: 'json_schema', schema: call.schema.schema } },
    }),
    signal: AbortSignal.timeout(call.timeoutMs),
  });
  if (!response.ok) throw await refused(response, 'Anthropic');
  const out = await response.json();
  if (out.stop_reason === 'refusal') {
    throw new ProviderError(`Anthropic declined the request (${out.stop_details?.category ?? 'no category'})`);
  }
  const text = (Array.isArray(out.content) ? out.content : [])
    .filter((block: { type?: string }) => block?.type === 'text')
    .map((block: { text?: string }) => block.text ?? '')
    .join('');
  const answer = parseObject<T>(text, 'Anthropic');
  const model: string = typeof out.model === 'string' ? out.model : call.model;
  const input = count(out.usage?.input_tokens) ?? 0;
  const cacheRead = count(out.usage?.cache_read_input_tokens) ?? 0;
  const cacheWrite = count(out.usage?.cache_creation_input_tokens) ?? 0;
  const output = count(out.usage?.output_tokens) ?? 0;
  return {
    answer,
    usage: {
      model,
      provider: 'Anthropic',
      // `input_tokens` is the part that the cache did not hold: the prompt is the sum.
      prompt_tokens: input + cacheRead + cacheWrite,
      completion_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      ...priced('anthropic', model, { input, output, cacheRead, cacheWrite }),
    },
  };
}

// --- A server with the API of OpenAI -----------------------------------------------------------

/**
 * `/chat/completions` of a server with the API of OpenAI. It asks for the schema with
 * `response_format`; a server that refuses it (400 or 422) gets the call again without it, with the
 * schema in the prompt. An answer that is not JSON gets one more call that asks for the JSON only.
 */
async function callOpenAiCompatible<T>(call: Call): Promise<Called<T>> {
  const name = 'The OpenAI-compatible server';
  const send = (messages: { role: string; content: string }[], withFormat: boolean) =>
    call.fetch(endpoint(call.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { ...(call.apiKey ? { Authorization: `Bearer ${call.apiKey}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: call.model,
        max_tokens: call.config.maxTokens,
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
    await response.body?.cancel();
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
    content = out.choices?.[0]?.message?.content ?? '';
    answer = parseObject<T>(content, name);
  }
  const model: string = typeof out.model === 'string' && out.model ? out.model : call.model;
  return {
    answer,
    usage: { model, prompt_tokens: input, completion_tokens: output, ...priced('openai_compatible', model, { input, output }, out.usage?.cost) },
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
