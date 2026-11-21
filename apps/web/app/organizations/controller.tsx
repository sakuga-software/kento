// KNT-150. The org on screen (`organizationRoutes`): its name and its installations. The org is
// always the one of the session: an installation of another org in a URL finds nothing.
import { createController } from 'remix/router'

import { UUID } from '@kento-review/protocol'

import type { LookupRole } from '../auth/github.ts'
import { errorMessage, log } from '../log.ts'
import { organizationRoutes, pageRoutes } from '../routes.ts'
import { isOrgNotice, OrganizationPage, type OrgNotice } from '../ui/organization.tsx'
import type { ScreenKit } from '../ui/pages.tsx'
import { readOrgName } from './rules.ts'
import type { OrgsStore } from './store.ts'

/** The organization screen. Null: it answers 404. */
export interface OrganizationDependencies {
  store: OrgsStore
  /** Asks GitHub for the role of a person in the account of an installation. Null: no move. */
  lookupRole: LookupRole | null
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
        log('info', 'organizations.renamed', { login: signed.user.login, org: signed.membership.org.id })
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
        let to: { orgId: string } | { name: string }
        if (toValue === 'new') {
          let name = readOrgName(form?.get('name'))
          if (!name) return toOrganization('bad_name')
          to = { name }
        } else if (UUID.test(toValue)) {
          to = { orgId: toValue }
        } else {
          return kit.errorPage(context, 400, 'form', 'settings', EXIT)
        }
        // GitHub, now: the person is an admin of the account of the installation.
        if (!deps.lookupRole) return toOrganization('github_failed')
        let githubAdmin: boolean
        try {
          githubAdmin =
            (await deps.lookupRole(
              { githubInstallationId: installation.githubInstallationId, githubAccountId: installation.githubAccountId, login: installation.login },
              { githubId: signed.user.githubId, login: signed.user.login },
            )) === 'admin'
        } catch (error) {
          log('warn', 'organizations.role_check_failed', { org: org.id, error: errorMessage(error) })
          return toOrganization('github_failed')
        }
        let outcome = await deps.store.moveInstallation({
          fromOrgId: org.id,
          installationId: installation.id,
          to,
          actorUserId: signed.user.id,
          githubAdmin,
          deleteEmpty: String(form?.get('confirm') ?? '').trim() === org.name,
        })
        let fields = { login: signed.user.login, org: org.id, installation: installation.githubInstallationId }
        if (!outcome.ok) {
          log('warn', 'organizations.move_refused', { ...fields, reason: outcome.reason })
          return toOrganization(outcome.reason === 'bad_name' ? 'bad_name' : outcome.reason)
        }
        log('info', 'organizations.installation_moved', { ...fields, to: outcome.orgId, deleted: outcome.deleted })
        // The session follows the installation to its new org.
        await kit.setActiveOrg(signed.sessionId, outcome.orgId)
        return toOrganization('moved')
      },
    },
  })
}
