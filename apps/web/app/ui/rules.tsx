import type { Handle } from 'remix/component'

import { RULE_PATHS_MAX, RULE_TEXT_MAX, RULE_TITLE_MAX } from '@sakuga-review/protocol'

import { FLOOR_LABELS, leftOutReason, RULE_FIELDS, type RuleField, type SeverityFloor } from '../rules/model.ts'
import { MAX_RULES, type RuleView } from '../rules/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { FormErrors, firstInvalid, focusIf } from './form-errors.tsx'
import { AlertIcon, CheckIcon } from './icons.tsx'

/** What the list says after a form, from `?rules=`. */
export const RULE_NOTICES = {
  added: { tone: 'ok', text: 'Règle ajoutée. Elle part au modèle avec la prochaine review d’une PR qui touche ses chemins.' },
  saved: { tone: 'ok', text: 'Règle enregistrée. Un job déjà en file lit la nouvelle version quand un runner le prend.' },
  disabled: { tone: 'ok', text: 'Règle désactivée : elle ne part plus au modèle.' },
  enabled: { tone: 'ok', text: 'Règle réactivée : elle part de nouveau au modèle.' },
  removed: { tone: 'info', text: 'Règle supprimée.' },
  conflict: { tone: 'alert', text: 'Cette règle a changé depuis l’ouverture de la page : rien n’est enregistré. Relisez-la ci-dessous, puis recommencez.' },
  missing: { tone: 'alert', text: 'Cette règle n’existe plus.' },
  full: { tone: 'alert', text: `${MAX_RULES} règles au plus ici, désactivées comprises : supprimez-en une d’abord.` },
} as const
export type RuleNotice = keyof typeof RULE_NOTICES

export function isRuleNotice(value: unknown): value is RuleNotice {
  return typeof value === 'string' && Object.hasOwn(RULE_NOTICES, value)
}

/** A form of a rule sent back with its errors. `ruleId` null: the form « Nouvelle règle ». */
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

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' })
const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })

/** « le 27 oct. à 18:02 ». */
function when(date: Date): string {
  return `le ${DATE.format(date)} à ${TIME.format(date)}`
}

/** « désactivée par alex le 30 oct. à 10:12 ». */
export function disabledLine(rule: Pick<RuleView, 'disabledBy' | 'disabledAt'>): string {
  let by = rule.disabledBy ? ` par ${rule.disabledBy}` : ''
  let at = rule.disabledAt ? ` ${when(rule.disabledAt)}` : ''
  return `désactivée${by}${at}`
}

/** « tous les chemins », or the first patterns. */
function pathsSummary(paths: readonly string[]): string {
  if (paths.length === 0) return 'tous les chemins'
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
      <p class="field-hint" id={`${id}-hint`}>
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
          <label class="field-label" for={id('title')}>
            Titre
          </label>
          <input
            class="input"
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
          <label class="field-label" for={id('body')}>
            Ce que la règle demande
          </label>
          <textarea
            class="input rule-body-input"
            id={id('body')}
            name="body"
            rows={4}
            maxLength={RULE_TEXT_MAX}
            {...focusIf(first, 'body')}
            aria-invalid={errors.body ? 'true' : undefined}
            aria-describedby={describedBy(id('body'), errors.body, true)}
            value={values.body ?? ''}
          ></textarea>
          <Message
            id={id('body')}
            error={errors.body}
            hint={`Le modèle lit ce texte tel quel, avec le diff. ${RULE_TEXT_MAX.toLocaleString('fr-FR')} caractères au plus.`}
          />
        </div>
        <div class="field">
          <label class="field-label" for={id('paths')}>
            Chemins
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
            hint={`Un motif par ligne, ${RULE_PATHS_MAX} au plus, comme les chemins du déclenchement : **/migrations/**, src/*.ts, apps/web (un dossier). Vide : tous les chemins. La règle part seulement si la PR touche l’un d’eux.`}
          />
        </div>
        <div class="field">
          <label class="field-label" for={id('severityFloor')}>
            Priorité minimale d’un constat de cette règle
          </label>
          <select
            class="input rule-floor-input"
            id={id('severityFloor')}
            name="severityFloor"
            {...focusIf(first, 'severityFloor')}
            aria-invalid={errors.severityFloor ? 'true' : undefined}
            aria-describedby={describedBy(id('severityFloor'), errors.severityFloor, true)}
          >
            <option value="" selected={!values.severityFloor}>
              Aucun plancher
            </option>
            {(Object.keys(FLOOR_LABELS) as SeverityFloor[]).map((floor) => (
              <option value={floor} selected={values.severityFloor === floor}>
                {FLOOR_LABELS[floor]}
              </option>
            ))}
          </select>
          <Message
            id={id('severityFloor')}
            error={errors.severityFloor}
            hint="Un constat qui cite la règle ne descend pas sous cette priorité. P1 ou P0 sur une ligne modifiée, avec 70 % de confiance, demande des changements."
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
              {rule.severityFloor ? <span class="tag tag-info">au moins {FLOOR_LABELS[rule.severityFloor].split(' · ')[0]}</span> : null}
              {rule.active ? null : <span class="tag tag-warn">{disabledLine(rule)}</span>}
              {leftOut ? <span class="tag tag-alert">jamais envoyée</span> : null}
            </span>
          </summary>
          <div class="rule-content">
            {leftOut ? (
              <p class="hint hint-alert">
                {leftOut === 'too_long'
                  ? `Les jobs ne l’envoient pas : son titre dépasse ${RULE_TITLE_MAX} caractères ou son texte ${RULE_TEXT_MAX.toLocaleString('fr-FR')} (un emoji compte pour deux). Raccourcissez-les et enregistrez.`
                  : 'Les jobs ne l’envoient pas : aucun de ses chemins n’est valide. Corrigez-les et enregistrez.'}
              </p>
            ) : null}
            {admin ? (
              <form method="post" action={routes.ruleSave.href({ id: rule.id })} class="rule-form" noValidate>
                <Hidden csrf={csrf} repoId={repoId} version={rule.version} />
                <RuleFields prefix={prefix} values={mine?.values ?? valuesOf(rule)} errors={mine?.errors ?? {}} />
                <button class="button button-primary" type="submit">
                  Enregistrer<span class="visually-hidden"> la règle {rule.title}</span>
                </button>
              </form>
            ) : (
              <dl class="config-facts">
                <div>
                  <dt>Ce que la règle demande</dt>
                  <dd class="rule-body">{rule.body}</dd>
                </div>
                <div>
                  <dt>Chemins</dt>
                  <dd>
                    {rule.paths.length === 0 ? (
                      'Tous les chemins.'
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
                  <dt>Priorité minimale</dt>
                  <dd>{rule.severityFloor ? FLOOR_LABELS[rule.severityFloor] : 'Aucun plancher.'}</dd>
                </div>
              </dl>
            )}
            <p class="hint">
              v{rule.version}, modifiée{rule.updatedBy ? ` par ${rule.updatedBy}` : ''} {when(rule.updatedAt)}
              {rule.active ? '' : ` · ${disabledLine(rule)} : elle ne part plus au modèle`}.
            </p>
            {admin ? (
              <div class="rule-actions">
                <form method="post" action={routes.ruleActive.href({ id: rule.id })}>
                  <Hidden csrf={csrf} repoId={repoId} version={rule.version} />
                  <input type="hidden" name="active" value={rule.active ? 'false' : 'true'} />
                  <button class="button" type="submit">
                    {rule.active ? 'Désactiver' : 'Réactiver'}
                    <span class="visually-hidden"> la règle {rule.title}</span>
                  </button>
                </form>
                <Confirm
                  trigger={
                    <>
                      Supprimer…<span class="visually-hidden"> la règle {rule.title}</span>
                    </>
                  }
                  action={`${routes.ruleRemove.href({ id: rule.id })}?repo=${repoId ?? ''}`}
                  csrf={csrf}
                  submit={`Supprimer « ${rule.title.length > 40 ? `${rule.title.slice(0, 39)}…` : rule.title} »`}
                >
                  <p>
                    La règle ne part plus au modèle, et son texte est perdu. Pour l’arrêter sans la perdre, désactivez-la. Les
                    reviews déjà publiées gardent leurs constats.
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
 * REV-19. The rules of a repository (Config › Règles) or of the org (Réglages › Règles d’org): a
 * list of folded rules, each one open to edit, disable or remove, and the form of a new rule. An
 * admin of the org writes; a member reads.
 */
export function RulesList(handle: Handle<RulesListProps>) {
  return () => {
    let props = handle.props
    let { scope, repoId, rules, admin, csrf, form, notice } = props
    let newForm = form?.ruleId === null ? form : null
    let full = rules.length >= MAX_RULES
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
                ? 'Aucune règle d’org. Une règle d’org part avec la review de chaque repo de l’org dont la PR touche ses chemins.'
                : 'Aucune règle pour ce repo.'}
            </p>
          </div>
        ) : (
          <ul class="rule-list">
            {rules.map((rule) => (
              <RuleItem rule={rule} props={props} />
            ))}
          </ul>
        )}
        {admin && !full ? (
          <details class="rule-new" id={`${scope}-rule-new`} open={newForm !== null || rules.length === 0}>
            <summary class="button">Nouvelle règle</summary>
            <form method="post" action={routes.ruleAdd.href()} class="rule-form" noValidate>
              <Hidden csrf={csrf} repoId={repoId} />
              <RuleFields prefix={`${scope}-rule-new`} values={newForm?.values ?? {}} errors={newForm?.errors ?? {}} />
              <button class="button button-primary" type="submit">
                Ajouter la règle
              </button>
            </form>
          </details>
        ) : admin ? (
          <p class="hint">{MAX_RULES} règles au plus ici, désactivées comprises : supprimez-en une pour en ajouter une autre.</p>
        ) : null}
      </div>
    )
  }
}
