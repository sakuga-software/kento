// KNT-150. The org on screen (`organizationRoutes`): its name and its installations. The org is
// always the one of the session: an installation of another org in a URL finds nothing.
import { createController } from 'remix/router'

import { UUID } from '@kento-review/protocol'

import type { InstallationAccount, LookupAccountType, LookupRole } from '../auth/github.ts'
import { errorMessage, log } from '../log.ts'
import { organizationRoutes, pageRoutes } from '../routes.ts'
import { isOrgNotice, OrganizationPage, type OrgNotice } from '../ui/organization.tsx'
import type { ScreenKit } from '../ui/pages.tsx'
import { readOrgName } from './rules.ts'
import type { OrgInstallationView, OrgsStore } from './store.ts'

/** The organization screen. Null: it answers 404. */
export interface OrganizationDependencies {
  store: OrgsStore
  /** Asks GitHub for the role of a person in the account of an installation. Null: no move. */
  lookupRole: LookupRole | null
  /** Asks GitHub whether the account of an installation is a person. Null: no move. */
  lookupAccountType: LookupAccountType | null
}

function accountOf(installation: OrgInstallationView): InstallationAccount {
  return { githubInstallationId: installation.githubInstallationId, githubAccountId: installation.githubAccountId, login: installation.login }
}

const EXIT = { href: pageRoutes.settings.href(), label: 'Back to the settings' }

function toOrganization(notice: OrgNotice) {
  return new Response(null, { status: 303, headers: { Location: `${organizationRoutes.organization.href()}?notice=${notice}` } })
}

export function createOrganizationController(kit: ScreenKit, deps: OrganizationDependencies | null) {
  return createController(organizationRoutes, {
    middleware: kit.middleware,
    actions: {
      async organization(context) {
        if (!deps) return kit.errorPage(context, 404, 'page', 'settings', EXIT)
        let signed = kit.signedIn(context)
        let org = await deps.store.view(signed.membership.org.id)
        if (!org) return kit.errorPage(context, 404, 'page', 'settings', EXIT)
        let owner = signed.membership.role === 'owner'
        let notice = context.url.searchParams.get('notice')
        return context.render(
          <OrganizationPage
            frame={kit.frame(context)}
            org={org}
            owner={owner}
            targets={owner ? await deps.store.ownedOrgs(signed.user.id, org.id) : []}
            notice={isOrgNotice(notice) ? notice : null}
          />,
        )
      },

      async organizationRename(context) {
        if (!deps) return kit.errorPage(context, 404, 'page', 'settings', EXIT)
        let signed = kit.signedIn(context)
        if (signed.membership.role !== 'owner') return kit.forbidden()
        let name = readOrgName(context.get(FormData)?.get('name'))
        if (!name) return toOrganization('bad_name')
        let outcome = await deps.store.rename(signed.membership.org.id, signed.user.id, name)
        if (!outcome.ok) return outcome.reason === 'not_owner' ? kit.forbidden() : toOrganization(outcome.reason)
        log('info', 'organizations.renamed', { login: signed.user.login, org: signed.membership.org.id, name })
        return toOrganization('renamed')
      },

      async installationMove(context) {
        if (!deps) return kit.errorPage(context, 404, 'page', 'settings', EXIT)
        let signed = kit.signedIn(context)
        if (signed.membership.role !== 'owner') return kit.forbidden()
        let id = context.params.id
        let form = context.get(FormData)
        let toValue = String(form?.get('to') ?? '')
        let org = await deps.store.view(signed.membership.org.id)
        let installation = UUID.test(id) ? org?.installations.find((i) => i.id === id && !i.suspended) : undefined
        if (!org || !installation) return toOrganization('not_found')
        let to: { orgId: string } | { name: string } | { detach: true }
        if (toValue === 'new') {
          let name = readOrgName(form?.get('name'))
          if (!name) return toOrganization('bad_name')
          to = { name }
        } else if (toValue === 'detach') {
          to = { detach: true }
        } else if (UUID.test(toValue)) {
          to = { orgId: toValue }
        } else {
          return kit.errorPage(context, 400, 'form', 'settings', EXIT)
        }
        if (!deps.lookupRole || !deps.lookupAccountType) return toOrganization('github_failed')
        let { lookupRole, lookupAccountType } = deps
        let person = { githubId: signed.user.githubId, login: signed.user.login }
        // GitHub, now, before the locks: the store decides with these answers, and refuses when the
        // installations changed in between.
        let checked = new Set<string>()
        let adminOf = new Set<string>()
        let personal = new Set<string>()
        let ask = async (asked: OrgInstallationView, type: boolean) => {
          if ((await lookupRole(accountOf(asked), person)) === 'admin') adminOf.add(asked.id)
          if (type && (await lookupAccountType(accountOf(asked))) === 'User') personal.add(asked.id)
          checked.add(asked.id)
        }
        try {
          if ('detach' in to) {
            // An admin on GitHub of another active account of the org: one answer is enough.
            let remaining = org.installations.filter((i) => !i.suspended && i.id !== installation.id)
            let failure: unknown = null
            for (let other of remaining) {
              try {
                await ask(other, false)
              } catch (error) {
                failure ??= error
              }
              if (adminOf.has(other.id)) break
            }
            if (adminOf.size === 0 && failure !== null) throw failure
          } else if ('orgId' in to) {
            let targetId = to.orgId
            if (!(await deps.store.ownedOrgs(signed.user.id, org.id)).some((target) => target.id === targetId)) return toOrganization('target_not_owner')
            let targets = await deps.store.activeInstallations(targetId)
            await Promise.all([ask(installation, true), ...targets.map((target) => ask(target, true))])
          } else {
            await ask(installation, false)
          }
        } catch (error) {
          log('warn', 'organizations.role_check_failed', { org: org.id, error: errorMessage(error) })
          return toOrganization('github_failed')
        }
        let outcome = await deps.store.moveInstallation({
          fromOrgId: org.id,
          installationId: installation.id,
          to,
          actorUserId: signed.user.id,
          checks: { checked, adminOf, personal },
          deleteEmpty: String(form?.get('confirm') ?? '').trim() === org.name,
        })
        let fields = { login: signed.user.login, org: org.id, installation: installation.githubInstallationId }
        if (!outcome.ok) {
          log('warn', 'organizations.move_refused', { ...fields, reason: outcome.reason })
          return toOrganization(outcome.reason === 'bad_name' ? 'bad_name' : outcome.reason)
        }
        log('info', 'organizations.installation_moved', { ...fields, to: outcome.orgId, detached: 'detach' in to, deleted: outcome.deleted })
        // A detach leaves the person where they are. A move: the session follows the installation.
        if ('detach' in to) return toOrganization('detached')
        // The move is committed: a failure here only leaves the session on the org it was on (or,
        // when that org is gone, on another org of the person at the next request).
        try {
          await kit.setActiveOrg(signed.sessionId, outcome.orgId)
        } catch (error) {
          log('warn', 'organizations.session_org_failed', { ...fields, to: outcome.orgId, error: errorMessage(error) })
        }
        return toOrganization('moved')
      },
    },
  })
}
