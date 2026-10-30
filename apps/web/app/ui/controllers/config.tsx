// REV-12. The Config screen of a repository: a member reads it, an admin changes it, one key at a time.
import { createAction } from 'remix/router'

import { UUID, type Level } from '@sakuga-review/protocol'

import { log } from '../../log.ts'
import {
  CONFIG_FIELDS,
  hasField,
  readCapForm,
  readLevelForm,
  readModelsForm,
  readPathsForm,
  readTriggerForm,
  withoutField,
  type ConfigField,
  type ConfigOverrides,
} from '../../repo-config/model.ts'
import type { SaveOutcome } from '../../repo-config/store.ts'
import { pageRoutes } from '../../routes.ts'
import { ConfigPage, isConfigTab, tabOf, type ConfigForm, type ConfigNotice, type ConfigTab } from '../config.tsx'
import type { PageFrame } from '../shell.tsx'
import { forbidden, formValues, isAdmin, redirect, REPOS_EXIT, rulesNotice, signedOf, type FormContext, type RulesExtra, type ScreenContext, type SignedIn, type UiKit } from './kit.tsx'
import { conflictNotice, parseField, readVersionedForm, type FieldParsers } from './versioned.ts'

type RepoConfig = { config: ConfigOverrides; defaultLevel: Level }

/** The Config page of the repository `repoId`, on its tab, or the 404 of a repository that the org does not have. */
export async function renderConfig(
  kit: UiKit,
  context: ScreenContext,
  signed: SignedIn,
  page: PageFrame,
  tab: ConfigTab,
  extra: { notice?: ConfigNotice | null; form?: ConfigForm | null; rules?: RulesExtra },
  status: number,
  repoId: string,
) {
  let { deps } = kit
  let configDeps = deps.repoConfig!
  let orgId = signed.membership.org.id
  let view = await configDeps.store.read(orgId, repoId)
  if (!view) return kit.errorPage(context, 404, 'repo', 'repos')
  let providers = await configDeps.providers.list(orgId)
  // REV-19. The tab Règles reads the rules; the other tabs only need to know that it exists.
  let rules = deps.rules
    ? tab === 'rules'
      ? {
          list: await deps.rules.list(orgId, view.id),
          orgActive: await deps.rules.activeOrgRules(orgId),
          form: extra.rules?.form ?? null,
          notice: extra.rules?.notice ?? null,
          noticeRule: extra.rules?.noticeRule ?? null,
        }
      : { list: [], orgActive: 0, form: null, notice: null, noticeRule: null }
    : null
  return context.render(
    <ConfigPage frame={page} view={view} providers={providers} tab={tab} notice={extra.notice ?? null} form={extra.form ?? null} rules={rules} />,
    { status },
  )
}

export function configActions(kit: UiKit) {
  let { deps } = kit

  async function changeConfig(context: FormContext & { params: { id: string } }, reset: boolean) {
    let signed = signedOf(context)
    let configDeps = deps.repoConfig
    if (!configDeps) return kit.errorPage(context, 404, 'page', 'repos', REPOS_EXIT)
    if (!isAdmin(signed, 'repo_config.change_refused')) return forbidden()
    let id = context.params.id
    if (!UUID.test(id)) return kit.errorPage(context, 404, 'repo', 'repos')
    let read = readVersionedForm(context.get(FormData), CONFIG_FIELDS)
    if (!read) return kit.errorPage(context, 400, 'form', 'repos', { href: pageRoutes.repoConfig.href({ id }), label: 'Revenir à la config du repo' })
    let { form, field: key, version } = read
    let tab = tabOf(key)
    let page = kit.page(context)

    let change: (current: RepoConfig) => RepoConfig
    if (reset) {
      // The column goes back to `lite` with the key: the level of the org then applies (REV-13).
      change = (current) => ({ config: withoutField(current.config, key), defaultLevel: key === 'level' ? 'lite' : current.defaultLevel })
    } else {
      let parsers: FieldParsers<ConfigField> = {
        level: readLevelForm,
        trigger: readTriggerForm,
        paths: readPathsForm,
        monthlyCapUsd: readCapForm,
        models: async (form) => readModelsForm(form, await configDeps.providers.list(signed.membership.org.id)),
      }
      let parsed = await parseField(parsers, key, form)
      if (!parsed.ok) {
        return renderConfig(kit, context, signed, page, tab, { form: { field: key, values: formValues(form), errors: parsed.errors } }, 422, id)
      }
      let value = parsed.value
      change = (current) => {
        // The column keeps the level too: a release before REV-13 reads only the column.
        if (key === 'level') {
          let level = value as Level
          return { config: { ...current.config, level }, defaultLevel: level }
        }
        let config: ConfigOverrides = { ...current.config }
        if (key.startsWith('models.')) {
          let level = key.slice('models.'.length) as Level
          config.models = { ...config.models, [level]: value }
        } else {
          ;(config as Record<string, unknown>)[key] = value
        }
        return { ...current, config }
      }
    }

    let outcome: SaveOutcome = await configDeps.store.save(signed.membership.org.id, id, signed.user.id, version, (current) => {
      // « Revenir à l'org » on a key that the repository does not set changes nothing, but still
      // writes a version: the person sees which version they are on.
      if (reset && !hasField(current.config, key) && !(key === 'level' && current.defaultLevel !== 'lite')) return current
      return change(current)
    })
    if (outcome.kind === 'not_found') return kit.errorPage(context, 404, 'repo', 'repos')
    if (outcome.kind === 'conflict') {
      log('info', 'repo_config.conflict', { login: signed.user.login, repoId: id, field: key, sent: version, current: outcome.version })
      return renderConfig(kit, context, signed, page, tab, { notice: conflictNotice(outcome) }, 409, id)
    }
    log('info', reset ? 'repo_config.reset' : 'repo_config.saved', {
      login: signed.user.login,
      org: signed.membership.org.login,
      repo: outcome.fullName,
      field: key,
      version: outcome.version,
    })
    let query = new URLSearchParams({ tab, done: reset ? 'reset' : 'saved', v: String(outcome.version) })
    return redirect(`${pageRoutes.repoConfig.href({ id })}?${query}`)
  }

  return {
    repoConfig: createAction(pageRoutes.repoConfig, async (context) => {
      let signed = signedOf(context)
      if (!deps.repoConfig) return kit.errorPage(context, 404, 'page', 'repos', REPOS_EXIT)
      if (!UUID.test(context.params.id)) return kit.errorPage(context, 404, 'repo', 'repos')
      let page = kit.page(context)
      let query = context.url.searchParams
      let tab = query.get('tab')
      let done = query.get('done')
      let version = Number(query.get('v'))
      let notice: ConfigNotice | null =
        (done === 'saved' || done === 'reset') && Number.isSafeInteger(version) && version > 0 ? { kind: done, version } : null
      return renderConfig(kit, context, signed, page, isConfigTab(tab) ? tab : 'models', { notice, rules: rulesNotice(query) }, 200, context.params.id)
    }),
    // cop() and csrf() of the session layer ran before.
    repoConfigSave: createAction(pageRoutes.repoConfigSave, (context) => changeConfig(context, false)),
    repoConfigReset: createAction(pageRoutes.repoConfigReset, (context) => changeConfig(context, true)),
  }
}
