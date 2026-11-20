// REV-21. The forms of the tab Assignation of a repository: add a rule, move it, remove it. An admin
// of the org only; cop() and csrf() of the session layer ran before.
import { createAction } from 'remix/router'

import { UUID } from '@sakuga-review/protocol'

import { readAssignmentForm } from '../../assignment/model.ts'
import { log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { isAssignmentNotice, type AssignmentFormState, type AssignmentNotice } from '../assignment.tsx'
import { renderConfig } from './config.tsx'
import { forbidden, formValues, isAdmin, redirect, signedOf, type FormContext, type UiKit } from './kit.tsx'

/** What the tab Assignation shows after a form: the notice, or the new rule with its errors. */
export type AssignmentExtra = { form: AssignmentFormState | null; notice: AssignmentNotice | null; noticeRule: string | null }

/** The notice of the assignment rules from the query of a page: `?assign=moved&rule=<id>`. */
export function assignmentNotice(query: URLSearchParams): AssignmentExtra {
  let notice = query.get('assign')
  let rule = query.get('rule')
  return { form: null, notice: isAssignmentNotice(notice) ? notice : null, noticeRule: rule && UUID.test(rule) ? rule : null }
}

/** The tab Assignation of the repository, with a notice and the anchor of the rule. */
function assignmentBack(repoId: string, notice: AssignmentNotice, rule: string | null) {
  let query = new URLSearchParams({ tab: 'assignment', assign: notice })
  if (rule) query.set('rule', rule)
  return redirect(`${pageRoutes.repoConfig.href({ id: repoId })}?${query}#${rule && notice !== 'removed' ? `assignment-${rule}` : 'assignment'}`)
}

export function assignmentActions(kit: UiKit) {
  let { deps } = kit

  async function changeAssignment(context: FormContext & { params: { id: string; rule?: string } }, action: 'add' | 'move' | 'remove') {
    let signed = signedOf(context)
    let store = deps.assignment
    if (!store || !deps.repoConfig) return new Response('Not Found', { status: 404 })
    let login = signed.user.login
    let org = signed.membership.org
    if (!isAdmin(signed, 'assignment.change_refused', { action })) return forbidden()
    let repoId = context.params.id
    let ruleId = action === 'add' ? null : (context.params.rule ?? '')
    if (!UUID.test(repoId) || (ruleId !== null && !UUID.test(ruleId))) return new Response('Not Found', { status: 404 })
    let form = context.get(FormData)
    if (!form) return new Response('Bad Request', { status: 400 })

    if (action === 'add') {
      let parsed = readAssignmentForm(form)
      if (!parsed.ok) {
        let assignment: AssignmentExtra = { form: { values: formValues(form), errors: parsed.errors }, notice: null, noticeRule: null }
        return renderConfig(kit, context, signed, kit.page(context), 'assignment', { assignment }, 422, repoId)
      }
      let outcome = await store.create(org.id, repoId, signed.user.id, parsed.value)
      if (outcome.kind === 'saved') {
        log('info', 'assignment.added', { login, org: org.name, repoId, ruleId: outcome.id, position: outcome.position, action: parsed.value.action, level: parsed.value.level })
        return assignmentBack(repoId, 'added', outcome.id)
      }
      if (outcome.kind === 'full') return assignmentBack(repoId, 'full', null)
      return new Response('Not Found', { status: 404 })
    }
    if (action === 'move') {
      let direction = form.get('direction')
      if (direction !== 'up' && direction !== 'down') return new Response('Bad Request', { status: 400 })
      let outcome = await store.move(org.id, repoId, ruleId!, direction)
      if (outcome.kind === 'saved') {
        log('info', 'assignment.moved', { login, org: org.name, repoId, ruleId, position: outcome.position })
        return assignmentBack(repoId, 'moved', ruleId)
      }
      return assignmentBack(repoId, 'missing', null)
    }
    let outcome = await store.remove(org.id, repoId, ruleId!)
    if (outcome.kind === 'removed') {
      log('info', 'assignment.removed', { login, org: org.name, repoId, ruleId, position: outcome.position })
      return assignmentBack(repoId, 'removed', null)
    }
    return assignmentBack(repoId, 'missing', null)
  }

  return {
    assignmentAdd: createAction(pageRoutes.assignmentAdd, (context) => changeAssignment(context, 'add')),
    assignmentMove: createAction(pageRoutes.assignmentMove, (context) => changeAssignment(context, 'move')),
    assignmentRemove: createAction(pageRoutes.assignmentRemove, (context) => changeAssignment(context, 'remove')),
  }
}
