/**
 * The engine of Sakuga Review: the pack of a pull request, the model call, the findings and the
 * review as a reader sees it. It reads a checkout with git and calls the model through a provider
 * (OpenRouter, Anthropic, a server of the OpenAI API, or Ollama); it never calls GitHub. The Action (review/sakuga-review.ts), the bench (eval/martian) and the
 * runner call it.
 *
 * Node 26 or later runs this code as is: no build. Keep to erasable TypeScript syntax, and import
 * with the `.ts` extension. The Action imports it by its relative path, with no install: so the
 * engine imports packages/protocol (the levels, the providers, the severities) by its relative path too.
 */
export { git } from './git.ts';
export { fileChangedSince } from './history.ts';
export { levelConfig, providerLevelConfig, type LevelConfig } from './levels.ts';
export { ProviderError } from './providers.ts';
export {
  anchor,
  findingKey,
  isBlocking,
  score,
  suggestionRange,
  verdict,
  type Answer,
  type ChangedLines,
  type Finding,
  type Usage,
} from './findings.ts';
export { buildPack } from './pack.ts';
export { askJson } from './model.ts';
export { costLine, descriptionBlock, FINDING_KEY, inlineBody, MARKER_GONE, REVIEW_COUNT, reviewBody, withBlock, type Link } from './render.ts';
export { markerResolve, RESOLVE_SCHEMA, resolvePack, type OpenThread, type ThreadVerdict } from './resolve.ts';
export { mergeBase, reviewPullRequest, type ReviewResult } from './review.ts';
// The Action (review/sakuga-review.ts) imports these from the engine by their old names. They go away
// with it (REV-24); the apps import them from packages/protocol.
export {
  isLevel,
  MAX_RESOLVE_PACK_BYTES,
  MAX_RESOLVE_THREADS as MAX_THREADS,
  SEVERITIES as SEVERITY_ORDER,
  type Level,
} from '../../protocol/src/index.ts';
