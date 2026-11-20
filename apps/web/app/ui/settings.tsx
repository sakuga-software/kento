import type { Handle } from 'remix/component'

import { defaultModels } from '@kento-review/engine/levels'
import { costKnown } from '@kento-review/engine/prices'
import { LEVELS, type Level, type ProviderKind } from '@kento-review/protocol'

import { KIND_LABELS, type ProviderField, type ProviderFormValues } from '../providers/form.ts'
import type { ProviderView } from '../providers/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { Button, Choice, Input, Select, buttonClass } from './controls.tsx'
import { FormErrors, firstInvalid, focusIf } from './form-errors.tsx'
import { agoShort, clock, hourOrDate } from './format.ts'
import { OrgSettingsSections, orgEffectiveLevels, orgVersionLine, SectionsLink, type OrgSectionProps } from './org-settings.tsx'
import { canAddRule, RulesList, type RuleFormState, type RuleNotice } from './rules.tsx'
import type { RuleView } from '../rules/store.ts'
import { Shell, type PageFrame } from './shell.tsx'

const KINDS: readonly ProviderKind[] = ['anthropic', 'openrouter', 'openai_compatible', 'ollama']
/** REV-28. What each type needs, all shown under the select: right whatever the choice, without JavaScript. */
const KIND_HINTS: Record<ProviderKind, string> = {
  anthropic: 'an Anthropic key (sk-ant-…). The URL and the models of the type by default.',
  openrouter: 'an OpenRouter key (sk-or-…). The URL and the models of the type by default.',
  openai_compatible: 'the URL of the server, required, and at least one model per level.',
  ollama: 'a server on the machine of a runner. The service never has a key.',
}
/** The order of the fields of "Add a provider": the first one in error gets the focus. */
const PROVIDER_FIELDS: readonly ProviderField[] = ['kind', 'label', 'baseUrl', 'apiKey', 'models']

/** What the section says after a form, from `?notice=`. */
export const PROVIDER_NOTICES = {
  added: { tone: 'ok', text: 'Provider added. Test it to check the key.' },
  // No "Test" for these two: the service has no key, and cannot reach the server of a runner.
  added_runner: { tone: 'ok', text: 'Provider added. Its key stays on the runner, and the first job of a runner that has it tells whether it works.' },
  added_ollama: { tone: 'ok', text: 'Provider added. Its server is on the network of a runner. The first job of a runner with PROVIDER_KIND=ollama tells whether it answers.' },
  replaced: { tone: 'ok', text: 'Key replaced. Kentō no longer keeps the old key.' },
  default: { tone: 'ok', text: 'This provider is now "Default". The levels with no chosen provider use it.' },
  removed: { tone: 'info', text: 'Provider removed, with its key.' },
  tested_ok: { tone: 'ok', text: 'The provider accepted the key.' },
  tested_refused: { tone: 'alert', text: 'The provider refused the key.' },
  test_failed: { tone: 'alert', text: 'The test did not complete, and the state of the provider does not change.' },
  missing: { tone: 'alert', text: 'Nothing changed. Someone changed or removed this provider after the page loaded. Read its state below, then do the action again if necessary.' },
} as const
export type ProviderNotice = keyof typeof PROVIDER_NOTICES

export type ProviderState = 'runner' | 'refused' | 'valid' | 'unknown'

/**
 * The state of a provider, as the screen and the catalog of REV-12 show it. A refusal comes first,
 * also for a runner-held provider: a job of a runner that got 401 or 403 records it (REV-31).
 */
export function providerState(provider: Pick<ProviderView, 'runnerHeld' | 'refusedAt' | 'lastOkAt'>): ProviderState {
  if (provider.refusedAt) return 'refused'
  if (provider.runnerHeld) return 'runner'
  if (provider.lastOkAt) return 'valid'
  return 'unknown'
}

export interface SettingsPageProps {
  frame: PageFrame
  /** Null: the service has no providers section. */
  providers: ProviderView[] | null
  /** REV-13. The settings of the org, above the providers. Null: not configured on the service. */
  org?: OrgSectionProps | null
  now: Date
  /** KENTO_SECRETS_KEY is set: the service can store a key. */
  secretsConfigured: boolean
  /** KENTO_PROVIDER_API_KEY is set: the jobs of an org without a provider use it. */
  serviceKey: boolean
  notice?: { kind: ProviderNotice; detail?: string | null } | null
  form?: { values: ProviderFormValues; errors: Partial<Record<ProviderField, string>> } | null
  /** The provider whose "Replace the key" failed, with its message. */
  keyError?: { id: string; message: string } | null
  /** REV-19. The rules of the org. Null: the service has no rules. */
  rules?: { list: RuleView[]; form: RuleFormState | null; notice: RuleNotice | null; noticeRule: string | null } | null
}

export function SettingsPage(handle: Handle<SettingsPageProps>) {
  return () => {
    let { frame, providers, org, now, secretsConfigured, serviceKey, notice, form, keyError, rules } = handle.props
    let admin = frame.viewer?.role === 'admin'
    let csrf = frame.csrfToken ?? ''
    let refused = (providers ?? []).filter((p) => providerState(p) === 'refused')
    // REV-27. Which levels of the org run on each provider: the same rule as Default values.
    let effective = org ? orgEffectiveLevels(org.view, org.providers) : null
    let usage = (id: string) => (effective ? LEVELS.filter((level) => effective[level].provider.id === id) : null)
    let sections = settingsSections({ org: org ?? null, rules: rules ? { count: rules.list.length } : null, providers, admin })
    // KNT-168. With a sidebar, each section ends with a link back to the bar "Sections" of a phone.
    let back = sections.length >= 2
    return (
      <Shell
        frame={frame}
        section="settings"
        title="Settings"
        // REV-91: the version of the settings goes under the title, after "For the whole organization".
        lead={org ? `For the whole organization · ${orgVersionLine(org.view)}` : 'What applies to the whole organization.'}
      >
        {refused.map((p) => {
          let levels = usage(p.id)
          let failing =
            levels === null
              ? p.isDefault
                ? 'The jobs of the organization fail until someone replaces it.'
                : 'This provider is not the one of the jobs.'
              : levels.length > 0
                ? `The jobs of the ${levels.length > 1 ? 'levels' : 'level'} ${levelList(levels)} fail until someone replaces it.`
                : 'No level of the organization uses it. Only a repo that chose it in its Config is affected.'
          return (
            <div class="banner banner-alert" role="alert">
              <p>
                <strong>
                  {p.runnerHeld ? <>The runner got {p.refusedStatus} for the key of "{p.label}" </> : <>The key of "{p.label}" is refused ({p.refusedStatus}) </>}
                  since <time dateTime={p.refusedAt!.toISOString()}>{hourOrDate(p.refusedAt!, now)}</time>.
                </strong>{' '}
                {failing}{' '}
                {p.runnerHeld ? (
                  <a href={`#provider-${p.id}`}>What to do</a>
                ) : admin ? (
                  <a href={`#provider-${p.id}`}>Replace the key</a>
                ) : (
                  'An admin of the organization can replace it.'
                )}
              </p>
            </div>
          )
        })}
        {notice ? (
          <div class={`banner banner-${PROVIDER_NOTICES[notice.kind].tone}`} role="status">
            <p>
              {PROVIDER_NOTICES[notice.kind].text}
              {notice.detail ? <> {notice.detail}</> : null}
            </p>
          </div>
        ) : null}

        {/* KNT-149: the sidebar only with two sections or more; without it, the page keeps one column of 760 px.
            The alerts of a refused key stay above it, in reach of the keyboard. */}
        <div class={back ? 'settings-layout settings-layout-nav' : 'settings-layout'}>
          <SettingsNav sections={sections} />
          <div class="settings-content">
        {org ? <OrgSettingsSections {...org} admin={admin} csrf={csrf} back={back} /> : null}

        {rules ? (
          <section class="card config-card" id="org-rules" aria-labelledby="org-rules-title" tabIndex={-1}>
            <h2 id="org-rules-title" class="section-title">
              Org rules <span class="count">{rules.list.filter((r) => r.active).length}</span>
            </h2>
            <p class="hint">
              They go with the review of each repo of the organization, after the rules of the repo, when the PR changes one of
              their paths. Write the rules of one repo in its Config, tab Rules.
            </p>
            <RulesList
              scope="org"
              repoId={null}
              rules={rules.list}
              admin={admin}
              csrf={csrf}
              form={rules.form}
              notice={rules.notice}
              noticeRule={rules.noticeRule}
            />
          </section>
        ) : null}
        {rules && back ? <SectionsLink section="org-rules" /> : null}

        {providers ? (
          <section class="provider-section" id="providers" aria-labelledby="providers-title" tabIndex={-1}>
            <h2 id="providers-title" class="section-title">
              Providers and keys <span class="count">{providers.length}</span>
            </h2>
            <p class="hint provider-lead">
              The default provider does the reviews of the organization. Its key is encrypted at rest (AES-256-GCM). The screen
              shows only its last 4 characters, and only a trusted runner of the organization gets it, for one
              job.
            </p>
            {!secretsConfigured ? (
              <div class="banner banner-info" role="note">
                <p>
                  The encryption of the keys is not configured on the service (<span class="mono">KENTO_SECRETS_KEY</span>).
                  You can add only a provider whose key stays on the runner.
                </p>
              </div>
            ) : null}
            {providers.length === 0 ? (
              <div class="empty">
                <p>
                  {serviceKey
                    ? 'No provider. The runners of the service review with the OpenRouter key of the service; a runner of your organization needs its own OpenRouter key. Add your own provider to pay for your reviews and choose your models.'
                    : 'No provider, and the service has no key. Only a runner with its own key does the reviews.'}
                </p>
              </div>
            ) : (
              <ul class="provider-list">
                {providers.map((provider) => (
                  <ProviderItem
                    provider={provider}
                    now={now}
                    admin={admin}
                    csrf={csrf}
                    keyError={keyError?.id === provider.id ? keyError.message : null}
                    levels={usage(provider.id)}
                    serviceKey={serviceKey}
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {admin && providers ? <NewProviderForm csrf={csrf} form={form ?? null} secretsConfigured={secretsConfigured} /> : null}
        {providers && back ? <SectionsLink section="providers" /> : null}
          </div>
        </div>
        <script src={`/assets/settings.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script>
      </Shell>
    )
  }
}

/** One link of the sidebar of the settings, to an anchor of the page. */
export interface SettingsNavLink {
  id: string
  label: string
  /** A level name: written in mono, as in its card. */
  mono?: boolean
}
/** A section of the sidebar, with the parts of the section under it. */
export interface SettingsNavSection extends SettingsNavLink {
  items: SettingsNavLink[]
}

/**
 * KNT-149. The sidebar of the settings: the sections in the order of the page (REV-29, REV-91
 * labels), and under each section the parts that have their own anchor. The anchors of the sections
 * stay the same: #cap, #defaults, #bots, #app, #org-rules, #providers.
 */
export function settingsSections(input: {
  org: Pick<OrgSectionProps, 'app'> | null
  rules: { count: number } | null
  providers: readonly Pick<ProviderView, 'id' | 'label'>[] | null
  admin: boolean
}): SettingsNavSection[] {
  let { org, rules, providers, admin } = input
  let sections: SettingsNavSection[] = []
  if (org) {
    sections.push(
      { id: 'cap', label: 'Costs and cap', items: [] },
      {
        id: 'defaults',
        label: 'Levels and models',
        items: [{ id: 'org-level', label: 'Level of a push' }, ...LEVELS.map((level) => ({ id: `org-${level}`, label: level, mono: true }))],
      },
      { id: 'bots', label: 'Trusted bots', items: [] },
      {
        id: 'app',
        label: 'GitHub App',
        items: [
          { id: 'app-installation', label: 'Installation' },
          { id: 'app-webhook', label: 'Webhook' },
          { id: 'app-deliveries', label: 'Deliveries' },
          // The permissions and the events show only when GitHub answered.
          ...(org.app?.ok ? [{ id: 'app-permissions', label: 'Permissions and events' }] : []),
        ],
      },
    )
  }
  if (rules) {
    // The condition of the form "New rule" itself (rules.tsx).
    sections.push({ id: 'org-rules', label: 'Org rules', items: canAddRule(admin, rules.count) ? [{ id: 'org-rule-new', label: 'New rule' }] : [] })
  }
  if (providers) {
    sections.push({
      id: 'providers',
      label: 'Providers and keys',
      items: [
        ...providers.map((provider) => ({ id: `provider-${provider.id}`, label: provider.label })),
        ...(admin ? [{ id: 'new-provider', label: 'Add a provider' }] : []),
      ],
    })
  }
  return sections
}

/**
 * KNT-149. The sidebar of the settings, in place of the tabs of REV-91: one link per section, and
 * the parts of each section under it. It stays in view while the page scrolls, and settings.js
 * marks the section and the part on screen with aria-current. Under 900 px it is a bar at the top of
 * the page, "Sections", that opens the list under it (settings.js). There, the marks show the section
 * that the person chose or came back from (KNT-168). Without JavaScript the list is part of the page.
 */
function SettingsNav(handle: Handle<{ sections: SettingsNavSection[] }>) {
  return () => {
    let { sections } = handle.props
    if (sections.length < 2) return null
    return (
      <nav class="settings-nav" id="settings-nav" aria-label="Sections of the settings" data-settings-nav="" tabIndex={-1}>
        {/* KNT-168: the bar names no section. At the top of the page, it would only ever name the first one. */}
        <button class="settings-nav-toggle" type="button" aria-expanded="false" aria-controls="settings-nav-list" data-settings-nav-toggle="">
          <span class="settings-nav-toggle-label">Sections</span>
        </button>
        <ul class="settings-nav-list" id="settings-nav-list">
          {sections.map((section) => (
            <li>
              <a class="settings-nav-link" href={`#${section.id}`}>
                {section.label}
              </a>
              {section.items.length > 0 ? (
                <ul class="settings-nav-sub">
                  {section.items.map((item) => (
                    <li>
                      <a class={item.mono ? 'settings-nav-link mono' : 'settings-nav-link'} href={`#${item.id}`}>
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </nav>
    )
  }
}

const STATE_TEXT: Record<ProviderState, string> = {
  runner: 'Key on the runner',
  refused: 'Key refused',
  valid: 'Valid',
  unknown: 'Never called',
}
const STATE_CLASS: Record<ProviderState, string> = {
  // A key on the runner is a normal state: neutral. The amber of `status-wait` says "attention".
  runner: 'status-neutral',
  refused: 'status-alert',
  valid: 'status-online',
  unknown: 'status-stale',
}

/** "lite", "lite and heavy", "lite, balanced and heavy". */
function levelList(levels: readonly Level[]): string {
  return levels.length <= 1 ? levels.join('') : `${levels.slice(0, -1).join(', ')} and ${levels.at(-1)}`
}

/**
 * REV-27. The levels of the org that run on this provider, under its name: "Default" and the
 * choices of Default values never say two different things. Null: the service has no settings of
 * the org.
 */
function ProviderUsage(handle: Handle<{ provider: ProviderView; levels: Level[] | null }>) {
  return () => {
    let { provider, levels } = handle.props
    if (!levels) return null
    let others = LEVELS.filter((level) => !levels.includes(level))
    let defaults = <a href="#defaults">Default values</a>
    if (provider.isDefault) {
      return (
        <p class="hint provider-usage">
          {levels.length === LEVELS.length ? (
            <>Does the levels {levelList(levels)} of the organization.</>
          ) : levels.length > 0 ? (
            <>
              Does the levels {levelList(levels)} of the organization. {others.length > 1 ? 'The levels' : 'The level'} {levelList(others)}{' '}
              {others.length > 1 ? 'have' : 'has'} another provider, chosen
              in {defaults}.
            </>
          ) : (
            <>No level of the organization uses it. Each level has its provider, chosen in {defaults}.</>
          )}{' '}
          A repo can choose its own provider in its Config.
        </p>
      )
    }
    return levels.length > 0 ? (
      <p class="hint provider-usage">
        Chosen for the {levels.length > 1 ? 'levels' : 'level'} {levelList(levels)} of the organization, in {defaults}.
      </p>
    ) : null
  }
}

function ProviderItem(
  handle: Handle<{ provider: ProviderView; now: Date; admin: boolean; csrf: string; keyError: string | null; levels: Level[] | null; serviceKey: boolean }>,
) {
  return () => {
    let { provider, now, admin, csrf, keyError, levels, serviceKey } = handle.props
    let state = providerState(provider)
    let id = provider.id
    return (
      <li class={`provider provider-${state}`} id={`provider-${id}`} tabIndex={-1}>
        <div class="provider-head">
          <h3 class="provider-name">{provider.label}</h3>
          <span class="tag">{KIND_LABELS[provider.kind]}</span>
          {provider.isDefault ? <span class="tag tag-ok">Default</span> : null}
          <span class={`status ${STATE_CLASS[state]}`}>
            {state === 'refused' ? (
              <>
                {provider.runnerHeld ? 'Refused on the runner' : 'Refused'} · {provider.refusedStatus} since{' '}
                <time dateTime={provider.refusedAt!.toISOString()}>{hourOrDate(provider.refusedAt!, now)}</time>
              </>
            ) : state === 'valid' ? (
              <>
                Valid · last call{' '}
                <time dateTime={provider.lastOkAt!.toISOString()} title={clock(provider.lastOkAt!)}>
                  {agoShort(provider.lastOkAt!, now)}
                </time>
              </>
            ) : (
              state === 'runner' && provider.kind === 'ollama' ? 'Server of the runner' : STATE_TEXT[state]
            )}
          </span>
        </div>
        <ProviderUsage provider={provider} levels={levels} />
        <dl class="provider-facts">
          <div>
            <dt>Key</dt>
            <dd>
              {provider.keyLast4 ? (
                <span class="mono" aria-label={`ends with ${provider.keyLast4}`}>
                  ••••{provider.keyLast4}
                </span>
              ) : provider.kind === 'ollama' ? (
                'none, server of the runner'
              ) : (
                'on the runner (PROVIDER_API_KEY)'
              )}
            </dd>
          </div>
          <div>
            <dt>URL</dt>
            <dd class="mono">{provider.baseUrl ?? 'default'}</dd>
          </div>
          {LEVELS.map((level) => {
            let models = provider.models[level] ?? defaultModels(provider.kind, level)
            return (
              <div>
                <dt>Models {level}</dt>
                <dd>
                  {models.map((model) => (
                    <span class="model">
                      <span class="mono">{model}</span>
                      {costKnown(provider.kind, model) ? null : <span class="tag tag-warn">no price: not counted in the cap</span>}
                    </span>
                  ))}
                </dd>
              </div>
            )
          })}
          {provider.keySetAt ? (
            <div>
              <dt>Key set</dt>
              <dd>
                <time dateTime={provider.keySetAt.toISOString()}>{clock(provider.keySetAt)}</time>
              </dd>
            </div>
          ) : null}
        </dl>
        {state === 'refused' && provider.refusedMessage ? <p class="hint">Last answer: {provider.refusedMessage}</p> : null}
        {provider.runnerHeld && state === 'refused' ? (
          <p class="hint provider-todo">
            <strong>What to do.</strong> Replace <span class="mono">PROVIDER_API_KEY</span> on the runners of the organization that have{' '}
            <span class="mono">PROVIDER_KIND={provider.kind}</span>, then run a review again. The first job that completes clears this refusal.
          </p>
        ) : null}
        {state === 'runner' ? (
          <p class="hint">
            The service does not have this key. A runner of the organization with <span class="mono">PROVIDER_KIND={provider.kind}</span> does
            its jobs, and the jobs show its state.
          </p>
        ) : null}
        {admin ? (
          <div class="provider-actions">
            {provider.runnerHeld ? null : (
              <form method="post" action={routes.providerTest.href({ id })}>
                <input type="hidden" name="_csrf" value={csrf} />
                <Button type="submit">
                  Test
                </Button>
              </form>
            )}
            {provider.isDefault ? null : (
              <form method="post" action={routes.providerDefault.href({ id })}>
                <input type="hidden" name="_csrf" value={csrf} />
                <Button type="submit">
                  Make default
                </Button>
              </form>
            )}
            {provider.runnerHeld ? null : (
              <details class="confirm replace-key" open={keyError !== null || state === 'refused' ? true : undefined}>
                <summary class={buttonClass(state === 'refused' ? 'primary' : 'outline')}>Replace the key</summary>
                <form class="confirm-body replace-body" method="post" action={routes.providerKey.href({ id })} noValidate>
                  <input type="hidden" name="_csrf" value={csrf} />
                  {keyError ? <FormErrors errors={{ apiKey: keyError }} /> : null}
                  <div class="field">
                    <label class="label" for={`key-${id}`}>
                      New {KIND_LABELS[provider.kind]} key
                    </label>
                    <Input
                      class="mono"
                      id={`key-${id}`}
                      name="apiKey"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      autoFocus={keyError ? true : undefined}
                      aria-invalid={keyError ? 'true' : undefined}
                      aria-describedby={keyError ? `key-${id}-error` : `key-${id}-hint`}
                    />
                    {keyError ? (
                      <p class="field-error" id={`key-${id}-error`}>
                        {keyError}
                      </p>
                    ) : (
                      <p class="description" id={`key-${id}-hint`}>
                        Kentō deletes the old key. The jobs already in progress keep the key that they got.
                      </p>
                    )}
                  </div>
                  <Button variant="primary" type="submit">
                    Replace
                  </Button>
                </form>
              </details>
            )}
            <Confirm trigger="Remove…" action={routes.providerRemove.href({ id })} csrf={csrf} submit={`Remove ${provider.label}`}>
              <p>
                Kentō deletes <strong>{provider.label}</strong> and its key.{' '}
                {!provider.isDefault
                  ? 'The jobs do not use this provider.'
                  : serviceKey
                    ? 'The oldest of the other providers becomes the one of the jobs. With no other provider, the runners of the service review with the OpenRouter key of the service, and a runner of your organization needs its own OpenRouter key.'
                    : 'The oldest of the other providers becomes the one of the jobs. With no other provider, only a runner with its own key does the reviews.'}
              </p>
            </Confirm>
          </div>
        ) : null}
      </li>
    )
  }
}

function NewProviderForm(handle: Handle<{ csrf: string; form: SettingsPageProps['form']; secretsConfigured: boolean }>) {
  return () => {
    let { csrf, form, secretsConfigured } = handle.props
    let values: ProviderFormValues = form?.values ?? {
      kind: 'anthropic',
      label: '',
      baseUrl: '',
      runnerHeld: !secretsConfigured,
      models: { lite: '', balanced: '', heavy: '' },
    }
    let errors = form?.errors ?? {}
    let first = firstInvalid(errors, PROVIDER_FIELDS)
    // A key in error with the key field disabled (no KENTO_SECRETS_KEY): the way out is the box below it.
    let focusRunnerHeld = first === 'apiKey' && !secretsConfigured
    let field = (name: ProviderField) => ({
      ...(focusRunnerHeld ? {} : focusIf(first, name)),
      'aria-invalid': errors[name] ? ('true' as const) : undefined,
      'aria-describedby': errors[name] ? `provider-${name}-error` : `provider-${name}-hint`,
    })
    let message = (name: ProviderField, hint: string) =>
      errors[name] ? (
        <p class="field-error" id={`provider-${name}-error`}>
          {errors[name]}
        </p>
      ) : (
        <p class="description" id={`provider-${name}-hint`}>
          {hint}
        </p>
      )
    return (
      // Folded until it is asked for (REV-29): open after a form with errors, or when the URL names
      // #new-provider (public/assets/settings.js).
      <section class="new-provider" id="new-provider" aria-labelledby="new-provider-title" tabIndex={-1}>
        <details class="new-provider-toggle" open={form && Object.keys(form.errors).length > 0 ? true : undefined}>
          <summary class={buttonClass()}>
            <span id="new-provider-title">Add a provider</span>
          </summary>
          <div class="card new-provider-card">
        <form method="post" action={routes.providerAdd.href()} noValidate autoComplete="off">
          <input type="hidden" name="_csrf" value={csrf} />
          <FormErrors errors={errors} />
          <div class="field">
            <label class="label" for="provider-kind">
              Type
            </label>
            <Select
              id="provider-kind"
              name="kind"
              {...field('kind')}
              aria-describedby={errors.kind ? 'provider-kind-error provider-kind-hint' : 'provider-kind-hint'}
            >
              {KINDS.map((kind) => (
                <option value={kind} selected={values.kind === kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
            {errors.kind ? (
              <p class="field-error" id="provider-kind-error">
                {errors.kind}
              </p>
            ) : null}
            <ul class="description kind-hints" id="provider-kind-hint">
              {KINDS.map((kind) => (
                <li>
                  <strong>{KIND_LABELS[kind]}</strong>: {KIND_HINTS[kind]}
                </li>
              ))}
            </ul>
          </div>
          <div class="field">
            <label class="label" for="provider-label">
              Name
            </label>
            <Input id="provider-label" name="label" value={values.label} maxLength={60} required {...field('label')} />
            {message('label', 'What the screen shows, for example "Anthropic of Sakuga".')}
          </div>
          <div class="field">
            <label class="label" for="provider-baseUrl">
              Server URL
            </label>
            <Input class="mono" id="provider-baseUrl" name="baseUrl" value={values.baseUrl} inputMode="url" spellCheck={false} {...field('baseUrl')} />
            {message('baseUrl', 'Leave it empty for the URL of the type. Required for an OpenAI-compatible server. HTTPS, except for Ollama.')}
          </div>
          <div class="field">
            <label class="label" for="provider-apiKey">
              Key
            </label>
            <Input
              class="mono"
              id="provider-apiKey"
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={!secretsConfigured ? true : undefined}
              {...field('apiKey')}
            />
            {message('apiKey', 'Encrypted when it arrives. It never comes back to the browser.')}
          </div>
          <Choice
            type="checkbox"
            name="runnerHeld"
            checked={values.runnerHeld ? true : undefined}
            autoFocus={focusRunnerHeld ? true : undefined}
            label={
              <>
                <strong>The key stays on the runner.</strong> A runner of the organization has it in <span class="mono">PROVIDER_API_KEY</span>. The
                service never has it.
              </>
            }
          />
          <fieldset class="field" aria-describedby={errors.models ? 'provider-models-error' : 'provider-models-hint'}>
            <legend class="label">Models per level</legend>
            {LEVELS.map((level) => (
              <div class="model-field">
                <label class="description" for={`provider-models-${level}`}>
                  {level}
                </label>
                <Input
                  class="mono"
                  id={`provider-models-${level}`}
                  name={`models_${level}`}
                  value={values.models[level]}
                  spellCheck={false}
                  placeholder={defaultModels(values.kind, level).join(', ') || 'to name'}
                  autoFocus={first === 'models' && level === 'lite' ? true : undefined}
                  aria-invalid={errors.models ? 'true' : undefined}
                />
              </div>
            ))}
            {message('models', 'Separated by commas, the first one first. Leave it empty for the default models of the type (Anthropic, OpenRouter).')}
          </fieldset>
          <Button variant="primary" type="submit">
            Add the provider
          </Button>
        </form>
          </div>
        </details>
      </section>
    )
  }
}
