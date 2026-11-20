import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import postgres from 'postgres'

import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The end-to-end test of REV-10: an admin makes a registration token, a runner registers with it
// and shows up online, the admin trusts it and revokes it; an expired token shows its help; a
// member reads and changes nothing.

function sql() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** What the runner does at its first start: POST /api/runner/register with the token, then a claim. */
async function startRunner(request: APIRequestContext, token: string) {
  let registered = await request.post('/api/runner/register', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'what-the-runner-says', labels: [], version: '0.0.1' },
  })
  expect(registered.status()).toBe(201)
  let { token: runnerToken } = await registered.json()
  // A first authenticated call marks the runner as seen. A claim would wait 30 s for a job that the
  // e2e server never has; a heartbeat on no job answers at once, after the same authentication.
  let call = await request.post('/api/runner/jobs/00000000-0000-4000-8000-000000000000/heartbeat', {
    headers: { Authorization: `Bearer ${runnerToken}` },
    data: { attempt: 1 },
  })
  expect(call.status()).toBe(404)
  return runnerToken as string
}

async function createToken(page: Page, name: string, labels: string, keyMode: 'app' | 'runner') {
  await page.goto('/runners')
  await page.getByRole('link', { name: 'New runner' }).click()
  let form = page.locator('#new-runner')
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Labels').fill(labels)
  await form.getByRole('radio', { name: keyMode === 'app' ? /Keys stored in Kentō/ : /Key on the runner/ }).check()
  await form.getByRole('button', { name: 'Create the token' }).click()
  await expect(page.getByRole('heading', { name: `Token of ${name}` })).toBeVisible()
  let command = await page.getByLabel('docker run command').inputValue()
  let token = /KENTO_REGISTRATION_TOKEN=(kento_reg_\S+)/.exec(command)?.[1]
  expect(token).toBeTruthy()
  return { command, token: token! }
}

test('an admin registers a runner, sees it online, trusts it and revokes it', async ({ page, request }, testInfo) => {
  let errors = watchConsole(page)
  let name = `runner-1-${testInfo.project.name}`
  await signIn(page, 'octocat')

  let { command, token } = await createToken(page, name, 'macos, arm64', 'runner')
  expect(command).toContain(`-e KENTO_RUNNER_NAME=${name}`)
  expect(command).toContain('-e KENTO_RUNNER_LABELS=macos,arm64')
  expect(command).toContain('-e PROVIDER_API_KEY=<your OpenRouter key>')
  expect(command).toMatch(/ghcr\.io\/sakuga-software\/kento-runner:\d+\.\d+\.\d+$/)
  await expect(page.getByText('The screen does not show it again')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy the command' })).toBeVisible()
  await expectNoAxeViolations(page)

  // The database has the hash, never the token.
  let db = sql()
  try {
    let rows = await db`select token_hash from runner_registrations where name = ${name}`
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(token)
  } finally {
    await db.end()
  }

  // The token is pending until the runner starts; the page does not show it again.
  await page.goto('/runners')
  let pending = page.locator('.runner', { hasText: name })
  await expect(pending.getByText('Waiting for the runner')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(token)

  let runnerToken = await startRunner(request, token)
  await page.reload()
  // REV-37: a row of the table of the runners (a card under 760 px).
  let card = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${name}`) }) })
  await expect(card.getByText('Online', { exact: true })).toBeVisible()
  await expect(card.getByText('Key on the runner', { exact: true })).toBeVisible()
  await expect(card.getByText(/available$/)).toBeVisible()
  await expect(card.getByRole('listitem').filter({ hasText: 'arm64' })).toBeVisible()
  // The name and the labels come from the token, not from the runner.
  await expect(page.getByText('what-the-runner-says')).toHaveCount(0)
  // The token works once.
  expect((await request.post('/api/runner/register', { headers: { Authorization: `Bearer ${token}` }, data: { name: 'x', labels: [], version: '0.0.1' } })).status()).toBe(401)

  await card.getByRole('button', { name: 'Mark as trusted' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'now gets the keys that Kentō stores' })).toBeVisible()
  await expect(card.getByText('Keys stored in Kentō (trusted)')).toBeVisible()

  // KNT-163: the confirmation is a popover of @remix-run/ui once it hydrated, out of the row.
  let revoke = card.getByRole('button', { name: 'Revoke…' })
  let dialog = page.getByRole('dialog', { name: 'Revoke…' })
  await revoke.click()
  await expect(dialog.getByText('stops working at its next call')).toBeVisible()
  // REV-33: Escape closes the confirmation and gives the focus back to "Revoke…".
  await dialog.getByRole('button', { name: `Revoke ${name}` }).focus()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(revoke).toBeFocused()
  await revoke.click()
  await expectNoAxeViolations(page)
  await dialog.getByRole('button', { name: `Revoke ${name}` }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Runner revoked.' })).toBeVisible()
  let revoked = page.locator('section', { has: page.getByRole('heading', { name: /Revoked/ }) })
  await expect(revoked.getByRole('rowheader', { name: new RegExp(`^${name}`) })).toBeVisible()

  // The runner gets 401 at its next call.
  let claim = await request.post('/api/runner/jobs/claim', { headers: { Authorization: `Bearer ${runnerToken}` }, data: { hasProviderKey: true } })
  expect(claim.status()).toBe(401)
  let heartbeat = await request.post('/api/runner/jobs/00000000-0000-4000-8000-000000000000/heartbeat', {
    headers: { Authorization: `Bearer ${runnerToken}` },
    data: { attempt: 1 },
  })
  expect(heartbeat.status()).toBe(401)
  expect(errors).toEqual([])
})

test('a token that expires without a runner shows the help and "New token"', async ({ page }, testInfo) => {
  let name = `gpu-${testInfo.project.name}`
  await signIn(page, 'octocat')
  await createToken(page, name, 'gpu', 'app')
  let db = sql()
  try {
    await db`update runner_registrations set expires_at = now() - interval '1 minute' where name = ${name} and used_at is null`
  } finally {
    await db.end()
  }
  await page.goto('/runners')
  let card = page.locator('.runner', { hasText: name })
  await expect(card.getByText('Token expired', { exact: true })).toBeVisible()
  await expect(card).toContainText('Check that the container reaches 127.0.0.1')
  await expect(card).toContainText('with outbound HTTPS')
  await card.getByRole('button', { name: 'New token' }).click()
  await expect(page.getByRole('heading', { name: `Token of ${name}` })).toBeVisible()
  await expect(page.getByLabel('docker run command')).toHaveValue(/KENTO_RUNNER_LABELS=gpu/)
})

test('"Cancel the token" asks first: "Cancel" keeps the token, the confirmation deletes it', async ({ page }, testInfo) => {
  let name = `spare-${testInfo.project.name}`
  await signIn(page, 'octocat')
  await createToken(page, name, 'spare', 'runner')
  await page.goto('/runners')
  let card = page.locator('.runner', { hasText: name })
  let trigger = card.getByRole('button', { name: 'Cancel the token…' })
  let dialog = page.getByRole('dialog', { name: 'Cancel the token…' })
  let act = dialog.getByRole('button', { name: `Cancel the token of ${name}` })
  await trigger.click()
  await expect(dialog).toContainText('stops working at once')
  await expectNoAxeViolations(page)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(act).toBeHidden()
  await expect(trigger).toBeFocused()
  await page.reload()
  await expect(page.locator('.runner', { hasText: name })).toBeVisible()

  await trigger.click()
  await act.click()
  await expect(page.getByRole('status').filter({ hasText: 'Registration token cancelled.' })).toBeVisible()
  await expect(page.locator('.runner', { hasText: name })).toHaveCount(0)
})

test('the form says what is wrong, and makes no token', async ({ page }) => {
  await signIn(page, 'octocat')
  await page.goto('/runners')
  let form = page.locator('#new-runner')
  await form.getByLabel('Name').fill('runner 1')
  await form.getByRole('button', { name: 'Create the token' }).click()
  await expect(form.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true')
  await expect(form.getByText('Letters, digits, dots, hyphens or underscores')).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Token of/ })).toHaveCount(0)
  await expectNoAxeViolations(page)
})

for (let theme of ['paper', 'sumi'] as const) {
  test(`the Runners screen passes axe in the theme ${theme} for an admin, and fits the screen`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
    await signIn(page, 'octocat')
    await page.goto('/runners')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    // REV-30: the facts of the protocol are folded under "Technical details".
    await expect(page.getByRole('heading', { name: 'Protocol' })).toBeHidden()
    await page.getByText('Technical details').click()
    await expect(page.getByRole('heading', { name: 'Protocol' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Reservation and attempts' })).toBeVisible()
    await expectNoAxeViolations(page)
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
}

test('a runner offline for 2 h is "Offline", in red, at the top; a new token keeps the key on the runner by default (REV-30)', async ({ page }, testInfo) => {
  let name = `runner-cloud-${testInfo.project.name}`
  let db = sql()
  try {
    await db`delete from runners where name = ${name}`
    await db`
      insert into runners (org_id, name, labels, version, token_hash, trusted, last_seen_at, created_at)
      select id, ${name}, '{linux}', '0.3.9', ${`e2e-${name}`}, false, now() - interval '2 hours', now() - interval '30 days'
      from orgs where login = 'sakuga-software'`
  } finally {
    await db.end()
  }
  await signIn(page, 'octocat')
  await page.goto('/runners')
  let first = page.getByRole('table', { name: 'Runners in service' }).locator('tbody tr').first()
  await expect(first.getByRole('rowheader')).toHaveText(new RegExp(`^${name}`))
  let state = first.getByText('Offline for 2 h', { exact: true })
  await expect(state).toBeVisible()
  // The colour repeats the word: the red of an alert, as an expired token.
  let colours = await state.evaluate((el) => {
    let probe = document.createElement('span')
    probe.className = 'status status-alert'
    document.body.append(probe)
    let alert = getComputedStyle(probe).color
    probe.remove()
    return { state: getComputedStyle(el).color, alert }
  })
  expect(colours.state).toBe(colours.alert)

  let form = page.locator('#new-runner')
  await expect(form.getByRole('radio', { name: /Key on the runner/ })).toBeChecked()
  await expect(form.getByRole('radio', { name: /Keys stored in Kentō/ })).not.toBeChecked()
  await expectNoAxeViolations(page)

  db = sql()
  try {
    await db`delete from runners where name = ${name}`
  } finally {
    await db.end()
  }
})

test('the runners silent for a day are folded away, and revoked together after a confirmation (REV-37)', async ({ page }, testInfo) => {
  let prefix = `ci-${testInfo.project.name}-`
  let db = sql()
  try {
    await db`delete from runners where name like ${`${prefix}%`}`
    await db`
      insert into runners (org_id, name, labels, version, token_hash, last_seen_at, created_at)
      select orgs.id, ${prefix} || g, '{linux}', '0.3.9', ${`e2e-${prefix}`} || g, now() - (g || ' days')::interval, now() - interval '30 days'
      from orgs, generate_series(1, 3) g where login = 'sakuga-software'`
  } finally {
    await db.end()
  }
  await signIn(page, 'octocat')
  await page.goto('/runners')
  await expect(page.getByRole('heading', { level: 2, name: 'Runners', exact: true })).toBeVisible()
  await expect(page.locator('.runner-counts').first()).toContainText('offline')
  let silent = page.locator('details.runner-silent')
  await expect(silent.locator('> summary')).toHaveText(/runners? silent for more than 24 h/)
  await expect(silent.getByRole('rowheader', { name: new RegExp(`^${prefix}1`) })).toBeHidden()
  await silent.locator('> summary').click()
  await expect(silent.getByRole('rowheader', { name: new RegExp(`^${prefix}1`) })).toBeVisible()
  await expect(silent.getByText('Offline for 3 d', { exact: true }).first()).toBeVisible()

  let trigger = silent.getByRole('button', { name: /^Revoke th/ })
  let dialog = page.getByRole('dialog', { name: /^Revoke th/ })
  await trigger.click()
  await expect(dialog.getByText('A runner that called after the page loaded stays in service.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expectNoAxeViolations(page)
  await trigger.click()
  await dialog.getByRole('button', { name: /^Revoke \d+ runners$|^Revoke ci-/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Silent runners revoked.' })).toBeVisible()
  await expect(page.locator('details.runner-silent')).toHaveCount(0)
  let revoked = page.locator('section', { has: page.getByRole('heading', { name: /Revoked/ }) })
  for (let n = 1; n <= 3; n++) await expect(revoked.getByRole('rowheader', { name: new RegExp(`^${prefix}${n}`) })).toBeVisible()
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  db = sql()
  try {
    await db`delete from runners where name like ${`${prefix}%`}`
  } finally {
    await db.end()
  }
})

test('a member reads the runners and has no form', async ({ page, request }) => {
  await signIn(page, 'camille')
  await page.goto('/runners')
  await expect(page.getByRole('heading', { level: 1, name: 'Runners' })).toBeVisible()
  await expect(page.getByText('Read only', { exact: true })).toBeVisible()
  await expect(page.locator('form[action^="/runners"]')).toHaveCount(0)
  await expect(page.getByText('Revoke…')).toHaveCount(0)
  await expectNoAxeViolations(page)
  // And a forged write without the session gets nothing.
  let forged = await request.post('/runners/new', { form: { name: 'x', keyMode: 'app' } })
  expect([401, 403]).toContain(forged.status())
})
