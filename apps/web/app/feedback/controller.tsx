// REV-107. The controller of the answers about the reviews, on the frame of the screens (`ScreenKit` of
// app/ui/pages.tsx): the session, the signed-in person, the 404 page.
import { createController } from 'remix/router'

import { feedbackRoutes } from '../routes.ts'
import { FeedbackPage, feedbackHref, readFeedbackQuery } from '../ui/feedback.tsx'
import type { ScreenKit } from '../ui/pages.tsx'
import type { FeedbackStore } from './store.ts'

/** The screen of the answers. Null: it answers 404. */
export interface FeedbackDependencies {
  store: FeedbackStore
  now?: () => number
}

export function createFeedbackControllers(kit: ScreenKit, deps: FeedbackDependencies | null) {
  let now = deps?.now ?? Date.now
  return createController(feedbackRoutes, {
    middleware: kit.middleware,
    actions: {
      async feedback(context) {
        let signed = kit.signed(context)
        if (!deps) return kit.errorPage(context, 404, 'page')
        let query = readFeedbackQuery(context.url.searchParams)
        // KNT-195. One URL for one screen: the form of the filters sends its empty fields, and a value
        // the screen cannot read gives the default. Both go to the URL with only the values in use.
        let canonical = feedbackHref(query)
        if (`${context.url.pathname}${context.url.search}` !== canonical) return kit.redirect(canonical)
        let screen = await deps.store.list(signed.orgId, query)
        return context.render(
          <FeedbackPage frame={kit.frame(context)} screen={screen} query={query} now={new Date(now())} />,
        )
      },
    },
  })
}
