import { PATHS } from '@kento-review/protocol'
import { post, route } from 'remix/routes'

/** The runner API. packages/protocol describes each message. */
export const runnerRoutes = route({
  register: post(PATHS.register),
  claim: post(PATHS.claim),
  heartbeat: post('/api/runner/jobs/:id/heartbeat'),
  result: post('/api/runner/jobs/:id/result'),
})
