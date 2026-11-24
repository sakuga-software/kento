// KNT-204. The presets of the providers: known servers of the API of OpenAI. A preset gives the
// name, the base URL, the models of each level and the page of the keys of a provider. A preset is
// not a kind of provider: a provider made from it is `openai_compatible`, with the base URL of the
// preset. The service and the runner find the preset of a provider by its base URL (presetOf). So a
// provider that an admin added before KNT-204 gets its preset too, and nothing is stored for it.
//
// The prices of the models of a preset are in prices.ts, by the host of the base URL.
import type { Level, ProviderKind } from '../../protocol/src/index.ts';

/** Where a fact comes from: a page of the provider, and the day it was read (YYYY-MM-DD). */
export type Source = { url: string; checked: string };

export type ProviderPreset = {
  /** Stable: the form keeps it in its URL (`?preset=`). Never rename one. */
  id: string;
  /** The name of the provider, as the screens show it. */
  name: string;
  /** `openai_compatible` for every preset of KNT-204. */
  kind: ProviderKind;
  /** The base URL of the API, with no slash at the end. The adapter adds `/chat/completions`. */
  baseUrl: string;
  /** The page where an admin creates a key. */
  keysUrl: string;
  /**
   * The models of each level, the first one first. A model is here only if the docs of the provider
   * say that it takes tool calls and answers in a JSON schema (`response_format` `json_schema`).
   */
  models: Record<Level, readonly string[]>;
  /** Where the docs say it, for the models of `models`. */
  modelsSource: Source;
  /** The path after the base URL that "Test" reads with the key: the list of the models. */
  modelsPath: string;
  /**
   * The name of the field of the request that caps the answer tokens. The reasoning models of OpenAI
   * refuse `max_tokens`. Not set: `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /**
   * The most answer tokens that a model takes, when it is less than the levels ask (32,000). The
   * call asks for this number then: above it, the provider refuses the call (400).
   */
  maxOutputTokens?: Readonly<Record<string, number>>;
  /** What the provider keeps of a request of the API, and whether it trains on it. */
  data: { note: string } & Source;
};

/** The picker of the form also offers these words: a preset never takes one as its id. */
export const RESERVED_PRESET_IDS = ['anthropic', 'openrouter', 'ollama', 'openai_compatible', 'other'] as const;

/** The day the docs of the first batch were read. */
const KNT_204 = '2026-11-24';

/**
 * The presets, in the order of the picker. KNT-204 checked each fact in the docs of the provider
 * on KNT_204: the base URL, the models, their tool calls and their JSON schema, the limits of their
 * answer, the path of the list of models, and the data terms.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    // Chat Completions takes the tools of the GPT-5.6 models and of GPT-5.5 with no condition. The
    // GPT-6 models need the Responses API for their tools on Chat Completions, or no reasoning.
    models: { lite: ['gpt-5.6-luna'], balanced: ['gpt-5.6-terra'], heavy: ['gpt-5.6-sol', 'gpt-5.5'] },
    modelsSource: { url: 'https://developers.openai.com/api/docs/guides/function-calling', checked: KNT_204 },
    modelsPath: '/models',
    // `max_tokens` is deprecated, and the reasoning models refuse it.
    maxTokensField: 'max_completion_tokens',
    data: {
      note: 'OpenAI does not train on the data of its API unless you opt in. Its abuse monitoring logs stay up to 30 days. Zero data retention needs its approval.',
      url: 'https://developers.openai.com/api/docs/guides/your-data',
      checked: KNT_204,
    },
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keysUrl: 'https://aistudio.google.com/apikey',
    // The page of each model says "Function calling: Supported" and "Structured outputs: Supported";
    // the page of the OpenAI compatibility sends the schema with `json_schema` and `strict`.
    models: {
      lite: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
      balanced: ['gemini-4-hydrogen', 'gemini-3.8-flash'],
      heavy: ['gemini-4-neon', 'gemini-4-argon'],
    },
    modelsSource: { url: 'https://aistudio.google.com/docs/openai', checked: KNT_204 },
    modelsPath: '/models',
    data: {
      note: 'With billing on, Google does not use the prompts or the answers to improve its products, and keeps them 55 days for abuse monitoring; its logs keep them up to 55 days too. On the free tier, Google uses them, and people may read them. The Gemini API has no zero data retention.',
      url: 'https://aistudio.google.com/docs/terms.md',
      checked: KNT_204,
    },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    keysUrl: 'https://console.mistral.ai/api-keys',
    // « All currently available models except for codestral-mamba » answer in a JSON schema. Mistral
    // Large 4 is active since 2026-10-29 in the legal center, after its preview.
    models: {
      lite: ['mistral-small-2603', 'ministral-14b-2512'],
      balanced: ['mistral-large-4', 'mistral-small-2603'],
      heavy: ['mistral-large-4', 'zai-glm-5-3'],
    },
    modelsSource: { url: 'https://docs.mistral.ai/llms/inference/conversations/structured-output/custom/llms.txt', checked: KNT_204 },
    modelsPath: '/models',
    data: {
      note: 'Mistral keeps the inputs and the outputs 30 days for abuse monitoring, unless it grants zero data retention on request. Turn off "Data usage for improving our services" in the admin panel: the opt-out does not cover its preview models.',
      url: 'https://legal.mistral.ai/terms/commercial-terms-of-service/',
      checked: KNT_204,
    },
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    keysUrl: 'https://console.groq.com/keys',
    // A strict JSON schema only on the gpt-oss models among those in production. Qwen 3.8 27B is a
    // preview, and answers 16,384 tokens at most.
    models: { lite: ['openai/gpt-oss-20b'], balanced: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], heavy: ['openai/gpt-oss-120b'] },
    modelsSource: { url: 'https://console.groq.com/docs/structured-outputs', checked: KNT_204 },
    modelsPath: '/models',
    data: {
      note: 'Groq keeps no data of an inference request by default. Its logs for troubleshooting and abuse stay up to 30 days, and zero data retention is a setting of the organization. Groq does not train on inputs or outputs.',
      url: 'https://console.groq.com/docs/your-data',
      checked: KNT_204,
    },
  },
  {
    id: 'xai',
    name: 'xAI',
    kind: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1',
    keysUrl: 'https://console.x.ai/team/default/api-keys',
    // xAI calls Chat Completions a legacy endpoint, with no date of removal.
    models: { lite: ['grok-4.20-0309-non-reasoning', 'grok-4.3'], balanced: ['grok-4.3'], heavy: ['grok-4.7', 'grok-4.6'] },
    modelsSource: { url: 'https://docs.x.ai/docs/guides/structured-outputs', checked: KNT_204 },
    modelsPath: '/models',
    maxTokensField: 'max_completion_tokens',
    data: {
      note: 'xAI keeps the requests and the answers of its API 30 days for abuse audits, then deletes them. Zero data retention is a setting of the team. xAI does not train on them without your permission.',
      url: 'https://docs.x.ai/developers/faq/security',
      checked: KNT_204,
    },
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'openai_compatible',
    baseUrl: 'https://api.together.ai/v1',
    keysUrl: 'https://api.together.ai/settings/projects/~current/api-keys',
    // The catalog of the serverless models has the columns "Function calling" and "Structured outputs".
    models: {
      lite: ['zai-org/GLM-5.3-Flash', 'deepseek-ai/DeepSeek-V4.1-Flash'],
      balanced: ['zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-V4-Pro-0813'],
      heavy: ['moonshotai/Kimi-K3.1-Pro', 'moonshotai/Kimi-K3'],
    },
    modelsSource: { url: 'https://docs.together.ai/docs/serverless/models.md', checked: KNT_204 },
    modelsPath: '/models',
    data: {
      note: 'A new organization of Together AI starts with zero data retention, and no prompt storage. Sharing data for training is opt-in.',
      url: 'https://docs.together.ai/docs/privacy-and-security.md',
      checked: KNT_204,
    },
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'openai_compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keysUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    // `json_schema` is a field of Chat Completions for every model; the card of each model says that it
    // takes tool calls.
    models: {
      lite: ['accounts/fireworks/models/glm-5p3-flash', 'accounts/fireworks/models/deepseek-v4p1-flash'],
      balanced: ['accounts/fireworks/models/glm-5p3', 'accounts/fireworks/models/deepseek-v4p1-flash'],
      heavy: ['accounts/fireworks/models/kimi-k3p1-pro', 'accounts/fireworks/models/kimi-k3'],
    },
    modelsSource: { url: 'https://docs.fireworks.ai/structured-responses/structured-response-formatting', checked: KNT_204 },
    modelsPath: '/models',
    data: {
      note: 'Fireworks AI does not log or store the prompts or the answers of open models without your opt-in, and does not train on them.',
      url: 'https://docs.fireworks.ai/guides/security_compliance/data_handling',
      checked: KNT_204,
    },
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    kind: 'openai_compatible',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    keysUrl: 'https://deepinfra.com/dash/keys',
    // Each model page has the tags "JSON" and "Function".
    models: {
      lite: ['deepseek-ai/DeepSeek-V4.1-Flash-1017', 'zai-org/GLM-5.3-Flash'],
      balanced: ['zai-org/GLM-5.3', 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo'],
      heavy: ['deepseek-ai/DeepSeek-V4-Pro', 'moonshotai/Kimi-K3'],
    },
    modelsSource: { url: 'https://docs.deepinfra.com/chat/structured-outputs.md', checked: KNT_204 },
    modelsPath: '/models',
    // « A hard cap of 16384 tokens for most models »: the docs give no number for each model.
    maxOutputTokens: {
      'deepseek-ai/DeepSeek-V4.1-Flash-1017': 16_384,
      'zai-org/GLM-5.3-Flash': 16_384,
      'zai-org/GLM-5.3': 16_384,
      'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo': 16_384,
      'deepseek-ai/DeepSeek-V4-Pro': 16_384,
      'moonshotai/Kimi-K3': 16_384,
    },
    data: {
      note: 'DeepInfra keeps the requests and the answers of its API in memory only, logs no content, and does not train on them (Google and Anthropic models excepted).',
      url: 'https://docs.deepinfra.com/account/data-privacy.md',
      checked: KNT_204,
    },
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'openai_compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    keysUrl: 'https://cloud.cerebras.ai',
    // The shared API serves two models, and both take tool calls and a strict JSON schema.
    models: { lite: ['gpt-oss-120b'], balanced: ['gpt-oss-120b', 'qwen-3.8-27b'], heavy: ['gpt-oss-120b', 'qwen-3.8-27b'] },
    modelsSource: { url: 'https://inference-docs.cerebras.ai/capabilities/structured-outputs', checked: KNT_204 },
    modelsPath: '/models',
    data: {
      note: 'Cerebras says that it keeps no inputs or outputs of its inference service. Its terms say nothing of training on the data of the API.',
      url: 'https://www.cerebras.ai/privacy-policy',
      checked: KNT_204,
    },
  },
];

/** The preset of this id, or null. */
export function presetById(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * A base URL as the registry compares it: the scheme, the host in lower case with its port when it
 * is not the default one, and the path with no slash at the end. Null when it is not a URL.
 */
export function normalBaseUrl(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The preset of a provider: the one with its kind and its base URL, a slash at the end or not, and
 * the host in any case. Null for any other provider: an admin who changed the base URL of a preset
 * made a server of their own.
 */
export function presetOf(kind: ProviderKind, baseUrl: string | null | undefined): ProviderPreset | null {
  if (!baseUrl) return null;
  const normal = normalBaseUrl(baseUrl);
  if (normal === null) return null;
  return PROVIDER_PRESETS.find((preset) => preset.kind === kind && normalBaseUrl(preset.baseUrl) === normal) ?? null;
}

/** The host of a base URL in lower case, or null when it is not a URL. prices.ts reads it. */
export function hostOf(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}
