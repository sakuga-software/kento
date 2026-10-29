// The levels of a review: the model, its reasoning, its limits and the context of the pack.
import type { ProviderKind } from './providers.ts';

export type Level = 'lite' | 'balanced' | 'heavy';
export type ContextKind = 'full' | 'definitions';
export type LevelConfig = {
  /** The model that answers, then the one that takes over when it fails. */
  models: string[];
  /** The time limit of each attempt, in the order of `models`. */
  timeoutsMs: number[];
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  /** The most a provider can charge, in dollars a million tokens. */
  maxPrice: { prompt: number; completion: number };
  /**
   * The code around the change that the pack holds (see buildContext): `full` adds the callers of
   * the changed code, `definitions` only the definitions that the change uses and the SQL names.
   */
  context: ContextKind;
};

/**
 * The levels of a review. A push gets `lite`; a person asks for another level with a command.
 *
 * - lite: Claude Haiku 5.5 at medium reasoning answers in 20 to 45 seconds for about 1 cent. On
 *   the bench of 2026-10-08 it found as much as GLM-5.3 or more, two to three times faster, with
 *   no failed review. GLM-5.3 takes over when it fails; the price cap keeps GLM-5.3 off the
 *   providers at $1.4 / $4.4, one of which reasons less. The reasoning counts in the output
 *   tokens: at 16,000, a long reasoning left no room for the answer, which came back empty.
 *   The bench measured no gain from the callers at this level (2026-10-04), so lite sends only the
 *   definitions that the change uses: they are small, and they answer what the model otherwise
 *   lists as not reviewed.
 * - balanced: Claude Sonnet 5.5 with the context, about 5 cents. On the bench it found a defect
 *   in a caller that GLM-5.3 missed with the same context.
 * - heavy: Claude Opus 5.5 with the context and more reasoning, about 10 to 50 cents.
 */
export const LEVELS: Record<Level, LevelConfig> = {
  lite: {
    models: ['anthropic/claude-haiku-5.5', 'z-ai/glm-5.3'],
    timeoutsMs: [180_000, 240_000],
    effort: 'medium',
    maxTokens: 32_000,
    maxPrice: { prompt: 0.5, completion: 3.5 },
    context: 'definitions',
  },
  balanced: {
    models: ['anthropic/claude-sonnet-5.5'],
    timeoutsMs: [480_000],
    effort: 'medium',
    maxTokens: 24_000,
    maxPrice: { prompt: 3, completion: 15 },
    context: 'full',
  },
  heavy: {
    models: ['anthropic/claude-opus-5.5'],
    timeoutsMs: [720_000],
    effort: 'high',
    maxTokens: 32_000,
    maxPrice: { prompt: 5, completion: 25 },
    context: 'full',
  },
};

/** The variables of the environment that change a level. */
export type LevelEnv = Partial<Record<'REVIEW_MODELS' | 'REVIEW_EFFORT' | 'REVIEW_MAX_TOKENS' | 'REVIEW_TIMEOUT_MS' | 'REVIEW_MAX_PRICE', string>>;

/**
 * The configuration of a level. The bench sets REVIEW_MODELS, REVIEW_EFFORT, REVIEW_MAX_TOKENS,
 * REVIEW_TIMEOUT_MS and REVIEW_MAX_PRICE ("prompt,completion"). The caller passes the environment, or
 * nothing for the levels as they are.
 */
export function levelConfig(level: Level, env: LevelEnv = {}): LevelConfig {
  const config = { ...LEVELS[level] };
  if (env.REVIEW_MODELS) config.models = env.REVIEW_MODELS.split(',');
  const effort = env.REVIEW_EFFORT;
  if (effort === 'low' || effort === 'medium' || effort === 'high') config.effort = effort;
  if (env.REVIEW_MAX_TOKENS) config.maxTokens = Number(env.REVIEW_MAX_TOKENS);
  if (env.REVIEW_TIMEOUT_MS) config.timeoutsMs = config.models.map(() => Number(env.REVIEW_TIMEOUT_MS));
  if (env.REVIEW_MAX_PRICE) {
    const [prompt, completion] = env.REVIEW_MAX_PRICE.split(',').map(Number);
    config.maxPrice = { prompt: prompt!, completion: completion! };
  }
  return config;
}

export function isLevel(value: string | undefined): value is Level {
  return value === 'lite' || value === 'balanced' || value === 'heavy';
}

/**
 * The models of a level at Anthropic, by their own ids: the same family as on OpenRouter, without
 * GLM. A server of the OpenAI API and Ollama have no default: their admin names the models.
 */
const ANTHROPIC_MODELS: Record<Level, string[]> = {
  lite: ['claude-haiku-5-5'],
  balanced: ['claude-sonnet-5-5'],
  heavy: ['claude-opus-5-5'],
};

/** The models of a level at a provider when its admin names none. Empty: the admin must name them. */
export function defaultModels(kind: ProviderKind, level: Level): string[] {
  if (kind === 'openrouter') return [...LEVELS[level].models];
  if (kind === 'anthropic') return [...ANTHROPIC_MODELS[level]];
  return [];
}

/**
 * The configuration of a level for a provider: the models that the job names, or the default
 * models of the provider. The time limits follow the models: the last one repeats.
 */
export function providerLevelConfig(level: Level, kind: ProviderKind, models?: readonly string[], env: LevelEnv = {}): LevelConfig {
  const config = levelConfig(level, env);
  if (env.REVIEW_MODELS) return config;
  const chosen = models && models.length > 0 ? [...models] : defaultModels(kind, level);
  config.timeoutsMs = chosen.map((_, i) => config.timeoutsMs[i] ?? config.timeoutsMs.at(-1)!);
  config.models = chosen;
  return config;
}
