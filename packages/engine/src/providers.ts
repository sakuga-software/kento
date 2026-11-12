// The providers of models: one call that gives an answer held by a JSON schema, its tokens and its
// cost. OpenRouter, Anthropic, a server with the API of OpenAI, and Ollama each have their adapter.
import type { Usage } from './findings.ts';
import type { LevelConfig } from './levels.ts';
import type { CostSource, ProviderKind } from '../../protocol/src/index.ts';
import { costFromTable } from './prices.ts';
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

/**
 * REV-104. The reasoning counts in `max_tokens`, and a long reasoning cuts the JSON. The error then
 * gives the `stop_reason` and the output tokens after the message of parseObject.
 */
function parseAnthropic<T>(text: string, stopReason: unknown, outputTokens: number): T {
  try {
    return parseObject<T>(text, 'Anthropic');
  } catch (error) {
    if (!(error instanceof ProviderError) || stopReason === 'end_turn') throw error;
    throw new ProviderError(`${error.message} (stop_reason ${String(stopReason)}, ${outputTokens} output tokens)`);
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
        messages.push({ role: 'tool', tool_call_id: c.id, content: call.tools.run({ name: c.function?.name ?? '', input }) });
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
 * The Messages API of Anthropic. The answer schema goes in `output_config.format`: Claude Opus 5.5
 * and Sonnet 5.5 refuse a forced tool (`tool_choice` `tool` answers 400), and the structured output
 * holds the answer to the schema in the same way. The system prompt is the same for every review of
 * a level: it carries the cache mark, so the next review with the same model within 5 minutes reads
 * it from the cache. Without tools, the pack changes with each review and is sent once: it carries no
 * mark, since a cache write costs 1.25 times the input and would never be read. With tools (REV-68),
 * each round sends it again, so the last block of each request carries the mark (markLastBlock).
 */
async function callAnthropic<T>(call: Call): Promise<Called<T>> {
  const signal = AbortSignal.timeout(call.timeoutMs);
  const started = Date.now();
  type Block = { type: string; cache_control?: object; [key: string]: unknown };
  const messages: { role: string; content: string | Block[] }[] = [
    { role: 'user', content: call.tools ? [{ type: 'text', text: call.message }] : call.message },
  ];
  const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let model = call.model;
  for (let round = 0; ; round++) {
    const offer = offerTools(call, started, round);
    if (call.tools) markLastBlock(messages);
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
        messages,
        // `none` on the last request: the conversation holds tool calls, so the tools stay declared.
        ...(call.tools ? { tools: anthropicTools(), tool_choice: { type: offer ? 'auto' : 'none' } } : {}),
        output_config: { effort: call.config.effort, format: { type: 'json_schema', schema: call.schema.schema } },
      }),
      signal,
    });
    if (!response.ok) throw await refused(response, 'Anthropic');
    const out = await response.json();
    if (out.stop_reason === 'refusal') {
      throw new ProviderError(`Anthropic declined the request (${out.stop_details?.category ?? 'no category'})`);
    }
    if (typeof out.model === 'string') model = out.model;
    total.input += count(out.usage?.input_tokens) ?? 0;
    total.cacheRead += count(out.usage?.cache_read_input_tokens) ?? 0;
    total.cacheWrite += count(out.usage?.cache_creation_input_tokens) ?? 0;
    total.output += count(out.usage?.output_tokens) ?? 0;
    const content: Block[] = Array.isArray(out.content) ? out.content : [];
    const uses = content.filter((block) => block?.type === 'tool_use');
    if (call.tools && offer && out.stop_reason === 'tool_use' && uses.length > 0) {
      call.tools.ranRound();
      // The answer goes back whole, thinking blocks included, as the API asks.
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: uses.map((use) => ({ type: 'tool_result', tool_use_id: use.id, content: call.tools!.run({ name: String(use.name), input: use.input }) })),
      });
      continue;
    }
    if (out.stop_reason === 'tool_use') throw toolAfterLastRound('Anthropic');
    const text = content
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('');
    const answer = parseAnthropic<T>(text, out.stop_reason, total.output);
    const { input, cacheRead, cacheWrite, output } = total;
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
}

/**
 * With tools, each request sends the conversation again. The cache mark goes on its last block, and
 * only there: the next request reads the whole conversation up to it from the cache, and the API
 * takes at most four marks.
 */
function markLastBlock(messages: { content: string | { cache_control?: object }[] }[]): void {
  for (const message of messages) {
    if (Array.isArray(message.content)) for (const block of message.content) delete block.cache_control;
  }
  const last = messages.at(-1)?.content;
  if (Array.isArray(last) && last.length) last[last.length - 1]!.cache_control = { type: 'ephemeral' };
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
  const cached = count(out.usage?.prompt_tokens_details?.cached_tokens);
  return {
    answer,
    usage: {
      model,
      prompt_tokens: input,
      completion_tokens: output,
      // REV-89. The cached tokens of the last call, when the server gives them.
      ...(cached !== undefined ? { cache_read_tokens: cached } : {}),
      ...priced('openai_compatible', model, { input, output }, out.usage?.cost),
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
