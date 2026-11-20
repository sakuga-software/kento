// REV-21. The assignment rules of a repository: who and what sets the level of the review of a push,
// as a CODEOWNERS file sets the reviewers. The rules are read in their order, and the first one that
// matches wins; with none, the level of the config applies. No database, no network.
import { isLevel, isOneOf, LEVELS, type Level } from '@kento/protocol'

import { checkPattern, patternToRegExp, type FormResult, type Trigger } from '../repo-config/model.ts'

/** A repository holds at most this many assignment rules. */
export const MAX_ASSIGNMENT_RULES = 20
/** A condition lists at most this many authors, paths or labels. */
export const MAX_CONDITION_VALUES = 20
/** A label of GitHub has 50 characters at most. */
const LABEL_MAX = 50

/** A GitHub login, or the login of an App (`sakuga-agent[bot]`). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
/** The person that a review mentions: a login of a person, not of an App. */
const MENTION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** What a rule does: a review at its level, or no review of a push (a command still creates one). */
export const ASSIGNMENT_ACTIONS = ['review', 'command_only'] as const
export type AssignmentAction = (typeof ASSIGNMENT_ACTIONS)[number]

/** What an admin writes for a rule. Each empty list matches every pull request. */
export interface AssignmentValues {
  authors: string[]
  paths: string[]
  labels: string[]
  action: AssignmentAction
  /** The level of the review; null for `command_only`. */
  level: Level | null
  /** A login that the published review mentions, without `@`; null for none. */
  mention: string | null
}

/** A rule as the webhook reads it, in its order. */
export interface AssignmentRule extends AssignmentValues {
  id: string
  position: number
}

/** The pull request of a push, as the webhook knows it. `files` null: GitHub did not list them. */
export interface PullFacts {
  author: string | null
  labels: readonly string[]
  files: readonly string[] | null
}

/**
 * Why a rule matched, as the review and the screen of the pull request say it. Each key is set when
 * its list is not empty: the author, the first changed file under one of the paths, the first label.
 */
export interface AssignmentReasons {
  author?: string
  path?: string
  label?: string
}

/** The rule that set the level of a job: what `jobs.config.assignment` holds. */
export interface JobAssignment {
  ruleId: string
  position: number
  level: Level
  mention: string | null
  reasons: AssignmentReasons
  /** The trigger of the config when the job was queued, for "at each push". */
  trigger: Trigger
}

/** The matching rule, or null. A rule with paths does not match when GitHub did not list the files. */
export function matchAssignment(
  rules: readonly AssignmentRule[],
  pull: PullFacts,
): { rule: AssignmentRule; reasons: AssignmentReasons } | null {
  let author = pull.author?.toLowerCase() ?? null
  let labels = pull.labels.map((label) => label.toLowerCase())
  for (let rule of [...rules].sort((a, b) => a.position - b.position)) {
    let reasons: AssignmentReasons = {}
    if (rule.authors.length > 0) {
      if (author === null || !rule.authors.some((a) => a.toLowerCase() === author)) continue
      reasons.author = pull.author!
    }
    if (rule.paths.length > 0) {
      if (pull.files === null) continue
      let regexps = rule.paths.map(patternToRegExp)
      let file = pull.files.find((f) => regexps.some((re) => re.test(f)))
      if (file === undefined) continue
      reasons.path = file
    }
    if (rule.labels.length > 0) {
      let wanted = new Set(rule.labels.map((l) => l.toLowerCase()))
      let index = labels.findIndex((l) => wanted.has(l))
      if (index < 0) continue
      reasons.label = pull.labels[index]!
    }
    return { rule, reasons }
  }
  return null
}

/**
 * The positions of the rules with paths that a push could not test, because GitHub did not list the
 * files: the ones before the rule that matched, or all of them when none matched. Empty when the
 * files are known.
 */
export function unreadPathRules(rules: readonly AssignmentRule[], files: readonly string[] | null, matched: AssignmentRule | null): number[] {
  if (files !== null) return []
  return rules
    .filter((rule) => rule.paths.length > 0 && (matched === null || rule.position < matched.position))
    .map((rule) => rule.position)
    .sort((a, b) => a - b)
}

/** `jobs.config.assignmentUnread`: the positions of `unreadPathRules`, or an empty list. */
export function readUnreadPathRules(config: unknown): number[] {
  let value = typeof config === 'string' ? safeParse(config) : config
  if (!isObject(value) || !Array.isArray(value.assignmentUnread)) return []
  return value.assignmentUnread.filter((n): n is number => Number.isInteger(n) && (n as number) >= 1).slice(0, 20)
}

/**
 * "Assignment: without the list of the files of the PR, Kentō could not test rule 1 (paths)."
 * The list is missing when GitHub did not give it, or when the rule came while the push was read.
 */
export function unreadPathsLine(positions: readonly number[]): string {
  if (positions.length === 0) return ''
  let rules = positions.length === 1 ? `rule ${positions[0]}` : `rules ${positions.join(', ')}`
  return `Assignment: without the list of the files of the PR, Kentō could not test ${rules} (paths).`
}

/** Whether a rule needs the changed files of the pull request: GitHub is read only then. */
export function needsFiles(rules: readonly AssignmentRule[]): boolean {
  return rules.some((rule) => rule.paths.length > 0)
}

const TRIGGER_WORDS: Record<Trigger, string> = {
  push: 'at each push',
  ready: 'when the PR becomes "Ready for review"',
  command: 'on request',
}

/** "the author is sakuga-agent[bot] and the PR changes db/migrations/0002.sql". */
export function reasonsText(reasons: AssignmentReasons): string {
  let parts: string[] = []
  if (reasons.author !== undefined) parts.push(`the author is ${reasons.author}`)
  if (reasons.path !== undefined) parts.push(`the PR changes ${reasons.path}`)
  if (reasons.label !== undefined) parts.push(`the PR has the label "${reasons.label}"`)
  return parts.join(' and ')
}

/** "Assignment: rule 1, the author is sakuga-agent[bot], so balanced at each push." */
export function assignmentLine(assignment: JobAssignment): string {
  return `Assignment: rule ${assignment.position}, ${reasonsText(assignment.reasons)}, so ${assignment.level} ${TRIGGER_WORDS[assignment.trigger]}.`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The assignment of `jobs.config`, or null: a job of a command, of a retry, or queued before REV-21. */
export function readJobAssignment(config: unknown): JobAssignment | null {
  let value = typeof config === 'string' ? safeParse(config) : config
  if (!isObject(value) || !isObject(value.assignment)) return null
  let a = value.assignment
  let reasons = isObject(a.reasons) ? a.reasons : {}
  let text = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 300 ? v : undefined)
  let read: AssignmentReasons = {}
  for (let key of ['author', 'path', 'label'] as const) {
    let v = text(reasons[key])
    if (v !== undefined) read[key] = v
  }
  if (typeof a.ruleId !== 'string' || !Number.isInteger(a.position) || (a.position as number) < 1) return null
  if (!isLevel(a.level) || !isOneOf(['push', 'ready', 'command'] as const, a.trigger)) return null
  if (Object.keys(read).length === 0) return null
  let mention = typeof a.mention === 'string' && MENTION.test(a.mention) ? a.mention : null
  return { ruleId: a.ruleId, position: a.position as number, level: a.level, mention, reasons: read, trigger: a.trigger }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// --- The form of the screen ---------------------------------------------------------------------

/** The fields of the form of a rule, in their order: the first one in error gets the focus. */
export const ASSIGNMENT_FIELDS = ['authors', 'paths', 'labels', 'outcome', 'mention'] as const
export type AssignmentField = (typeof ASSIGNMENT_FIELDS)[number]

/** The choices of "Then" in the form: a level, or no automatic review. */
export const OUTCOMES = [...LEVELS, 'command_only'] as const
export type Outcome = (typeof OUTCOMES)[number]

function text(form: FormData, name: string): string {
  let value = form.get(name)
  return typeof value === 'string' ? value : ''
}

/** Values separated by new lines or commas, trimmed, without duplicates. */
function list(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ]
}

/** The values of the form of a rule, or the error of each field. */
export function readAssignmentForm(form: FormData): FormResult<AssignmentValues> {
  let errors: Partial<Record<AssignmentField, string>> = {}

  let authors = [...new Set(list(text(form, 'authors')).map((a) => a.replace(/^@/, '')))]
  let badAuthor = authors.find((a) => !LOGIN.test(a))
  if (authors.length > MAX_CONDITION_VALUES) errors.authors = `${MAX_CONDITION_VALUES} authors at most.`
  else if (badAuthor !== undefined) errors.authors = `"${badAuthor.slice(0, 60)}" is not a GitHub login.`

  let paths = list(text(form, 'paths'))
  if (paths.length > MAX_CONDITION_VALUES) errors.paths = `${MAX_CONDITION_VALUES} patterns at most.`
  else {
    for (let pattern of paths) {
      let problem = checkPattern(pattern)
      if (problem) {
        errors.paths = `"${pattern.slice(0, 60)}": ${problem}.`
        break
      }
    }
  }

  let labels = list(text(form, 'labels'))
  if (labels.length > MAX_CONDITION_VALUES) errors.labels = `${MAX_CONDITION_VALUES} labels at most.`
  else if (labels.some((l) => l.length > LABEL_MAX)) errors.labels = `A GitHub label has ${LABEL_MAX} characters at most.`

  if (!errors.authors && !errors.paths && !errors.labels && authors.length + paths.length + labels.length === 0) {
    errors.authors = 'Give at least one author, path or label. A rule without a condition would take every PR.'
  }

  let outcome = text(form, 'outcome')
  if (!isOneOf(OUTCOMES, outcome)) errors.outcome = 'Choose a level, or "No automatic review".'

  let mentionText = text(form, 'mention').trim().replace(/^@/, '')
  let mention: string | null = mentionText || null
  if (mention !== null && !MENTION.test(mention)) errors.mention = 'The GitHub login of a person, for example octocat.'
  else if (mention !== null && outcome === 'command_only') errors.mention = 'Without an automatic review, there is no review to mention someone in.'

  if (Object.keys(errors).length || !isOneOf(OUTCOMES, outcome)) return { ok: false, errors: errors as Record<string, string> }
  let action: AssignmentAction = outcome === 'command_only' ? 'command_only' : 'review'
  return { ok: true, value: { authors, paths, labels, action, level: outcome === 'command_only' ? null : outcome, mention } }
}
