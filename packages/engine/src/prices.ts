// The prices of the models whose provider does not give the cost of a call, and the cost of a call
// from its tokens. OpenRouter gives the cost in its answer; Ollama runs on a machine of the runner and
// costs nothing. A model that is not here costs 0, and the review says that its cost is not known.
import type { ProviderKind } from '../../protocol/src/index.ts';

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

/** The price of a model at a provider, or null when the table does not know it. */
export function priceOf(kind: ProviderKind, model: string): Price | null {
  if (kind === 'anthropic') return ANTHROPIC[model] ?? null;
  return null;
}

/** Whether a call to this model has a known cost: the provider gives it, the table has it, or it is free. */
export function costKnown(kind: ProviderKind, model: string): boolean {
  return kind === 'openrouter' || kind === 'ollama' || priceOf(kind, model) !== null;
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
export function costFromTable(kind: ProviderKind, model: string, tokens: Tokens): number | null {
  const price = priceOf(kind, model);
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
