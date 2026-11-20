import type { Handle } from 'remix/component'

import { RULE_PATHS_MAX, RULE_TEXT_MAX, RULE_TITLE_MAX } from '@kento/protocol'

import { FLOOR_LABELS, leftOutReason, RULE_FIELDS, type RuleField, type SeverityFloor } from '../rules/model.ts'
import { MAX_RULES, type RuleView } from '../rules/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { Button, Input, Select, Textarea, buttonClass } from './controls.tsx'
import { FormErrors, firstInvalid, focusIf } from './form-errors.tsx'
import { count, when } from './format.ts'
import { AlertIcon, CheckIcon } from './icons.tsx'

/** What the list says after a form, from `?rules=`. */
export const RULE_NOTICES = {
  added: { tone: 'ok', text: 'Rule added. It goes to the model with the next review of a PR that changes its paths.' },
  saved: { tone: 'ok', text: 'Rule saved. A job already in the queue reads the new version when a runner takes it.' },
  disabled: { tone: 'ok', text: 'Rule disabled. It no longer goes to the model.' },
  enabled: { tone: 'ok', text: 'Rule enabled again. It goes to the model again.' },
  removed: { tone: 'info', text: 'Rule deleted.' },
  conflict: { tone: 'alert', text: 'This rule changed after the page opened. Nothing is saved. Read it again below, then try again.' },
  missing: { tone: 'alert', text: 'This rule no longer exists.' },
  full: { tone: 'alert', text: `${MAX_RULES} rules at most here, disabled ones included. Delete one first.` },
} as const
export type RuleNotice = keyof typeof RULE_NOTICES

export function isRuleNotice(value: unknown): value is RuleNotice {
  return typeof value === 'string' && Object.hasOwn(RULE_NOTICES, value)
}

/** A form of a rule sent back with its errors. `ruleId` null: the form "New rule". */
export interface RuleFormState {
  ruleId: string | null
  values: Record<string, string>
  errors: Partial<Record<RuleField, string>>
}

export interface RulesListProps {
  /** `repo`: the rules of the repository `repoId`; `org`: the rules of the org. */
  scope: 'repo' | 'org'
  repoId: string | null
  rules: RuleView[]
  admin: boolean
  csrf: string | null
  form: RuleFormState | null
  notice: RuleNotice | null
  /** The rule that the notice is about: its item opens. */
  noticeRule: string | null
}

/** "disabled by octocat on 30 Oct at 10:12". */
export function disabledLine(rule: Pick<RuleView, 'disabledBy' | 'disabledAt'>): string {
  let by = rule.disabledBy ? ` by ${rule.disabledBy}` : ''
  let at = rule.disabledAt ? ` ${when(rule.disabledAt)}` : ''
  return `disabled${by}${at}`
}

/** "all paths", or the first patterns. */
function pathsSummary(paths: readonly string[]): string {
  if (paths.length === 0) return 'all paths'
  if (paths.length <= 2) return paths.join(', ')
  return `${paths.slice(0, 2).join(', ')} +${paths.length - 2}`
}

function Hidden(handle: Handle<{ csrf: string | null; repoId: string | null; version?: number }>) {
  return () => {
    let { csrf, repoId, version } = handle.props
    return (
      <>
        {csrf ? <input type="hidden" name="_csrf" value={csrf} /> : null}
        <input type="hidden" name="repo" value={repoId ?? ''} />
        {version !== undefined ? <input type="hidden" name="version" value={String(version)} /> : null}
      </>
    )
  }
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
      <p class="description" id={`${id}-hint`}>
        {hint}
      </p>
    ) : null
  }
}

/** The fields of a rule: the same for a new rule and for a rule that changes. */
function RuleFields(handle: Handle<{ prefix: string; values: Record<string, string>; errors: Partial<Record<RuleField, string>> }>) {
  return () => {
    let { prefix, values, errors } = handle.props
    let first = firstInvalid(errors, RULE_FIELDS)
    let id = (field: RuleField) => `${prefix}-${field}`
    return (
      <>
        <FormErrors errors={errors} />
        <div class="field">
          <label class="label" for={id('title')}>
            Title
          </label>
          <Input
            id={id('title')}
            name="title"
            value={values.title ?? ''}
            maxLength={RULE_TITLE_MAX}
            autoComplete="off"
            {...focusIf(first, 'title')}
            aria-invalid={errors.title ? 'true' : undefined}
            aria-describedby={describedBy(id('title'), errors.title, false)}
          />
          <Message id={id('title')} error={errors.title} />
        </div>
        <div class="field">
          <label class="label" for={id('body')}>
            What the rule asks for
          </label>
          <Textarea
            class="rule-body-input"
            id={id('body')}
            name="body"
            rows={4}
            maxLength={RULE_TEXT_MAX}
            {...focusIf(first, 'body')}
            aria-invalid={errors.body ? 'true' : undefined}
            aria-describedby={describedBy(id('body'), errors.body, true)}
            value={values.body ?? ''}
          ></Textarea>
          <Message
            id={id('body')}
            error={errors.body}
            hint={`The model reads this text as it is, with the diff. ${count(RULE_TEXT_MAX)} characters at most.`}
          />
        </div>
        <div class="field">
          <label class="label" for={id('paths')}>
            Paths
          </label>
          <Textarea
            class="mono config-paths rule-paths-input"
            id={id('paths')}
            name="paths"
            rows={3}
            spellCheck={false}
            {...focusIf(first, 'paths')}
            aria-invalid={errors.paths ? 'true' : undefined}
            aria-describedby={describedBy(id('paths'), errors.paths, true)}
            value={values.paths ?? ''}
          ></Textarea>
          <Message
            id={id('paths')}
            error={errors.paths}
            hint={`One pattern per line, ${RULE_PATHS_MAX} at most, like the paths of the trigger: **/migrations/**, src/*.ts, apps/web (a folder). Empty: all paths. The rule goes to the model only if the PR changes one of them.`}
          />
        </div>
        <div class="field">
          <label class="label" for={id('severityFloor')}>
            Lowest priority of a finding of this rule
          </label>
          <Select
            wrapperClass="rule-floor-input"
            id={id('severityFloor')}
            name="severityFloor"
            {...focusIf(first, 'severityFloor')}
            aria-invalid={errors.severityFloor ? 'true' : undefined}
            aria-describedby={describedBy(id('severityFloor'), errors.severityFloor, true)}
          >
            <option value="" selected={!values.severityFloor}>
              No floor
            </option>
            {(Object.keys(FLOOR_LABELS) as SeverityFloor[]).map((floor) => (
              <option value={floor} selected={values.severityFloor === floor}>
                {FLOOR_LABELS[floor]}
              </option>
            ))}
          </Select>
          <Message
            id={id('severityFloor')}
            error={errors.severityFloor}
            hint="A finding that cites the rule does not go below this priority. A P1 or P0 on a changed line, with 70% confidence, requests changes."
          />
        </div>
      </>
    )
  }
}

function valuesOf(rule: RuleView): Record<string, string> {
  return { title: rule.title, body: rule.body, paths: rule.paths.join('\n'), severityFloor: rule.severityFloor ?? '' }
}

function RuleItem(handle: Handle<{ rule: RuleView; props: RulesListProps }>) {
  return () => {
    let { rule, props } = handle.props
    let { admin, csrf, repoId, form, noticeRule } = props
    let mine = form?.ruleId === rule.id ? form : null
    let open = mine !== null || noticeRule === rule.id
    let prefix = `rule-${rule.id}`
    let leftOut = leftOutReason({ title: rule.title, text: rule.body, paths: rule.paths })
    return (
      <li class={rule.active ? 'rule' : 'rule rule-off'} id={prefix} tabIndex={-1}>
        <details class="rule-details" open={open}>
          <summary class="rule-summary">
            <span class="rule-title">{rule.title}</span>
            <span class="rule-tags">
              <span class="tag tag-quiet mono">{pathsSummary(rule.paths)}</span>
              {rule.severityFloor ? <span class="tag tag-info">at least {FLOOR_LABELS[rule.severityFloor].split(' · ')[0]}</span> : null}
              {rule.active ? null : <span class="tag tag-warn">{disabledLine(rule)}</span>}
              {leftOut ? <span class="tag tag-alert">never sent</span> : null}
            </span>
          </summary>
          <div class="rule-content">
            {leftOut ? (
              <p class="hint hint-alert">
                {leftOut === 'too_long'
                  ? `The jobs do not send it. Its title is longer than ${RULE_TITLE_MAX} characters, or its text longer than ${count(RULE_TEXT_MAX)} (an emoji counts as two). Shorten them and save.`
                  : 'The jobs do not send it. None of its paths is valid. Fix them and save.'}
              </p>
            ) : null}
            {admin ? (
              <form method="post" action={routes.ruleSave.href({ id: rule.id })} class="rule-form" noValidate>
                <Hidden csrf={csrf} repoId={repoId} version={rule.version} />
                <RuleFields prefix={prefix} values={mine?.values ?? valuesOf(rule)} errors={mine?.errors ?? {}} />
                <Button variant="primary" type="submit">
                  Save<span class="visually-hidden"> the rule {rule.title}</span>
                </Button>
              </form>
            ) : (
              <dl class="config-facts">
                <div>
                  <dt>What the rule asks for</dt>
                  <dd class="rule-body">{rule.body}</dd>
                </div>
                <div>
                  <dt>Paths</dt>
                  <dd>
                    {rule.paths.length === 0 ? (
                      'All paths.'
                    ) : (
                      <ul class="config-paths-list">
                        {rule.paths.map((p) => (
                          <li class="mono">{p}</li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Lowest priority</dt>
                  <dd>{rule.severityFloor ? FLOOR_LABELS[rule.severityFloor] : 'No floor.'}</dd>
                </div>
              </dl>
            )}
            <p class="hint">
              v{rule.version}, changed{rule.updatedBy ? ` by ${rule.updatedBy}` : ''} {when(rule.updatedAt)}
              {rule.active ? '' : ` · ${disabledLine(rule)}, so it no longer goes to the model`}.
            </p>
            {admin ? (
              <div class="rule-actions">
                <form method="post" action={routes.ruleActive.href({ id: rule.id })}>
                  <Hidden csrf={csrf} repoId={repoId} version={rule.version} />
                  <input type="hidden" name="active" value={rule.active ? 'false' : 'true'} />
                  <Button type="submit">
                    {rule.active ? 'Disable' : 'Enable again'}
                    <span class="visually-hidden"> the rule {rule.title}</span>
                  </Button>
                </form>
                <Confirm
                  trigger={
                    <>
                      Delete…<span class="visually-hidden"> the rule {rule.title}</span>
                    </>
                  }
                  action={`${routes.ruleRemove.href({ id: rule.id })}?repo=${repoId ?? ''}`}
                  csrf={csrf}
                  submit={`Delete "${rule.title.length > 40 ? `${rule.title.slice(0, 39)}…` : rule.title}"`}
                >
                  <p>
                    The rule no longer goes to the model, and its text is lost. To stop it without losing it, disable it. The
                    reviews already published keep their findings.
                  </p>
                </Confirm>
              </div>
            ) : null}
          </div>
        </details>
      </li>
    )
  }
}

/**
 * Whether the form "New rule" shows: an admin, under MAX_RULES rules (disabled ones included). KNT-149:
 * the sidebar of the settings links to the form with the same rule.
 */
export function canAddRule(admin: boolean, count: number): boolean {
  return admin && count < MAX_RULES
}

/**
 * REV-19. The rules of a repository (Config › Rules) or of the org (Settings › Org rules): a
 * list of folded rules, each one open to edit, disable or remove, and the form of a new rule. An
 * admin of the org writes; a member reads.
 */
export function RulesList(handle: Handle<RulesListProps>) {
  return () => {
    let props = handle.props
    let { scope, repoId, rules, admin, csrf, form, notice } = props
    let newForm = form?.ruleId === null ? form : null
    let tone = notice ? RULE_NOTICES[notice].tone : null
    return (
      <div class="rules">
        {notice ? (
          <div class={`banner banner-${tone}`} role={tone === 'alert' ? 'alert' : 'status'}>
            {tone === 'alert' ? <AlertIcon /> : <CheckIcon />}
            <p>{RULE_NOTICES[notice].text}</p>
          </div>
        ) : null}
        {rules.length === 0 ? (
          <div class="empty">
            <p>
              {scope === 'org'
                ? 'No org rule. An org rule goes to the model with the review of each repo of the org whose PR changes its paths.'
                : 'No rule for this repo.'}
            </p>
          </div>
        ) : (
          <ul class="rule-list">
            {rules.map((rule) => (
              <RuleItem rule={rule} props={props} />
            ))}
          </ul>
        )}
        {canAddRule(admin, rules.length) ? (
          <details class="rule-new" id={`${scope}-rule-new`} open={newForm !== null || rules.length === 0}>
            <summary class={buttonClass()}>New rule</summary>
            <form method="post" action={routes.ruleAdd.href()} class="rule-form" noValidate>
              <Hidden csrf={csrf} repoId={repoId} />
              <RuleFields prefix={`${scope}-rule-new`} values={newForm?.values ?? {}} errors={newForm?.errors ?? {}} />
              <Button variant="primary" type="submit">
                Add the rule
              </Button>
            </form>
          </details>
        ) : admin ? (
          <p class="hint">{MAX_RULES} rules at most here, disabled ones included. Delete one to add another.</p>
        ) : null}
      </div>
    )
  }
}
