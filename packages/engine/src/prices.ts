// The prices of the models whose provider does not give the cost of a call, and the cost of a call
// from its tokens. OpenRouter gives the cost in its answer; Ollama, and a local server of the API of
// OpenAI (KNT-205), run on a machine of the runner and cost nothing. A model that is not here costs
// 0, and the review says that its cost is not known.
import type { ProviderKind } from '../../protocol/src/index.ts';
import { hostOf, onRunnerNetwork } from './presets.ts';

/** Dollars a million tokens. */
export type Price = {
  input: number;
  output: number;
  /** A token read from the prompt cache. */
  cacheRead: number;
  /** A token written to the prompt cache with the TTL of 5 minutes. */
  cacheWrite: number;
  /** A token written to the prompt cache with the TTL of 1 hour. */
  cacheWrite1h: number;
  /** Above `threshold` prompt tokens, every token of the call has the prices of `above`. */
  longContext?: { threshold: number; above: Omit<Price, 'longContext'> };
};

/**
 * The first-party prices of Anthropic (2026-11-16). A cache write costs 1.25 times the input with the
 * TTL of 5 minutes, and 2 times with the TTL of 1 hour. A cache read costs 0.05 times the input on
 * Opus 5.5 and Sonnet 5.5, and 0.1 times on the others.
 */
const ANTHROPIC: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    cacheWrite1h: 0.2,
    longContext: { threshold: 100_000, above: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 } },
  },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
};

/**
 * KNT-204. A price of a server of the API of OpenAI: no cache write costs more than the input, and a
 * token read from the cache costs `cacheRead` (the input when the provider has no cache price).
 */
function openAiPrice(input: number, output: number, cacheRead: number = input): Price {
  return { input, output, cacheRead, cacheWrite: input, cacheWrite1h: input };
}

/**
 * KNT-204. The same with a long-context tier: above `threshold` prompt tokens, the input and the
 * cache cost `inputTimes` as much, and the output `outputTimes`.
 */
function longOpenAiPrice(threshold: number, input: number, output: number, cacheRead: number, inputTimes: number, outputTimes: number): Price {
  const above = openAiPrice(input * inputTimes, output * outputTimes, cacheRead * inputTimes);
  return { ...openAiPrice(input, output, cacheRead), longContext: { threshold, above } };
}

/**
 * KNT-205. Dollars for one euro: the reference rate of the European Central Bank on 2026-11-24
 * (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml). The clouds of Europe give their
 * prices in euros, before tax; Kentō counts in dollars.
 */
export const EUR_USD = 1.0963;

/** KNT-205. A price in euros a million tokens, in dollars, rounded to the ten-thousandth. */
function eur(euros: number): number {
  return Math.round(euros * EUR_USD * 10_000) / 10_000;
}

/** KNT-205. openAiPrice, from prices in euros. */
function openAiPriceEur(input: number, output: number, cacheRead: number = input): Price {
  return openAiPrice(eur(input), eur(output), eur(cacheRead));
}

/**
 * KNT-204. The prices of the models of the presets (presets.ts), by the host of the base URL, then
 * by the id of the model. Each host gives the page of its prices and the day it was read.
 */
export const HOST_PRICES: Readonly<Record<string, { url: string; checked: string; models: Readonly<Record<string, Price>> }>> = {
  // The prices of the standard tier. Above 272,000 prompt tokens, the input and the cache cost twice as
  // much, and the output 1.5 times. The price of GPT-5.6 Sol is a promotion until 2026-11-30.
  'api.openai.com': {
    url: 'https://developers.openai.com/api/docs/pricing',
    checked: '2026-11-24',
    models: {
      'gpt-5.6-luna': longOpenAiPrice(272_000, 0.2, 1.2, 0.02, 2, 1.5),
      'gpt-5.6-terra': longOpenAiPrice(272_000, 2, 12, 0.2, 2, 1.5),
      'gpt-5.6-sol': longOpenAiPrice(272_000, 4, 20, 0.4, 2, 1.5),
      'gpt-5.5': longOpenAiPrice(272_000, 5, 30, 0.5, 2, 1.5),
    },
  },
  // The standard tier, with billing. The prices of a change that the page announces are the ones
  // here: Gemini 4 Argon from 2026-12-01, Gemini 3.8 Flash from 2027-01-01.
  'generativelanguage.googleapis.com': {
    url: 'https://aistudio.google.com/docs/pricing.md',
    checked: '2026-11-24',
    models: {
      'gemini-3.5-flash-lite': openAiPrice(0.3, 2.5, 0.03),
      'gemini-3.1-flash-lite': openAiPrice(0.25, 1.5, 0.025),
      'gemini-4-hydrogen': openAiPrice(1.5, 7.5, 0.075),
      'gemini-3.8-flash': openAiPrice(1.5, 7.5, 0.15),
      'gemini-4-neon': openAiPrice(3, 15, 0.15),
      'gemini-4-argon': openAiPrice(4, 20, 0.2),
    },
  },
  // The price of Mistral Large 4 is the one of its announcement: the table of the docs has none yet.
  'api.mistral.ai': {
    url: 'https://docs.mistral.ai/inference/pricing',
    checked: '2026-11-24',
    models: {
      'mistral-small-2603': openAiPrice(0.15, 0.6),
      'ministral-14b-2512': openAiPrice(0.2, 0.2),
      'mistral-large-4': openAiPrice(0.7, 2.1, 0.07),
      'zai-glm-5-3': openAiPrice(1.4, 4.4, 0.14),
    },
  },
  // From 200,000 prompt tokens, every token of the call costs twice as much.
  'api.x.ai': {
    url: 'https://docs.x.ai/docs/models',
    checked: '2026-11-24',
    models: {
      'grok-4.20-0309-non-reasoning': longOpenAiPrice(199_999, 1.25, 2.5, 0.2, 2, 2),
      'grok-4.3': longOpenAiPrice(199_999, 1.25, 2.5, 0.2, 2, 2),
      'grok-4.7': longOpenAiPrice(199_999, 2, 6, 0.5, 2, 2),
      'grok-4.6': longOpenAiPrice(199_999, 2, 6, 0.5, 2, 2),
    },
  },
  'api.together.ai': {
    url: 'https://docs.together.ai/docs/serverless/models.md',
    checked: '2026-11-24',
    models: {
      'zai-org/GLM-5.3-Flash': openAiPrice(0.15, 0.5, 0.03),
      'deepseek-ai/DeepSeek-V4.1-Flash': openAiPrice(0.3, 1.2, 0.006),
      'zai-org/GLM-5.3': openAiPrice(1.4, 4.4, 0.26),
      'deepseek-ai/DeepSeek-V4-Pro-0813': openAiPrice(1.32, 3.96, 0.13),
      'moonshotai/Kimi-K3.1-Pro': openAiPrice(2, 10, 0.2),
      'moonshotai/Kimi-K3': openAiPrice(3, 15, 0.3),
    },
  },
  'api.fireworks.ai': {
    url: 'https://fireworks.ai/pricing',
    checked: '2026-11-24',
    models: {
      'accounts/fireworks/models/glm-5p3-flash': openAiPrice(0.15, 0.5, 0.03),
      'accounts/fireworks/models/deepseek-v4p1-flash': openAiPrice(0.3, 1.2, 0.006),
      'accounts/fireworks/models/glm-5p3': openAiPrice(1.4, 4.4, 0.26),
      'accounts/fireworks/models/kimi-k3p1-pro': openAiPrice(2, 10, 0.2),
      'accounts/fireworks/models/kimi-k3': openAiPrice(3, 15, 0.3),
    },
  },
  'api.groq.com': {
    url: 'https://console.groq.com/docs/model/openai/gpt-oss-120b',
    checked: '2026-11-24',
    models: {
      'openai/gpt-oss-20b': openAiPrice(0.075, 0.3, 0.037),
      'openai/gpt-oss-120b': openAiPrice(0.15, 0.6, 0.075),
    },
  },
  // The list prices: DeepInfra sells some models below them for a time.
  'api.deepinfra.com': {
    url: 'https://deepinfra.com/pricing',
    checked: '2026-11-24',
    models: {
      'deepseek-ai/DeepSeek-V4.1-Flash-1017': openAiPrice(0.2, 0.6, 0.006),
      'zai-org/GLM-5.3-Flash': openAiPrice(0.15, 0.5, 0.03),
      'zai-org/GLM-5.3': openAiPrice(0.9, 4, 0.2),
      'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo': openAiPrice(0.3, 1, 0.1),
      'deepseek-ai/DeepSeek-V4-Pro': openAiPrice(1.3, 2.6, 0.1),
      'moonshotai/Kimi-K3': openAiPrice(2.85, 14.25, 0.285),
    },
  },
  // No discount on a token read from the cache.
  'api.cerebras.ai': {
    url: 'https://inference-docs.cerebras.ai/models/openai-oss',
    checked: '2026-11-24',
    models: {
      'gpt-oss-120b': openAiPrice(0.35, 0.75),
      'qwen-3.8-27b': openAiPrice(0.99, 1.49),
    },
  },
  // KNT-205. In euros before tax. The page refuses robots: these prices are its copy of 2026-11-16
  // on the Wayback Machine. A cached price for three models only; the others have none.
  'api.scaleway.ai': {
    url: 'https://www.scaleway.com/en/pricing/model-as-a-service/',
    checked: '2026-11-16',
    models: {
      'deepseek-v4-flash-0731': openAiPriceEur(0.4, 0.8, 0.08),
      'mistral-small-3.2-24b-instruct-2506': openAiPriceEur(0.15, 0.35),
      'deepseek-v4.1-flash-1017': openAiPriceEur(0.6, 1.8, 0.12),
      'qwen3.6-35b-a3b': openAiPriceEur(0.25, 1.5),
      'glm-5.3': openAiPriceEur(1.8, 5.5),
      'qwen3.5-397b-a17b': openAiPriceEur(0.6, 3.6),
    },
  },
  // KNT-205. In euros, from the page of each model of the catalog. No cached price.
  'oai.endpoints.kepler.ai.cloud.ovh.net': {
    url: 'https://www.ovhcloud.com/en-ie/public-cloud/ai-endpoints/catalog/',
    checked: '2026-11-24',
    models: {
      'gpt-oss-20b': openAiPriceEur(0.04, 0.15),
      'Mistral-Small-3.2-24B-Instruct-2506': openAiPriceEur(0.09, 0.28),
      'qwen3.6-35b-a3b': openAiPriceEur(0.17, 1.15),
      'gpt-oss-120b': openAiPriceEur(0.08, 0.4),
      'Qwen3.5-397B-A17B': openAiPriceEur(0.6, 3.6),
      'DeepSeek-V4.1-Flash-1017': openAiPriceEur(0.27, 1.08),
    },
  },
};

/**
 * The price of a model at a provider, or null when the table does not know it. A server of the API
 * of OpenAI has a price only on the host of a preset (`baseUrl`).
 */
export function priceOf(kind: ProviderKind, model: string, baseUrl?: string | null): Price | null {
  if (kind === 'anthropic') return Object.hasOwn(ANTHROPIC, model) ? ANTHROPIC[model]! : null;
  if (kind !== 'openai_compatible') return null;
  const host = hostOf(baseUrl);
  const table = host !== null && Object.hasOwn(HOST_PRICES, host) ? HOST_PRICES[host]!.models : null;
  return table && Object.hasOwn(table, model) ? table[model]! : null;
}

/**
 * KNT-201. The lowest `longContext.threshold` of these models, in prompt tokens, or null when none of
 * them has one. The models of a level read the same pack, so the lowest threshold sets its size.
 * OpenRouter bills the price of the provider that it routes to: a model `anthropic/<name>` has the
 * threshold of its Anthropic id (`anthropic/claude-haiku-5.5` is `claude-haiku-5-5`).
 */
export function longContextThreshold(kind: ProviderKind, models: readonly string[]): number | null {
  const thresholds = models.flatMap((model) => {
    const id = kind === 'openrouter' && model.startsWith('anthropic/') ? model.slice('anthropic/'.length).replaceAll('.', '-') : model;
    const threshold = kind === 'anthropic' || id !== model ? ANTHROPIC[id]?.longContext?.threshold : undefined;
    return threshold === undefined ? [] : [threshold];
  });
  return thresholds.length ? Math.min(...thresholds) : null;
}

/**
 * Whether a call to this model has a known cost: the provider gives it, the table has it, or it is
 * free (a server on the network of a runner, KNT-205).
 */
export function costKnown(kind: ProviderKind, model: string, baseUrl?: string | null): boolean {
  return kind === 'openrouter' || onRunnerNetwork(kind, baseUrl) || priceOf(kind, model, baseUrl) !== null;
}

/**
 * The tokens of one request. `cacheWrite` is the tokens written with the TTL of 5 minutes, and
 * `cacheWrite1h` those written with the TTL of 1 hour.
 */
export type Tokens = { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number };

/**
 * The cost of one request in dollars, from the table. Null when the table does not know the model.
 * Price each request alone: the tier above `longContext.threshold` reads the prompt of one request.
 */
export function costFromTable(kind: ProviderKind, model: string, tokens: Tokens, baseUrl?: string | null): number | null {
  const price = priceOf(kind, model, baseUrl);
  if (!price) return null;
  const write1h = tokens.cacheWrite1h ?? 0;
  const prompt = tokens.input + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) + write1h;
  const p = price.longContext && prompt > price.longContext.threshold ? price.longContext.above : price;
  const micro =
    tokens.input * p.input +
    tokens.output * p.output +
    (tokens.cacheRead ?? 0) * p.cacheRead +
    (tokens.cacheWrite ?? 0) * p.cacheWrite +
    write1h * p.cacheWrite1h;
  // Tokens times dollars a million tokens: millionths of a dollar. Six decimals, as reviews.cost_usd.
  return Math.round(micro) / 1_000_000;
}
