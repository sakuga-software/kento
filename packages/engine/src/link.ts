// REV-117. The link of the findings to the rules (REV-19) and to the earlier findings (REV-99).
//
// On the bench of REV-113, a review whose findings gave `rule_id` or `follows` almost never gave an
// applicable suggestion (0/34, 0/35, 1/33 on the P0 and P1 findings, against 9/23 to 13/32 without
// these fields). The review now answers with the plain finding schema, and one small call after it
// gives these links. The review stays valid when this call fails: its findings then have no link.
import type { ProviderKind } from '../../protocol/src/index.ts';
import type { HeldEarlier } from './earlier.ts';
import type { Finding, Usage } from './findings.ts';
import { defaultModels, LEVELS, type LevelConfig } from './levels.ts';
import { askJson, type ModelClient } from './model.ts';
import type { PackedRule } from './rules.ts';

/** The answer of the link call: for a finding of the list, the reference of a rule and of an earlier finding, or null. */
export type Link = { finding: number; rule_id: string | null; follows: string | null; reverses?: string | null };

const REFERENCE = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const LINK_SCHEMA = {
  type: 'object',
  properties: {
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: { finding: { type: 'integer' }, rule_id: REFERENCE, follows: REFERENCE, reverses: REFERENCE },
        required: ['finding', 'rule_id', 'follows', 'reverses'],
        additionalProperties: false,
      },
    },
  },
  required: ['links'],
  additionalProperties: false,
};

/**
 * What the link call did. `none`: the pack holds no rule and no earlier finding, or the review has
 * no finding, and no call went out. `failed`: the findings have no link. `rules` and `follows`: the
 * links of the answer whose finding and reference exist.
 */
export type LinkReport = { status: 'done' | 'failed' | 'none'; rules: number; follows: number; usage: Usage | null; error?: string };

export const NO_LINK: LinkReport = { status: 'none', rules: 0, follows: 0, usage: null };

// A link is a short answer with no thinking: one minute is enough, and a slow call must not hold the review.
const LINK_TIMEOUT_MS = 60_000;
const LINK_MAX_TOKENS = 8_000;

/**
 * The configuration of the link call: the cheapest model of the provider (the model of `lite`), at
 * low effort, with no thinking and no tools. A server of the OpenAI API and Ollama have no default
 * model: the call then uses the models of the review.
 */
export function linkConfig(kind: ProviderKind, review: LevelConfig): LevelConfig {
  const cheapest = defaultModels(kind, 'lite');
  const models = cheapest.length > 0 ? cheapest : [...review.models];
  return {
    models,
    timeoutsMs: models.map(() => LINK_TIMEOUT_MS),
    effort: 'low',
    thinking: false,
    maxTokens: LINK_MAX_TOKENS,
    maxPrice: cheapest.length > 0 ? LEVELS.lite.maxPrice : review.maxPrice,
    context: 'definitions',
    patch: false,
  };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The user message of the link call: the findings, the rules and the earlier findings, as JSON. */
export function linkMessage(findings: readonly Finding[], rules: readonly PackedRule[], earlier: readonly HeldEarlier[]): string {
  const list = findings.map((f, index) => ({ index, path: f.path, line: f.line, category: f.category, title: f.title, scenario: oneLine(f.scenario, 600) }));
  const ruleList = rules.map((r) => ({ ref: r.ref, title: r.title, paths: r.paths, text: oneLine(r.text, 1_500) }));
  const earlierList = earlier.map((e) => ({ ref: e.ref, path: e.path, line: e.line, category: e.category, status: e.status, title: oneLine(e.title, 200) }));
  return (
    `# Findings\n\n${JSON.stringify(list, null, 2)}\n\n` +
    `# Rules\n\n${JSON.stringify(ruleList, null, 2)}\n\n` +
    `# Earlier findings\n\n${JSON.stringify(earlierList, null, 2)}\n`
  );
}

/**
 * The findings with the links of the link call: `rule_id` holds the reference of a rule (`R1`) and
 * `follows` the reference of an earlier finding (`E1`). applyRule (rules.ts) and linkEarlier
 * (earlier.ts) then read these references, as they read the answer of the review before REV-117.
 * A link to a finding or a reference that the lists do not hold is ignored. The first link of a
 * finding wins. Any `rule_id` or `follows` that the findings had before goes.
 */
export async function linkFindings<F extends Finding>(
  client: ModelClient,
  review: LevelConfig,
  findings: readonly F[],
  rules: readonly PackedRule[],
  earlier: readonly HeldEarlier[],
): Promise<{ findings: F[]; report: LinkReport }> {
  const plain = findings.map(({ rule_id: _rule, follows: _follows, reverses: _reverses, ...rest }) => rest as F);
  if (plain.length === 0 || (rules.length === 0 && earlier.length === 0)) return { findings: plain, report: NO_LINK };
  const log = client.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  let links: unknown;
  let usage: Usage;
  try {
    const reply = await askJson<{ links?: unknown }>(client, linkConfig(client.kind ?? 'openrouter', review), 'link.md', linkMessage(plain, rules, earlier), {
      name: 'links',
      schema: LINK_SCHEMA,
    });
    links = reply.answer.links;
    usage = reply.usage;
  } catch (error) {
    log(`the link of the findings to the rules and the earlier findings failed, the findings have no link: ${error}`);
    return { findings: plain, report: { ...NO_LINK, status: 'failed', error: String(error).slice(0, 300) } };
  }
  const ruleRefs = new Map(rules.map((r) => [r.ref.toUpperCase(), r.ref]));
  const earlierRefs = new Map(earlier.map((e) => [e.ref.toUpperCase(), e.ref]));
  // KNT-167. Only a fixed finding has a fix to undo.
  const fixedRefs = new Map(earlier.filter((e) => e.status === 'fixed').map((e) => [e.ref.toUpperCase(), e.ref]));
  const refOf = (refs: Map<string, string>, value: unknown) => (typeof value === 'string' ? refs.get(value.trim().toUpperCase()) : undefined);
  const linked = plain.map((f) => ({ ...f }) as F);
  const ruled = new Set<number>();
  const followed = new Set<number>();
  const reversed = new Set<number>();
  for (const link of Array.isArray(links) ? (links as Partial<Link>[]) : []) {
    const index = link?.finding;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= linked.length) continue;
    const rule = refOf(ruleRefs, link.rule_id);
    if (rule && !ruled.has(index)) {
      ruled.add(index);
      linked[index]!.rule_id = rule;
    }
    const follows = refOf(earlierRefs, link.follows);
    if (follows && !followed.has(index)) {
      followed.add(index);
      linked[index]!.follows = follows;
    }
    const reverses = refOf(fixedRefs, link.reverses);
    if (reverses && !reversed.has(index) && reverses !== linked[index]!.follows) {
      reversed.add(index);
      linked[index]!.reverses = reverses;
    }
  }
  return { findings: linked, report: { status: 'done', rules: ruled.size, follows: followed.size, usage } };
}

/**
 * The usage of the review with the cost of the link call, and its tokens when the usage counts
 * tokens (a review in passes does not). The model, the hashes and the stop reason stay those of the review.
 */
export function withLinkUsage(usage: Usage, report: LinkReport): Usage {
  const link = report.usage;
  if (!link) return usage;
  const add = (a: number | undefined, b: number | undefined) => (a === undefined ? undefined : a + (b ?? 0));
  const prompt = add(usage.prompt_tokens, link.prompt_tokens);
  const completion = add(usage.completion_tokens, link.completion_tokens);
  return {
    ...usage,
    ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
    ...(completion !== undefined ? { completion_tokens: completion } : {}),
    cost: Math.round(((usage.cost ?? 0) + (link.cost ?? 0)) * 1_000_000) / 1_000_000,
  };
}
