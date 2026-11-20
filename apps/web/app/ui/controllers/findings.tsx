// REV-18. The Findings screen: a member reads the findings of the org; an admin marks them dismissed
// or wontfix.
import { createAction } from 'remix/router'

import { readStatusForm } from '../../findings/dismiss.ts'
import type { FindingFacets, FindingScreenPage } from '../../findings/screen.ts'
import { log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { findingListQuery, FindingsPage, readFindingList, readFindingsNotice } from '../findings.tsx'
import { forbidden, isAdmin, PlaceholderPage, redirect, signedOf, type UiKit } from './kit.tsx'

/** What the tab "Precision" gets in place of the list: it shows neither. */
const NO_PAGE: FindingScreenPage = {
  rows: [],
  counts: { open: 0, fixed: 0, dismissed: 0, wontfix: 0, stale: 0, closed: 0, all: 0 },
  matching: 0,
  offset: 0,
  page: 1,
  pages: 1,
}
const NO_FACETS: FindingFacets = { repos: [], rules: [] }

export function findingsActions(kit: UiKit) {
  let { deps } = kit
  return {
    // The filters and the page are in the query.
    findings: createAction(pageRoutes.findings, async (context) => {
      let signed = signedOf(context)
      let page = kit.page(context)
      let findings = deps.findings
      if (!findings) return context.render(<PlaceholderPage frame={page} section="findings" />)
      let orgId = signed.membership.org.id
      let list = readFindingList(context.url.searchParams)
      // The tab "Precision" shows no row and no filter: no query for them.
      let precisionTab = list.tab === 'precision'
      let [result, facets, precision] = await Promise.all([
        precisionTab ? NO_PAGE : findings.store.list(orgId, list),
        precisionTab ? NO_FACETS : findings.store.facets(orgId),
        findings.store.precision(orgId),
      ])
      return context.render(
        <FindingsPage
          frame={page}
          page={result}
          facets={facets}
          list={list}
          precision={precision}
          githubUrl={findings.githubUrl}
          now={new Date(kit.now())}
          notice={readFindingsNotice(context.url.searchParams)}
        />,
      )
    }),

    // "Mark dismissed" and "Mark wontfix": an admin of the org on screen only. cop() and
    // csrf() of the session layer ran before.
    findingsStatus: createAction(pageRoutes.findingsStatus, async (context) => {
      let signed = signedOf(context)
      let setStatus = deps.findings?.setStatus
      if (!setStatus || !isAdmin(signed)) return forbidden()
      let form = context.get(FormData)
      // Back to the list on screen: its query, read again, so that nothing else comes through. Always the
      // tab "List": the action and its count are there.
      let back = findingListQuery({ ...readFindingList(new URLSearchParams(String(form?.get('back') ?? ''))), tab: 'list' })
      let read = readStatusForm(form)
      if (!read.ok) {
        back.set('error', read.error)
        return redirect(`${pageRoutes.findings.href()}?${back}`)
      }
      let outcome = await setStatus({ orgId: signed.membership.org.id, ids: read.ids, status: read.status, reason: read.reason, actor: signed.user.login })
      log('info', 'findings.status_set', {
        login: signed.user.login,
        org: signed.membership.org.name,
        status: read.status,
        asked: read.ids.length,
        ...outcome,
      })
      back.set('done', read.status)
      back.set('n', String(outcome.changed))
      if (outcome.unchanged) back.set('same', String(outcome.unchanged))
      if (outcome.fixed) back.set('fixed', String(outcome.fixed))
      if (outcome.missing) back.set('missing', String(outcome.missing))
      if (outcome.failed) back.set('failed', String(outcome.failed))
      if (outcome.replied) back.set('replied', String(outcome.replied))
      if (outcome.unreplied) back.set('unreplied', String(outcome.unreplied))
      return redirect(`${pageRoutes.findings.href()}?${back}`)
    }),
  }
}
