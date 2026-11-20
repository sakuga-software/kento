// REV-19. The forms of the rules, from the tab Rules of a repository or from the settings: add, save,
// disable or enable, remove. An admin of the org only.
import { createAction } from 'remix/router'

import { UUID } from '@kento-review/protocol'

import { log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { readRuleForm } from '../../rules/model.ts'
import type { RuleOutcome } from '../../rules/store.ts'
import type { RuleNotice } from '../rules.tsx'
import { renderConfig } from './config.tsx'
import { forbidden, formValues, isAdmin, readVersion, redirect, signedOf, type FormContext, type RulesExtra, type UiKit } from './kit.tsx'
import { renderSettings } from './settings.tsx'

/** Where a form of a rule goes back: the tab Rules of its repository, or the section Org rules. */
function rulesBack(repoId: string | null, notice: RuleNotice, ruleId: string | null) {
  let query = new URLSearchParams({ rules: notice })
  if (ruleId) query.set('rule', ruleId)
  let anchor = ruleId && notice !== 'removed' ? `rule-${ruleId}` : repoId ? 'rules' : 'org-rules'
  if (repoId) {
    query.set('tab', 'rules')
    return redirect(`${pageRoutes.repoConfig.href({ id: repoId })}?${query}#${anchor}`)
  }
  return redirect(`${pageRoutes.settings.href()}?${query}#${anchor}`)
}

export function rulesActions(kit: UiKit) {
  let { deps } = kit

  /**
   * One form of a rule. cop() and csrf() of the session layer ran before. The field `repo` names the
   * repository of the rule, or is empty for a rule of the org.
   */
  async function changeRule(context: FormContext & { params: { id?: string } }, action: 'add' | 'save' | 'active' | 'remove') {
    let signed = signedOf(context)
    let store = deps.rules
    if (!store) return new Response('Not Found', { status: 404 })
    let login = signed.user.login
    let org = signed.membership.org
    if (!isAdmin(signed, 'rules.change_refused', { action })) return forbidden()
    let form = context.get(FormData)
    let repoField = form?.get('repo') ?? context.url.searchParams.get('repo') ?? ''
    if (typeof repoField !== 'string' || (repoField !== '' && !UUID.test(repoField))) return new Response('Bad Request', { status: 400 })
    let repoId = repoField === '' ? null : repoField
    // The rules of a repository live on its Config screen: without that screen, there is none to write.
    if (repoId !== null && !deps.repoConfig) return new Response('Not Found', { status: 404 })
    let ruleId = action === 'add' ? null : (context.params.id ?? '')
    if (ruleId !== null && !UUID.test(ruleId)) return new Response('Not Found', { status: 404 })
    let version = readVersion(form)
    if (!form || ((action === 'save' || action === 'active') && version === null)) return new Response('Bad Request', { status: 400 })

    if (action === 'remove') {
      let removed = await store.remove(org.id, ruleId!)
      if (removed) log('info', 'rules.removed', { login, org: org.login, ruleId, repoId: removed.repoId, title: removed.title })
      return rulesBack(removed ? removed.repoId : repoId, removed ? 'removed' : 'missing', null)
    }

    let outcome: RuleOutcome
    if (action === 'active') {
      let active = form.get('active')
      if (active !== 'true' && active !== 'false') return new Response('Bad Request', { status: 400 })
      outcome = await store.setActive(org.id, ruleId!, signed.user.id, version!, active === 'true')
      if (outcome.kind === 'saved') {
        log('info', active === 'true' ? 'rules.enabled' : 'rules.disabled', { login, org: org.login, ruleId, repoId: outcome.repoId, version: outcome.version })
        return rulesBack(outcome.repoId, active === 'true' ? 'enabled' : 'disabled', ruleId)
      }
    } else {
      let parsed = readRuleForm(form)
      if (!parsed.ok) {
        let rules: RulesExtra = { form: { ruleId, values: formValues(form), errors: parsed.errors }, notice: null, noticeRule: null }
        let page = kit.page(context)
        if (repoId) return renderConfig(kit, context, signed, page, 'rules', { rules }, 422, repoId)
        return renderSettings(kit, context, signed, page, { rules }, 422)
      }
      outcome = action === 'add' ? await store.create(org.id, repoId, signed.user.id, parsed.value) : await store.update(org.id, ruleId!, signed.user.id, version!, parsed.value)
      if (outcome.kind === 'saved') {
        log('info', action === 'add' ? 'rules.added' : 'rules.saved', { login, org: org.login, ruleId: outcome.id, repoId: outcome.repoId, version: outcome.version })
        return rulesBack(outcome.repoId, action === 'add' ? 'added' : 'saved', outcome.id)
      }
    }
    if (outcome.kind === 'conflict') {
      log('info', 'rules.conflict', { login, org: org.login, ruleId, sent: version, current: outcome.version })
      return rulesBack(repoId, 'conflict', ruleId)
    }
    if (outcome.kind === 'full') return rulesBack(repoId, 'full', null)
    // A rule removed meanwhile, or a repository of another org.
    if (action === 'add') return new Response('Not Found', { status: 404 })
    return rulesBack(repoId, 'missing', null)
  }

  return {
    ruleAdd: createAction(pageRoutes.ruleAdd, (context) => changeRule(context, 'add')),
    ruleSave: createAction(pageRoutes.ruleSave, (context) => changeRule(context, 'save')),
    ruleActive: createAction(pageRoutes.ruleActive, (context) => changeRule(context, 'active')),
    ruleRemove: createAction(pageRoutes.ruleRemove, (context) => changeRule(context, 'remove')),
  }
}
