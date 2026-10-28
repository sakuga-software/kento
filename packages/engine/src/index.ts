/**
 * The engine of Sakuga Review: the pack of a pull request, the model call, the findings and the
 * review as a reader sees it. It reads a checkout with git and calls the model through OpenRouter;
 * it never calls GitHub. The Action (review/sakuga-review.ts), the bench (eval/martian) and the
 * runner call it.
 *
 * Node 24 or later runs this code as is: no build. Keep to erasable TypeScript syntax, and import
 * with the `.ts` extension. The Action imports it by its relative path, with no install.
 */
export { git } from './git.ts';
export { diffStart, fileChangedSince, fileDiff, inHistory } from './history.ts';
export { isLevel, LEVELS, levelConfig, type ContextKind, type Level, type LevelConfig, type LevelEnv } from './levels.ts';
export {
  anchor,
  ANSWER_SCHEMA,
  CATEGORIES,
  changedLines,
  deeperReview,
  diagram,
  findingKey,
  isBlocking,
  score,
  SEVERITY_ORDER,
  suggestionRange,
  verdict,
  type Answer,
  type Anchors,
  type ChangedLines,
  type Finding,
  type Severity,
  type Usage,
} from './findings.ts';
export { buildContext, buildPack } from './pack.ts';
export { askJson, askModel, OPENROUTER_BASE_URL, type ModelClient, type Reply, type Schema } from './model.ts';
export {
  BLOCK_END,
  BLOCK_START,
  costLine,
  descriptionBlock,
  FINDING_KEY,
  inlineBody,
  MARKER_GONE,
  MARKER_SUMMARY,
  REVIEW_COUNT,
  reviewBody,
  withBlock,
  type Link,
} from './render.ts';
export {
  cleanBody,
  markerResolve,
  MAX_RESOLVE_PACK_BYTES,
  MAX_THREADS,
  RESOLVE_SCHEMA,
  resolvePack,
  type OpenThread,
  type ThreadComment,
  type ThreadVerdict,
} from './resolve.ts';
export { mergeBase, reviewPullRequest, type ReviewedFinding, type ReviewInput, type ReviewResult } from './review.ts';
