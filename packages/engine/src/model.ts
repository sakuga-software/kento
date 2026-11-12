// The model: one call through the provider, and the fallback to the next model of the level.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANSWER_SCHEMA, withPatch, type Answer, type Usage } from './findings.ts';
import type { LevelConfig } from './levels.ts';
import type { ProviderKind } from '../../protocol/src/index.ts';
import { ADAPTERS, defaultBaseUrl, ProviderError, refusedKey, type Schema } from './providers.ts';
import { TOOLS_NOTE, type RepoTools } from './tools.ts';

export { OPENROUTER_BASE_URL, type Schema } from './providers.ts';

const PROMPTS = join(import.meta.dirname, '..', 'prompts');
const PATCH_NOTE = readFileSync(join(PROMPTS, 'patch.md'), 'utf8').trim();

/**
 * What the engine needs to call a model. The caller gives the key: the engine reads no environment.
 * `kind` is the provider (OpenRouter when not given); `baseUrl` replaces its default URL, and a
 * server of the OpenAI API needs one. `fetch` replaces the network in a test; `log` gets the failed
 * attempts. `prompts` replaces the text of a file of `prompts/`, by its name: the bench compares a
 * prompt with another one on the same engine (REV-109).
 */
export type ModelClient = {
  apiKey: string | undefined;
  kind?: ProviderKind;
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  prompts?: Partial<Record<string, string>>;
};

export type Reply = { answer: Answer; usage: Usage };

const stderr = (message: string) => process.stderr.write(`${message}\n`);

/**
 * The answer of the first model of the level that gives one. `promptFile` is a file of `prompts/`;
 * `promptAddition`, when given, goes at the end of it (the focus of a pass, REV-20). `tools`: the
 * tools of the review (REV-68), shared by the models of the level and by the passes.
 */
export async function askJson<T>(
  client: ModelClient,
  config: LevelConfig,
  promptFile: string,
  message: string,
  schema: Schema,
  promptAddition?: string,
  tools?: RepoTools,
): Promise<{ answer: T; usage: Usage }> {
  const file = client.prompts?.[promptFile] ?? readFileSync(join(PROMPTS, promptFile), 'utf8');
  const prompt = promptAddition ? `${file.trimEnd()}\n\n${promptAddition}\n` : file;
  const kind = client.kind ?? 'openrouter';
  const baseUrl = client.baseUrl ?? defaultBaseUrl(kind);
  if (!baseUrl) throw new ProviderError(`the provider ${kind} needs a base URL`);
  if (config.models.length === 0) throw new ProviderError(`no model is set for the provider ${kind} at this level`);
  const call = ADAPTERS[kind];
  let lastError: unknown;
  for (const [attempt, model] of config.models.entries()) {
    // The calls and bytes of the tools are one budget for the review: a model that takes over gets
    // what the failed attempts left, and its own rounds.
    if (tools && attempt > 0 && tools.used.calls > 0) {
      (client.log ?? stderr)(`attempt ${attempt + 1} with ${model} starts with ${tools.used.calls} of ${tools.budget.calls} tool calls and ${tools.used.bytes} of ${tools.budget.bytes} bytes used`);
    }
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
        ...(tools ? { tools } : {}),
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
 * `focus`: the angle of a pass (REV-20), added to the prompt; none for a review in one pass. `tools`:
 * the tools of REV-68, with their note at the end of the prompt; none for the pack alone. A level with
 * `patch` (REV-104) gets prompts/patch.md and a `patch` in each finding of the schema.
 */
export async function askModel(
  client: ModelClient,
  config: LevelConfig,
  pack: string,
  schema: object = ANSWER_SCHEMA,
  focus?: string,
  tools?: RepoTools,
): Promise<Reply> {
  const patchNote = config.patch ? PATCH_NOTE : undefined;
  const addition = [focus, patchNote, tools ? TOOLS_NOTE : undefined].filter(Boolean).join('\n\n') || undefined;
  const asked = config.patch ? withPatch(schema) : schema;
  const reply = await askJson<Answer>(client, config, 'review.md', pack, { name: 'review', schema: asked }, addition, tools);
  reply.answer.findings = (reply.answer.findings ?? []).filter((f) => f && typeof f.path === 'string' && f.path);
  return reply;
}
