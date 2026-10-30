// REV-10. The Runners screen: a member reads it; an admin registers, trusts and revokes runners.
import { createAction } from 'remix/router'

import { UUID } from '@sakuga-review/protocol'

import { log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { hashToken, newRegistrationToken } from '../../runner/tokens.ts'
import { readRegistrationForm, RUNNER_NOTICES, RunnersPage, type RunnerNotice, type RunnersPageProps } from '../runners.tsx'
import type { PageFrame } from '../shell.tsx'
import { forbidden, isAdmin, PlaceholderPage, redirect, RUNNERS_EXIT, signedOf, type ScreenContext, type SignedIn, type UiKit } from './kit.tsx'

export function runnersActions(kit: UiKit) {
  let { deps } = kit

  async function renderRunners(
    context: ScreenContext,
    signed: SignedIn,
    page: PageFrame,
    extra: Pick<RunnersPageProps, 'created' | 'form' | 'notice'>,
    status = 200,
  ) {
    let screen = await deps.runners!.screen(signed.membership.org.id)
    return context.render(
      <RunnersPage frame={page} screen={screen} version={deps.version} kentoUrl={deps.auth!.publicUrl.origin} {...extra} />,
      { status },
    )
  }

  /** The store of the runners and the signed-in admin of a form, or null for the 403. */
  function admin(context: ScreenContext) {
    let signed = signedOf(context)
    let store = deps.runners
    return store && isAdmin(signed) ? { signed, store } : null
  }

  return {
    runners: createAction(pageRoutes.runners, async (context) => {
      let signed = signedOf(context)
      let page = kit.page(context)
      if (!deps.runners) return context.render(<PlaceholderPage frame={page} section="runners" />)
      let notice = context.url.searchParams.get('notice')
      return renderRunners(context, signed, page, {
        notice: notice !== null && notice in RUNNER_NOTICES ? (notice as RunnerNotice) : null,
      })
    }),

    // « Nouveau runner »: a registration token, shown on this response only. A reload posts the
    // form again and makes another token; the first one then ends unused after its hour.
    runnerNew: createAction(pageRoutes.runnerNew, async (context) => {
      let found = admin(context)
      if (!found) return forbidden()
      let { signed, store } = found
      let page = kit.page(context)
      let { values, input, errors } = readRegistrationForm(context.get(FormData))
      if (!input) return renderRunners(context, signed, page, { form: { values, errors } }, 422)
      let token = newRegistrationToken()
      let created = await store.createRegistration({
        orgId: signed.membership.org.id,
        userId: signed.user.id,
        name: input.name,
        labels: input.labels,
        trusted: input.trusted,
        tokenHash: hashToken(token),
      })
      log('info', 'runner.registration_created', {
        registrationId: created.id,
        org: signed.membership.org.login,
        by: signed.user.login,
        name: input.name,
        labels: input.labels,
        trusted: input.trusted,
      })
      return renderRunners(context, signed, page, { created: { ...input, token, expiresAt: created.expiresAt } }, 201)
    }),

    runnerRenew: createAction(pageRoutes.runnerRenew, async (context) => {
      let found = admin(context)
      if (!found) return forbidden()
      let { signed, store } = found
      let id = context.params.id
      if (!UUID.test(id)) return redirect(`${pageRoutes.runners.href()}?notice=missing`)
      let token = newRegistrationToken()
      let renewed = await store.renewRegistration({
        orgId: signed.membership.org.id,
        registrationId: id,
        userId: signed.user.id,
        tokenHash: hashToken(token),
      })
      if (!renewed) return redirect(`${pageRoutes.runners.href()}?notice=missing`)
      log('info', 'runner.registration_created', {
        registrationId: renewed.id,
        replaces: id,
        org: signed.membership.org.login,
        by: signed.user.login,
        name: renewed.name,
        labels: renewed.labels,
        trusted: renewed.trusted,
      })
      return renderRunners(context, signed, kit.page(context), { created: { ...renewed, token } }, 201)
    }),

    runnerDiscard: createAction(pageRoutes.runnerDiscard, async (context) => {
      let found = admin(context)
      if (!found) return forbidden()
      let { signed, store } = found
      let id = context.params.id
      let done = UUID.test(id) && (await store.discardRegistration(signed.membership.org.id, id))
      if (done) log('info', 'runner.registration_discarded', { registrationId: id, by: signed.user.login })
      return redirect(`${pageRoutes.runners.href()}?notice=${done ? 'discarded' : 'missing'}`)
    }),

    runnerTrust: createAction(pageRoutes.runnerTrust, async (context) => {
      let found = admin(context)
      if (!found) return forbidden()
      let { signed, store } = found
      let id = context.params.id
      let value = context.get(FormData)?.get('trusted')
      if (value !== 'true' && value !== 'false') return kit.errorPage(context, 400, 'form', 'runners', RUNNERS_EXIT)
      let trusted = value === 'true'
      let done = UUID.test(id) && (await store.setTrusted(signed.membership.org.id, id, trusted))
      if (done) log('info', 'runner.trust_changed', { runnerId: id, trusted, by: signed.user.login })
      return redirect(`${pageRoutes.runners.href()}?notice=${done ? (trusted ? 'trusted' : 'untrusted') : 'missing'}`)
    }),

    runnerRevoke: createAction(pageRoutes.runnerRevoke, async (context) => {
      let found = admin(context)
      if (!found) return forbidden()
      let { signed, store } = found
      let id = context.params.id
      let revoked = UUID.test(id) ? await store.revoke(signed.membership.org.id, id) : null
      if (revoked) {
        log('info', 'runner.revoked', { runnerId: id, name: revoked.name, requeued: revoked.requeued, by: signed.user.login })
      }
      return redirect(`${pageRoutes.runners.href()}?notice=${revoked ? 'revoked' : 'missing'}`)
    }),

    // REV-37. « Révoquer ces runners… » of the block of the silent runners: the ids that the screen
    // showed. The store keeps only those still silent. cop() and csrf() ran before.
    runnersRevokeSilent: createAction(pageRoutes.runnersRevokeSilent, async (context) => {
      let found = admin(context)
      if (!found) return forbidden()
      let { signed, store } = found
      let ids = (context.get(FormData)?.getAll('id') ?? []).map(String).filter((id) => UUID.test(id)).slice(0, 1000)
      let revoked = await store.revokeSilent(signed.membership.org.id, ids)
      if (revoked.names.length > 0) {
        log('info', 'runner.revoked_silent', { names: revoked.names, requeued: revoked.requeued, by: signed.user.login })
      }
      return redirect(`${pageRoutes.runners.href()}?notice=${revoked.names.length > 0 ? 'revoked_silent' : 'missing'}`)
    }),
  }
}
