/**
 * The engine of Sakuga Review: the pack of a pull request, the model call, the findings and the
 * review as a reader sees it. It reads a checkout with git and calls the model through a provider
 * (OpenRouter, Anthropic, a server of the OpenAI API, or Ollama); it never calls GitHub. The bench
 * (eval/martian) and the runner call it.
 *
 * Node 26 or later runs this code as is: no build. Keep to erasable TypeScript syntax, and import
 * with the `.ts` extension. A script that imports the engine by its relative path runs with no
 * install: so the engine imports packages/protocol (the levels, the providers, the severities) by
 * its relative path too.
 */
export { fileChangedSince } from './history.ts';
export { levelConfig, providerLevelConfig, type LevelConfig } from './levels.ts';
export { ProviderError } from './providers.ts';
export { findingKey, type Answer, type Finding, type Usage } from './findings.ts';
export { askJson } from './model.ts';
export { RESOLVE_SCHEMA, resolvePack, type OpenThread, type ThreadVerdict } from './resolve.ts';
export { mergeBase, reviewPullRequest, reviewUnlessUnchanged, type ReviewResult, type UnchangedReview } from './review.ts';
export { reviewInPasses, type Pass, type PassesResult, type PassReport } from './passes.ts';
export { isLevel, type Level } from '../../protocol/src/index.ts';
