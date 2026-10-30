// The review as a reader sees it: the inline comments, the body of the review and the block of the description.
import { anchor, deeperReview, diagram, findingKey, isBlocking, score, type Anchors, type Answer, type Finding, type Usage } from './findings.ts';
import type { Level } from '../../protocol/src/index.ts';
import { levelCost } from './levels.ts';

// The markers that the next review reads back in the comments and the description.
export const MARKER_SUMMARY = '<!-- sakuga-review:summary -->';
export const FINDING_KEY = /<!-- sakuga-review:finding ([0-9a-f]{12}) -->/;
export const MARKER_GONE = '<!-- sakuga-review:gone -->';
export const BLOCK_START = '<!-- sakuga-review:start -->';
export const BLOCK_END = '<!-- sakuga-review:end -->';
export const REVIEW_COUNT = /<!-- sakuga-review:count (\d+) -->/;
// The priority that a reader sees: P0 blocks hardest. The colours follow the score labels.
const PRIORITY = { critical: ['P0', 'b60205'], major: ['P1', 'e67e22'], minor: ['P2', '6c757d'] } as const;

const badge = (label: string, colour: string) =>
  `<img alt="${label}" src="https://img.shields.io/badge/${encodeURIComponent(label)}-${colour}?style=flat-square" align="top">`;

function badges(finding: Finding): string {
  const [priority, colour] = PRIORITY[finding.severity];
  return badge(priority, colour) + (finding.category === 'security' ? ` ${badge('sécurité', '8e44ad')}` : '');
}

export function inlineBody(finding: Finding, withSuggestion: boolean): string {
  const out = [`${badges(finding)} **${finding.title}**`, '', finding.scenario, '', `**Correction :** ${finding.fix}`];
  // REV-19. The rule of the repository or of the org that the finding applies.
  if (finding.rule_title) out.splice(1, 0, '', `Règle : « ${finding.rule_title.replace(/\s+/g, ' ').trim()} »`);
  if (withSuggestion) out.push('', '```suggestion', finding.suggestion.replace(/\n$/, ''), '```');
  out.push('', `<!-- sakuga-review:finding ${findingKey(finding)} -->`);
  return out.join('\n');
}

const LEVEL_LABEL: Record<Level, string> = { lite: 'lite', balanced: 'balanced', heavy: 'heavy' };

/**
 * The level, the model and the cost of a review, as the reader sees them. `by` names the service that
 * posts the review (`Kentō`); the Action gives none.
 */
export function costLine(level: Level, usage: Usage, by?: string): string {
  const amount = (value: number) => `${value.toFixed(3).replace('.', ',')} $`;
  const cost =
    usage.cost_source === 'unknown'
      ? ' · coût inconnu (aucun prix pour ce modèle, compté 0 $)'
      : usage.cost_source === 'free'
        ? ` · ${amount(0)} (modèle local)`
        : typeof usage.cost === 'number'
          ? ` · ${amount(usage.cost)}`
          : '';
  return `${by ? `${by} · ` : ''}Niveau \`${LEVEL_LABEL[level]}\` · \`${usage.model ?? '?'}\`${cost}`;
}

/**
 * The service that posts a review: `by` names it, and `handle` is the mention that starts a command
 * (`Kentō`, `@kento-review`). Without it, the review is the one of the Action.
 */
export type Poster = { by: string; handle: string };

// The name and the command of the Action (review/sakuga-review.ts), which gives no poster.
const ACTION = { name: 'Sakuga Review', command: '@sakuga-review review' };

function deeperReviewNote(reason: string, poster?: Poster): string {
  const command = poster?.handle ?? ACTION.command;
  return (
    `**Une review plus poussée est conseillée :** ${reason}\n` +
    `Commentez \`${command} balanced\` (${levelCost('balanced')}) ou \`${command} heavy\` (${levelCost('heavy')}).`
  );
}

export function reviewBody(answer: Answer, lines: Anchors, level: Level, usage: Usage, poster?: Poster): string {
  const blocking = answer.findings.filter((f) => isBlocking(f, lines)).length;
  const head = blocking
    ? `⛔ ${blocking} point${blocking > 1 ? 's' : ''} bloquant${blocking > 1 ? 's' : ''}`
    : answer.findings.length
      ? '⚠️ Rien de bloquant'
      : '✅ Rien de bloquant';
  const deeper = deeperReview(answer, level);
  return (
    `${MARKER_SUMMARY}\n**Score de confiance : ${score(answer, lines)}/5** · ${head} · ${answer.risk}\n\n` +
    (deeper ? `${deeperReviewNote(deeper, poster)}\n\n` : '') +
    `<sub>${costLine(level, usage, poster?.by)} · Le résumé, le diagramme et la liste des constats sont à la fin de la description de la PR.</sub>`
  );
}

export type Link = { finding: Finding; url: string | null };

export function descriptionBlock(
  answer: Answer,
  links: Link[],
  skipped: string[],
  resolved: number,
  usage: Usage,
  lines: Anchors,
  context: { count: number; head: string; subject: string; commitUrl: string; level: Level; poster?: Poster },
): string {
  const out = [BLOCK_START, '', '---', '', `<h2>${context.poster?.by ?? ACTION.name} · Score de confiance : ${score(answer, lines)}/5</h2>`, '', answer.risk, ''];
  const deeper = deeperReview(answer, context.level);
  if (deeper) out.push(deeperReviewNote(deeper, context.poster), '');
  if (links.length) {
    out.push('<h3>Constats</h3>', '');
    links.forEach(({ finding: f, url }, i) => {
      // The line of the thread: the nearest changed line when the model named one outside the diff.
      const line = anchor(f, lines);
      let where = `\`${f.path}:${line ?? f.line}\``;
      // A finding outside the diff has no thread: link the line in the file at the reviewed commit.
      if (line === null && context.commitUrl.startsWith('http')) {
        where = `[${where}](${context.commitUrl.replace('/commit/', '/blob/')}/${f.path.replace(/^\/+/, '')}#L${f.line})`;
      }
      out.push(`${i + 1}. ${badges(f)}&nbsp;**${f.title}** ${where}${url ? ` <a href="${url}">▶</a>` : ''}`);
      // A finding with no thread shows its scenario here: this is the only place it appears.
      if (!url) out.push(`   ${f.scenario} **Correction :** ${f.fix}`);
    });
    out.push('');
  }
  out.push('<details><summary>Résumé</summary>', '', answer.summary, '');
  if (resolved) {
    out.push(`${resolved} constat${resolved > 1 ? 's' : ''} d'une review précédente n'apparai${resolved > 1 ? 'ssent' : 't'} plus : le fil peut être résolu.`, '');
  }
  out.push('</details>', '');
  const flow = diagram(answer);
  if (flow) out.push('<details><summary>Diagramme</summary>', '', '```mermaid', "%%{init: {'theme': 'neutral'}}%%", flow, '```', '</details>', '');
  const notReviewed = [...skipped, ...answer.not_reviewed.filter((n) => !skipped.includes(n))];
  if (notReviewed.length) out.push('<details><summary>Non relu</summary>', '', ...notReviewed.map((n) => `- ${n}`), '', '</details>', '');
  const subject = context.subject.length > 50 ? `${context.subject.slice(0, 47)}...` : context.subject;
  out.push(
    `<sub>Reviews (${context.count}) · Dernier commit relu : [${subject.replace(/[[\]]/g, '')}](${context.commitUrl}) · ${costLine(context.level, usage, context.poster?.by)}</sub>`,
    '',
    `<!-- sakuga-review:count ${context.count} -->`,
    BLOCK_END,
  );
  return out.join('\n');
}

/** The body of the pull request with the block of the review at its end, in place of the earlier one. */
export function withBlock(body: string, block: string): string {
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (start !== -1 && end > start) return body.slice(0, start) + block + body.slice(end + BLOCK_END.length);
  return `${body.replace(/\s+$/, '')}\n\n${block}`;
}
