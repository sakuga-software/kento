// KNT-150. The members and the invitations of the org on screen (`memberRoutes`), and the
// invitations of the signed-in person (`invitationRoutes`), on the frame of the screens. The org is
// always the one of the session: an id of another org in a URL or a form finds nothing.
import { createController } from 'remix/router'

import { UUID } from '@kento-review/protocol'

import { canEdit } from '../auth/access.ts'
import { GITHUB_LOGIN, type LookupUser } from '../auth/github.ts'
import { errorMessage, log } from '../log.ts'
import { invitationRoutes, memberRoutes, pageRoutes } from '../routes.ts'
import { InvitationsPage, isMemberNotice, MembersPage, refusalNotice, type MemberNotice } from '../ui/members.tsx'
import type { ScreenKit } from '../ui/pages.tsx'
import { decideInvite, isInvitationRole, type MemberChange } from './rules.ts'
import type { MembersStore } from './store.ts'

/** The members screen. Null: it answers 404. */
export interface MembersDependencies {
  store: MembersStore
  /** Reads the account of a login on GitHub. Null without the GitHub App: nobody can be invited. */
  lookupUser: LookupUser | null
}

const EXIT = { href: pageRoutes.settings.href(), label: 'Back to the settings' }
const ROLES = ['owner', 'admin', 'member'] as const

function toMembers(notice: MemberNotice, extra: Record<string, string> = {}) {
  let query = new URLSearchParams({ notice, ...extra })
  return new Response(null, { status: 303, headers: { Location: `${memberRoutes.members.href()}?${query}` } })
}

export function createMemberControllers(kit: ScreenKit, deps: MembersDependencies | null) {
  let members = createController(memberRoutes, {
    middleware: kit.middleware,
    actions: {
      async members(context) {
        if (!deps) return kit.errorPage(context, 404, 'page', 'settings', EXIT)
        let signed = kit.signedIn(context)
        let { members: list, invitations } = await deps.store.list(signed.membership.org.id, kit.now())
        let notice = context.url.searchParams.get('notice')
        let login = context.url.searchParams.get('login')
        return context.render(
          <MembersPage
            frame={kit.frame(context)}
            actor={{ userId: signed.user.id, role: signed.membership.role, source: signed.membership.source }}
            members={list}
            invitations={invitations}
            notice={isMemberNotice(notice) ? notice : null}
            login={login && GITHUB_LOGIN.test(login) ? login : null}
          />,
        )
      },

      async memberInvite(context) {
        if (!deps) return kit.errorPage(context, 404, 'page', 'settings', EXIT)
        let signed = kit.signedIn(context)
        let form = context.get(FormData)
        let login = String(form?.get('login') ?? '').trim().replace(/^@/, '')
        let role = String(form?.get('role') ?? '')
        let refusal = decideInvite(signed.membership, role)
        if (refusal === 'not_admin') {
          log('warn', 'members.invite_refused', { login: signed.user.login, org: signed.membership.org.name, reason: refusal })
          return kit.forbidden()
        }
        if (refusal || !isInvitationRole(role)) return kit.errorPage(context, 400, 'form', 'settings', EXIT)
        if (!GITHUB_LOGIN.test(login)) return toMembers('unknown_login')
        let installation = signed.membership.org.installations[0]
        if (!deps.lookupUser || !installation) return toMembers('github_failed', { login })
        let account: { id: number; login: string } | null
        try {
          account = await deps.lookupUser(installation, login)
        } catch (error) {
          log('warn', 'members.lookup_failed', { org: signed.membership.org.name, error: errorMessage(error) })
          return toMembers('github_failed', { login })
        }
        if (!account) return toMembers('unknown_login', { login })
        let outcome = await deps.store.invite({
          orgId: signed.membership.org.id,
          githubId: account.id,
          githubLogin: account.login,
          role,
          inviterId: signed.user.id,
          now: kit.now(),
        })
        log('info', 'members.invited', { login: signed.user.login, org: signed.membership.org.name, invitee: account.login, role, outcome })
        return toMembers(outcome)
      },

      async invitationCancel(context) {
        if (!deps) return kit.errorPage(context, 404, 'page', 'settings', EXIT)
        let signed = kit.signedIn(context)
        if (!canEdit(signed.membership.role)) return kit.forbidden()
        if (!UUID.test(context.params.id)) return toMembers('not_found')
        let canceled = await deps.store.cancel(signed.membership.org.id, context.params.id, kit.now())
        if (canceled) log('info', 'members.invitation_canceled', { login: signed.user.login, org: signed.membership.org.name })
        return toMembers(canceled ? 'canceled' : 'not_found')
      },

      async memberRole(context) {
        let role = context.get(FormData)?.get('role')
        let found = ROLES.find((r) => r === role)
        if (!found) return kit.errorPage(context, 400, 'form', 'settings', EXIT)
        return change(context, context.params.id, { kind: 'role', role: found }, 'role')
      },

      async memberRemove(context) {
        return change(context, context.params.id, { kind: 'remove' }, 'removed')
      },

      async memberLeave(context) {
        return change(context, null, { kind: 'leave' }, null)
      },
    },
  })

  /** One change of a membership: the store decides under the lock of the org. */
  async function change(context: Parameters<ScreenKit['signedIn']>[0], membershipId: string | null, change: MemberChange, done: MemberNotice | null) {
    if (!deps) return kit.errorPage(context, 404, 'page', 'settings', EXIT)
    let signed = kit.signedIn(context)
    if (membershipId !== null && !UUID.test(membershipId)) return toMembers('not_found')
    let outcome = await deps.store.change({ orgId: signed.membership.org.id, actorUserId: signed.user.id, membershipId, change, now: kit.now() })
    let fields = { login: signed.user.login, org: signed.membership.org.name, change: change.kind }
    if (!outcome.ok) {
      log('warn', 'members.change_refused', { ...fields, reason: outcome.reason })
      // A member who posts a form of an admin gets the 403 of every screen.
      if (outcome.reason === 'not_admin' && change.kind !== 'leave') return kit.forbidden()
      return toMembers(refusalNotice(outcome.reason))
    }
    log('info', 'members.changed', { ...fields, role: outcome.role })
    // Gone from the org: the next request moves the session to another org, or to the sign-in.
    if (change.kind === 'leave') return kit.redirect(pageRoutes.home.href())
    return toMembers(done ?? 'role')
  }

  let invitations = createController(invitationRoutes, {
    middleware: kit.personMiddleware,
    actions: {
      async invitations(context) {
        if (!deps) return kit.errorPage(context, 404, 'page', undefined, { href: '/', label: 'Back to the dashboard' })
        let person = kit.person(context)
        let own = await deps.store.own(person.user.githubId, kit.now())
        let notice = context.url.searchParams.get('notice')
        return context.render(
          <InvitationsPage
            frame={kit.personFrame(context)}
            invitations={own}
            alone={person.signed === null}
            login={person.user.login}
            notice={notice === 'declined' || notice === 'gone' ? notice : null}
          />,
        )
      },

      async invitationAccept(context) {
        if (!deps) return kit.redirect(invitationRoutes.invitations.href())
        let person = kit.person(context)
        let accepted = UUID.test(context.params.id) ? await deps.store.accept(context.params.id, person.user, kit.now()) : null
        if (!accepted) return kit.redirect(`${invitationRoutes.invitations.href()}?notice=gone`)
        log('info', 'members.invitation_accepted', { login: person.user.login, org: accepted.orgId, role: accepted.role })
        // The session opens the org of the invitation.
        await kit.setActiveOrg(person.sessionId, accepted.orgId)
        return kit.redirect(pageRoutes.home.href())
      },

      async invitationDecline(context) {
        if (!deps) return kit.redirect(invitationRoutes.invitations.href())
        let person = kit.person(context)
        let declined = UUID.test(context.params.id) ? await deps.store.decline(context.params.id, person.user.githubId, kit.now()) : false
        if (declined) log('info', 'members.invitation_declined', { login: person.user.login })
        return kit.redirect(`${invitationRoutes.invitations.href()}?notice=${declined ? 'declined' : 'gone'}`)
      },
    },
  })

  return { members, invitations }
}
