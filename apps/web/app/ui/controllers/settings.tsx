// REV-11 and REV-13. The settings of the org: a member reads them; an admin changes the limits, the
// defaults, the trusted bots and the providers with their keys.
import { createAction } from 'remix/router'

import { canEdit } from '../../auth/access.ts'

import { onRunnerNetwork } from '@kento-review/engine/presets'
import { UUID, type Level } from '@kento-review/protocol'

import { log } from '../../log.ts'
import { readCapsForm, readTrustedBotsForm } from '../../org-settings/model.ts'
import type { OrgSaveOutcome, OrgSettingsValues } from '../../org-settings/store.ts'
import { readKeyForm, readProviderForm } from '../../providers/form.ts'
import { choiceById } from '../../providers/presets.ts'
import { SecretsError } from '../../providers/secrets.ts'
import { readLevelForm, readModelsForm, withoutField, type ConfigField } from '../../repo-config/model.ts'
import { pageRoutes } from '../../routes.ts'
import { anchorOf, ORG_FIELDS, ORG_RESET_FIELDS, type OrgField, type OrgForm, type OrgNotice, type OrgSectionProps } from '../org-settings.tsx'
import { PROVIDER_NOTICES, SettingsPage, type ProviderNotice, type SettingsPageProps } from '../settings.tsx'
import type { PageFrame } from '../shell.tsx'
import type { ProvidersDependencies } from './deps.ts'
import {
  forbidden,
  formValues,
  isAdmin,
  PlaceholderPage,
  redirect,
  rulesNotice,
  SETTINGS_EXIT,
  signedOf,
  type FormContext,
  type RulesExtra,
  type ScreenContext,
  type SignedIn,
  type UiKit,
} from './kit.tsx'
import { conflictNotice, parseField, readVersionedForm, type FieldParsers } from './versioned.ts'

export type SettingsExtra = Pick<SettingsPageProps, 'notice' | 'form' | 'chosen' | 'keyError'> & {
  orgNotice?: OrgNotice | null
  orgForm?: OrgForm | null
  rules?: RulesExtra
}

/** The settings page: the section of the org, the providers and the rules of the org. */
export async function renderSettings(kit: UiKit, context: ScreenContext, signed: SignedIn, page: PageFrame, extra: SettingsExtra, status = 200) {
  let { deps } = kit
  let providers = deps.providers
  let orgId = signed.membership.org.id
  let list = providers ? await providers.store.list(orgId) : null
  let org: OrgSectionProps | null = null
  let settings = deps.orgSettings
  let view = settings ? await settings.store.read(orgId) : null
  if (settings && view) {
    org = {
      view,
      app: settings.readAppStatus ? await settings.readAppStatus(view.githubInstallationId) : null,
      providers: await settings.providers.list(orgId),
      webhookUrl: settings.webhookUrl,
      webhookSecret: settings.webhookSecret,
      version: deps.version,
      commit: deps.commit,
      now: new Date(kit.now()),
      notice: extra.orgNotice ?? null,
      form: extra.orgForm ?? null,
    }
  }
  let { orgNotice: _notice, orgForm: _form, rules: rulesExtra, ...providerExtra } = extra
  let rules = deps.rules
    ? {
        list: await deps.rules.list(orgId, null),
        form: rulesExtra?.form ?? null,
        notice: rulesExtra?.notice ?? null,
        noticeRule: rulesExtra?.noticeRule ?? null,
      }
    : null
  return context.render(
    <SettingsPage
      frame={page}
      providers={list}
      org={org}
      rules={rules}
      now={new Date(kit.now())}
      secretsConfigured={providers?.secretsConfigured ?? false}
      serviceKey={providers?.serviceKey ?? false}
      {...providerExtra}
    />,
    { status },
  )
}

// The notice is a fixed word: no text of the URL is ever written into the page.
function toSettings(notice: ProviderNotice, id?: string) {
  return redirect(`${pageRoutes.settings.href()}?notice=${notice}${id ? `#provider-${id}` : ''}`)
}

export function settingsActions(kit: UiKit) {
  let { deps } = kit

  /**
   * REV-13. One form of the settings of the org: the limits, the trusted bots, the level or the
   * models of a level of the defaults. An admin only; cop() and csrf() of the session layer ran
   * before. `reset` removes a default of the org: the repositories then inherit the value of Kentō.
   */
  async function changeOrgSettings(context: FormContext, reset: boolean) {
    let signed = signedOf(context)
    let settings = deps.orgSettings
    if (!settings) return kit.errorPage(context, 404, 'page', 'settings', SETTINGS_EXIT)
    if (!isAdmin(signed, 'org_settings.change_refused')) return forbidden()
    let read = readVersionedForm<OrgField>(context.get(FormData), reset ? ORG_RESET_FIELDS : ORG_FIELDS)
    if (!read) return kit.errorPage(context, 400, 'form', 'settings', SETTINGS_EXIT)
    let { form, field: key, version } = read
    let orgId = signed.membership.org.id
    let page = kit.page(context)

    let change: (current: OrgSettingsValues) => OrgSettingsValues
    if (reset) {
      change = (current) => ({ ...current, config: withoutField(current.config, key as ConfigField) })
    } else {
      let parsers: FieldParsers<OrgField> = {
        caps: readCapsForm,
        trustedBots: readTrustedBotsForm,
        level: readLevelForm,
        models: async (form) => readModelsForm(form, await settings.providers.list(orgId)),
      }
      let parsed = await parseField(parsers, key, form)
      if (!parsed.ok) {
        return renderSettings(kit, context, signed, page, { orgForm: { field: key, values: formValues(form), errors: parsed.errors } }, 422)
      }
      let value = parsed.value
      change = (current) => {
        if (key === 'caps') return { ...current, caps: value as OrgSettingsValues['caps'] }
        if (key === 'trustedBots') return { ...current, trustedBots: value as string[] }
        if (key === 'level') return { ...current, config: { ...current.config, level: value as Level } }
        let level = key.slice('models.'.length) as Level
        return { ...current, config: { ...current.config, models: { ...current.config.models, [level]: value } } }
      }
    }

    // What changed, for the log: set by the save, inside its transaction.
    let changed: { before: OrgSettingsValues; after: OrgSettingsValues } | undefined
    let outcome: OrgSaveOutcome = await settings.store.save(orgId, signed.user.id, version, (current) => {
      let after = change(current)
      changed = { before: current, after }
      return after
    })
    if (outcome.kind === 'not_found') return kit.errorPage(context, 404, 'page', 'settings', SETTINGS_EXIT)
    if (outcome.kind === 'conflict') {
      log('info', 'org_settings.conflict', { login: signed.user.login, org: signed.membership.org.name, field: key, sent: version, current: outcome.version })
      return renderSettings(kit, context, signed, page, { orgNotice: conflictNotice(outcome) }, 409)
    }
    // The log keeps what changed for the cost and the rights: the limits and the bots, before and after.
    log('info', reset ? 'org_settings.reset' : 'org_settings.saved', {
      login: signed.user.login,
      org: signed.membership.org.name,
      field: key,
      version: outcome.version,
      ...(key === 'caps' && changed ? { before: changed.before.caps, after: changed.after.caps } : {}),
      ...(key === 'trustedBots' && changed ? { before: changed.before.trustedBots, after: changed.after.trustedBots } : {}),
    })
    let query = new URLSearchParams({ org: reset ? 'reset' : 'saved', v: String(outcome.version) })
    return redirect(`${pageRoutes.settings.href()}?${query}#${anchorOf(key)}`)
  }

  /** The providers and the signed-in admin of a form of the section, or the 403 to send. */
  function providerAdmin(context: ScreenContext, action: string): { signed: SignedIn; providers: ProvidersDependencies } | Response {
    let signed = signedOf(context)
    if (!deps.providers || !canEdit(signed.membership.role)) {
      log('warn', 'providers.change_refused', { login: signed.user.login, org: signed.membership.org.name, action, reason: 'not an admin' })
      return forbidden()
    }
    return { signed, providers: deps.providers }
  }

  return {
    settings: createAction(pageRoutes.settings, async (context) => {
      let signed = signedOf(context)
      let page = kit.page(context)
      if (!deps.providers && !deps.orgSettings && !deps.rules) return context.render(<PlaceholderPage frame={page} section="settings" />)
      let query = context.url.searchParams
      let notice = query.get('notice')
      let done = query.get('org')
      let version = Number(query.get('v'))
      return renderSettings(kit, context, signed, page, {
        notice: notice !== null && notice in PROVIDER_NOTICES ? { kind: notice as ProviderNotice } : null,
        // KNT-204. The picker of "Add a provider": an id that it does not offer opens nothing.
        chosen: choiceById(query.get('preset')),
        orgNotice: (done === 'saved' || done === 'reset') && Number.isSafeInteger(version) && version > 0 ? { kind: done, version } : null,
        rules: rulesNotice(query),
      })
    }),

    orgSettingsSave: createAction(pageRoutes.orgSettingsSave, (context) => changeOrgSettings(context, false)),
    orgSettingsReset: createAction(pageRoutes.orgSettingsReset, (context) => changeOrgSettings(context, true)),

    // REV-11. The forms of "Providers and keys": an admin of the org on screen only. cop() and
    // csrf() of the session layer ran before. A key is read from the form, encrypted, and never
    // written back into a page, a redirect or a log.
    providerAdd: createAction(pageRoutes.providerAdd, async (context) => {
      let admin = providerAdmin(context, 'add')
      if (admin instanceof Response) return admin
      let { signed, providers } = admin
      let page = kit.page(context)
      let { values, input, errors } = readProviderForm(context.get(FormData))
      if (input && input.apiKey !== null && !providers.secretsConfigured) {
        errors.apiKey = 'The service cannot encrypt a key (KENTO_SECRETS_KEY). Keep the key on the runner.'
      }
      if (!input || errors.apiKey) return renderSettings(kit, context, signed, page, { form: { values, errors } }, 422)
      let added
      try {
        added = await providers.store.add({ ...input, orgId: signed.membership.org.id, userId: signed.user.id })
      } catch (error) {
        if (!(error instanceof SecretsError)) throw error
        return renderSettings(kit, context, signed, page, { form: { values, errors: { apiKey: error.message } } }, 422)
      }
      log('info', 'providers.added', {
        providerId: added.id,
        org: signed.membership.org.name,
        by: signed.user.login,
        kind: added.kind,
        runnerHeld: added.runnerHeld,
        isDefault: added.isDefault,
      })
      let notice: ProviderNotice = added.kind === 'ollama' ? 'added_ollama' : onRunnerNetwork(added.kind, added.baseUrl) ? 'added_local' : added.runnerHeld ? 'added_runner' : 'added'
      return toSettings(notice, added.id)
    }),

    // The answer of a test is the page itself, with the message of the probe: it never goes
    // through a URL.
    providerTest: createAction(pageRoutes.providerTest, async (context) => {
      let admin = providerAdmin(context, 'test')
      if (admin instanceof Response) return admin
      let { signed, providers } = admin
      let id = context.params.id
      let page = kit.page(context)
      let failed = (detail: string) => renderSettings(kit, context, signed, page, { notice: { kind: 'test_failed', detail } })
      let found
      try {
        found = UUID.test(id) ? await providers.store.withKey(signed.membership.org.id, id) : null
      } catch (error) {
        if (!(error instanceof SecretsError)) throw error
        log('error', 'providers.key_unreadable', { providerId: id, error: error.message })
        return failed('The master key of the service does not decrypt the key. Replace the key, or check KENTO_SECRETS_KEY on the service.')
      }
      if (!found) return toSettings('missing')
      if (found.apiKey === null) return failed('Test this provider from the runner that holds it.')
      let result = await providers.probe({ kind: found.provider.kind, baseUrl: found.provider.baseUrl, apiKey: found.apiKey })
      log(result.outcome === 'ok' ? 'info' : 'warn', 'providers.tested', {
        providerId: id,
        org: signed.membership.org.name,
        by: signed.user.login,
        outcome: result.outcome,
        ...(result.outcome === 'refused' ? { status: result.status } : {}),
      })
      if (result.outcome === 'ok') {
        await providers.store.recordOk(id, found.provider.keySetAt)
        return toSettings('tested_ok', id)
      }
      if (result.outcome === 'refused') {
        await providers.store.recordRefused(id, result.status, result.message, found.provider.keySetAt)
        return toSettings('tested_refused', id)
      }
      return failed(result.message)
    }),

    providerKey: createAction(pageRoutes.providerKey, async (context) => {
      let admin = providerAdmin(context, 'replace_key')
      if (admin instanceof Response) return admin
      let { signed, providers } = admin
      let id = context.params.id
      if (!UUID.test(id)) return toSettings('missing')
      let { apiKey, error } = readKeyForm(context.get(FormData))
      let page = kit.page(context)
      if (!apiKey) return renderSettings(kit, context, signed, page, { keyError: { id, message: error! } }, 422)
      let replaced
      try {
        replaced = await providers.store.replaceKey(signed.membership.org.id, id, apiKey)
      } catch (cause) {
        if (!(cause instanceof SecretsError)) throw cause
        return renderSettings(kit, context, signed, page, { keyError: { id, message: cause.message } }, 422)
      }
      if (!replaced) return toSettings('missing')
      log('info', 'providers.key_replaced', { providerId: id, org: signed.membership.org.name, by: signed.user.login })
      return toSettings('replaced', id)
    }),

    providerDefault: createAction(pageRoutes.providerDefault, async (context) => {
      let admin = providerAdmin(context, 'default')
      if (admin instanceof Response) return admin
      let { signed, providers } = admin
      let id = context.params.id
      let done = UUID.test(id) ? await providers.store.setDefault(signed.membership.org.id, id) : null
      if (!done) return toSettings('missing')
      log('info', 'providers.default_changed', { providerId: id, org: signed.membership.org.name, by: signed.user.login })
      return toSettings('default', id)
    }),

    providerRemove: createAction(pageRoutes.providerRemove, async (context) => {
      let admin = providerAdmin(context, 'remove')
      if (admin instanceof Response) return admin
      let { signed, providers } = admin
      let id = context.params.id
      let removed = UUID.test(id) ? await providers.store.remove(signed.membership.org.id, id) : null
      if (!removed) return toSettings('missing')
      log('info', 'providers.removed', { providerId: id, org: signed.membership.org.name, by: signed.user.login, kind: removed.kind })
      return toSettings('removed')
    }),
  }
}
