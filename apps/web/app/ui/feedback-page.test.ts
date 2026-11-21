// REV-107. "Feedback": the answers about the reviews of the org, for every member.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, SESSION_COOKIE } from '../auth/test-helpers.ts'
import type { FeedbackQuery, FeedbackScreen, FeedbackStore } from '../feedback/store.ts'
import { encodeCursor } from '../findings/store.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { readFeedbackQuery } from './feedback.tsx'

const COOKIE = SESSION_COOKIE
const NOW = new Date('2026-11-12T10:00:00Z')
const REPO = '44444444-4444-4444-8444-444444444444'
const cursor = (at: string) => encodeCursor({ at, id: '55555555-5555-4555-8555-555555555555' })
const HERE = cursor('2026-11-10T10:00:00.000000Z')
const NEWER = cursor('2026-11-11T10:00:00.000000Z')
const OLDER = cursor('2026-11-09T10:00:00.000000Z')

function setup(page: Partial<Pick<FeedbackScreen, 'older' | 'newer' | 'rows'>> = {}) {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, OCTOCAT, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let asked: { orgId: string; query: FeedbackQuery | undefined }[] = []
  let store: FeedbackStore = {
    async list(orgId, query) {
      asked.push({ orgId, query })
      return {
        older: page.older ?? null,
        newer: page.newer ?? null,
        repos: [{ id: REPO, fullName: 'sakuga-software/sakuga-review' }],
        rows: page.rows ?? [
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
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookiesOf(start))
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
    assert.deepEqual(asked[0]!.query, { repoId: REPO, source: 'quote', kind: 'agent', before: null })
    assert.match(html, /<option value="quote" selected="">Quote<\/option>|<option value="quote" selected>Quote<\/option>/)
    assert.deepEqual(readFeedbackQuery(new URLSearchParams('source=other&author=robot')), { repoId: null, source: null, kind: null, before: null })
  })

  it('links Newer and Older with the cursors of the store, and keeps the filters in them (KNT-176)', async () => {
    let { request, signIn, asked } = setup({ older: OLDER, newer: { before: NEWER } })
    let cookie = await signIn()
    let html = await (await request(`/feedback?repo=${REPO}&source=quote&author=agent&before=${HERE}`, cookie)).text()
    assert.deepEqual(asked[0]!.query, { repoId: REPO, source: 'quote', kind: 'agent', before: HERE })
    let filters = `repo=${REPO}&amp;source=quote&amp;author=agent`
    assert.match(html, /<nav aria-label="Pages of the feedback" class="pager pager-steps">/)
    assert.ok(html.includes(`href="/feedback?${filters}&amp;before=${NEWER}" rel="prev"`), 'Newer')
    assert.ok(html.includes(`href="/feedback?${filters}&amp;before=${OLDER}" rel="next"`), 'Older')
    // The form of the filters goes back to the newest page: it has no field `before`.
    assert.doesNotMatch(html, /name="before"/)
  })

  it('links Newer to the first page, and shows no Older on the last page (KNT-176)', async () => {
    let { request, signIn } = setup({ newer: { before: null } })
    let cookie = await signIn()
    let html = await (await request(`/feedback?source=command&before=${HERE}`, cookie)).text()
    assert.ok(html.includes('href="/feedback?source=command" rel="prev"'), 'Newer is the first page, with the filter')
    assert.match(html, /Older<span class="visually-hidden"> \(no older feedback\)<\/span>/)
    assert.doesNotMatch(html, /rel="next"/)
  })

  it('shows no pager when the answers fit on one page (KNT-176)', async () => {
    let { request, signIn } = setup()
    let html = await (await request('/feedback', await signIn())).text()
    assert.doesNotMatch(html, /Pages of the feedback/)
  })

  it('after the last page, says so and links the newest feedback with the filters (KNT-176)', async () => {
    let { request, signIn } = setup({ rows: [], newer: { before: null } })
    let html = await (await request(`/feedback?repo=${REPO}&before=${HERE}`, await signIn())).text()
    assert.match(html, /<h2 id="empty-title">No older feedback<\/h2>/)
    assert.ok(html.includes(`<a href="/feedback?repo=${REPO}">See the newest feedback</a>`))
    assert.doesNotMatch(html, /No feedback yet/)
  })

  it('sends a URL with an empty field, a value it cannot read or a broken cursor to the URL of the same screen (KNT-195)', async () => {
    let { request, signIn, asked } = setup()
    let cookie = await signIn()
    let cases: [string, string][] = [
      ['/feedback?repo=&source=&author=', '/feedback'],
      [`/feedback?repo=${REPO}&source=&author=`, `/feedback?repo=${REPO}`],
      ['/feedback?repo=not-an-id&source=reaction', '/feedback?source=reaction'],
      [`/feedback?source=quote&before=broken`, '/feedback?source=quote'],
      [`/feedback?before=${cursor('2026-02-30T10:00:00.000000Z')}`, '/feedback'],
      [`/feedback?author=agent&repo=${REPO}`, `/feedback?repo=${REPO}&author=agent`],
      ['/feedback?other=1', '/feedback'],
      // A variant of a cursor that reads as the same one goes to the cursor as the screen writes it.
      [`/feedback?before=${HERE}+`, `/feedback?before=${HERE}`],
      [`/feedback?before=${Buffer.from(`${Buffer.from(HERE, 'base64url').toString()}|x`).toString('base64url')}`, `/feedback?before=${HERE}`],
    ]
    for (let [from, to] of cases) {
      let response = await request(from, cookie)
      assert.equal(response.status, 303, from)
      assert.equal(response.headers.get('Location'), to, from)
    }
    assert.equal(asked.length, 0, 'no list read before the redirect')
    assert.equal((await request(`/feedback?repo=${REPO}&source=quote&before=${HERE}`, cookie)).status, 200, 'a canonical URL is shown')
  })

  it('needs a sign-in', async () => {
    let { request } = setup()
    let response = await request('/feedback')
    assert.equal(response.status, 303)
  })
})
