import { isOneOf, RULE_PATH_MAX, RULE_PATHS_MAX, RULE_TEXT_MAX, RULE_TITLE_MAX, SEVERITIES } from '@sakuga-review/protocol'

import { checkPattern, MAX_PATH_LENGTH, type FormResult } from '../repo-config/model.ts'

/** The lowest severity of a finding that cites a rule: the priority that a reader sees. */
export type SeverityFloor = (typeof SEVERITIES)[number]

/** What an admin writes for a rule (REV-19). */
export interface RuleValues {
  title: string
  body: string
  paths: string[]
  severityFloor: SeverityFloor | null
}

/** The fields of the form of a rule, in their order: the first one in error gets the focus. */
export const RULE_FIELDS = ['title', 'body', 'paths', 'severityFloor'] as const
export type RuleField = (typeof RULE_FIELDS)[number]

/** The priority of each floor, as the review shows it (P0 to P2). */
export const FLOOR_LABELS: Record<SeverityFloor, string> = {
  critical: 'P0 · critique',
  major: 'P1 · majeur',
  minor: 'P2 · mineur',
}

function text(form: FormData, name: string): string {
  let value = form.get(name)
  return typeof value === 'string' ? value : ''
}

/** The values of the form of a rule, or the error of each field. */
export function readRuleForm(form: FormData): FormResult<RuleValues> {
  let errors: Partial<Record<RuleField, string>> = {}
  let title = text(form, 'title').replace(/\s+/g, ' ').trim()
  if (!title) errors.title = 'Donnez un titre à la règle.'
  else if (title.length > RULE_TITLE_MAX) errors.title = `${RULE_TITLE_MAX} caractères au plus ; un emoji compte pour deux.`

  let body = text(form, 'body').replace(/\r\n/g, '\n').trim()
  if (!body) errors.body = 'Écrivez ce que la règle demande : le modèle ne lit que ce texte.'
  else if (body.length > RULE_TEXT_MAX) errors.body = `${RULE_TEXT_MAX.toLocaleString('fr-FR')} caractères au plus, un emoji comptant pour deux (${body.length.toLocaleString('fr-FR')} ici).`

  let lines = text(form, 'paths')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  let paths = [...new Set(lines)]
  if (paths.length > RULE_PATHS_MAX) errors.paths = `${RULE_PATHS_MAX} motifs au plus.`
  else {
    for (let pattern of paths) {
      let problem = pattern.length > MAX_PATH_LENGTH ? `plus de ${MAX_PATH_LENGTH} caractères` : checkPattern(pattern)
      if (problem) {
        errors.paths = `« ${pattern.slice(0, 60)} » : ${problem}.`
        break
      }
    }
  }

  let floor = text(form, 'severityFloor')
  let severityFloor: SeverityFloor | null = null
  if (isOneOf(SEVERITIES, floor)) severityFloor = floor
  else if (floor !== '') errors.severityFloor = 'Choisissez une priorité, ou « Aucun plancher ».'

  if (Object.keys(errors).length) return { ok: false, errors: errors as Record<string, string> }
  return { ok: true, value: { title, body, paths, severityFloor } }
}

/** The patterns of a rule that a job can carry: within the limits of the protocol, 20 at most. */
export function sendablePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => p.length >= 1 && p.length <= RULE_PATH_MAX).slice(0, RULE_PATHS_MAX)
}

/**
 * Why a job leaves a rule out, or null. The screens never write such a rule; a row written another
 * way can hold one. The protocol counts UTF-16 units (`length`), where `char_length` of Postgres
 * counts characters. A rule that had patterns and keeps none is left out, instead of covering every
 * path. The claim (`jobRules`) and the screens use this one rule.
 */
export function leftOutReason(rule: { title: string; text: string; paths: readonly string[] }): 'too_long' | 'no_pattern' | null {
  if (rule.title.length < 1 || rule.title.length > RULE_TITLE_MAX || rule.text.length < 1 || rule.text.length > RULE_TEXT_MAX) return 'too_long'
  if (rule.paths.length > 0 && sendablePaths(rule.paths).length === 0) return 'no_pattern'
  return null
}
