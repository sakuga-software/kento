// The review as a reader sees it: the inline comments, the body of the review and the block of the description.
import {
  anchor,
  BLOCKING_CONFIDENCE,
  BLOCKING_SEVERITIES,
  deeperReview,
  diagram,
  findingKey,
  isBlocking,
  score,
  shownPatch,
  toConsider,
  type Anchors,
  type Answer,
  type Finding,
  type Usage,
} from './findings.ts';
import type { Level } from '../../protocol/src/index.ts';
import { levelCost } from './levels.ts';

// The markers that the next review reads back in the comments and the description.
export const MARKER_SUMMARY = '<!-- sakuga-review:summary -->';
export const FINDING_KEY = /<!-- sakuga-review:finding ([0-9a-f]{12}) -->/;
export const MARKER_GONE = '<!-- sakuga-review:gone -->';
/** REV-99. A reply of Kentō in the thread of an earlier finding: the head, and the key of the finding that follows it. */
export const MARKER_VARIANT = /<!-- kento:variant ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{12}) -->/;
export const BLOCK_START = '<!-- sakuga-review:start -->';
export const BLOCK_END = '<!-- sakuga-review:end -->';
export const REVIEW_COUNT = /<!-- sakuga-review:count (\d+) -->/;
/**
 * REV-106. How a text shows an icon:
 * - `{ base }`: the SVG files that the service serves under `base`, in a light and a dark variant;
 * - `text`: the alt text, or nothing when the text next to the icon says the same (the service without
 *   a public URL);
 * - `emoji`: an emoji (the Action has no host for the files).
 */
export type Icons = { base: string } | 'text' | 'emoji';

/** The version in the names of the files. GitHub keeps an image in its cache under its URL. */
export const ICON_VERSION = 2;

// `emoji`: the icon of a state that the text next to it names. In `text`, it shows nothing.
type IconSpec = { alt: string; emoji?: string };

const ICON = {
  p0: { alt: 'P0' },
  p1: { alt: 'P1' },
  p2: { alt: 'P2' },
  security: { alt: 'security' },
  'to-check': { alt: 'to check' },
  'to-consider': { alt: 'to consider' },
  blocking: { alt: 'Blocking', emoji: '⛔' },
  warning: { alt: 'To check', emoji: '⚠️' },
  ok: { alt: 'Nothing blocking', emoji: '✅' },
  thread: { alt: 'Thread' },
  resolved: { alt: 'Resolved', emoji: '✅' },
  'to-resolve': { alt: 'To resolve', emoji: '☑️' },
  'stays-open': { alt: 'Stays open', emoji: '💬' },
} satisfies Record<string, IconSpec>;

export type IconName = keyof typeof ICON;

/** The names of the files that the service serves under public/assets/pr, each in a light and a dark variant. */
export const ICON_FILES = [...Object.keys(ICON), ...[1, 2, 3, 4, 5].map((n) => `gauge-${n}`)];

function picture(base: string, file: string, alt: string, height = 20): string {
  const url = (suffix: string) => `${base}${file}${suffix}.v${ICON_VERSION}.svg`;
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${url('-dark')}"><img alt="${alt}" src="${url('')}" height="${height}" align="top"></picture>`;
}

/** The icon `name` in the style of `icons`. A label icon (a priority, a mark) gives its alt as text. */
export function icon(name: IconName, icons: Icons): string {
  const spec: IconSpec = ICON[name];
  if (typeof icons === 'object') return picture(icons.base, name, spec.alt);
  if (spec.emoji) return icons === 'emoji' ? spec.emoji : '';
  return `\`${spec.alt}\``;
}

/** The icon, a space, then `text`; `text` alone when the icon shows nothing. */
export function withIcon(name: IconName, icons: Icons, text: string): string {
  const mark = icon(name, icons);
  return mark ? `${mark} ${text}` : text;
}

/** The height of the gauge image: one line of the h2 of the block. */
const GAUGE_HEIGHT = 26;

/** REV-106. The gauge of the score next to its text, which an agent reads. */
function scoreTitle(value: number, icons: Icons): string {
  const text = `Confidence score: ${value}/5`;
  return typeof icons === 'object' ? `${text} ${picture(icons.base, `gauge-${value}`, `${value}/5`, GAUGE_HEIGHT)}` : text;
}

const PRIORITY = { critical: 'p0', major: 'p1', minor: 'p2' } as const;

function badges(finding: Finding, icons: Icons): string {
  return icon(PRIORITY[finding.severity], icons) + (finding.category === 'security' ? ` ${icon('security', icons)}` : '');
}

/**
 * REV-103. The mark of a P0 or P1 that has a thread but does not block: "to consider" for a
 * finding to consider (REV-100), "to check" below the blocking confidence.
 */
function threadMark(finding: Finding, icons: Icons): string {
  if (!BLOCKING_SEVERITIES.has(finding.severity)) return '';
  if (toConsider(finding)) return ` ${icon('to-consider', icons)}`;
  return finding.confidence < BLOCKING_CONFIDENCE ? ` ${icon('to-check', icons)}` : '';
}

/** The length of the short id of a finding that a reader sees, and gives to `@kento-review reject`. */
export const SHORT_ID_LENGTH = 6;

/**
 * REV-93. The short id of a finding as a reader sees it, `#3cf454`: the start of its key. A person
 * names the finding by it in `@kento-review reject #3cf454 <cause>`.
 */
export function shortId(finding: Finding): string {
  return `#${findingKey(finding).slice(0, SHORT_ID_LENGTH)}`;
}

/** The mention that starts a command when the caller gives none: the first name of the service. */
const DEFAULT_HANDLE = '@kento-review';

/**
 * The comment of a finding. `docsUrl`: the page of the commands of the service (REV-96), linked in
 * the footer with the `reject` command of `handle`; the Action gives none.
 */
export function inlineBody(
  finding: Finding,
  withSuggestion: boolean,
  docsUrl?: string | null,
  icons: Icons = 'emoji',
  handle: string = DEFAULT_HANDLE,
): string {
  const out = [`${badges(finding, icons)}${threadMark(finding, icons)} **${finding.title}** \`${shortId(finding)}\``, '', finding.scenario, '', `**Fix:** ${finding.fix}`];
  // REV-19. The rule of the repository or of the org that the finding applies.
  if (finding.rule_title) out.splice(1, 0, '', `Rule: "${finding.rule_title.replace(/\s+/g, ' ').trim()}"`);
  const patch = shownPatch(finding);
  if (withSuggestion) out.push('', '```suggestion', finding.suggestion.replace(/\n$/, ''), '```');
  else if (patch) out.push('', '```diff', patch, '```');
  if (docsUrl) out.push('', `<sub>Wrong finding? Reply \`${handle} reject <cause>\` in this thread. [Kentō commands](${docsUrl})</sub>`);
  out.push('', `<!-- sakuga-review:finding ${findingKey(finding)} -->`);
  return out.join('\n');
}

/**
 * REV-103. The comment at the level of the file of a P0 or P1 outside the diff: GitHub has no line
 * of the diff for it. `lineUrl` links the lines of the finding at the reviewed commit.
 */
export function fileCommentBody(
  finding: Finding,
  lineUrl: string,
  docsUrl?: string | null,
  icons: Icons = 'emoji',
  handle: string = DEFAULT_HANDLE,
): string {
  const lines = finding.start_line && finding.start_line < finding.line ? `${finding.start_line}-${finding.line}` : `${finding.line}`;
  return `Outside the diff of the PR: [\`${finding.path.replace(/^\/+/, '')}:${lines}\`](${lineUrl})\n\n${inlineBody(finding, false, docsUrl, icons, handle)}`;
}

/**
 * REV-99. The reply of Kentō in the thread of an earlier finding, when a review finds that defect
 * again: in other words, or what a fix left of it. `was`: the status of the earlier finding.
 */
export function variantReplyBody(
  finding: Finding,
  head: string,
  was: 'open' | 'fixed' | 'dismissed' | 'wontfix' | 'stale',
  icons: Icons = 'emoji',
): string {
  const at = `\`${head.slice(0, 9)}\``;
  const lead =
    was === 'fixed'
      ? `This finding comes back at commit ${at}. The fix did not remove all of it.`
      : was === 'dismissed' || was === 'wontfix'
        ? `The file changed after this finding was dismissed, and the review of commit ${at} still finds it.`
        : `The review of commit ${at} still finds this finding.`;
  return [
    lead,
    '',
    `${badges(finding, icons)} **${finding.title}** \`${shortId(finding)}\``,
    '',
    finding.scenario,
    '',
    `**Fix:** ${finding.fix}`,
    '',
    `<!-- kento:variant ${head} ${findingKey(finding)} -->`,
  ].join('\n');
}

const LEVEL_LABEL: Record<Level, string> = { lite: 'lite', balanced: 'balanced', heavy: 'heavy' };

/**
 * The level, the model and the cost of a review, as the reader sees them. `by` names the service that
 * posts the review (`Kentō`); the Action gives none.
 */
export function costLine(level: Level, usage: Usage, by?: string): string {
  const amount = (value: number) => `$${value.toFixed(3)}`;
  const cost =
    usage.cost_source === 'unknown'
      ? ' · unknown cost (no price for this model, counted as $0)'
      : usage.cost_source === 'free'
        ? ` · ${amount(0)} (local model)`
        : typeof usage.cost === 'number'
          ? ` · ${amount(usage.cost)}`
          : '';
  return `${by ? `${by} · ` : ''}Level \`${LEVEL_LABEL[level]}\` · \`${usage.model ?? '?'}\`${cost}`;
}

/**
 * The service that posts a review: `by` names it, and `handle` is the mention that starts a command
 * (`Kentō`, `@kento-review`). Without it, the review is the one of the Action, with emojis.
 */
export type Poster = { by: string; handle: string; icons: Icons };

// The name and the command of the Action (review/sakuga-review.ts), which gives no poster.
const ACTION = { name: 'Sakuga Review', command: '@sakuga-review review' };

function deeperReviewNote(reason: string, poster?: Poster): string {
  const command = poster?.handle ?? ACTION.command;
  return (
    `${withIcon('warning', poster?.icons ?? 'emoji', `**A deeper review is advised:** ${reason}`)}\n` +
    `Comment \`${command} balanced\` (${levelCost('balanced')}) or \`${command} heavy\` (${levelCost('heavy')}).`
  );
}

/**
 * REV-106. The P0 and P1 that have a thread and do not block: "to check" below the blocking
 * confidence or outside the diff, and "to consider" when `raised` (REV-103).
 */
export function toCheck(answer: Answer, lines: Anchors, raised: boolean): number {
  return answer.findings.filter((f) => BLOCKING_SEVERITIES.has(f.severity) && !isBlocking(f, lines) && (raised || !toConsider(f))).length;
}

/**
 * The head of a review, in this order:
 * 1. a finding blocks: `N blocking issues`;
 * 2. else a P0 or P1 asks a person to look (`toCheck`): `N issues to check`;
 * 3. else `Nothing blocking`, also with P2 findings.
 */
function reviewHead(answer: Answer, lines: Anchors, raised: boolean, icons: Icons): string {
  const blocking = answer.findings.filter((f) => isBlocking(f, lines)).length;
  if (blocking) return withIcon('blocking', icons, `${blocking} blocking issue${blocking === 1 ? '' : 's'}`);
  const checks = toCheck(answer, lines, raised);
  if (checks) return withIcon('warning', icons, `${checks} issue${checks === 1 ? '' : 's'} to check`);
  return withIcon('ok', icons, 'Nothing blocking');
}

/** `raised`: the P0 and P1 to consider of the review have a thread (REV-103). */
export function reviewBody(answer: Answer, lines: Anchors, level: Level, usage: Usage, poster?: Poster, raised = false): string {
  const head = reviewHead(answer, lines, raised, poster?.icons ?? 'emoji');
  const deeper = deeperReview(answer, level);
  return (
    `${MARKER_SUMMARY}\n**Confidence score: ${score(answer, lines)}/5** · ${head} · ${answer.risk}\n\n` +
    (deeper ? `${deeperReviewNote(deeper, poster)}\n\n` : '') +
    `<sub>${costLine(level, usage, poster?.by)} · The summary, the diagram and the list of findings are at the end of the PR description.</sub>`
  );
}

export type Link = { finding: Finding; url: string | null };

/** REV-105. The commands of the service, as facts: the line says what exists, not when to use it. */
function commandsLine({ by, handle }: Poster, docsUrl: string): string {
  return (
    `<sub>${by} commands: \`${handle} [lite|balanced|heavy]\` · \`${handle} resolve\` · ` +
    `\`${handle} reject <cause>\` (in a thread) or \`reject #<id> <cause>\` · \`${handle} feedback <opinion>\` · ` +
    `[${by} commands](${docsUrl})</sub>`
  );
}

export function descriptionBlock(
  answer: Answer,
  links: Link[],
  skipped: string[],
  resolved: number,
  usage: Usage,
  lines: Anchors,
  /**
   * `reusedFrom`: REV-89, the head of the review that this block shows again, when no reviewed file
   * changed since it.
   */
  context: {
    count: number;
    head: string;
    subject: string;
    commitUrl: string;
    level: Level;
    poster?: Poster;
    reusedFrom?: string;
    /** REV-88. The review read only the files that changed since this head. */
    delta?: { since: string; files: number };
    /** REV-105. The page of the commands. Without it, or without a poster, the block lists no command. */
    docsUrl?: string | null;
  },
): string {
  const icons = context.poster?.icons ?? 'emoji';
  const out = [BLOCK_START, '', '---', '', `<h2>${context.poster?.by ?? ACTION.name} · ${scoreTitle(score(answer, lines), icons)}</h2>`, '', answer.risk, ''];
  const deeper = deeperReview(answer, context.level);
  if (deeper) out.push(deeperReviewNote(deeper, context.poster), '');
  const item = ({ finding: f, url }: Link, i: number) => {
    // The line of the thread: the nearest changed line when the model named one outside the diff.
    const line = anchor(f, lines);
    let where = `\`${f.path}:${line ?? f.line}\``;
    // A finding outside the diff has no line in the diff: link the line in the file at the reviewed commit.
    if (line === null && context.commitUrl.startsWith('http')) {
      where = `[${where}](${context.commitUrl.replace('/commit/', '/blob/')}/${f.path.replace(/^\/+/, '')}#L${f.line})`;
    }
    out.push(`${i + 1}. ${badges(f, icons)}&nbsp;**${f.title}** \`${shortId(f)}\` ${where}${url ? ` <a href="${url}">${icons === 'emoji' ? '▶' : icon('thread', icons)}</a>` : ''}`);
    // A finding with no thread shows its scenario here: this is the only place it appears.
    if (!url) out.push(`   ${f.scenario} **Fix:** ${f.fix}`);
    const patch = url ? null : shownPatch(f);
    if (patch) out.push('', '   <details><summary>Fix</summary>', '', '   ```diff', ...patch.split('\n').map((row) => `   ${row}`), '   ```', '   </details>', '');
  };
  // REV-100. The new findings on code that an earlier review already read go in a list of their own.
  const main = links.filter((l) => !toConsider(l.finding));
  const considered = links.filter((l) => toConsider(l.finding));
  if (main.length) {
    out.push('<h3>Findings</h3>', '');
    main.forEach(item);
    out.push('');
  }
  if (considered.length) {
    out.push(
      '<h3>To consider (code already reviewed)</h3>',
      '',
      'These findings are on code that an earlier review already read, and that did not change since. They do not block the PR.',
      '',
    );
    considered.forEach(item);
    out.push('');
  }
  out.push('<details><summary>Summary</summary>', '', answer.summary, '');
  if (resolved) {
    out.push(
      resolved === 1
        ? '1 finding of an earlier review does not show anymore. Its thread can be resolved.'
        : `${resolved} findings of an earlier review do not show anymore. Their threads can be resolved.`,
      '',
    );
  }
  out.push('</details>', '');
  const flow = diagram(answer);
  if (flow) out.push('<details><summary>Diagram</summary>', '', '```mermaid', "%%{init: {'theme': 'neutral'}}%%", flow, '```', '</details>', '');
  const notReviewed = [...skipped, ...answer.not_reviewed.filter((n) => !skipped.includes(n))];
  if (notReviewed.length) out.push('<details><summary>Not reviewed</summary>', '', ...notReviewed.map((n) => `- ${n}`), '', '</details>', '');
  if (context.delta) {
    const files =
      context.delta.files === 1
        ? `it read the file of the PR that changed since commit \`${context.delta.since.slice(0, 9)}\``
        : `it read the ${context.delta.files} files of the PR that changed since commit \`${context.delta.since.slice(0, 9)}\``;
    out.push(
      `<sub>Incremental review: ${files}. The findings of the other files come from the review of that commit.</sub>`,
      '',
    );
  }
  if (context.reusedFrom) {
    out.push(
      `<sub>No reviewed file changed since commit \`${context.reusedFrom.slice(0, 9)}\`. Its review applies to this commit, with no new model call.</sub>`,
      '',
    );
  }
  const subject = context.subject.length > 50 ? `${context.subject.slice(0, 47)}...` : context.subject;
  out.push(
    `<sub>Reviews (${context.count}) · Last reviewed commit: [${subject.replace(/[[\]]/g, '')}](${context.commitUrl}) · ${costLine(context.level, usage, context.poster?.by)}</sub>`,
    '',
  );
  if (context.poster && context.docsUrl) out.push(commandsLine(context.poster, context.docsUrl), '');
  out.push(`<!-- sakuga-review:count ${context.count} -->`, BLOCK_END);
  return out.join('\n');
}

/** The body of the pull request with the block of the review at its end, in place of the earlier one. */
export function withBlock(body: string, block: string): string {
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (start !== -1 && end > start) return body.slice(0, start) + block + body.slice(end + BLOCK_END.length);
  return `${body.replace(/\s+$/, '')}\n\n${block}`;
}
