// The levels of a review: the model, its reasoning, its limits and the context of the pack.
import type { Level, ProviderKind } from '../../protocol/src/index.ts';
import { TOOL_BUDGETS, type ToolBudget } from './tools.ts';

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
  /**
   * REV-104. The model can give a `patch` when a suggestion cannot hold the fix (prompts/patch.md).
   * Not at `lite`: on the bench of REV-104, Haiku gave a patch to half of its P0 and P1, and found
   * no more defects.
   */
  patch: boolean;
  /**
   * REV-68. The budget of the tools `read_file` and `grep`, or none: the model reads the pack only.
   * No level has tools until the bench measures them; `REVIEW_TOOLS=1` gives them for a run.
   */
  tools?: ToolBudget;
};

/**
 * The levels of a review. A push gets `lite`; a person asks for another level with a command.
 *
 * - lite: Claude Haiku 5.5 at medium reasoning answers in 20 to 45 seconds. On
 *   the bench of 2026-10-08 it found as much as GLM-5.3 or more, two to three times faster, with
 *   no failed review. GLM-5.3 takes over when it fails; the price cap keeps GLM-5.3 off the
 *   providers at $1.4 / $4.4, one of which reasons less. The reasoning counts in the output
 *   tokens: at 16,000, a long reasoning left no room for the answer, which came back empty.
 *   The bench measured no gain from the callers at this level (2026-10-04), so lite sends only the
 *   definitions that the change uses: they are small, and they answer what the model otherwise
 *   lists as not reviewed.
 * - balanced: Claude Sonnet 5.5 with the context. On the bench it found a defect in a caller that
 *   GLM-5.3 missed with the same context.
 * - heavy: Claude Opus 5.5 with the context and more reasoning.
 * LEVEL_COST_CENTS gives the cost of each level.
 */
export const LEVELS: Record<Level, LevelConfig> = {
  lite: {
    models: ['anthropic/claude-haiku-5.5', 'z-ai/glm-5.3'],
    timeoutsMs: [180_000, 240_000],
    effort: 'medium',
    maxTokens: 32_000,
    maxPrice: { prompt: 0.5, completion: 3.5 },
    context: 'definitions',
    patch: false,
  },
  balanced: {
    models: ['anthropic/claude-sonnet-5.5'],
    timeoutsMs: [480_000],
    effort: 'medium',
    maxTokens: 24_000,
    maxPrice: { prompt: 3, completion: 15 },
    context: 'full',
    patch: true,
  },
  heavy: {
    models: ['anthropic/claude-opus-5.5'],
    timeoutsMs: [720_000],
    effort: 'high',
    maxTokens: 32_000,
    maxPrice: { prompt: 5, completion: 25 },
    context: 'full',
    patch: true,
  },
};

/**
 * The cost of one review at each level, in US cents: the low end and the high end. The screens, the
 * help of the commands and the body of a review show it. These are the models of LEVELS on OpenRouter:
 * - lite: $0.20 to $0.21 for the 20 pull requests of eval/martian (2026-10-08), so 1 cent a review.
 * - balanced: $0.08 a review in eval/results.md, and 9 to 20 cents on the reviews of our repos.
 * - heavy: 29 to 43 cents on the reviews of our repos. The price of Opus is 5/3 of the price of Sonnet.
 */
export const LEVEL_COST_CENTS: Record<Level, readonly [low: number, high: number]> = {
  lite: [1, 1],
  balanced: [10, 20],
  heavy: [30, 50],
};

/** The cost of one review at a level: "about 1 cent", "10 to 20 cents". */
export function levelCost(level: Level): string {
  const [low, high] = LEVEL_COST_CENTS[level];
  const cents = (n: number) => `${n} cent${n === 1 ? '' : 's'}`;
  return low === high ? `about ${cents(low)}` : `${low} to ${cents(high)}`;
}

/** The variables of the environment that change a level. */
export type LevelEnv = Partial<Record<'REVIEW_MODELS' | 'REVIEW_EFFORT' | 'REVIEW_MAX_TOKENS' | 'REVIEW_TIMEOUT_MS' | 'REVIEW_MAX_PRICE' | 'REVIEW_TOOLS', string>>;

/**
 * The configuration of a level. The bench sets REVIEW_MODELS, REVIEW_EFFORT, REVIEW_MAX_TOKENS,
 * REVIEW_TIMEOUT_MS, REVIEW_MAX_PRICE ("prompt,completion") and REVIEW_TOOLS (1: the tools of
 * REV-68). The caller passes the environment, or nothing for the levels as they are.
 *
 * A number that is not valid throws: before, `REVIEW_MAX_PRICE=1` sent no completion cap and `x`
 * sent NaN, which JSON writes as null, and the call went out with a wrong cap and no message.
 */
export function levelConfig(level: Level, env: LevelEnv = {}): LevelConfig {
  const config = { ...LEVELS[level] };
  if (env.REVIEW_MODELS) config.models = env.REVIEW_MODELS.split(',');
  const effort = env.REVIEW_EFFORT;
  if (effort === 'low' || effort === 'medium' || effort === 'high') config.effort = effort;
  if (env.REVIEW_MAX_TOKENS) {
    const maxTokens = Number(env.REVIEW_MAX_TOKENS);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error(`REVIEW_MAX_TOKENS must be a whole number above 0, not "${env.REVIEW_MAX_TOKENS}"`);
    config.maxTokens = maxTokens;
  }
  if (env.REVIEW_TIMEOUT_MS) {
    const timeoutMs = Number(env.REVIEW_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`REVIEW_TIMEOUT_MS must be a number of milliseconds above 0, not "${env.REVIEW_TIMEOUT_MS}"`);
    config.timeoutsMs = config.models.map(() => timeoutMs);
  }
  if (env.REVIEW_MAX_PRICE) config.maxPrice = readMaxPrice(env.REVIEW_MAX_PRICE);
  if (env.REVIEW_TOOLS === '1') config.tools = { ...TOOL_BUDGETS[level] };
  else if (env.REVIEW_TOOLS && env.REVIEW_TOOLS !== '0') throw new Error(`REVIEW_TOOLS must be 1 (tools) or 0 (none), not "${env.REVIEW_TOOLS}"`);
  return config;
}

/** `prompt,completion`: two numbers of dollars a million tokens, 0 or more (0: free models only). */
function readMaxPrice(value: string): LevelConfig['maxPrice'] {
  const parts = value.split(',').map((part) => part.trim());
  const [prompt, completion] = parts.map(Number);
  const valid = (n: number | undefined, text: string | undefined) => text !== '' && Number.isFinite(n) && n! >= 0;
  if (parts.length !== 2 || !valid(prompt, parts[0]) || !valid(completion, parts[1])) {
    throw new Error(`REVIEW_MAX_PRICE must be "prompt,completion", two numbers of dollars a million tokens (for example "0.5,3.5"), not "${value}"`);
  }
  return { prompt: prompt!, completion: completion! };
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
