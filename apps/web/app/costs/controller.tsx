// KNT-188. The Costs screen, on the frame of the screens (`ScreenKit` of app/ui/pages.tsx): the
// session, the signed-in member and their org, the 404 page. Every member reads it.
import { createController } from 'remix/router'

import { costRoutes } from '../routes.ts'
import { CostsPage } from '../ui/costs.tsx'
import type { ScreenKit } from '../ui/pages.tsx'
import { DEFAULT_PERIOD, readPeriod } from './period.ts'
import type { CostsStore } from './store.ts'

/** The Costs screen. Null: it answers 404. */
export interface CostsDependencies {
  store: CostsStore
}

export function createCostControllers(kit: ScreenKit, deps: CostsDependencies | null) {
  return createController(costRoutes, {
    middleware: kit.middleware,
    actions: {
      async costs(context) {
        let signed = kit.signed(context)
        if (!deps) return kit.errorPage(context, 404, 'page')
        let asked = context.url.searchParams.get('period')
        let period = readPeriod(asked)
        // KNT-195: the default and an unknown value both read `/costs`, the one URL of the default.
        if (asked !== null && period === DEFAULT_PERIOD) return kit.redirect(costRoutes.costs.href())
        let report = await deps.store.report(signed.orgId, period)
        return context.render(<CostsPage frame={kit.frame(context)} report={report} />)
      },
    },
  })
}
