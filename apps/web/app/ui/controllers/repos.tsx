// REV-9. The Repos screen: a member reads the list; an admin enables or disables a repository, or
// reads GitHub again.
import { createAction } from 'remix/router'

import { log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { readRepoList, repoListQuery, ReposPage, type ReposNotice } from '../repos.tsx'
import { forbidden, installationUrl, isAdmin, PlaceholderPage, redirect, signedOf, type ScreenContext, type UiKit } from './kit.tsx'

export function reposActions(kit: UiKit) {
  let { deps } = kit

  async function setRepoEnabled(context: ScreenContext & { params: { id: string } }, enabled: boolean) {
    let signed = signedOf(context)
    if (!isAdmin(signed, 'repos.change_refused')) return forbidden()
    let store = deps.repos?.store
    let result = store ? await store.setEnabled(signed.membership.org.id, context.params.id, enabled) : null
    if (!result) return kit.errorPage(context, 404, 'repo', 'repos')
    log('info', enabled ? 'repos.enabled' : 'repos.disabled', {
      login: signed.user.login,
      org: signed.membership.org.name,
      repo: result.fullName,
      cancelled: result.cancelled,
    })
    // REV-36. Back to the page of the list that the form was on: its query carries the filter, the
    // search and the page.
    let query = repoListQuery(readRepoList(context.url.searchParams))
    query.set('done', enabled ? 'enabled' : 'disabled')
    query.set('repo', context.params.id)
    if (!enabled) query.set('cancelled', String(result.cancelled))
    return redirect(`${pageRoutes.repos.href()}?${query}#repo-${context.params.id}`)
  }

  return {
    repos: createAction(pageRoutes.repos, async (context) => {
      let signed = signedOf(context)
      let page = kit.page(context)
      let repos = deps.repos
      if (!repos) return context.render(<PlaceholderPage frame={page} section="repos" />)
      let org = signed.membership.org
      let query = context.url.searchParams
      let list = readRepoList(query)
      let result = await repos.store.list(org.id, list)
      let precisions = deps.findings ? await deps.findings.store.repoPrecisions(org.id, result.rows.map((row) => row.id)) : null
      let checking = repos.check?.refreshIfStale(org, result) ?? false
      let named = query.get('repo')
      let fullName =
        named === null ? null : (result.rows.find((row) => row.id === named)?.fullName ?? (await repos.store.fullName(org.id, named)))
      let done = query.get('done')
      let notice: ReposNotice | null =
        done === 'checked' || done === 'check_failed'
          ? { kind: done }
          : done === 'enabled' && fullName
            ? { kind: 'enabled', fullName }
            : done === 'disabled' && fullName
              ? { kind: 'disabled', fullName, cancelled: Number(query.get('cancelled')) || 0 }
              : null
      return context.render(
        <ReposPage
          frame={page}
          page={result}
          list={list}
          installationUrl={installationUrl(repos.githubUrl, org.installations[0]!)}
          githubUrl={repos.githubUrl}
          checking={checking}
          precisions={precisions}
          notice={notice}
          now={new Date(kit.now())}
        />,
      )
    }),

    // The forms of the screen: an admin of the org on screen only. cop() and csrf() of the session
    // layer ran before.
    repoEnable: createAction(pageRoutes.repoEnable, (context) => setRepoEnabled(context, true)),
    repoDisable: createAction(pageRoutes.repoDisable, (context) => setRepoEnabled(context, false)),
    reposCheck: createAction(pageRoutes.reposCheck, async (context) => {
      let signed = signedOf(context)
      if (!isAdmin(signed)) return forbidden()
      let check = deps.repos?.check
      if (!check) return redirect(`${pageRoutes.repos.href()}?done=check_failed`)
      try {
        await check.run(signed.membership.org)
        return redirect(`${pageRoutes.repos.href()}?done=checked`)
      } catch {
        // The check logs its error.
        return redirect(`${pageRoutes.repos.href()}?done=check_failed`)
      }
    }),
  }
}
