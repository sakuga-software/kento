// KNT-204. The presets of the providers: known servers of the API of OpenAI. A preset gives the
// name, the base URL, the models of each level and the page of the keys of a provider. A preset is
// not a kind of provider: a provider made from it is `openai_compatible`, with the base URL of the
// preset. The service and the runner find the preset of a provider by its base URL (presetOf). So a
// provider that an admin added before KNT-204 gets its preset too, and nothing is stored for it.
//
// The prices of the models of a preset are in prices.ts, by the host of the base URL.
//
// KNT-206. A cloud with one URL for each resource or region (Azure OpenAI, Amazon Bedrock) has a
// base URL with a placeholder (`{resource}`, `{region}`): the admin replaces it, and presetOf finds
// the preset by the form of the URL. Amazon Bedrock serves Claude with the Messages API, so its
// preset is of the kind `anthropic`.
import type { Level, ProviderKind } from '../../protocol/src/index.ts';
import { ENTERPRISE_PRESETS } from './enterprise-presets.ts';

/** Where a fact comes from: a page of the provider, and the day it was read (YYYY-MM-DD). */
export type Source = { url: string; checked: string };

export type ProviderPreset = {
  /** Stable: the form keeps it in its URL (`?preset=`). Never rename one. */
  id: string;
  /** The name of the provider, as the screens show it. */
  name: string;
  /** `openai_compatible`, or `anthropic` for a cloud that serves the Messages API (KNT-206). */
  kind: ProviderKind;
  /**
   * The base URL of the API, with no slash at the end. The adapter adds `/chat/completions`, or
   * `/v1/messages` for `anthropic`. KNT-206: it can hold placeholders (PLACEHOLDERS) that the admin
   * replaces.
   */
  baseUrl: string;
  /** KNT-206. Other forms of `baseUrl` that the provider serves, for presetOf. */
  otherBaseUrls?: readonly string[];
  /** KNT-206. What the admin puts in the placeholders of `baseUrl`: the hint of the URL field. */
  baseUrlHint?: string;
  /** The page where an admin creates a key. */
  keysUrl: string;
  /**
   * The models of each level, the first one first. A model is here only if the docs of the provider
   * say that it takes tool calls and answers in a JSON schema (`response_format` `json_schema`).
   */
  models: Record<Level, readonly string[]>;
  /** Where the docs say it, for the models of `models`. */
  modelsSource: Source;
  /**
   * The path after the base URL that "Test" reads with the key: the list of the models. KNT-206:
   * null when the provider has no call that tests a key for free; `testNote` then says it.
   */
  modelsPath: string | null;
  /** KNT-206. With no `modelsPath`: what "Test" says instead. */
  testNote?: string;
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
const KNT_204_PRESETS: readonly ProviderPreset[] = [
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

/** The presets, in the order of the picker: those of KNT-204, then the clouds of KNT-206. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [...KNT_204_PRESETS, ...ENTERPRISE_PRESETS];

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
 * KNT-206. The placeholders of a base URL, and the values that presetOf takes for them: the name of
 * an Azure resource (letters, digits and hyphens), the code of an AWS Region (`us-east-1`,
 * `us-gov-west-1`).
 */
export const PLACEHOLDERS: Readonly<Record<string, RegExp>> = {
  resource: /[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/,
  region: /[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}/,
};

/** KNT-206. The placeholders that a base URL still holds, in their order: `["resource"]`. */
export function placeholdersOf(baseUrl: string): string[] {
  return [...baseUrl.matchAll(/\{([a-z]+)\}/g)].map((match) => match[1]!);
}

/** KNT-206. A base URL with each placeholder replaced by its value. */
export function fillBaseUrl(baseUrl: string, values: Readonly<Record<string, string>>): string {
  return baseUrl.replace(/\{([a-z]+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? values[name]! : whole));
}

/** KNT-206. Whether a normal base URL has the form of a base URL of a preset, placeholders included. */
function matches(template: string, normal: string): boolean {
  if (placeholdersOf(template).length === 0) return normalBaseUrl(template) === normal;
  if (template === normal) return true;
  const source = template
    .split(/(\{[a-z]+\})/)
    .map((part) => {
      const name = /^\{([a-z]+)\}$/.exec(part)?.[1];
      if (name === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return Object.hasOwn(PLACEHOLDERS, name) ? `(?:${PLACEHOLDERS[name]!.source})` : '(?!)';
    })
    .join('');
  return new RegExp(`^${source}$`).test(normal);
}

/**
 * The preset of a provider: the one with its kind and its base URL, a slash at the end or not, and
 * the host in any case. Null for any other provider: an admin who changed the base URL of a preset
 * made a server of their own. KNT-206: a placeholder of the preset matches any value of its form.
 */
export function presetOf(kind: ProviderKind, baseUrl: string | null | undefined): ProviderPreset | null {
  if (!baseUrl) return null;
  const normal = normalBaseUrl(baseUrl);
  if (normal === null) return null;
  return PROVIDER_PRESETS.find((preset) => preset.kind === kind && [preset.baseUrl, ...(preset.otherBaseUrls ?? [])].some((url) => matches(url, normal))) ?? null;
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
