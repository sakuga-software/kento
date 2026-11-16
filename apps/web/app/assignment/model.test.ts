import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { assignmentNote } from '../publish/publish.ts'
import { assignmentLine, matchAssignment, needsFiles, readAssignmentForm, readJobAssignment, readUnreadPathRules, unreadPathRules, unreadPathsLine, type AssignmentRule, type JobAssignment } from './model.ts'

const AGENT: AssignmentRule = {
  id: 'r1',
  position: 1,
  authors: ['sakuga-agent[bot]'],
  paths: [],
  labels: [],
  action: 'review',
  level: 'balanced',
  mention: null,
}
const MIGRATIONS: AssignmentRule = {
  id: 'r2',
  position: 2,
  authors: [],
  paths: ['**/migrations/**'],
  labels: [],
  action: 'review',
  level: 'heavy',
  mention: 'alex',
}
const WIP: AssignmentRule = { id: 'r3', position: 3, authors: [], paths: [], labels: ['wip'], action: 'command_only', level: null, mention: null }
const RULES = [AGENT, MIGRATIONS, WIP]

function form(values: Record<string, string>): FormData {
  let data = new FormData()
  for (let [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

describe('the assignment rules of a repository (REV-21)', () => {
  it('gives the pull request of the agent balanced, by rule 1', () => {
    let match = matchAssignment(RULES, { author: 'sakuga-agent[bot]', labels: [], files: ['db/migrations/0002.sql'] })
    assert.equal(match?.rule.id, 'r1', 'the first rule that matches wins, even when a later one matches too')
    assert.deepEqual(match?.reasons, { author: 'sakuga-agent[bot]' })
  })

  it('gives a pull request of a person that touches a migration heavy, with the first file under the paths', () => {
    let match = matchAssignment(RULES, { author: 'camille', labels: [], files: ['src/a.ts', 'apps/web/drizzle/migrations/0016.sql'] })
    assert.equal(match?.rule.id, 'r2')
    assert.deepEqual(match?.reasons, { path: 'apps/web/drizzle/migrations/0016.sql' })
  })

  it('gives no rule to a pull request that matches none: the level of the config applies', () => {
    assert.equal(matchAssignment(RULES, { author: 'camille', labels: ['docs'], files: ['README.md'] }), null)
    assert.equal(matchAssignment([], { author: 'camille', labels: [], files: [] }), null)
  })

  it('reads a login and a label in any case, and needs every list that is set', () => {
    assert.equal(matchAssignment(RULES, { author: 'Sakuga-Agent[bot]', labels: [], files: [] })?.rule.id, 'r1')
    assert.equal(matchAssignment(RULES, { author: 'camille', labels: ['WIP'], files: [] })?.rule.id, 'r3')
    let both: AssignmentRule = { ...AGENT, id: 'both', paths: ['docs/**'] }
    assert.equal(matchAssignment([both], { author: 'sakuga-agent[bot]', labels: [], files: ['src/a.ts'] }), null)
    assert.deepEqual(matchAssignment([both], { author: 'sakuga-agent[bot]', labels: [], files: ['docs/a.md'] })?.reasons, {
      author: 'sakuga-agent[bot]',
      path: 'docs/a.md',
    })
  })

  it('skips a rule with paths when GitHub did not list the files, and reads the next one', () => {
    let match = matchAssignment([MIGRATIONS, WIP], { author: 'camille', labels: ['wip'], files: null })
    assert.equal(match?.rule.id, 'r3')
    assert.equal(needsFiles([AGENT, WIP]), false)
    assert.equal(needsFiles(RULES), true)
  })

  it('reads the rules in the order of their position, not of the list', () => {
    assert.equal(matchAssignment([MIGRATIONS, AGENT], { author: 'sakuga-agent[bot]', labels: [], files: ['x/migrations/1.sql'] })?.rule.id, 'r1')
  })
})

describe('the rules with paths that GitHub kept from being tested (REV-21)', () => {
  let rule = (position: number, paths: string[], authors: string[] = []): AssignmentRule => ({
    id: `r${position}`,
    position,
    authors,
    paths,
    labels: [],
    action: 'review',
    level: 'heavy',
    mention: null,
  })

  it('lists the rules with paths before the one that matched, or all of them, only when the files are unknown', () => {
    let rules = [rule(1, ['**/migrations/**']), rule(2, [], ['camille']), rule(3, ['src/**'])]
    assert.deepEqual(unreadPathRules(rules, null, rules[1]!), [1])
    assert.deepEqual(unreadPathRules(rules, null, null), [1, 3])
    assert.deepEqual(unreadPathRules(rules, ['a.ts'], null), [])
    assert.equal(unreadPathsLine([1]), 'Assignment: without the list of the files of the PR, Kentō could not test rule 1 (paths).')
    assert.deepEqual(readUnreadPathRules({ assignmentUnread: [1, 'x', 0, 3] }), [1, 3])
    assert.deepEqual(readUnreadPathRules(null), [])
    // With a rule that applied: its line first, then the rules that could not be tested, then the mention.
    let applied: JobAssignment = { ruleId: 'r2', position: 2, level: 'heavy', mention: 'alex', reasons: { author: 'camille' }, trigger: 'push' }
    assert.equal(
      assignmentNote(applied, [1]),
      '\n\n<sub>Assignment: rule 2, the author is camille, so heavy at each push.</sub>\n\n<sub>Assignment: without the list of the files of the PR, Kentō could not test rule 1 (paths).</sub>\n\nReview requested by the rule: @alex',
    )
  })
})

describe('what the review and the screen of the pull request say (REV-21)', () => {
  let assignment: JobAssignment = { ruleId: 'r1', position: 1, level: 'balanced', mention: null, reasons: { author: 'sakuga-agent[bot]' }, trigger: 'push' }

  it('names the rule, why it matched and the level', () => {
    assert.equal(assignmentLine(assignment), 'Assignment: rule 1, the author is sakuga-agent[bot], so balanced at each push.')
    assert.equal(
      assignmentLine({ ...assignment, position: 2, level: 'heavy', reasons: { path: 'db/migrations/1.sql', label: 'risky' }, trigger: 'ready' }),
      'Assignment: rule 2, the PR changes db/migrations/1.sql and the PR has the label "risky", so heavy when the PR becomes "Ready for review".',
    )
  })

  it('adds the line to the body of the review, and the mention of the rule', () => {
    assert.equal(assignmentNote(null), '')
    assert.equal(assignmentNote(assignment), '\n\n<sub>Assignment: rule 1, the author is sakuga-agent[bot], so balanced at each push.</sub>')
    assert.match(assignmentNote({ ...assignment, mention: 'alex' }), /\n\nReview requested by the rule: @alex$/)
  })

  it('reads the assignment of jobs.config back, and nothing from a job without one', () => {
    assert.deepEqual(readJobAssignment({ repoConfigVersion: 0, assignment }), assignment)
    assert.deepEqual(readJobAssignment(JSON.stringify({ assignment })), assignment)
    assert.equal(readJobAssignment({ repoConfigVersion: 0 }), null)
    assert.equal(readJobAssignment(null), null)
    assert.equal(readJobAssignment({ assignment: { ...assignment, level: 'ultra' } }), null)
    assert.equal(readJobAssignment({ assignment: { ...assignment, reasons: {} } }), null)
    // A mention that is not a login is dropped, never written in the review.
    assert.equal(readJobAssignment({ assignment: { ...assignment, mention: 'x y' } })?.mention, null)
  })
})

describe('the form of an assignment rule (REV-21)', () => {
  it('reads the authors, the paths, the labels, the level and the mention', () => {
    let result = readAssignmentForm(
      form({ authors: '@sakuga-agent[bot], renovate[bot], sakuga-agent[bot]', paths: '**/migrations/**\n\nsrc/*.ts', labels: 'risky, db', outcome: 'heavy', mention: '@alex' }),
    )
    assert.deepEqual(result, {
      ok: true,
      value: {
        authors: ['sakuga-agent[bot]', 'renovate[bot]'],
        paths: ['**/migrations/**', 'src/*.ts'],
        labels: ['risky', 'db'],
        action: 'review',
        level: 'heavy',
        mention: 'alex',
      },
    })
  })

  it('keeps the first error of the mention: a login of an App, even with "No automatic review"', () => {
    let form = new FormData()
    form.set('authors', 'camille')
    form.set('outcome', 'command_only')
    form.set('mention', 'renovate[bot]')
    let read = readAssignmentForm(form)
    assert.deepEqual(read.ok ? null : read.errors.mention, 'The GitHub login of a person, for example alex.')
  })

  it('reads "No automatic review" as a rule with no level', () => {
    assert.deepEqual(readAssignmentForm(form({ labels: 'wip', outcome: 'command_only' })), {
      ok: true,
      value: { authors: [], paths: [], labels: ['wip'], action: 'command_only', level: null, mention: null },
    })
  })

  it('refuses a rule with no condition, a bad login, a bad path, an unknown outcome or a mention without a review', () => {
    let empty = readAssignmentForm(form({ outcome: 'balanced' }))
    assert.equal(empty.ok, false)
    assert.match(String(!empty.ok && empty.errors.authors), /at least one author, path or label/)
    let bad = readAssignmentForm(form({ authors: 'not a login', paths: '/abs', outcome: 'ultra', mention: 'a b' }))
    assert.deepEqual(Object.keys(!bad.ok ? bad.errors : {}).sort(), ['authors', 'mention', 'outcome', 'paths'])
    let silent = readAssignmentForm(form({ labels: 'wip', outcome: 'command_only', mention: 'alex' }))
    assert.match(String(!silent.ok && silent.errors.mention), /no review to mention someone in/)
  })
})
