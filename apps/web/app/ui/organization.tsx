// KNT-150. The org on screen (`/settings/organization`): its name, and its installations of the
// GitHub App, each one with the form that moves it to another org of the person or to a new one.
import type { Handle } from 'remix/component'

import type { OrgView } from '../organizations/store.ts'
import { ORG_NAME_MAX } from '../organizations/rules.ts'
import { memberRoutes, organizationRoutes, pageRoutes } from '../routes.ts'
import { Button, buttonClass, Field, Input, Select } from './controls.tsx'
import { Shell, type PageFrame } from './shell.tsx'

export const ORG_NOTICES = {
  renamed: { tone: 'ok', text: 'Name saved.' },
  moved: { tone: 'ok', text: 'Installation moved, with its repositories. Their reviews, findings and rules went with them.' },
  detached: {
    tone: 'ok',
    text: 'Installation detached into a new organization with no member. The next admin of its account on GitHub who signs in becomes its owner.',
  },
  bad_name: { tone: 'alert', text: 'A name has 1 to 60 characters, on one line, with no invisible character.' },
  not_owner: { tone: 'alert', text: 'Only an owner of the organization renames it or moves its installations.' },
  target_not_owner: { tone: 'alert', text: 'You are not an owner of that organization.' },
  not_github_admin: { tone: 'alert', text: 'GitHub does not count you as an admin of the account of this installation.' },
  not_target_admin: {
    tone: 'alert',
    text: 'GitHub does not count you as an admin of an account of that organization. An installation joins an organization only from a person who is an admin of both accounts.',
  },
  target_inactive: { tone: 'alert', text: 'That organization has no active installation: nobody reaches it.' },
  personal_account: {
    tone: 'alert',
    text: 'An installation on a personal account stays in an organization of its own: it joins no organization of other accounts, and no other account joins it.',
  },
  not_remaining_admin: {
    tone: 'alert',
    text: 'Only an owner whom GitHub counts as an admin of another account of this organization detaches an installation.',
  },
  changed: { tone: 'alert', text: 'The installations changed while Kentō asked GitHub. Try again.' },
  github_failed: { tone: 'alert', text: 'GitHub did not answer. Try again in a minute.' },
  same_org: { tone: 'info', text: 'The installation is in this organization already.' },
  last_installation: { tone: 'alert', text: 'This is the last installation of the organization: confirm that the organization goes with the move.' },
  not_found: { tone: 'alert', text: 'This installation is not in the organization any more.' },
} as const satisfies Record<string, { tone: 'ok' | 'info' | 'alert'; text: string }>

export type OrgNotice = keyof typeof ORG_NOTICES

export function isOrgNotice(value: unknown): value is OrgNotice {
  return typeof value === 'string' && Object.hasOwn(ORG_NOTICES, value)
}

export interface OrganizationPageProps {
  frame: PageFrame
  org: OrgView
  /** The person is an owner of the org on screen. */
  owner: boolean
  /** The other orgs where the person is an owner: where an installation can go. */
  targets: { id: string; name: string }[]
  notice: OrgNotice | null
}

export function OrganizationPage(handle: Handle<OrganizationPageProps>) {
  return () => {
    let { frame, org, owner, targets, notice } = handle.props
    let csrf = frame.csrfToken ?? ''
    let message = notice ? ORG_NOTICES[notice] : null
    let active = org.installations.filter((i) => !i.suspended).length
    let last = active === 1
    let suspendedLeft = org.installations.length > active
    let invited = org.members.filter((m) => m.source === 'invitation').map((m) => m.login)
    let fromGitHub = org.members.filter((m) => m.source === 'github').map((m) => m.login)
    return (
      <Shell frame={frame} section="settings" title="Organization" lead={`The name of ${org.name} and the GitHub accounts where Kentō is installed for it.`}>
        <p class="members-back">
          <a href={pageRoutes.settings.href()}>Back to the settings</a> · <a href={memberRoutes.members.href()}>Members</a>
        </p>
        {message ? (
          <div class={`banner banner-${message.tone}`} role={message.tone === 'alert' ? 'alert' : 'status'}>
            <p>{message.text}</p>
          </div>
        ) : null}

        <section class="card members-card" aria-labelledby="org-name-title">
          <h2 id="org-name-title" class="section-title">
            Name
          </h2>
          {owner ? (
            <form class="member-invite" method="post" action={organizationRoutes.organizationRename.href()}>
              <input type="hidden" name="_csrf" value={csrf} />
              <Field id="org-name" label="Name of the organization">
                <Input id="org-name" name="name" required maxLength={ORG_NAME_MAX} value={org.name} />
              </Field>
              <Button type="submit" variant="primary">
                Save the name
              </Button>
            </form>
          ) : (
            <p>
              {org.name} <span class="member-source">({org.slug})</span>
            </p>
          )}
        </section>

        <section class="card members-card" aria-labelledby="org-installations-title">
          <h2 id="org-installations-title" class="section-title">
            Installations of the GitHub App <span class="count">{org.installations.length}</span>
          </h2>
          <p class="hint">
            Each installation brings the repositories that its GitHub account chose. An owner who is also an admin of that
            account on GitHub moves an installation to a new organization, or to another organization of theirs where GitHub
            counts them as an admin of an account too. An installation on a personal account stays in an organization of its
            own. The repositories go with the installation, with their reviews, findings, rules and assignment rules. The
            settings, the providers, the runners and the rules of this organization stay here.
          </p>
          <ul class="member-list">
            {org.installations.map((installation) => (
              <li class="member installation">
                <div class="member-who">
                  <span class="member-login">{installation.login}</span>
                  {installation.suspended ? <span class="tag tag-quiet">Suspended</span> : null}
                </div>
                <div class="member-facts">
                  <span class="member-source">
                    {installation.repos === 1 ? '1 repository' : `${installation.repos} repositories`}
                  </span>
                </div>
                {owner && !installation.suspended ? (
                  <details class="installation-move">
                    <summary class={buttonClass("outline", "sm")}>Move…</summary>
                    <form method="post" action={organizationRoutes.installationMove.href({ id: installation.id })}>
                      <input type="hidden" name="_csrf" value={csrf} />
                      <Field id={`move-to-${installation.id}`} label="To">
                        <Select id={`move-to-${installation.id}`} name="to">
                          {targets.map((target) => (
                            <option value={target.id}>{target.name}</option>
                          ))}
                          <option value="new">A new organization</option>
                          {active > 1 ? <option value="detach">A new organization with no member (detach)</option> : null}
                        </Select>
                      </Field>
                      <Field id={`move-name-${installation.id}`} label="Name of the new organization">
                        <Input id={`move-name-${installation.id}`} name="name" maxLength={ORG_NAME_MAX} value={installation.login} />
                      </Field>
                      {active > 1 ? (
                        <p class="hint">
                          A detach needs no right on {installation.login}: an owner whom GitHub counts as an admin of another
                          account of {org.name} takes it out. The people who reach {org.name} only through {installation.login} lose
                          their access at their next check of GitHub.
                        </p>
                      ) : null}
                      {last ? (
                        <div class="installation-confirm">
                          {suspendedLeft ? (
                            <p class="hint">
                              It is the last active installation: after the move nobody reaches {org.name}. Kentō keeps it, with its
                              members, settings and suspended installations: it comes back when one of these accounts installs the App again, or GitHub lifts the suspension.
                            </p>
                          ) : (
                            <>
                              <p class="hint">
                                It is the last installation: {org.name} is deleted with the move, with its settings, providers, runners
                                and rules.
                              </p>
                              {invited.length > 0 ? (
                                <p class="hint">Its members from an invitation lose their access: {invited.join(', ')}.</p>
                              ) : null}
                              {fromGitHub.length > 0 ? (
                                <p class="hint">
                                  Its members from GitHub leave it: {fromGitHub.join(', ')}. They keep the organizations of their other
                                  accounts.
                                </p>
                              ) : null}
                              {org.invitations.length > 0 ? (
                                <p class="hint">Its pending invitations are canceled: {org.invitations.join(', ')}.</p>
                              ) : null}
                            </>
                          )}
                          <Field id={`move-confirm-${installation.id}`} label={`Type ${org.name} to confirm.`}>
                            <Input id={`move-confirm-${installation.id}`} name="confirm" autocomplete="off" />
                          </Field>
                        </div>
                      ) : null}
                      <Button type="submit" variant={last ? 'danger-solid' : 'primary'}>
                        Move {installation.login}
                      </Button>
                    </form>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </Shell>
    )
  }
}
