import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, OTHER_ORG, SESSION_COOKIE } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import type { RunnersAdminStore, RunnersScreen, RunnerView } from '../runner/admin.ts'
import { hashToken } from '../runner/tokens.ts'
import { byState, dockerCommand, newerVersion, readRegistrationForm, runnerState, runnerStateLabel } from './runners.tsx'

const COOKIE = SESSION_COOKIE
const RUNNER_ID = '11111111-1111-4111-8111-111111111111'
const REGISTRATION_ID = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-29T10:00:00Z')

function runner(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    id: RUNNER_ID,
    name: 'runner-1',
    labels: ['macos'],
    version: '1.2.3',
    trusted: false,
    orgId: ORG.id,
    revokedAt: null,
    lastSeenAt: new Date(NOW.getTime() - 10_000),
    createdAt: NOW,
    currentJob: null,
    jobs24h: 0,
    ...overrides,
  }
}

/** A store in memory that records each write, with the org it was for. */
function fakeStore(screen: Partial<RunnersScreen> = {}) {
  let writes: string[] = []
  let registrations: { orgId: string; name: string; labels: string[]; trusted: boolean; tokenHash: string }[] = []
  let store: RunnersAdminStore = {
    async screen() {
      return { now: NOW, runners: [], registrations: [], ...screen }
    },
    async createRegistration(input) {
      registrations.push(input)
      writes.push(`create ${input.orgId} ${input.name}`)
      return { id: REGISTRATION_ID, expiresAt: new Date(NOW.getTime() + 3600_000) }
    },
    async renewRegistration(input) {
      writes.push(`renew ${input.orgId} ${input.registrationId}`)
      if (input.registrationId !== REGISTRATION_ID) return null
      return { id: 'new', name: 'gpu', labels: ['gpu'], trusted: false, expiresAt: NOW }
    },
    async discardRegistration(orgId, id) {
      writes.push(`discard ${orgId} ${id}`)
      return id === REGISTRATION_ID
    },
    async setTrusted(orgId, id, trusted) {
      writes.push(`trust ${orgId} ${id} ${trusted}`)
      return id === RUNNER_ID
    },
    async revoke(orgId, id) {
      writes.push(`revoke ${orgId} ${id}`)
      return id === RUNNER_ID ? { name: 'runner-1', requeued: [] } : null
    },
    async revokeSilent(orgId, ids) {
      writes.push(`revoke-silent ${orgId} ${ids.join(',')}`)
      return { names: ids.length > 0 ? ['old'] : [], requeued: [] }
    },
  }
  return { store, writes, registrations }
}

function setup(screen: Partial<RunnersScreen> = {}, orgs = [ORG]) {
  let auth = fakeAuth({ orgs })
  auth.setRole(ORG, OCTOCAT, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let fake = fakeStore(screen)
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    runnersAdmin: fake.store,
  })

  function request(path: string, init: { cookie?: string | null; headers?: Record<string, string>; form?: Record<string, string> | URLSearchParams } = {}) {
    let headers = new Headers(init.headers)
    if (init.cookie) headers.set('Cookie', init.cookie)
    return router.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: init.form ? 'POST' : 'GET',
        headers,
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
    )
  }

  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookiesOf(start) })
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request('/runners', { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf }
  }

  return { ...fake, auth, request, signIn }
}

describe('the form "New runner"', () => {
  function form(values: Record<string, string>) {
    let data = new FormData()
    for (let [key, value] of Object.entries(values)) data.set(key, value)
    return data
  }

  it('reads a name, labels and the key mode', () => {
    let read = readRegistrationForm(form({ name: 'runner-1', labels: 'macos, arm64,macos', keyMode: 'runner' }))
    assert.deepEqual(read.input, { name: 'runner-1', labels: ['macos', 'arm64'], trusted: false })
    assert.deepEqual(read.errors, {})
    assert.equal(readRegistrationForm(form({ name: 'a', labels: '', keyMode: 'app' })).input?.trusted, true)
  })

  it('refuses a name or a label that the runner protocol refuses, and a missing key mode', () => {
    let read = readRegistrationForm(form({ name: 'runner 1', labels: 'ok,not good;', keyMode: 'other' }))
    assert.equal(read.input, null)
    assert.ok(read.errors.name)
    assert.ok(read.errors.labels)
    assert.ok(read.errors.keyMode)
    assert.ok(readRegistrationForm(form({ name: 'x', labels: Array.from({ length: 21 }, (_, i) => `l${i}`).join(','), keyMode: 'app' })).errors.labels)
  })
})

describe('the docker run command', () => {
  it('holds every variable of the runner and the image of the release', () => {
    let command = dockerCommand({ kentoUrl: 'https://review.test', token: 'kento_reg_abc', name: 'runner-1', labels: ['macos', 'arm64'], trusted: true, version: '1.2.3' })
    for (let part of [
      '-e KENTO_URL=https://review.test',
      '-e KENTO_REGISTRATION_TOKEN=kento_reg_abc',
      '-e KENTO_RUNNER_NAME=runner-1',
      '-e KENTO_RUNNER_LABELS=macos,arm64',
      '-e PROVIDER_KIND=openrouter',
      '-e PROVIDER_BASE_URL=https://openrouter.ai/api/v1',
      '-v kento-runner-state:/var/lib/kento-runner',
      'ghcr.io/sakuga-software/kento-runner:1.2.3',
    ]) {
      assert.ok(command.includes(part), part)
    }
    assert.ok(!command.includes('PROVIDER_API_KEY'), 'a runner on the key of the app needs no key')
    let own = dockerCommand({ kentoUrl: 'https://review.test', token: 't', name: 'n', labels: [], trusted: false, version: '1.2.3' })
    assert.ok(own.includes('-e PROVIDER_API_KEY=<your OpenRouter key>'))
  })
})

describe('the state of a runner', () => {
  it('is online up to 90 s, late up to 1 h, offline after or never seen, and revoked above all (REV-30)', () => {
    let at = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)
    assert.equal(runnerState({ revokedAt: null, lastSeenAt: at(30) }, NOW), 'online')
    assert.equal(runnerState({ revokedAt: null, lastSeenAt: at(90) }, NOW), 'online')
    assert.equal(runnerState({ revokedAt: null, lastSeenAt: at(91) }, NOW), 'late')
    assert.equal(runnerState({ revokedAt: null, lastSeenAt: at(3600) }, NOW), 'late')
    assert.equal(runnerState({ revokedAt: null, lastSeenAt: at(3601) }, NOW), 'offline')
    assert.equal(runnerState({ revokedAt: null, lastSeenAt: at(3 * 86_400) }, NOW), 'offline')
    assert.equal(runnerState({ revokedAt: null, lastSeenAt: null }, NOW), 'offline')
    assert.equal(runnerState({ revokedAt: NOW, lastSeenAt: at(1) }, NOW), 'revoked')
  })

  it('names the state, and says since when a runner is offline (REV-30)', () => {
    let at = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)
    assert.equal(runnerStateLabel({ revokedAt: null, lastSeenAt: at(20) }, NOW), 'Online')
    assert.equal(runnerStateLabel({ revokedAt: null, lastSeenAt: at(120) }, NOW), 'Late signal')
    assert.equal(runnerStateLabel({ revokedAt: null, lastSeenAt: at(3 * 86_400) }, NOW), 'Offline for 3 d')
    assert.equal(runnerStateLabel({ revokedAt: null, lastSeenAt: at(5 * 3600) }, NOW), 'Offline for 5 h')
    assert.equal(runnerStateLabel({ revokedAt: null, lastSeenAt: null }, NOW), 'Offline')
    assert.equal(runnerStateLabel({ revokedAt: NOW, lastSeenAt: at(1) }, NOW), 'Revoked')
  })

  it('lists an offline runner first, then a late one, then the online ones in their order (REV-30)', () => {
    let at = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)
    let runners = [
      { name: 'a', revokedAt: null, lastSeenAt: at(10) },
      { name: 'b', revokedAt: null, lastSeenAt: at(600) },
      { name: 'c', revokedAt: null, lastSeenAt: at(20) },
      { name: 'd', revokedAt: null, lastSeenAt: at(3 * 86_400) },
    ]
    assert.deepEqual(byState(runners, NOW).map((r) => r.name), ['d', 'b', 'a', 'c'])
  })

  it('says a newer release when its version is older, by number and not by text', () => {
    assert.equal(newerVersion('0.9.0', '0.10.0'), '0.10.0')
    assert.equal(newerVersion('1.2.3', '1.2.3'), null)
    assert.equal(newerVersion('1.3.0', '1.2.9'), null)
    assert.equal(newerVersion(null, '1.2.3'), null)
    assert.equal(newerVersion('dev', '1.2.3'), null)
  })
})

describe('the Runners screen', () => {
  it('shows the runners, their state, version and job, and the forms to an admin', async () => {
    let { request, signIn } = setup({
      runners: [
        runner({ trusted: true, version: '1.0.0', currentJob: { kind: 'review', repo: 'sakuga-software/sakuga-review', prNumber: 57, startedAt: NOW }, jobs24h: 14 }),
        runner({ id: '33333333-3333-4333-8333-333333333333', name: 'shared-01', orgId: null }),
      ],
    })
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/runners', { cookie })).text()
    assert.match(html, /runner-1/)
    assert.match(html, /Online/)
    assert.match(html, /1\.2\.3 available/)
    assert.match(html, /sakuga-software\/sakuga-review#57/)
    assert.match(html, /Keys stored in Kentō \(trusted\)/)
    // REV-43: one name for the key of the service, and no word of the runner protocol.
    assert.doesNotMatch(html, /key of the app/i)
    assert.doesNotMatch(html, /claim|[Hh]eartbeat|\b[Ll]ease\b(?!-title)|[Mm]ax body/)
    assert.match(html, /Wait for a job/)
    assert.match(html, /Largest request/)
    assert.match(html, /only its hash is kept/)
    assert.doesNotMatch(html, / — /)
    assert.match(html, /Remove the trust/)
    assert.match(html, /Revoke runner-1/)
    assert.match(html, /action="\/runners\/new"/)
    // A runner of the service shows, with no form: only an operator manages it.
    assert.match(html, /Runner of the service/)
    assert.doesNotMatch(html, /Revoke shared-01/)
    // REV-30: the facts of the protocol fold under "Technical details".
    assert.match(html, /<details class="runner-details"><summary>Technical details<\/summary>/)
    assert.match(html, /Protocol/)
    assert.match(html, /Reservation and attempts/)
    // REV-30: "Key on the runner" is the choice by default; the key of the app is an explicit choice.
    assert.match(html, /<input type="radio" name="keyMode" value="runner" checked \/>/)
    assert.doesNotMatch(html, /<input type="radio" name="keyMode" value="app" checked/)
    // REV-51: no screen sets the pool of a repository, so the help of the labels does not name it.
    assert.doesNotMatch(html, /pool/i)
  })

  it('shows a runner offline for 2 h above a runner that is online, in a table, with the counts by state (REV-30, REV-37)', async () => {
    let { request, signIn } = setup({
      runners: [
        runner({ name: 'runner-office' }),
        runner({ id: '33333333-3333-4333-8333-333333333334', name: 'runner-cloud', lastSeenAt: new Date(NOW.getTime() - 2 * 3_600_000) }),
        runner({ id: '33333333-3333-4333-8333-333333333335', name: 'ci-ephemeral-7', lastSeenAt: new Date(NOW.getTime() - 3 * 86_400_000) }),
        runner({ id: '33333333-3333-4333-8333-333333333336', name: 'old-laptop', revokedAt: new Date(NOW.getTime() - 86_400_000) }),
      ],
    })
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/runners', { cookie })).text()
    assert.match(html, /<h2 id="runners-title" class="section-title">Runners<\/h2><p class="runner-counts">1 online · 2 offline<\/p>/)
    let main = html.slice(html.indexOf('id="runners-title"'), html.indexOf('class="runner-silent"'))
    assert.match(main, /<table class="table runners-table">/)
    assert.match(main, /<span class="status status-offline">Offline for 2 h<\/span>/)
    assert.ok(main.indexOf('runner-cloud') < main.indexOf('runner-office'), 'the offline runner comes first')
    assert.doesNotMatch(main, /ci-ephemeral-7/)
    // REV-37: a runner silent for a day is in a folded block, with one action for all of them.
    let silent = html.slice(html.indexOf('class="runner-silent"'), html.indexOf('id="revoked-title"'))
    assert.match(silent, /^class="runner-silent"><summary>1 runner silent for more than 24 h<\/summary>/)
    assert.match(silent, /Offline for 3 d/)
    assert.match(silent, /<form id="revoke-silent" method="post" action="\/runners\/revoke-silent" hidden><input type="hidden" name="_csrf" value="[0-9a-f]+" \/><input type="hidden" name="id" value="33333333-3333-4333-8333-333333333335" \/><\/form>/)
    assert.match(silent, /<summary class="button button-danger">Revoke this runner…<\/summary>/)
    assert.match(silent, /<button type="submit" form="revoke-silent" formaction="\/runners\/revoke-silent" class="button button-danger-solid">Revoke ci-ephemeral-7<\/button>/)
    assert.match(html, /Revoked <span class="count">1<\/span>/)
  })

  it('counts the silent runners in the action, and leaves a runner of the service out of it (REV-37)', async () => {
    let days = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
    let { request, signIn } = setup({
      runners: [
        runner({ id: '44444444-4444-4444-8444-444444444441', name: 'ci-1', lastSeenAt: days(2) }),
        runner({ id: '44444444-4444-4444-8444-444444444442', name: 'ci-2', lastSeenAt: null, createdAt: days(5) }),
        runner({ id: '44444444-4444-4444-8444-444444444443', name: 'shared-02', orgId: null, lastSeenAt: days(4) }),
        runner({ id: '44444444-4444-4444-8444-444444444444', name: 'fresh', lastSeenAt: null, createdAt: NOW }),
      ],
    })
    let admin = await (await request('/runners', { cookie: (await signIn(OCTOCAT)).cookie })).text()
    assert.match(admin, /<summary>3 runners silent for more than 24 h<\/summary>/)
    assert.match(admin, /Revoke these 2 runners…/)
    assert.match(admin, />Revoke 2 runners<\/button>/)
    assert.doesNotMatch(admin, /name="id" value="44444444-4444-4444-8444-444444444443"/)
    assert.doesNotMatch(admin, /name="id" value="44444444-4444-4444-8444-444444444444"/)
    let member = await (await request('/runners', { cookie: (await signIn(CAMILLE)).cookie })).text()
    assert.match(member, /3 runners silent for more than 24 h/)
    assert.doesNotMatch(member, /revoke-silent/)
  })

  it('shows a member the same list, and no form', async () => {
    let { request, signIn } = setup({ runners: [runner()] })
    let { cookie } = await signIn(CAMILLE)
    let html = await (await request('/runners', { cookie })).text()
    assert.match(html, /runner-1/)
    assert.match(html, /Read only/)
    assert.doesNotMatch(html, /method="post" action="\/runners/)
    assert.doesNotMatch(html, /New runner<\/a>/)
  })

  it('shows an expired token with the help and "New token"', async () => {
    let { request, signIn } = setup({
      registrations: [{ id: REGISTRATION_ID, name: 'gpu', labels: ['gpu'], trusted: false, expiresAt: new Date(NOW.getTime() - 1000), createdAt: NOW }],
    })
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/runners', { cookie })).text()
    assert.match(html, /Token expired/)
    assert.match(html, /reaches review\.test with outbound HTTPS/)
    assert.match(html, new RegExp(`action="/runners/registrations/${REGISTRATION_ID}/renew"`))
  })
})

describe('the writes of the Runners screen', () => {
  it('makes a registration token, shows it once and stores only its hash', async () => {
    let { request, signIn, registrations, auth } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let response = await request('/runners/new', { cookie, form: { _csrf: csrf, name: 'runner-1', labels: 'macos,arm64', keyMode: 'app' } })
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    let html = await response.text()
    let token = /KENTO_REGISTRATION_TOKEN=(kento_reg_[A-Za-z0-9_-]{43})/.exec(html)?.[1]
    assert.ok(token, 'the page shows the token in the command')
    assert.match(html, /The screen does not show it again/)
    assert.equal(registrations.length, 1)
    assert.deepEqual(registrations[0], { orgId: ORG.id, userId: auth.userIdOf(OCTOCAT), name: 'runner-1', labels: ['macos', 'arm64'], trusted: true, tokenHash: hashToken(token) })
    // The next page does not show it again.
    assert.doesNotMatch(await (await request('/runners', { cookie })).text(), new RegExp(token))
  })

  it('gives the form back with its errors, and makes nothing', async () => {
    let { request, signIn, writes } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let response = await request('/runners/new', { cookie, form: { _csrf: csrf, name: 'runner 1', labels: '', keyMode: 'app' } })
    assert.equal(response.status, 422)
    let html = await response.text()
    assert.match(html, /aria-invalid="true"/)
    assert.match(html, /value="runner 1"/)
    assert.deepEqual(writes, [])
  })

  it('trusts, revokes, renews and discards for the org on screen only', async () => {
    let { request, signIn, writes } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)

    let trust = await request(`/runners/${RUNNER_ID}/trust`, { cookie, form: { _csrf: csrf, trusted: 'true' } })
    assert.equal(trust.headers.get('Location'), '/runners?notice=trusted')
    let revoke = await request(`/runners/${RUNNER_ID}/revoke`, { cookie, form: { _csrf: csrf } })
    assert.equal(revoke.headers.get('Location'), '/runners?notice=revoked')
    let renew = await request(`/runners/registrations/${REGISTRATION_ID}/renew`, { cookie, form: { _csrf: csrf } })
    assert.equal(renew.status, 201)
    assert.match(await renew.text(), /KENTO_REGISTRATION_TOKEN=kento_reg_/)
    let discard = await request(`/runners/registrations/${REGISTRATION_ID}/discard`, { cookie, form: { _csrf: csrf } })
    assert.equal(discard.headers.get('Location'), '/runners?notice=discarded')
    assert.deepEqual(writes, [
      `trust ${ORG.id} ${RUNNER_ID} true`,
      `revoke ${ORG.id} ${RUNNER_ID}`,
      `renew ${ORG.id} ${REGISTRATION_ID}`,
      `discard ${ORG.id} ${REGISTRATION_ID}`,
    ])

    // An unknown id, or one that is not a UUID: nothing to do, and the screen says so.
    let missing = await request('/runners/not-a-uuid/revoke', { cookie, form: { _csrf: csrf } })
    assert.equal(missing.headers.get('Location'), '/runners?notice=missing')
    assert.equal(writes.length, 4)
  })

  it('revokes the silent runners that the screen showed, for the org on screen (REV-37)', async () => {
    let { request, signIn, writes } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    assert.equal((await request('/runners/revoke-silent', { cookie, form: { id: RUNNER_ID } })).status, 403, 'no CSRF token')
    let posted = await request('/runners/revoke-silent', {
      cookie,
      form: new URLSearchParams([['_csrf', csrf], ['id', RUNNER_ID], ['id', 'not-a-uuid'], ['id', REGISTRATION_ID]]),
    })
    assert.equal(posted.headers.get('Location'), '/runners?notice=revoked_silent')
    assert.deepEqual(writes, [`revoke-silent ${ORG.id} ${RUNNER_ID},${REGISTRATION_ID}`])
    let html = await (await request('/runners?notice=revoked_silent', { cookie })).text()
    assert.match(html, /Silent runners revoked\./)

    let member = await signIn(CAMILLE)
    assert.equal((await request('/runners/revoke-silent', { cookie: member.cookie, form: { _csrf: member.csrf, id: RUNNER_ID } })).status, 403)
    assert.equal(writes.length, 1)
  })

  it('refuses every write to a member', async () => {
    let { request, signIn, writes } = setup()
    let { cookie, csrf } = await signIn(CAMILLE)
    for (let path of ['/runners/new', `/runners/${RUNNER_ID}/trust`, `/runners/${RUNNER_ID}/revoke`, `/runners/registrations/${REGISTRATION_ID}/renew`, `/runners/registrations/${REGISTRATION_ID}/discard`]) {
      let response = await request(path, { cookie, form: { _csrf: csrf, name: 'x', keyMode: 'app', trusted: 'true' } })
      assert.equal(response.status, 403, path)
    }
    assert.deepEqual(writes, [])
  })

  it('refuses a write without the CSRF token, or from another site', async () => {
    let { request, signIn, writes } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let forged = await request(`/runners/${RUNNER_ID}/revoke`, { cookie, form: { _csrf: 'f'.repeat(64) } })
    assert.equal(forged.status, 403)
    let none = await request(`/runners/${RUNNER_ID}/revoke`, { cookie, form: {} })
    assert.equal(none.status, 403)
    for (let headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }] as Record<string, string>[]) {
      let response = await request(`/runners/${RUNNER_ID}/revoke`, { cookie, headers, form: { _csrf: csrf } })
      assert.equal(response.status, 403)
    }
    assert.deepEqual(writes, [])
  })

  it('refuses a write to a person who is not signed in', async () => {
    let { request, writes } = setup()
    let response = await request(`/runners/${RUNNER_ID}/revoke`, { form: { _csrf: 'x' } })
    assert.ok(response.status === 401 || response.status === 403)
    assert.deepEqual(writes, [])
  })

  it('writes for the org on screen: an admin of another org changes nothing here', async () => {
    let { request, signIn, writes, auth } = setup({}, [ORG, OTHER_ORG])
    auth.setRole(OTHER_ORG, OCTOCAT, 'admin')
    auth.setRole(ORG, OCTOCAT, 'member')
    let { cookie, csrf } = await signIn(OCTOCAT)
    // The sign-in puts the session on the org where Octocat is admin.
    await request(`/runners/${RUNNER_ID}/revoke`, { cookie, form: { _csrf: csrf } })
    assert.deepEqual(writes, [`revoke ${OTHER_ORG.id} ${RUNNER_ID}`])
  })
})
