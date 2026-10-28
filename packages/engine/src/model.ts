// The model: one call through OpenRouter, and the fallback to the next model of the level.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANSWER_SCHEMA, type Answer, type Usage } from './findings.ts';
import type { LevelConfig } from './levels.ts';

/** The API of OpenRouter. A caller can give another base with the same API, for example a proxy. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const PROMPTS = join(import.meta.dirname, '..', 'prompts');

/**
 * What the engine needs to call a model. The caller gives the key: the engine reads no environment.
 * `fetch` replaces the network in a test; `log` gets the failed attempts. `baseUrl` replaces
 * OPENROUTER_BASE_URL with another server of the same API.
 */
export type ModelClient = {
  apiKey: string | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
};

export type Reply = { answer: Answer; usage: Usage };

export type Schema = { name: string; schema: object };

const stderr = (message: string) => process.stderr.write(`${message}\n`);

/** One call to one model. It throws on an error, a timeout or an answer that is not the schema. */
async function callJson<T>(
  client: ModelClient,
  model: string,
  config: LevelConfig,
  prompt: string,
  message: string,
  schema: Schema,
  timeoutMs: number,
): Promise<{ answer: T; usage: Usage }> {
  const url = `${(client.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const response = await (client.fetch ?? globalThis.fetch)(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${client.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Sakuga Review',
    },
    body: JSON.stringify({
      model,
      max_tokens: config.maxTokens,
      reasoning: { effort: config.effort },
      usage: { include: true },
      // The diff goes only to a provider that keeps nothing and trains on nothing, and that honours
      // the answer schema. Of those, the cheapest under MAX_PRICE answers first.
      provider: { zdr: true, data_collection: 'deny', require_parameters: true, sort: 'price', max_price: config.maxPrice },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: message },
      ],
      response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenRouter answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const out = await response.json();
  const content: string = out.choices?.[0]?.message?.content ?? '';
  const answer: T = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  return { answer, usage: { model: out.model, provider: out.provider, ...out.usage } };
}

/** The answer of the first model of the level that gives one. `promptFile` is a file of `prompts/`. */
export async function askJson<T>(
  client: ModelClient,
  config: LevelConfig,
  promptFile: string,
  message: string,
  schema: Schema,
): Promise<{ answer: T; usage: Usage }> {
  const prompt = readFileSync(join(PROMPTS, promptFile), 'utf8');
  let lastError: unknown;
  for (const [attempt, model] of config.models.entries()) {
    try {
      return await callJson<T>(client, model, config, prompt, message, schema, config.timeoutsMs[attempt] ?? config.timeoutsMs.at(-1)!);
    } catch (error) {
      lastError = error;
      (client.log ?? stderr)(`attempt ${attempt + 1} with ${model} failed: ${error}`);
    }
  }
  throw new Error(`no model gave a usable answer: ${lastError}`);
}

export async function askModel(client: ModelClient, config: LevelConfig, pack: string): Promise<Reply> {
  const reply = await askJson<Answer>(client, config, 'review.md', pack, { name: 'review', schema: ANSWER_SCHEMA });
  reply.answer.findings = (reply.answer.findings ?? []).filter((f) => f && typeof f.path === 'string' && f.path);
  return reply;
}
