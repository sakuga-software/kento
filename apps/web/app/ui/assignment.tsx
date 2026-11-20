import type { Handle } from 'remix/component'

import type { Level } from '@kento-review/protocol'

import { mention } from '../instance.ts'
import { ASSIGNMENT_FIELDS, MAX_ASSIGNMENT_RULES, MAX_CONDITION_VALUES, OUTCOMES, type AssignmentField, type Outcome } from '../assignment/model.ts'
import type { AssignmentView } from '../assignment/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { FormErrors, firstInvalid, focusIf } from './form-errors.tsx'
import { AlertIcon, CheckIcon } from './icons.tsx'

/** What the tab says after a form, from `?assign=`. */
export const ASSIGNMENT_NOTICES = {
  added: { tone: 'ok', text: 'Rule added last. It applies from the next push.' },
  moved: { tone: 'ok', text: 'Order saved. The first rule that matches wins.' },
  removed: { tone: 'info', text: 'Rule deleted. The rules after it move up one place.' },
  missing: { tone: 'alert', text: 'This rule no longer exists.' },
  full: { tone: 'alert', text: `${MAX_ASSIGNMENT_RULES} assignment rules at most. Delete one first.` },
} as const
export type AssignmentNotice = keyof typeof ASSIGNMENT_NOTICES

export function isAssignmentNotice(value: unknown): value is AssignmentNotice {
  return typeof value === 'string' && Object.hasOwn(ASSIGNMENT_NOTICES, value)
}

/** The form "New rule" sent back with its errors. */
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
  command_only: 'No automatic review (command only)',
}

/** "the author is sakuga-agent[bot] or renovate[bot]". */
function oneOf(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`
}

/** "If the author is sakuga-agent[bot] and the PR changes **\/migrations/**". */
export function conditionText(rule: Pick<AssignmentView, 'authors' | 'paths' | 'labels'>): string {
  let parts: string[] = []
  if (rule.authors.length) parts.push(`the author is ${oneOf(rule.authors)}`)
  if (rule.paths.length) parts.push(`the PR changes ${oneOf(rule.paths)}`)
  if (rule.labels.length) parts.push(`the PR has the label ${oneOf(rule.labels.map((l) => `"${l}"`))}`)
  return `If ${parts.join(' and ')}`
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
    let label = `rule ${rule.position}`
    return (
      <li class={noticeRule === rule.id ? 'assignment-rule assignment-rule-current' : 'assignment-rule'} id={`assignment-${rule.id}`} tabIndex={-1}>
        <span class="assignment-position" aria-hidden="true">
          {rule.position}
        </span>
        <div class="assignment-body">
          <p class="assignment-when">
            <span class="visually-hidden">Rule {rule.position}. </span>
            {conditionText(rule)}
          </p>
          <p class="assignment-then">
            then{' '}
            {rule.action === 'review' ? (
              <>
                <strong class="mono">{rule.level}</strong>
                {rule.mention ? (
                  <>
                    , and the review mentions <span class="mono">@{rule.mention}</span>
                  </>
                ) : null}
              </>
            ) : (
              <strong>no automatic review</strong>
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
                Move up<span class="visually-hidden"> {label}</span>
              </button>
            </form>
            <form method="post" action={routes.assignmentMove.href({ id: repoId, rule: rule.id })}>
              <Hidden csrf={csrf} />
              <input type="hidden" name="direction" value="down" />
              <button class="button" type="submit" disabled={last ? true : undefined}>
                Move down<span class="visually-hidden"> {label}</span>
              </button>
            </form>
            <Confirm
              trigger={
                <>
                  Delete…<span class="visually-hidden"> {label}</span>
                </>
              }
              action={routes.assignmentRemove.href({ id: repoId, rule: rule.id })}
              csrf={csrf}
              submit={`Delete rule ${rule.position}`}
            >
              <p>The next pushes no longer read it. The rules after it move up one place. The jobs already in the queue keep their level.</p>
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
        <summary class="button">New rule</summary>
        <form method="post" action={routes.assignmentAdd.href({ id: repoId })} class="rule-form" noValidate>
          <Hidden csrf={csrf} />
          <FormErrors errors={errors} />
          <fieldset class="assignment-condition">
            <legend class="field-label">If</legend>
            <p class="field-hint">Fill in at least one line. Each filled line must match. In one line, one value is enough.</p>
            <div class="field">
              <label class="field-label" for={id('authors')}>
                The author of the PR is
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
              <Message id={id('authors')} error={errors.authors} hint={`GitHub logins separated by commas, ${MAX_CONDITION_VALUES} at most: sakuga-agent[bot], camille.`} />
            </div>
            <div class="field">
              <label class="field-label" for={id('paths')}>
                The PR changes one of these paths
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
                hint={`One pattern per line, ${MAX_CONDITION_VALUES} at most, like the paths of the trigger: **/migrations/**, src/*.ts.`}
              />
            </div>
            <div class="field">
              <label class="field-label" for={id('labels')}>
                The PR has one of these labels
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
              <Message id={id('labels')} error={errors.labels} hint="Labels separated by commas. Case does not count." />
            </div>
          </fieldset>
          <div class="field">
            <label class="field-label" for={id('outcome')}>
              Then
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
              hint={`The level of the review of a push. With no automatic review, only a ${mention()} command creates one.`}
            />
          </div>
          <div class="field">
            <label class="field-label" for={id('mention')}>
              Mention in the review (optional)
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
            <Message id={id('mention')} error={errors.mention} hint="The GitHub login of a person. The published review asks them to review the PR, and GitHub notifies them." />
          </div>
          <button class="button button-primary" type="submit">
            Add the rule
          </button>
        </form>
      </details>
    )
  }
}

/**
 * REV-21. "Assignment": the ordered rules that set the level of the review of a push, from the
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
            Assignment <span class="count">{rules.length}</span>
          </h2>
        </header>
        <p class="hint">
          The level of the review of a push, from the author, the changed paths and the labels of the PR. Kentō reads the rules in
          order, and the first one that matches wins, before the preferences of the author. A {mention()} command keeps the level that it asks for.
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
              <p class="assignment-when">Else</p>
              <p class="assignment-then">
                the preferences of the author if they have some, then the default level of the repo, <strong class="mono">{defaultLevel}</strong> (tab Levels
                and passes).
              </p>
            </div>
          </li>
        </ol>
        {admin && !full ? <NewRule props={props} /> : admin ? <p class="hint">{ASSIGNMENT_NOTICES.full.text}</p> : null}
      </section>
    )
  }
}
