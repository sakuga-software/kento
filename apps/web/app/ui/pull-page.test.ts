import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG } from '../auth/test-helpers.ts'
import { InvalidCursorError } from '../findings/store.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { CodeRead, FindingDetail } from '../pulls/finding.ts'
import type { PullHeader } from '../pulls/github.ts'
import type { PullSheet, PullsStore, PullSummary } from '../pulls/store.ts'
import { createAppRouter } from '../router.ts'
import { codeText } from './finding.tsx'
import { readPullQuery, scoreProgress } from './pull.tsx'

const COOKIE = '__Host-kento_session'
const REPO_ID = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-30T10:00:00Z')

function summary(overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    target: { repoId: REPO_ID, fullName: 'sakuga-software/orchard', prNumber: 142, installationId: 11, githubRepoId: 7001 },
    headSha: 'd'.repeat(40),
    baseRef: 'main',
    reviews: 4,
    lastScores: [4, 4],
    costUsd: 0.5361,
    byStatus: { open: 1, fixed: 1, stale: 0, dismissed: 1, wontfix: 1 },
    active: null,
    ...overrides,
  }
}

function sheet(): PullSheet {
  let review = (n: number, line: string) => ({
    id: `r${n}`,
    number: n,
    level: 'lite' as const,
    headSha: line.repeat(40),
    model: 'm',
    score: 3,
    costUsd: 0.01,
    findings: 2,
    createdAt: NOW,
    publishedAt: NOW,
  })
  return {
    columns: [review(1, 'a'), review(2, 'b')],
    rows: [
      {
        finding: {
          id: 'f1',
          title: 'Le jeton de session n’expire jamais',
          path: 'src/auth/session.ts',
          line: 47,
          severity: 'major',
          category: 'bug',
          confidence: 88,
          status: 'open',
          ruleId: null,
          githubCommentId: 1,
        },
        cells: [
          { state: 'posted', carried: false, line: 42 },
          { state: 'moved', carried: false, line: 47 },
        ],
      },
    ],
    olderCursor: null,
    nextRowsCursor: null,
  }
}

const FINDING_ID = '33333333-3333-4333-8333-333333333333'

function detail(): FindingDetail {
  return {
    id: FINDING_ID,
    target: summary().target,
    title: 'Le jeton de session n’expire jamais',
    path: 'src/auth/session.ts',
    line: 47,
    severity: 'major',
    category: 'bug',
    confidence: 88,
    status: 'dismissed',
    statusReason: 'Faux positif',
    rule: { id: 'rule-1', title: 'Pas de jeton sans expiration' },
    fingerprint: 'a1',
    firstSeenSha: 'a'.repeat(40),
    lastSeenSha: 'd'.repeat(40),
    githubCommentId: 914201,
    review: { id: 'r4', number: 4, level: 'lite', model: 'claude-haiku-4-5', headSha: 'd'.repeat(40), scenario: 'Un jeton volé reste valide.', fix: 'Ajouter exp.', suggestion: '' },
  }
}

function setup(options: { header?: PullHeader | Error | null; found?: boolean; badCursor?: boolean; code?: CodeRead | Error | null } = {}) {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let asked: string[] = []
  let store: PullsStore = {
    async summary(orgId, repoId, prNumber) {
      asked.push(`${orgId} ${repoId} ${prNumber}`)
      return options.found === false ? null : summary()
    },
    async sheet(_target, page) {
      if (options.badCursor && page.reviewsCursor) throw new InvalidCursorError()
      return sheet()
    },
    async finding(orgId, id) {
      asked.push(`finding ${orgId} ${id}`)
      return id === FINDING_ID ? detail() : null
    },
    async history(_orgId, _id, cursor) {
      if (cursor === 'bad') throw new InvalidCursorError()
      return {
        items: [
          { id: 'e1', type: 'opened', actor: 'kento', reason: null, review: 1, createdAt: NOW },
          { id: 'e2', type: 'dismissed', actor: 'camille', reason: 'Faux positif', review: null, createdAt: NOW },
        ],
        nextCursor: 'next',
      }
    },
  }
  let header = options.header === undefined ? { title: 'Sessions : expiration', author: 'camille', headRef: 'feat/x', baseRef: 'main', state: 'open' as const, headSha: 'd'.repeat(40) } : options.header
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    pulls: {
      store,
      githubUrl: 'https://github.com',
      readHeader:
        header === null
          ? null
          : async () => {
              if (header instanceof Error) throw header
              return header
            },
      readCode:
        options.code === null
          ? null
          : async (_target, input) => {
              if (options.code instanceof Error) throw options.code
              return options.code ?? { kind: 'lines', excerpt: { start: input.line - 1, lines: ['  let token = sign(user)', '  return { token }', '}'] } }
            },
      now: () => NOW.getTime(),
    },
  })
  let request = (path: string, cookie?: string | null) =>
    router.fetch(new Request(new URL(path, 'http://localhost'), { headers: cookie ? { Cookie: cookie } : {} }))
  async function signIn(profile = ALEX) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookieOf(start, COOKIE))
    return cookieOf(callback, COOKIE)!
  }
  return { request, signIn, asked }
}

const PATH = `/repos/${REPO_ID}/pulls/142`

describe('the screen of a pull request', () => {
  it('sends a person who is not signed in to the sign-in, and back', async () => {
    let { request } = setup()
    let response = await request(PATH)
    assert.equal(response.status, 303)
    assert.match(response.headers.get('Location')!, /\/login\?returnTo=%2Frepos%2F/)
  })

  it('shows the header, the numbers and the sheet to a member, for the org of the session', async () => {
    let { request, signIn, asked } = setup()
    let cookie = await signIn(CAMILLE)
    let response = await request(PATH, cookie)
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.deepEqual(asked, [`${ORG.id} ${REPO_ID} 142`])
    assert.match(html, /orchard #142 · Sessions : expiration/)
    assert.match(html, /@camille/)
    assert.match(html, /feat\/x → main/)
    assert.match(html, /Feuille d’exposition/)
    assert.match(html, /cell cell-moved[^>]*>déplacé<span class="cell-line"> l\.47/)
    assert.match(html, /data-label="R2 · bbbbbbb"/)
    assert.match(html, /0,54\s\$/)
    assert.match(html, /https:\/\/github\.com\/sakuga-software\/orchard\/pull\/142/)
  })

  it('answers 404 for a pull request that Kentō does not know, or a number that is not one', async () => {
    let { request, signIn } = setup({ found: false })
    let cookie = await signIn()
    assert.equal((await request(PATH, cookie)).status, 404)
    let other = setup()
    let cookie2 = await other.signIn()
    assert.equal((await other.request(`/repos/${REPO_ID}/pulls/1e3`, cookie2)).status, 404)
    assert.deepEqual(other.asked, [])
  })

  it('still shows the sheet when GitHub does not answer, and says what is missing', async () => {
    let { request, signIn } = setup({ header: new Error('502') })
    let html = await (await request(PATH, await signIn())).text()
    assert.match(html, /GitHub n’a pas répondu/)
    assert.match(html, /Feuille d’exposition/)
  })

  it('drops the cursor of the findings from the links of the status filter', async () => {
    let { request, signIn } = setup()
    let html = await (await request(`${PATH}?avant=old&suite=rows`, await signIn())).text()
    let filter = /<nav aria-label="Filtrer par statut"[^]*?<\/nav>/.exec(html)![0]
    assert.match(filter, /\?statut=open&amp;avant=old"/)
    assert.doesNotMatch(filter, /suite=/)
  })

  it('starts again at the first page for a cursor that it cannot read', async () => {
    let { request, signIn } = setup({ badCursor: true })
    let response = await request(`${PATH}?avant=nope&statut=open`, await signIn())
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), `${PATH}?statut=open`)
  })
})

describe('the detail of a finding', () => {
  const DETAIL = `/findings/${FINDING_ID}`

  it('shows its source, model, scenario, code with its line, history and thread to a member', async () => {
    let { request, signIn, asked } = setup()
    let response = await request(DETAIL, await signIn(CAMILLE))
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.ok(asked.includes(`finding ${ORG.id} ${FINDING_ID}`))
    assert.match(html, /Règle « Pas de jeton sans expiration »/)
    assert.match(html, /88 %/)
    assert.match(html, /claude-haiku-4-5 \(R4, lite\)/)
    assert.match(html, /Un jeton volé reste valide\./)
    assert.match(html, /class="code-line code-line-hit"><span aria-hidden="true" class="code-number">47<\/span><code>  return \{ token \}/)
    assert.match(html, /@camille · « Faux positif »/)
    assert.match(html, /Kentō · R1/)
    assert.match(html, /href="https:\/\/github\.com\/sakuga-software\/orchard\/pull\/142#discussion_r914201"/)
    assert.match(html, /href="\/findings\/33333333-3333-4333-8333-333333333333\?historique=next"/)
    assert.match(html, /href="\/repos\/22222222-2222-4222-8222-222222222222\/pulls\/142"/)
  })

  it('answers 404 for a finding of another org, or an id that is not one', async () => {
    let { request, signIn } = setup()
    let cookie = await signIn()
    assert.equal((await request('/findings/44444444-4444-4444-8444-444444444444', cookie)).status, 404)
    assert.equal((await request('/findings/nope', cookie)).status, 404)
  })

  it('still shows the finding when GitHub does not give its code', async () => {
    let { request, signIn } = setup({ code: new Error('timeout') })
    let html = await (await request(DETAIL, await signIn())).text()
    assert.match(html, /GitHub n’a pas répondu : le code n’a pas pu être lu\./)
    assert.match(html, /Scénario/)
  })

  it('starts the history again for a cursor that it cannot read', async () => {
    let { request, signIn } = setup()
    let response = await request(`${DETAIL}?historique=bad`, await signIn())
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), DETAIL)
  })
})

describe('the words of the screen of a pull request', () => {
  it('says how the score moved since the review before', () => {
    assert.deepEqual(scoreProgress({ lastScores: [4, 2], reviews: 4 }), { value: '4/5', change: '+2 depuis R3' })
    assert.deepEqual(scoreProgress({ lastScores: [2, 4], reviews: 2 }), { value: '2/5', change: '−2 depuis R1' })
    assert.deepEqual(scoreProgress({ lastScores: [3, 3], reviews: 5 }), { value: '3/5', change: 'inchangé depuis R4' })
    assert.deepEqual(scoreProgress({ lastScores: [3], reviews: 1 }), { value: '3/5', change: null })
  })

  it('says why the code of a finding is not there: no App, GitHub down, a file gone, a file too short', () => {
    assert.equal(codeText(undefined), 'Sans l’App GitHub, Kentō ne lit pas le code.')
    assert.match(codeText('failed'), /GitHub n’a pas répondu/)
    assert.match(codeText({ kind: 'missing' }), /n’est plus sur GitHub à ce commit/)
    assert.equal(codeText({ kind: 'empty' }), 'Le fichier est vide à ce commit.')
    assert.match(codeText({ kind: 'unreadable' }), /un dossier, ou un fichier de plus de 1 Mo/)
    assert.equal(codeText({ kind: 'short', length: 1 }), 'Le fichier n’a que 1 ligne à ce commit : la ligne du finding n’y est pas.')
    assert.equal(codeText({ kind: 'short', length: 12 }), 'Le fichier n’a que 12 lignes à ce commit : la ligne du finding n’y est pas.')
  })

  it('reads the known statuses of the filter only', () => {
    let query = readPullQuery(new URLSearchParams('statut=open&statut=nope&statut=open&avant=x'))
    assert.deepEqual(query, { statuses: ['open'], reviews: 'x', rows: null })
  })
})
