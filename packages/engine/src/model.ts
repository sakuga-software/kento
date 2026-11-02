// The model: one call through the provider, and the fallback to the next model of the level.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANSWER_SCHEMA, type Answer, type Usage } from './findings.ts';
import type { LevelConfig } from './levels.ts';
import type { ProviderKind } from '../../protocol/src/index.ts';
import { ADAPTERS, defaultBaseUrl, ProviderError, refusedKey, type Schema } from './providers.ts';

export { OPENROUTER_BASE_URL, type Schema } from './providers.ts';

const PROMPTS = join(import.meta.dirname, '..', 'prompts');

/**
 * What the engine needs to call a model. The caller gives the key: the engine reads no environment.
 * `kind` is the provider (OpenRouter when not given); `baseUrl` replaces its default URL, and a
 * server of the OpenAI API needs one. `fetch` replaces the network in a test; `log` gets the failed
 * attempts.
 */
export type ModelClient = {
  apiKey: string | undefined;
  kind?: ProviderKind;
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
};

export type Reply = { answer: Answer; usage: Usage };

const stderr = (message: string) => process.stderr.write(`${message}\n`);

/**
 * The answer of the first model of the level that gives one. `promptFile` is a file of `prompts/`;
 * `promptAddition`, when given, goes at the end of it (the focus of a pass, REV-20).
 */
export async function askJson<T>(
  client: ModelClient,
  config: LevelConfig,
  promptFile: string,
  message: string,
  schema: Schema,
  promptAddition?: string,
): Promise<{ answer: T; usage: Usage }> {
  const file = readFileSync(join(PROMPTS, promptFile), 'utf8');
  const prompt = promptAddition ? `${file.trimEnd()}\n\n${promptAddition}\n` : file;
  const kind = client.kind ?? 'openrouter';
  const baseUrl = client.baseUrl ?? defaultBaseUrl(kind);
  if (!baseUrl) throw new ProviderError(`the provider ${kind} needs a base URL`);
  if (config.models.length === 0) throw new ProviderError(`no model is set for the provider ${kind} at this level`);
  const call = ADAPTERS[kind];
  let lastError: unknown;
  for (const [attempt, model] of config.models.entries()) {
    try {
      return await call<T>({
        apiKey: client.apiKey,
        baseUrl,
        fetch: client.fetch ?? globalThis.fetch,
        model,
        config,
        prompt,
        message,
        schema,
        timeoutMs: config.timeoutsMs[attempt] ?? config.timeoutsMs.at(-1)!,
      });
    } catch (error) {
      lastError = error;
      (client.log ?? stderr)(`attempt ${attempt + 1} with ${model} failed: ${error}`);
      // A refused key fails with every model: the next one would be refused too.
      if (refusedKey(error)) break;
    }
  }
  const status = lastError instanceof ProviderError ? lastError.status : null;
  throw new ProviderError(`no model gave a usable answer: ${lastError}`, status);
}

/**
 * The review call. `schema`: the answer schema, `ANSWER_SCHEMA` or the one with the rules of the pack.
 * `focus`: the angle of a pass (REV-20), added to the prompt; none for a review in one pass.
 */
export async function askModel(client: ModelClient, config: LevelConfig, pack: string, schema: object = ANSWER_SCHEMA, focus?: string): Promise<Reply> {
  const reply = await askJson<Answer>(client, config, 'review.md', pack, { name: 'review', schema }, focus);
  reply.answer.findings = (reply.answer.findings ?? []).filter((f) => f && typeof f.path === 'string' && f.path);
  return reply;
}
