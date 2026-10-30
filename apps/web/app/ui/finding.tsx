import type { Handle, RemixNode } from 'remix/component'

import type { FindingEventType, Page } from '../findings/store.ts'
import type { CodeExcerpt, CodeRead, FindingDetail, HistoryEvent } from '../pulls/finding.ts'
import { STATUS_LABELS } from '../pulls/sheet.ts'
import { pageRoutes, pullRoutes } from '../routes.ts'
import { agoOrDate, clock, plural } from './format.ts'
import { ExternalIcon } from './icons.tsx'
import { pullHref, pullUrl, SEVERITY_BADGES, statusClass } from './pull.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** A member decides on a finding as an admin does (REV-17). */
export const MEMBER_CAN = 'vous dismissez, gardez (wontfix) ou rouvrez un finding'

/** The words of each event of the history. */
export const EVENT_LABELS: Record<FindingEventType, string> = {
  opened: 'posté',
  reopened: 'rouvert',
  fixed: 'fixed',
  stale: 'en suspens',
  dismissed: 'dismissed',
  wontfix: 'wontfix',
}

/** The thread of a finding on GitHub. */
export function threadUrl(githubUrl: string, finding: Pick<FindingDetail, 'target' | 'githubCommentId'>): string | null {
  if (finding.githubCommentId === null) return null
  return `${pullUrl(githubUrl, finding.target.fullName, finding.target.prNumber)}#discussion_r${finding.githubCommentId}`
}

/** The address of the detail, with the cursor of its history. */
export function findingHref(id: string, history: string | null = null): string {
  let base = pullRoutes.finding.href({ id })
  return history ? `${base}?historique=${encodeURIComponent(history)}` : base
}

export interface FindingPageProps {
  frame: PageFrame
  finding: FindingDetail
  history: Page<HistoryEvent>
  /** The cursor of the page of history on screen, null for the first. */
  historyCursor: string | null
  /** Undefined: GitHub was not asked (no GitHub App). `failed`: GitHub did not answer. */
  code: CodeRead | 'failed' | undefined
  githubUrl: string
  now: Date
  /** The forms of the finding (REV-17, 3/4), under its facts. */
  actions?: RemixNode
  notice?: RemixNode
}

export function FindingPage(handle: Handle<FindingPageProps>) {
  return () => {
    let { frame, finding, history, historyCursor, code, githubUrl, now, actions, notice } = handle.props
    let { target } = finding
    let repoName = target.fullName.split('/')[1] ?? target.fullName
    let thread = threadUrl(githubUrl, finding)
    let review = finding.review
    return (
      <Shell frame={frame} section="repos" title={finding.title || 'Finding sans titre'} memberCan={MEMBER_CAN}>
        <nav class="crumbs" aria-label="Fil d’Ariane">
          <a href={pageRoutes.repos.href()}>Repos</a>
          <span aria-hidden="true">/</span>
          <a href={pageRoutes.repoConfig.href({ id: target.repoId })}>{target.fullName}</a>
          <span aria-hidden="true">/</span>
          <a href={pullHref(target.repoId, target.prNumber)}>
            {repoName} #{target.prNumber}
          </a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Finding</span>
        </nav>

        {notice}

        <div class="finding-tags">
          <span class="tag">{SEVERITY_BADGES[finding.severity]}</span>
          <span class={`status ${statusClass(finding.status)}`}>{STATUS_LABELS[finding.status]}</span>
          <span class="tag tag-quiet">{finding.category === 'security' ? 'sécurité' : finding.category}</span>
          {finding.statusReason ? <span class="hint">Motif : {finding.statusReason}</span> : null}
        </div>

        <dl class="pull-meta finding-facts">
          <div>
            <dt>Source</dt>
            <dd>{finding.rule ? `Règle « ${finding.rule.title ?? 'retirée depuis'} »` : 'Passe du modèle'}</dd>
          </div>
          <div>
            <dt>Confiance</dt>
            <dd>{finding.confidence} %</dd>
          </div>
          <div>
            <dt>Modèle</dt>
            <dd>{review ? `${review.model} (R${review.number}, ${review.level})` : 'inconnu'}</dd>
          </div>
          <div>
            <dt>Vérification</dt>
            <dd>aucune : une seule passe</dd>
          </div>
          <div>
            <dt>Fichier</dt>
            <dd class="mono">
              {finding.path}:{finding.line}
            </dd>
          </div>
          <div>
            <dt>Fil GitHub</dt>
            <dd>
              {thread ? (
                <a href={thread}>
                  Voir le fil
                  <ExternalIcon />
                </a>
              ) : (
                'pas de commentaire en ligne'
              )}
            </dd>
          </div>
        </dl>

        {actions}

        <div class="finding-grid">
          <section class="card finding-section" aria-labelledby="scenario-title">
            <h2 id="scenario-title" class="section-title">
              Scénario
            </h2>
            <p class="finding-text">{review?.scenario || 'La review ne l’a pas écrit.'}</p>
            <h2 id="fix-title" class="section-title">
              Piste
            </h2>
            <p class="finding-text">{review?.fix || 'La review n’en propose pas.'}</p>
            {review?.suggestion ? (
              <>
                <h3 class="finding-subtitle">Suggestion</h3>
                <pre class="code-block">
                  <code>{review.suggestion}</code>
                </pre>
              </>
            ) : null}
          </section>

          <section class="card finding-section" aria-labelledby="code-title">
            <h2 id="code-title" class="section-title">
              Code
            </h2>
            <p class="hint">
              <span class="mono">{finding.path}</span> à <span class="mono">{finding.lastSeenSha.slice(0, 7)}</span>, le commit de la dernière review qui l’a trouvé.
            </p>
            {code !== undefined && code !== 'failed' && code.kind === 'lines' ? (
              <>
                {finding.line < 1 ? <p class="hint">Ce finding n’a pas de ligne (un fil d’une version antérieure) : voici le début du fichier.</p> : null}
                <CodeView code={code.excerpt} line={finding.line} />
              </>
            ) : (
              <p class="finding-text">{codeText(code)}</p>
            )}
          </section>
        </div>

        <section class="finding-history" aria-labelledby="history-title">
          <h2 id="history-title" class="section-title">
            Historique
          </h2>
          {history.items.length === 0 ? (
            <p class="hint">Aucun événement.</p>
          ) : (
            <ol class="history">
              {history.items.map((event) => (
                <li class="history-item">
                  <span class={`cell cell-${event.type === 'opened' ? 'posted' : event.type === 'stale' ? 'absent' : event.type}`}>{EVENT_LABELS[event.type]}</span>
                  <span>
                    {event.actor === 'kento' ? 'Kentō' : `@${event.actor}`}
                    {event.review === null ? '' : ` · R${event.review}`}
                    {event.reason ? ` · « ${event.reason} »` : ''}
                  </span>
                  <time class="hint" dateTime={event.createdAt.toISOString()} title={clock(event.createdAt)}>
                    {agoOrDate(event.createdAt, now)}
                  </time>
                </li>
              ))}
            </ol>
          )}
          {historyCursor || history.nextCursor ? (
            <nav class="pager" aria-label="Pages de l’historique">
              {historyCursor ? <a href={findingHref(finding.id)}>Début de l’historique</a> : <span />}
              <span />
              {history.nextCursor ? <a href={findingHref(finding.id, history.nextCursor)}>Événements suivants</a> : <span />}
            </nav>
          ) : null}
        </section>
      </Shell>
    )
  }
}

/** Why the code of a finding is not on screen. */
export function codeText(code: CodeRead | 'failed' | undefined): string {
  if (code === undefined) return 'Sans l’App GitHub, Kentō ne lit pas le code.'
  if (code === 'failed') return 'GitHub n’a pas répondu : le code n’a pas pu être lu.'
  if (code.kind === 'missing') return 'Ce fichier n’est plus sur GitHub à ce commit (un force-push l’a retiré, ou le fichier a été renommé).'
  if (code.kind === 'empty') return 'Le fichier est vide à ce commit.'
  if (code.kind === 'unreadable') return 'GitHub ne donne pas le contenu de ce fichier (un dossier, ou un fichier de plus de 1 Mo).'
  if (code.kind === 'short') return `Le fichier n’a que ${code.length} ${plural(code.length, 'ligne')} à ce commit : la ligne du finding n’y est pas.`
  return ''
}

function CodeView(handle: Handle<{ code: CodeExcerpt; line: number }>) {
  return () => {
    let { code, line } = handle.props
    return (
      <div class="code-block" role="group" tabIndex={0} aria-label={`Lignes ${code.start} à ${code.start + code.lines.length - 1}`}>
        {code.lines.map((text, i) => {
          let n = code.start + i
          return (
            <div class={`code-line${n === line ? ' code-line-hit' : ''}`}>
              <span class="code-number" aria-hidden="true">
                {n}
              </span>
              <code>{text || ' '}</code>
              {n === line ? <span class="visually-hidden"> (ligne du finding)</span> : null}
            </div>
          )
        })}
      </div>
    )
  }
}
