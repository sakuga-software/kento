// REV-107. "Feedback": the answers about the reviews of the org, for every member.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG } from '../auth/test-helpers.ts'
import type { FeedbackQuery, FeedbackStore } from '../feedback/store.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { readFeedbackQuery } from './feedback.tsx'

const COOKIE = '__Host-kento_session'
const NOW = new Date('2026-11-12T10:00:00Z')
const REPO = '44444444-4444-4444-8444-444444444444'

function setup() {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let asked: { orgId: string; query: FeedbackQuery | undefined }[] = []
  let store: FeedbackStore = {
    async list(orgId, query) {
      asked.push({ orgId, query })
      return {
        total: 2,
        repos: [{ id: REPO, fullName: 'sakuga-software/sakuga-review' }],
        rows: [
          {
            id: 'f-1',
            repoId: REPO,
            repo: 'sakuga-software/sakuga-review',
            prNumber: 172,
            authorLogin: 'sakuga-agent[bot]',
            authorIsBot: true,
            source: 'command',
            text: 'The thread about the cache was useless.',
            url: 'https://github.com/sakuga-software/sakuga-review/pull/172#issuecomment-1',
            score: 4,
            createdAt: new Date(NOW.getTime() - 3_600_000),
          },
          {
            id: 'f-2',
            repoId: REPO,
            repo: 'sakuga-software/sakuga-review',
            prNumber: 170,
            authorLogin: 'camille',
            authorIsBot: false,
            source: 'reaction',
            text: '👍',
            url: null,
            score: null,
            createdAt: new Date(NOW.getTime() - 7_200_000),
          },
        ],
      }
    },
  }
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    feedback: { store, now: () => NOW.getTime() },
  })
  let request = (path: string, cookie?: string | null) =>
    router.fetch(new Request(new URL(path, 'http://localhost'), { headers: cookie ? { Cookie: cookie } : {} }))
  async function signIn(profile = CAMILLE) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookieOf(start, COOKIE))
    return cookieOf(callback, COOKIE)!
  }
  return { request, signIn, asked }
}

describe('the page of the answers about the reviews (REV-107)', () => {
  it('lists the answers of the org for a member, with the PR, the author, person or agent, the source and the score', async () => {
    let { request, signIn, asked } = setup()
    let cookie = await signIn()
    let response = await request('/feedback', cookie)
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.equal(asked[0]!.orgId, ORG.id)
    assert.match(html, /<h1 class="page-title">Feedback<\/h1>/)
    assert.match(html, /<a href="\/feedback" aria-current="page" class="bar-link">Feedback<\/a>/)
    assert.match(html, /The thread about the cache was useless\./)
    assert.match(html, /href="https:\/\/github\.com\/sakuga-software\/sakuga-review\/pull\/172#issuecomment-1"/)
    assert.match(html, />sakuga-review#172</)
    assert.match(html, /sakuga-agent\[bot\]<\/span> <span class="tag tag-info">Agent<\/span>/)
    assert.match(html, /camille<\/span> <span class="tag tag-quiet">Person<\/span>/)
    assert.match(html, /<td>Command<\/td>/)
    assert.match(html, /<td>Reaction<\/td>/)
    assert.match(html, /4\/5/)
    assert.ok(html.indexOf('sakuga-review#172') < html.indexOf('sakuga-review#170'), 'the newest first')
  })

  it('passes the filters of the query, and drops the values it does not know', async () => {
    let { request, signIn, asked } = setup()
    let cookie = await signIn()
    let html = await (await request(`/feedback?repo=${REPO}&source=quote&author=agent`, cookie)).text()
    assert.deepEqual(asked[0]!.query, { repoId: REPO, source: 'quote', kind: 'agent' })
    assert.match(html, /<option value="quote" selected="">Quote<\/option>|<option value="quote" selected>Quote<\/option>/)
    assert.deepEqual(readFeedbackQuery(new URLSearchParams('source=other&author=robot')), { repoId: null, source: null, kind: null })
  })

  it('needs a sign-in', async () => {
    let { request } = setup()
    let response = await request('/feedback')
    assert.equal(response.status, 303)
  })
})
