// KNT-150. The members of the org on screen and its invitations (`/settings/members`), and the
// invitations of the signed-in person (`/invitations`).
import type { Handle } from 'remix/component'

import type { OrgRole } from '../db/schema.ts'
import type { InvitationView, MemberView, OwnInvitation } from '../members/store.ts'
import { rolesFor, type MemberFacts, type MemberRefusal } from '../members/rules.ts'
import { invitationRoutes, memberRoutes, pageRoutes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { Button, Field, Input, Select } from './controls.tsx'
import { dayMonth } from './format.ts'
import { ROLE_LABELS, Shell, type PageFrame } from './shell.tsx'

/** What the page says after a form. A fixed word in the URL: no text of the URL goes into the page. */
export const MEMBER_NOTICES = {
  invited: { tone: 'ok', text: 'Invitation sent. The person sees it after their next sign-in to Kentō with GitHub.' },
  canceled: { tone: 'ok', text: 'Invitation canceled.' },
  role: { tone: 'ok', text: 'Role changed.' },
  removed: { tone: 'ok', text: 'Member removed. Their next request ends their access to this organization.' },
  unknown_login: { tone: 'alert', text: 'GitHub has no person with this login.' },
  already_member: { tone: 'info', text: 'This person is already a member of the organization.' },
  already_invited: { tone: 'info', text: 'This person already has a pending invitation.' },
  github_failed: { tone: 'alert', text: 'GitHub did not answer. Try again in a minute.' },
  not_found: { tone: 'alert', text: 'This member or invitation is not in the organization any more.' },
  not_admin: { tone: 'alert', text: 'Only an owner or an admin changes the members.' },
  not_owner: { tone: 'alert', text: 'Only an owner gives the owner role, takes it, or removes an owner.' },
  last_owner: { tone: 'alert', text: 'The organization needs an owner: give the owner role to someone else first.' },
  github: { tone: 'alert', text: 'GitHub decides the role and the membership of this person. Change it on GitHub.' },
  same_role: { tone: 'info', text: 'The person already has this role.' },
  github_admin: { tone: 'alert', text: 'GitHub counts this person as an admin of the account: an owner from an invitation does not demote them.' },
  not_github_admin: { tone: 'alert', text: 'GitHub does not count you now as an admin of an account of this organization.' },
  changed: { tone: 'alert', text: 'The installations of the organization changed while Kentō asked GitHub. Try again in a minute.' },
  reclaimed: { tone: 'ok', text: 'You are an owner of the organization again.' },
  reclaim_wait: { tone: 'info', text: 'Kentō asked GitHub less than a minute ago. Try again in a minute.' },
  too_many: { tone: 'alert', text: 'The organization has 50 pending invitations: cancel some before you invite again.' },
} as const satisfies Record<string, { tone: 'ok' | 'info' | 'alert'; text: string }>

export type MemberNotice = keyof typeof MEMBER_NOTICES

export function isMemberNotice(value: unknown): value is MemberNotice {
  return typeof value === 'string' && Object.hasOwn(MEMBER_NOTICES, value)
}

/** A refusal of the rules as a notice of the page. */
export function refusalNotice(reason: MemberRefusal | 'not_found'): MemberNotice {
  return reason
}

export interface MembersPageProps {
  frame: PageFrame
  /** The signed-in person, as the rules see them. */
  actor: MemberFacts
  members: MemberView[]
  invitations: InvitationView[]
  notice: MemberNotice | null
  /** The login typed in the invite form, shown again after an error. */
  login: string | null
}

const SOURCE_LABELS = { github: 'From GitHub', invitation: 'Invited' } as const

export function MembersPage(handle: Handle<MembersPageProps>) {
  return () => {
    let { frame, actor, members, invitations, notice, login } = handle.props
    let csrf = frame.csrfToken ?? ''
    let admin = frame.viewer?.canEdit === true
    let activeOwners = members.filter((m) => m.role === 'owner' && m.active)
    let otherOwners = (member: MemberView) => activeOwners.filter((m) => m.membershipId !== member.membershipId).length
    let self = members.find((m) => m.userId === actor.userId)
    let message = notice ? MEMBER_NOTICES[notice] : null
    return (
      <Shell
        frame={frame}
        section="settings"
        title="Members"
        lead={`Who reads and who changes ${frame.viewer?.org.name ?? 'the organization'} in Kentō.`}
        memberCan="and leave it when you were invited"
      >
        <p class="members-back">
          <a href={pageRoutes.settings.href()}>Back to the settings</a>
        </p>
        {message ? (
          <div class={`banner banner-${message.tone}`} role={message.tone === 'alert' ? 'alert' : 'status'}>
            <p>{message.text}</p>
          </div>
        ) : null}

        <section class="card members-card" aria-labelledby="members-title">
          <h2 id="members-title" class="section-title">
            Members <span class="count">{members.length}</span>
          </h2>
          <p class="hint">
            A person whom GitHub counts in an account of the App gets in from GitHub: GitHub decides between admin and
            member, and ends the membership when they leave. An owner gives the owner role to a GitHub admin. A person
            invited here gets in from the invitation: Kentō alone sets their role and ends it, whatever GitHub says.
          </p>
          <ul class="member-list">
            {members.map((member) => {
              let target: MemberFacts = { userId: member.userId, role: member.role, source: member.source }
              let roles = rolesFor(actor, target, otherOwners(member))
              let canRemove = admin && member.source === 'invitation' && member.userId !== actor.userId && rolesRemovable(actor, member, otherOwners(member))
              return (
                <li class="member" id={`member-${member.membershipId}`}>
                  <div class="member-who">
                    <a class="member-login" href={`/users/${encodeURIComponent(member.login)}`}>
                      {member.login}
                    </a>
                    {member.name ? <span class="member-name">{member.name}</span> : null}
                    {member.userId === actor.userId ? <span class="tag tag-quiet">You</span> : null}
                  </div>
                  <div class="member-facts">
                    <span class={member.role === 'member' ? 'tag tag-quiet' : 'tag tag-info'}>{ROLE_LABELS[member.role]}</span>
                    <span class="member-source">{SOURCE_LABELS[member.source]}</span>
                    {member.role === 'owner' && !member.active ? <span class="member-source">Not seen for 30 days</span> : null}
                  </div>
                  {roles.length > 1 ? (
                    <form class="member-role" method="post" action={memberRoutes.memberRole.href({ id: member.membershipId })}>
                      <input type="hidden" name="_csrf" value={csrf} />
                      <label class="visually-hidden" for={`role-${member.membershipId}`}>
                        Role of {member.login}
                      </label>
                      <Select id={`role-${member.membershipId}`} name="role">
                        {roles.map((role) => (
                          <option value={role} selected={role === member.role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit" size="sm">
                        Change the role
                      </Button>
                    </form>
                  ) : null}
                  {canRemove ? (
                    <Confirm trigger="Remove…" action={memberRoutes.memberRemove.href({ id: member.membershipId })} csrf={csrf} submit={`Remove ${member.login}`}>
                      <p>
                        {member.login} loses the access to this organization at their next request. Their reviews and comments
                        stay. If GitHub counts them in an account of the organization, they come back from GitHub at their next
                        sign-in.
                      </p>
                    </Confirm>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {self && ((self.source === 'github' && self.role === 'admin') || self.source === 'invitation') ? (
            <form class="member-leave" method="post" action={memberRoutes.memberReclaim.href()}>
              <input type="hidden" name="_csrf" value={csrf} />
              <p class="hint">
                {self.source === 'github'
                  ? 'GitHub counts you as an admin of an account of this organization: you can take the owner role, whatever an owner from an invitation did. Kentō asks GitHub again first.'
                  : 'You joined from an invitation. If GitHub counts you as an admin of an account of this organization, take the owner role from GitHub: Kentō asks GitHub first, and your membership then follows GitHub.'}
              </p>
              <Button type="submit">Take the owner role</Button>
            </form>
          ) : null}
          {self && self.source === 'invitation' ? (
            <div class="member-leave">
              {self.role === 'owner' && otherOwners(self) === 0 ? (
                <p class="hint">You are the only owner: give the owner role to someone else before you leave.</p>
              ) : (
                <Confirm trigger="Leave the organization…" action={memberRoutes.memberLeave.href()} csrf={csrf} submit={`Leave ${frame.viewer?.org.name ?? 'the organization'}`}>
                  <p>You lose the access to this organization at once. An owner or an admin can invite you again.</p>
                </Confirm>
              )}
            </div>
          ) : null}
        </section>

        <section class="card members-card" aria-labelledby="invitations-title">
          <h2 id="invitations-title" class="section-title">
            Invitations <span class="count">{invitations.length}</span>
          </h2>
          <p class="hint">
            Kentō sends no mail: the person sees the invitation after a sign-in with their GitHub account, and accepts it or
            declines it within 7 days. A person invited here stays a member when they leave the account on GitHub.
          </p>
          {invitations.length === 0 ? <p class="hint">No pending invitation.</p> : null}
          {invitations.length > 0 ? (
            <ul class="member-list">
              {invitations.map((invitation) => (
                <li class="member">
                  <div class="member-who">
                    <span class="member-login">{invitation.githubLogin}</span>
                  </div>
                  <div class="member-facts">
                    <span class="tag tag-quiet">{ROLE_LABELS[invitation.role]}</span>
                    <span class="member-source">
                      {invitation.inviterLogin ? `By ${invitation.inviterLogin}, until ${dayMonth(invitation.expiresAt)}` : `Until ${dayMonth(invitation.expiresAt)}`}
                    </span>
                  </div>
                  {admin ? (
                    <form method="post" action={memberRoutes.invitationCancel.href({ id: invitation.id })}>
                      <input type="hidden" name="_csrf" value={csrf} />
                      <Button type="submit" size="sm" variant="ghost">
                        Cancel the invitation
                      </Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {admin ? (
            <form class="member-invite" method="post" action={memberRoutes.memberInvite.href()} id="invite">
              <input type="hidden" name="_csrf" value={csrf} />
              <h3 class="member-invite-title">Invite someone</h3>
              <Field id="invite-login" label="GitHub login">
                <Input id="invite-login" name="login" required autocomplete="off" spellcheck={false} maxLength={39} value={login ?? ''} />
              </Field>
              <Field id="invite-role" label="Role">
                <Select id="invite-role" name="role">
                  <option value="member">{ROLE_LABELS.member}: reads everything</option>
                  <option value="admin">{ROLE_LABELS.admin}: changes the settings, the repos and the members</option>
                </Select>
              </Field>
              <Button type="submit" variant="primary">
                Invite
              </Button>
            </form>
          ) : null}
        </section>
      </Shell>
    )
  }
}

/** The remove button follows the rules of a removal. */
function rolesRemovable(actor: MemberFacts, member: MemberView, otherOwners: number): boolean {
  if (member.role === 'owner') return actor.role === 'owner' && otherOwners > 0
  return true
}

export interface InvitationsPageProps {
  frame: PageFrame
  invitations: OwnInvitation[]
  /** The person has no org yet: the page is all they can reach. */
  alone: boolean
  login: string
  notice: 'declined' | 'gone' | null
}

/** The invitations of the signed-in person. */
export function InvitationsPage(handle: Handle<InvitationsPageProps>) {
  return () => {
    let { frame, invitations, alone, login, notice } = handle.props
    let csrf = frame.csrfToken ?? ''
    return (
      <Shell frame={frame} title="Invitations" lead={`The organizations that invited @${login} to Kentō.`}>
        {notice === 'declined' ? (
          <div class="banner banner-ok" role="status">
            <p>Invitation declined.</p>
          </div>
        ) : null}
        {notice === 'gone' ? (
          <div class="banner banner-alert" role="alert">
            <p>This invitation is not pending any more: it was canceled, it expired, or you answered it already.</p>
          </div>
        ) : null}
        {invitations.length === 0 ? (
          <div class="empty">
            <p>No pending invitation.</p>
          </div>
        ) : (
          <ul class="member-list">
            {invitations.map((invitation) => (
              <li class="member invitation">
                <div class="member-who">
                  <span class="member-login">{invitation.orgName}</span>
                </div>
                <div class="member-facts">
                  <span class="tag tag-info">{ROLE_LABELS[invitation.role as OrgRole]}</span>
                  <span class="member-source">
                    {invitation.inviterLogin ? `Invited by ${invitation.inviterLogin}, until ${dayMonth(invitation.expiresAt)}` : `Until ${dayMonth(invitation.expiresAt)}`}
                  </span>
                </div>
                <div class="invitation-actions">
                  <form method="post" action={invitationRoutes.invitationAccept.href({ id: invitation.id })}>
                    <input type="hidden" name="_csrf" value={csrf} />
                    <Button type="submit" variant="primary">
                      Accept and open {invitation.orgName}
                    </Button>
                  </form>
                  <form method="post" action={invitationRoutes.invitationDecline.href({ id: invitation.id })}>
                    <input type="hidden" name="_csrf" value={csrf} />
                    <Button type="submit" variant="ghost">
                      Decline
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
        {alone ? (
          <form class="invitation-signout" method="post" action={pageRoutes.signOut.href()}>
            <input type="hidden" name="_csrf" value={csrf} />
            <Button type="submit" variant="ghost">
              Sign out
            </Button>
          </form>
        ) : null}
      </Shell>
    )
  }
}
