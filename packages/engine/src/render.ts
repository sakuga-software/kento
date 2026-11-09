// The review as a reader sees it: the inline comments, the body of the review and the block of the description.
import { anchor, deeperReview, diagram, findingKey, isBlocking, score, toConsider, type Anchors, type Answer, type Finding, type Usage } from './findings.ts';
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
// The priority that a reader sees: P0 blocks hardest. The colours follow the score labels.
const PRIORITY = { critical: ['P0', 'b60205'], major: ['P1', 'e67e22'], minor: ['P2', '6c757d'] } as const;

const badge = (label: string, colour: string) =>
  `<img alt="${label}" src="https://img.shields.io/badge/${encodeURIComponent(label)}-${colour}?style=flat-square" align="top">`;

function badges(finding: Finding): string {
  const [priority, colour] = PRIORITY[finding.severity];
  return badge(priority, colour) + (finding.category === 'security' ? ` ${badge('sécurité', '8e44ad')}` : '');
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

/**
 * The comment of a finding. `docsUrl`: the page of the commands of the service (REV-96), linked in
 * the footer; the Action gives none.
 */
export function inlineBody(finding: Finding, withSuggestion: boolean, docsUrl?: string | null): string {
  const out = [`${badges(finding)} **${finding.title}** \`${shortId(finding)}\``, '', finding.scenario, '', `**Correction :** ${finding.fix}`];
  // REV-19. The rule of the repository or of the org that the finding applies.
  if (finding.rule_title) out.splice(1, 0, '', `Règle : « ${finding.rule_title.replace(/\s+/g, ' ').trim()} »`);
  if (withSuggestion) out.push('', '```suggestion', finding.suggestion.replace(/\n$/, ''), '```');
  if (docsUrl) out.push('', `<sub>Constat faux : \`@kento-review reject <cause>\` en réponse dans ce fil. [Les commandes de Kentō](${docsUrl})</sub>`);
  out.push('', `<!-- sakuga-review:finding ${findingKey(finding)} -->`);
  return out.join('\n');
}

/**
 * REV-99. The reply of Kentō in the thread of an earlier finding, when a review finds that defect
 * again: in other words, or what a fix left of it. `was`: the status of the earlier finding.
 */
export function variantReplyBody(finding: Finding, head: string, was: 'open' | 'fixed' | 'dismissed' | 'wontfix' | 'stale'): string {
  const at = `\`${head.slice(0, 9)}\``;
  const lead =
    was === 'fixed'
      ? `Ce constat revient au commit ${at}. Le correctif ne l'a pas réglé en entier.`
      : was === 'dismissed' || was === 'wontfix'
        ? `Le fichier a changé depuis la mise à l'écart de ce constat, et la review du commit ${at} le trouve encore.`
        : `La review du commit ${at} trouve encore ce constat.`;
  return [
    lead,
    '',
    `${badges(finding)} **${finding.title}** \`${shortId(finding)}\``,
    '',
    finding.scenario,
    '',
    `**Correction :** ${finding.fix}`,
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
  },
): string {
  const out = [BLOCK_START, '', '---', '', `<h2>${context.poster?.by ?? ACTION.name} · Score de confiance : ${score(answer, lines)}/5</h2>`, '', answer.risk, ''];
  const deeper = deeperReview(answer, context.level);
  if (deeper) out.push(deeperReviewNote(deeper, context.poster), '');
  const item = ({ finding: f, url }: Link, i: number) => {
    // The line of the thread: the nearest changed line when the model named one outside the diff.
    const line = anchor(f, lines);
    let where = `\`${f.path}:${line ?? f.line}\``;
    // A finding outside the diff has no thread: link the line in the file at the reviewed commit.
    if (line === null && context.commitUrl.startsWith('http')) {
      where = `[${where}](${context.commitUrl.replace('/commit/', '/blob/')}/${f.path.replace(/^\/+/, '')}#L${f.line})`;
    }
    out.push(`${i + 1}. ${badges(f)}&nbsp;**${f.title}** \`${shortId(f)}\` ${where}${url ? ` <a href="${url}">▶</a>` : ''}`);
    // A finding with no thread shows its scenario here: this is the only place it appears.
    if (!url) out.push(`   ${f.scenario} **Correction :** ${f.fix}`);
  };
  // REV-100. The new findings on code that an earlier review already read go in a list of their own.
  const main = links.filter((l) => !toConsider(l.finding));
  const considered = links.filter((l) => toConsider(l.finding));
  if (main.length) {
    out.push('<h3>Constats</h3>', '');
    main.forEach(item);
    out.push('');
  }
  if (considered.length) {
    out.push(
      '<h3>À considérer (code déjà relu)</h3>',
      '',
      "Ces constats portent sur du code qu'une review précédente a déjà relu, et qui n'a pas changé depuis. Ils ne bloquent pas la PR.",
      '',
    );
    considered.forEach(item);
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
  if (context.delta) {
    const files =
      context.delta.files > 1 ? `les ${context.delta.files} fichiers de la PR modifiés depuis le commit \`${context.delta.since.slice(0, 9)}\` ont été relus` : `le fichier de la PR modifié depuis le commit \`${context.delta.since.slice(0, 9)}\` a été relu`;
    out.push(
      `<sub>Review incrémentale : ${files} ; les constats des autres fichiers viennent de la review de ce commit.</sub>`,
      '',
    );
  }
  if (context.reusedFrom) {
    out.push(
      `<sub>Aucun fichier relu n'a changé depuis le commit \`${context.reusedFrom.slice(0, 9)}\` : sa review vaut pour ce commit, sans nouvel appel au modèle.</sub>`,
      '',
    );
  }
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
