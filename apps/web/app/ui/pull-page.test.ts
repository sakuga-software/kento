import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG } from '../auth/test-helpers.ts'
import { InvalidCursorError } from '../findings/store.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { CodeRead, FindingDetail } from '../pulls/finding.ts'
import type { PullRequestNow } from '../dashboard/github.ts'
import type { PullHeader } from '../pulls/github.ts'
import { jobDuration, type PullSheet, type PullsStore, type PullSummary } from '../pulls/store.ts'
import { createAppRouter } from '../router.ts'
import { DISMISS_REASONS, replyText } from '../findings/dismiss.ts'
import { codeText } from './finding.tsx'
import { firstSentence, levelLine, modelName, readPullQuery, scoreProgress } from './pull.tsx'

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
    assignment: null,
    levelOrigin: null,
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
    verdict: n === 2 ? 'REQUEST_CHANGES' : 'COMMENT',
    summary: n === 2 ? 'Deux findings restent ouverts, dont un P1 sur l’expiration des jetons. Le reste est corrigé.\n\nDétail plus bas.' : null,
    durationMs: 160_000,
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

function detail(status: FindingDetail['status'] = 'dismissed'): FindingDetail {
  return {
    id: FINDING_ID,
    target: summary().target,
    title: 'Le jeton de session n’expire jamais',
    path: 'src/auth/session.ts',
    line: 47,
    severity: 'major',
    category: 'bug',
    confidence: 88,
    status,
    statusReason: status === 'dismissed' ? 'Faux positif' : null,
    rule: { id: 'rule-1', title: 'Pas de jeton sans expiration' },
    fingerprint: 'a1',
    firstSeenSha: 'a'.repeat(40),
    lastSeenSha: 'd'.repeat(40),
    githubCommentId: 914201,
    review: { id: 'r4', number: 4, level: 'lite', model: 'claude-haiku-4-5', headSha: 'd'.repeat(40), scenario: 'Un jeton volé reste valide.', fix: 'Ajouter exp.', suggestion: '' },
  }
}

function setup(options: { assignment?: PullSummary['assignment']; levelOrigin?: PullSummary['levelOrigin']; header?: PullHeader | Error | null; found?: boolean; badCursor?: boolean; code?: CodeRead | Error | null; unchanged?: boolean; reply?: Error | null; status?: FindingDetail['status']; github?: PullRequestNow | Error } = {}) {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let asked: string[] = []
  let decisions: string[] = []
  let reruns: string[] = []
  let replies: string[] = []
  let store: PullsStore = {
    async summary(orgId, repoId, prNumber) {
      asked.push(`${orgId} ${repoId} ${prNumber}`)
      return options.found === false ? null : summary({ assignment: options.assignment ?? null, levelOrigin: options.levelOrigin ?? null })
    },
    async sheet(_target, page) {
      if (options.badCursor && page.reviewsCursor) throw new InvalidCursorError()
      return sheet()
    },
    async finding(orgId, id) {
      asked.push(`finding ${orgId} ${id}`)
      return id === FINDING_ID ? detail(options.status) : null
    },
    async setStatus(input) {
      decisions.push(`${input.orgId} ${input.findingId} ${input.status} ${input.reason} ${input.actor}`)
      if (input.findingId !== FINDING_ID) return { outcome: 'not_found' }
      if (options.unchanged) return { outcome: 'unchanged', finding: {} as never }
      return { outcome: 'changed', finding: {} as never }
    },
    async estimates() {
      return { lite: 0.004, balanced: 0.12, heavy: null }
    },
    async rerun(input) {
      reruns.push(`${input.orgId} ${input.repoId} ${input.prNumber} ${input.level} ${input.githubHead}`)
      return { kind: 'queued', jobId: 'job-9' }
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
      postReply:
        options.reply === null
          ? null
          : async (target, body) => {
              if (options.reply instanceof Error) throw options.reply
              replies.push(`${target.fullName}#${target.prNumber} ${target.commentId} ${body}`)
            },
      readPullRequest: async () => {
        if (options.github instanceof Error) throw options.github
        return options.github ?? { open: true, headSha: 'd'.repeat(40) }
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
  let post = (path: string, cookie: string, form: Record<string, string>) =>
    router.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://review.test' },
        body: new URLSearchParams(form),
      }),
    )
  return { request, signIn, asked, post, decisions, replies, reruns }
}

const PATH = `/repos/${REPO_ID}/pulls/142`

describe('the screen of a pull request', () => {
  it('sends a person who is not signed in to the sign-in, and back', async () => {
    let { request } = setup()
    let response = await request(PATH)
    assert.equal(response.status, 303)
    assert.match(response.headers.get('Location')!, /\/login\?returnTo=%2Frepos%2F/)
  })

  it('gives the time of a job only when it is a time: none, negative or not finite reads null (REV-91)', () => {
    assert.equal(jobDuration(160_000.4), 160_000)
    assert.equal(jobDuration(0), 0)
    assert.equal(jobDuration(null), null)
    assert.equal(jobDuration(undefined), null)
    assert.equal(jobDuration(-5_000), null)
    assert.equal(jobDuration(Number.NaN), null)
    assert.equal(jobDuration(Number.POSITIVE_INFINITY), null)
  })

  it('says a summary in its first sentence, and a model without its provider (REV-91)', () => {
    assert.equal(firstSentence('Deux findings restent ouverts. Le reste est corrigé.'), 'Deux findings restent ouverts.')
    assert.equal(firstSentence('Sans point final\n\nUn autre paragraphe.'), 'Sans point final')
    assert.equal(firstSentence('  \n '), null)
    assert.equal(firstSentence(null), null)
    assert.equal(firstSentence('v1.2 garde son point. Fin.'), 'v1.2 garde son point.')
    assert.equal(firstSentence('x'.repeat(300))?.length, 240)
    assert.equal(modelName('anthropic/claude-sonnet-5.5'), 'claude-sonnet-5.5')
    assert.equal(modelName('claude-haiku-4-5'), 'claude-haiku-4-5')
  })

  it('shows the header, the numbers and the sheet to a member, for the org of the session', async () => {
    let { request, signIn, asked } = setup()
    let cookie = await signIn(CAMILLE)
    let response = await request(PATH, cookie)
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.deepEqual(asked, [`${ORG.id} ${REPO_ID} 142`])
    // REV-91: the title of the pull request is the title of the page; « orchard #142 » leads its facts.
    assert.match(html, /<h1 class="page-title">Sessions : expiration/)
    assert.match(html, /<span class="mono">orchard #142<\/span>/)
    assert.match(html, /@camille/)
    assert.match(html, /feat\/x → main/)
    assert.match(html, /Feuille d’exposition/)
    assert.match(html, /title="déplacé, ligne 47" class="cell cell-moved"><span class="visually-hidden">déplacé l\.47/)
    // The last review: its verdict on a stamp, its facts, the first sentence of its summary.
    assert.match(html, /Dernière review, R2/)
    assert.match(html, /<span class="stamp-text">Changements demandés<\/span><span class="stamp-score">3\/5<\/span>/)
    assert.match(html, /lite · m · bbbbbbb · 0,010\s\$ · 2 min 40 s · /)
    assert.match(html, /<p class="pull-last-summary">Deux findings restent ouverts, dont un P1 sur l’expiration des jetons\.<\/p>/)
    assert.match(html, /Une seule passe par review/)
    assert.match(html, /data-label="R2 · bbbbbbb"/)
    assert.match(html, /0,54\s\$/)
    assert.match(html, /https:\/\/github\.com\/sakuga-software\/orchard\/pull\/142/)
  })

  it('says which assignment rule set the level of the last push (REV-21), and nothing without one', async () => {
    let assignment = { ruleId: 'r1', position: 1, level: 'balanced' as const, mention: null, reasons: { author: 'sakuga-agent[bot]' }, trigger: 'push' as const }
    let { request, signIn } = setup({ assignment, levelOrigin: { source: 'rule', level: 'balanced' } })
    let html = await (await request(PATH, await signIn(CAMILLE))).text()
    assert.match(html, /<p class="pull-assignment">Assignation : règle 1, l’auteur est sakuga-agent\[bot\], donc balanced à chaque push\.<\/p>/)
    let none = setup()
    assert.doesNotMatch(await (await none.request(PATH, await none.signIn(CAMILLE))).text(), /pull-assignment/)
  })

  it('says what else chose the level of the last job: a command, a retry, a preference, the repository (REV-21)', () => {
    let line = (source: 'command' | 'retry' | 'preference' | 'repo' | 'rule', level: 'lite' | 'heavy' = 'heavy') =>
      levelLine({ assignment: null, levelOrigin: { source, level } })
    assert.equal(line('command'), 'Niveau heavy : demandé par une commande, les règles d’assignation ne s’appliquent pas.')
    assert.equal(line('retry'), 'Niveau heavy : choisi à la relance depuis le tableau de bord.')
    assert.equal(line('preference', 'lite'), 'Niveau lite : préférence de l’auteur, aucune règle d’assignation ne correspond.')
    assert.equal(line('repo', 'lite'), 'Niveau lite : celui du repo, aucune règle d’assignation ne correspond.')
    // A job of a rule with no copy of it in its config: the line still says that a rule chose the level.
    assert.equal(line('rule'), 'Assignation : une règle d’assignation a choisi heavy.')
    assert.equal(levelLine({ assignment: null, levelOrigin: null }), null)
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
    // REV-91: with no title from GitHub, the title is « orchard #142 », and an admin keeps « Relancer R5… ».
    assert.match(html, /<h1 class="page-title">orchard #142<\/h1>/)
    assert.match(html, /<summary class="button">Relancer R\d+…<\/summary>/)
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

describe('the decisions on a finding', () => {
  const DETAIL = `/findings/${FINDING_ID}`

  async function member(options: Parameters<typeof setup>[0] = {}) {
    let t = setup(options)
    let cookie = await t.signIn(CAMILLE)
    let html = await (await t.request(DETAIL, cookie)).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)![1]!
    return { ...t, cookie, csrf, html }
  }

  it('offers a member « Marquer dismissed… » with the reasons of REV-18, and « Marquer wontfix… »', async () => {
    let { html } = await member({ status: 'open' })
    assert.doesNotMatch(html, />Rouvrir</)
    assert.match(html, /Marquer dismissed…/)
    assert.match(html, /Marquer wontfix…/)
    // The reasons of the dialog of REV-18, shared with the Findings screen, and « Autre ».
    for (let reason of DISMISS_REASONS) assert.match(html, new RegExp(`value="${reason}"`))
    assert.match(html, /value="other"/)
    assert.match(html, new RegExp(`name="ids" value="${FINDING_ID}"`))
    assert.match(html, /vous dismissez, gardez \(wontfix\) ou rouvrez un finding/)
  })

  it('a member dismisses with a reason: the status changes, then the bot replies in the thread', async () => {
    let { post, cookie, csrf, decisions, replies } = await member()
    let response = await post(`${DETAIL}/dismiss`, cookie, { _csrf: csrf, ids: FINDING_ID, status: 'dismissed', reason: 'Faux positif' })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), `${DETAIL}?fait=dismissed&github=posted`)
    assert.deepEqual(decisions, [`${ORG.id} ${FINDING_ID} dismissed Faux positif camille`])
    assert.deepEqual(replies, [`sakuga-software/orchard#142 914201 ${replyText('dismissed', 'Faux positif', 'camille')}`])
  })

  it('takes « Autre » with a reason of the person', async () => {
    let { post, cookie, csrf, decisions } = await member({ status: 'open' })
    let response = await post(`${DETAIL}/dismiss`, cookie, { _csrf: csrf, ids: FINDING_ID, status: 'dismissed', reason: 'other', other: 'Code généré' })
    assert.equal(response.headers.get('Location'), `${DETAIL}?fait=dismissed&github=posted`)
    assert.deepEqual(decisions, [`${ORG.id} ${FINDING_ID} dismissed Code généré camille`])
  })

  it('refuses an unknown reason, the id of another finding, and a form without its token', async () => {
    let { post, cookie, csrf, decisions } = await member()
    assert.equal((await post(`${DETAIL}/dismiss`, cookie, { _csrf: csrf, ids: FINDING_ID, status: 'dismissed', reason: 'Parce que' })).status, 400)
    assert.equal((await post(`${DETAIL}/dismiss`, cookie, { _csrf: csrf, ids: '44444444-4444-4444-8444-444444444444', status: 'dismissed', reason: 'Faux positif' })).status, 400)
    assert.equal((await post(`${DETAIL}/dismiss`, cookie, { ids: FINDING_ID, status: 'dismissed', reason: 'Faux positif' })).status, 403)
    assert.deepEqual(decisions, [])
  })

  it('posts nothing on GitHub when the status does not change', async () => {
    let { post, cookie, csrf, replies } = await member({ unchanged: true })
    let response = await post(`${DETAIL}/wontfix`, cookie, { _csrf: csrf })
    assert.equal(response.headers.get('Location'), `${DETAIL}?fait=unchanged`)
    assert.deepEqual(replies, [])
  })

  it('keeps the new status when GitHub refuses the reply, and says so', async () => {
    let { post, cookie, csrf, decisions, request } = await member({ reply: new Error('502') })
    let response = await post(`${DETAIL}/reopen`, cookie, { _csrf: csrf })
    assert.equal(response.headers.get('Location'), `${DETAIL}?fait=open&github=failed`)
    assert.deepEqual(decisions, [`${ORG.id} ${FINDING_ID} open null camille`])
    let html = await (await request(response.headers.get('Location')!, cookie)).text()
    assert.match(html, /La réponse n’a pas pu être postée sur GitHub/)
  })

  it('posts each button of a confirmation to its own action, through the one form of the page', async () => {
    let { html } = await member({ status: 'open' })
    let form = `finding-${FINDING_ID}`
    let buttons = [...html.matchAll(/<button[^>]*type="submit"[^>]*>(Marquer dismissed|Marquer wontfix)<\/button>/g)].map((m) => m[0])
    assert.equal(buttons.length, 2)
    assert.match(buttons[0]!, new RegExp(`form="${form}"`))
    assert.match(buttons[0]!, new RegExp(`formaction="/findings/${FINDING_ID}/dismiss"`))
    assert.match(buttons[1]!, new RegExp(`form="${form}"`))
    assert.match(buttons[1]!, new RegExp(`formaction="/findings/${FINDING_ID}/wontfix"`))
  })

  it('offers « Rouvrir » only for a finding dismissed or kept', async () => {
    let { html } = await member({ status: 'dismissed' })
    assert.match(html, />Rouvrir</)
    assert.doesNotMatch(html, /Marquer dismissed…/)
  })

  it('does not set aside a finding that a push fixed, as the Findings screen does not', async () => {
    let { post, cookie, csrf, decisions, replies } = await member({ status: 'fixed' })
    let response = await post(`${DETAIL}/wontfix`, cookie, { _csrf: csrf, ids: FINDING_ID })
    assert.equal(response.headers.get('Location'), `${DETAIL}?fait=fixed`)
    assert.deepEqual(decisions, [])
    assert.deepEqual(replies, [])
  })

  it('answers 404 for a finding of another org', async () => {
    let { post, cookie, csrf } = await member()
    assert.equal((await post('/findings/44444444-4444-4444-8444-444444444444/wontfix', cookie, { _csrf: csrf })).status, 404)
  })
})

describe('« Relancer en <niveau> »', () => {
  async function as(profile: typeof ALEX, options: Parameters<typeof setup>[0] = {}) {
    let t = setup(options)
    let cookie = await t.signIn(profile)
    let html = await (await t.request(PATH, cookie)).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)![1]!
    return { ...t, cookie, csrf, html }
  }

  it('offers an admin the three levels with their estimate, and a member none', async () => {
    let admin = await as(ALEX)
    assert.match(admin.html, /Relancer R5/)
    assert.match(admin.html, /Relancer en lite<span class="dash-estimate"> · ≈ 0,004\s\$/)
    assert.match(admin.html, /Relancer en heavy<span class="dash-estimate"> · coût inconnu/)
    let member = await as(CAMILLE)
    assert.doesNotMatch(member.html, /Relancer en/)
  })

  it('queues a review of the head that GitHub gives, for an admin', async () => {
    let { post, cookie, csrf, reruns, request } = await as(ALEX)
    let response = await post(`${PATH}/rerun`, cookie, { _csrf: csrf, level: 'heavy' })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), `${PATH}?relance=queued`)
    assert.deepEqual(reruns, [`${ORG.id} ${REPO_ID} 142 heavy ${'d'.repeat(40)}`])
    let html = await (await request(response.headers.get('Location')!, cookie)).text()
    assert.match(html, /Review relancée : elle est en file\. Un nouveau push l’annule\./)
  })

  it('refuses a member, an unknown level, a closed pull request, and GitHub down', async () => {
    let member = await as(CAMILLE)
    assert.equal((await member.post(`${PATH}/rerun`, member.cookie, { _csrf: member.csrf, level: 'lite' })).status, 403)
    let admin = await as(ALEX)
    assert.equal((await admin.post(`${PATH}/rerun`, admin.cookie, { _csrf: admin.csrf, level: 'ultra' })).status, 400)
    let closed = await as(ALEX, { github: { open: false, headSha: 'd'.repeat(40) } })
    assert.equal((await closed.post(`${PATH}/rerun`, closed.cookie, { _csrf: closed.csrf, level: 'lite' })).headers.get('Location'), `${PATH}?relance=closed`)
    let down = await as(ALEX, { github: new Error('502') })
    assert.equal((await down.post(`${PATH}/rerun`, down.cookie, { _csrf: down.csrf, level: 'lite' })).headers.get('Location'), `${PATH}?relance=github_failed`)
    assert.deepEqual([...member.reruns, ...admin.reruns, ...closed.reruns, ...down.reruns], [])
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
