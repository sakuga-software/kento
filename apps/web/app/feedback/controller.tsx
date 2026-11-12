// REV-107. The controller of the answers about the reviews, on the frame of the screens (`ScreenKit` of
// app/ui/pages.tsx): the session, the signed-in person, the 404 page.
import { createController } from 'remix/router'

import { feedbackRoutes } from '../routes.ts'
import { FeedbackPage, readFeedbackQuery } from '../ui/feedback.tsx'
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
        let screen = await deps.store.list(signed.orgId, query)
        return context.render(
          <FeedbackPage frame={kit.frame(context)} screen={screen} query={query} now={new Date(now())} />,
        )
      },
    },
  })
}
