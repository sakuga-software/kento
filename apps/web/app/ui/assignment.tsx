import type { Handle } from 'remix/component'

import type { Level } from '@sakuga-review/protocol'

import { ASSIGNMENT_FIELDS, MAX_ASSIGNMENT_RULES, MAX_CONDITION_VALUES, OUTCOMES, type AssignmentField, type Outcome } from '../assignment/model.ts'
import type { AssignmentView } from '../assignment/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { FormErrors, firstInvalid, focusIf } from './form-errors.tsx'
import { AlertIcon, CheckIcon } from './icons.tsx'

/** What the tab says after a form, from `?assign=`. */
export const ASSIGNMENT_NOTICES = {
  added: { tone: 'ok', text: 'Règle ajoutée en dernier. Elle s’applique au prochain push.' },
  moved: { tone: 'ok', text: 'Ordre enregistré. La première règle qui correspond l’emporte.' },
  removed: { tone: 'info', text: 'Règle supprimée. Les règles suivantes remontent d’une place.' },
  missing: { tone: 'alert', text: 'Cette règle n’existe plus.' },
  full: { tone: 'alert', text: `${MAX_ASSIGNMENT_RULES} règles d’assignation au plus : supprimez-en une d’abord.` },
} as const
export type AssignmentNotice = keyof typeof ASSIGNMENT_NOTICES

export function isAssignmentNotice(value: unknown): value is AssignmentNotice {
  return typeof value === 'string' && Object.hasOwn(ASSIGNMENT_NOTICES, value)
}

/** The form « Nouvelle règle » sent back with its errors. */
export interface AssignmentFormState {
  values: Record<string, string>
  errors: Partial<Record<AssignmentField, string>>
}

export interface AssignmentTabProps {
  repoId: string
  rules: AssignmentView[]
  /** The level of the config, what a push gets when no rule matches. */
  defaultLevel: Level
  admin: boolean
  csrf: string | null
  form: AssignmentFormState | null
  notice: AssignmentNotice | null
  /** The rule that the notice is about. */
  noticeRule: string | null
}

const OUTCOME_LABELS: Record<Outcome, string> = {
  lite: 'lite',
  balanced: 'balanced',
  heavy: 'heavy',
  command_only: 'Aucune review automatique (commande seulement)',
}

/** « l’auteur est sakuga-agent[bot] ou renovate[bot] ». */
function oneOf(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  return `${values.slice(0, -1).join(', ')} ou ${values.at(-1)}`
}

/** « Si l’auteur est sakuga-agent[bot] et la PR touche **\/migrations/** ». */
export function conditionText(rule: Pick<AssignmentView, 'authors' | 'paths' | 'labels'>): string {
  let parts: string[] = []
  if (rule.authors.length) parts.push(`l’auteur est ${oneOf(rule.authors)}`)
  if (rule.paths.length) parts.push(`la PR touche ${oneOf(rule.paths)}`)
  if (rule.labels.length) parts.push(`la PR porte le label ${oneOf(rule.labels.map((l) => `« ${l} »`))}`)
  return `Si ${parts.join(' et ')}`
}

function Hidden(handle: Handle<{ csrf: string | null }>) {
  return () => (handle.props.csrf ? <input type="hidden" name="_csrf" value={handle.props.csrf} /> : null)
}

function describedBy(id: string, error: string | undefined, hint: boolean): string | undefined {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined
}

function Message(handle: Handle<{ id: string; error?: string; hint?: string }>) {
  return () => {
    let { id, error, hint } = handle.props
    if (error) {
      return (
        <p class="field-error" id={`${id}-error`}>
          {error}
        </p>
      )
    }
    return hint ? (
      <p class="field-hint" id={`${id}-hint`}>
        {hint}
      </p>
    ) : null
  }
}

function RuleRow(handle: Handle<{ rule: AssignmentView; last: boolean; props: AssignmentTabProps }>) {
  return () => {
    let { rule, last, props } = handle.props
    let { admin, csrf, repoId, noticeRule } = props
    let label = `la règle ${rule.position}`
    return (
      <li class={noticeRule === rule.id ? 'assignment-rule assignment-rule-current' : 'assignment-rule'} id={`assignment-${rule.id}`} tabIndex={-1}>
        <span class="assignment-position" aria-hidden="true">
          {rule.position}
        </span>
        <div class="assignment-body">
          <p class="assignment-when">
            <span class="visually-hidden">Règle {rule.position}. </span>
            {conditionText(rule)}
          </p>
          <p class="assignment-then">
            alors{' '}
            {rule.action === 'review' ? (
              <>
                <strong class="mono">{rule.level}</strong>
                {rule.mention ? (
                  <>
                    , et la review mentionne <span class="mono">@{rule.mention}</span>
                  </>
                ) : null}
              </>
            ) : (
              <strong>aucune review automatique</strong>
            )}
            .
          </p>
        </div>
        {admin ? (
          <div class="assignment-actions">
            <form method="post" action={routes.assignmentMove.href({ id: repoId, rule: rule.id })}>
              <Hidden csrf={csrf} />
              <input type="hidden" name="direction" value="up" />
              <button class="button" type="submit" disabled={rule.position === 1 ? true : undefined}>
                Monter<span class="visually-hidden"> {label}</span>
              </button>
            </form>
            <form method="post" action={routes.assignmentMove.href({ id: repoId, rule: rule.id })}>
              <Hidden csrf={csrf} />
              <input type="hidden" name="direction" value="down" />
              <button class="button" type="submit" disabled={last ? true : undefined}>
                Descendre<span class="visually-hidden"> {label}</span>
              </button>
            </form>
            <Confirm
              trigger={
                <>
                  Supprimer…<span class="visually-hidden"> {label}</span>
                </>
              }
              action={routes.assignmentRemove.href({ id: repoId, rule: rule.id })}
              csrf={csrf}
              submit={`Supprimer la règle ${rule.position}`}
            >
              <p>Les pushs suivants ne la lisent plus. Les règles après elle remontent d’une place ; les jobs déjà en file gardent leur niveau.</p>
            </Confirm>
          </div>
        ) : null}
      </li>
    )
  }
}

function NewRule(handle: Handle<{ props: AssignmentTabProps }>) {
  return () => {
    let { props } = handle.props
    let { csrf, repoId, form, rules } = props
    let values = form?.values ?? {}
    let errors = form?.errors ?? {}
    let first = firstInvalid(errors, ASSIGNMENT_FIELDS)
    let id = (field: AssignmentField) => `assignment-new-${field}`
    let outcome = values.outcome ?? 'balanced'
    return (
      <details class="rule-new" id="assignment-new" open={form !== null || rules.length === 0}>
        <summary class="button">Nouvelle règle</summary>
        <form method="post" action={routes.assignmentAdd.href({ id: repoId })} class="rule-form" noValidate>
          <Hidden csrf={csrf} />
          <FormErrors errors={errors} />
          <fieldset class="assignment-condition">
            <legend class="field-label">Si</legend>
            <p class="field-hint">Remplissez au moins une ligne. Chaque ligne remplie doit correspondre ; dans une ligne, une seule valeur suffit.</p>
            <div class="field">
              <label class="field-label" for={id('authors')}>
                L’auteur de la PR est
              </label>
              <input
                class="input mono"
                id={id('authors')}
                name="authors"
                value={values.authors ?? ''}
                autoComplete="off"
                spellCheck={false}
                {...focusIf(first, 'authors')}
                aria-invalid={errors.authors ? 'true' : undefined}
                aria-describedby={describedBy(id('authors'), errors.authors, true)}
              />
              <Message id={id('authors')} error={errors.authors} hint={`Des logins GitHub séparés par des virgules, ${MAX_CONDITION_VALUES} au plus : sakuga-agent[bot], camille.`} />
            </div>
            <div class="field">
              <label class="field-label" for={id('paths')}>
                La PR touche l’un de ces chemins
              </label>
              <textarea
                class="input mono config-paths rule-paths-input"
                id={id('paths')}
                name="paths"
                rows={3}
                spellCheck={false}
                {...focusIf(first, 'paths')}
                aria-invalid={errors.paths ? 'true' : undefined}
                aria-describedby={describedBy(id('paths'), errors.paths, true)}
                value={values.paths ?? ''}
              ></textarea>
              <Message
                id={id('paths')}
                error={errors.paths}
                hint={`Un motif par ligne, ${MAX_CONDITION_VALUES} au plus, comme les chemins du déclenchement : **/migrations/**, src/*.ts.`}
              />
            </div>
            <div class="field">
              <label class="field-label" for={id('labels')}>
                La PR porte l’un de ces labels
              </label>
              <input
                class="input"
                id={id('labels')}
                name="labels"
                value={values.labels ?? ''}
                autoComplete="off"
                {...focusIf(first, 'labels')}
                aria-invalid={errors.labels ? 'true' : undefined}
                aria-describedby={describedBy(id('labels'), errors.labels, true)}
              />
              <Message id={id('labels')} error={errors.labels} hint="Des labels séparés par des virgules. Les majuscules ne comptent pas." />
            </div>
          </fieldset>
          <div class="field">
            <label class="field-label" for={id('outcome')}>
              Alors
            </label>
            <select
              class="input"
              id={id('outcome')}
              name="outcome"
              {...focusIf(first, 'outcome')}
              aria-invalid={errors.outcome ? 'true' : undefined}
              aria-describedby={describedBy(id('outcome'), errors.outcome, true)}
            >
              {OUTCOMES.map((o) => (
                <option value={o} selected={o === outcome}>
                  {OUTCOME_LABELS[o]}
                </option>
              ))}
            </select>
            <Message
              id={id('outcome')}
              error={errors.outcome}
              hint="Le niveau de la review d’un push. Sans review automatique, seule une commande @kento-review en crée une."
            />
          </div>
          <div class="field">
            <label class="field-label" for={id('mention')}>
              Mentionner dans la review (facultatif)
            </label>
            <input
              class="input mono"
              id={id('mention')}
              name="mention"
              value={values.mention ?? ''}
              autoComplete="off"
              spellCheck={false}
              {...focusIf(first, 'mention')}
              aria-invalid={errors.mention ? 'true' : undefined}
              aria-describedby={describedBy(id('mention'), errors.mention, true)}
            />
            <Message id={id('mention')} error={errors.mention} hint="Le login GitHub d’une personne : la review publiée lui demande de relire, et GitHub la prévient." />
          </div>
          <button class="button button-primary" type="submit">
            Ajouter la règle
          </button>
        </form>
      </details>
    )
  }
}

/**
 * REV-21. « Assignation »: the ordered rules that set the level of the review of a push, from the
 * author, the changed paths and the labels of the pull request. The first one that matches wins;
 * the last line says what a push gets when none does. An admin of the org writes; a member reads.
 */
export function AssignmentTab(handle: Handle<AssignmentTabProps>) {
  return () => {
    let props = handle.props
    let { rules, defaultLevel, admin, notice } = props
    let tone = notice ? ASSIGNMENT_NOTICES[notice].tone : null
    let full = rules.length >= MAX_ASSIGNMENT_RULES
    return (
      <section class="card config-card assignment" id="assignment" aria-labelledby="assignment-title" tabIndex={-1}>
        <header class="config-card-head">
          <h2 class="section-title" id="assignment-title">
            Assignation <span class="count">{rules.length}</span>
          </h2>
        </header>
        <p class="hint">
          Le niveau de la review d’un push selon l’auteur, les chemins touchés et les labels de la PR. Les règles se lisent dans
          l’ordre, et la première qui correspond l’emporte, avant les préférences de l’auteur. Une commande @kento-review garde le niveau qu’elle demande.
        </p>
        {notice ? (
          <div class={`banner banner-${tone}`} role={tone === 'alert' ? 'alert' : 'status'}>
            {tone === 'alert' ? <AlertIcon /> : <CheckIcon />}
            <p>{ASSIGNMENT_NOTICES[notice].text}</p>
          </div>
        ) : null}
        <ol class="assignment-list">
          {rules.map((rule, i) => (
            <RuleRow rule={rule} last={i === rules.length - 1} props={props} />
          ))}
          <li class="assignment-rule assignment-default">
            <span class="assignment-position" aria-hidden="true">
              ·
            </span>
            <div class="assignment-body">
              <p class="assignment-when">Sinon</p>
              <p class="assignment-then">
                les préférences de l’auteur s’il en a, puis le niveau par défaut du repo, <strong class="mono">{defaultLevel}</strong> (onglet Niveaux
                et passes).
              </p>
            </div>
          </li>
        </ol>
        {admin && !full ? <NewRule props={props} /> : admin ? <p class="hint">{ASSIGNMENT_NOTICES.full.text}</p> : null}
      </section>
    )
  }
}
