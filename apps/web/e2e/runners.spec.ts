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
  await page.getByRole('link', { name: 'Nouveau runner' }).click()
  let form = page.locator('#nouveau-runner')
  await form.getByLabel('Nom').fill(name)
  await form.getByLabel('Labels').fill(labels)
  await form.getByRole('radio', { name: keyMode === 'app' ? /Clé de l’app/ : /Clé du runner/ }).check()
  await form.getByRole('button', { name: 'Créer le token' }).click()
  await expect(page.getByRole('heading', { name: `Token de ${name}` })).toBeVisible()
  let command = await page.getByLabel('Commande docker run').inputValue()
  let token = /KENTO_REGISTRATION_TOKEN=(kento_reg_\S+)/.exec(command)?.[1]
  expect(token).toBeTruthy()
  return { command, token: token! }
}

test('an admin registers a runner, sees it online, trusts it and revokes it', async ({ page, request }, testInfo) => {
  let errors = watchConsole(page)
  let name = `mac-mini-${testInfo.project.name}`
  await signIn(page, 'alex')

  let { command, token } = await createToken(page, name, 'macos, arm64', 'runner')
  expect(command).toContain(`-e KENTO_RUNNER_NAME=${name}`)
  expect(command).toContain('-e KENTO_RUNNER_LABELS=macos,arm64')
  expect(command).toContain('-e PROVIDER_API_KEY=<votre clé OpenRouter>')
  expect(command).toMatch(/ghcr\.io\/sakuga-software\/kento-runner:\d+\.\d+\.\d+$/)
  await expect(page.getByText('il ne sera plus affiché')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copier la commande' })).toBeVisible()
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
  await expect(pending.getByText('En attente du runner')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(token)

  let runnerToken = await startRunner(request, token)
  await page.reload()
  let card = page.locator('.runner', { has: page.getByRole('heading', { name, exact: true }) })
  await expect(card.getByText('En ligne', { exact: true })).toBeVisible()
  await expect(card.getByText('Clé du runner', { exact: true })).toBeVisible()
  await expect(card.getByText(/disponible$/)).toBeVisible()
  await expect(card.getByRole('listitem').filter({ hasText: 'arm64' })).toBeVisible()
  // The name and the labels come from the token, not from the runner.
  await expect(page.getByText('what-the-runner-says')).toHaveCount(0)
  // The token works once.
  expect((await request.post('/api/runner/register', { headers: { Authorization: `Bearer ${token}` }, data: { name: 'x', labels: [], version: '0.0.1' } })).status()).toBe(401)

  await card.getByRole('button', { name: 'Marquer de confiance' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'reçoit maintenant la clé de l’app' })).toBeVisible()
  await expect(card.getByText('Clé de l’app (de confiance)')).toBeVisible()

  await card.getByText('Révoquer…').click()
  await expect(card.getByText('cessera de marcher à son prochain appel')).toBeVisible()
  await expectNoAxeViolations(page)
  await card.getByRole('button', { name: `Révoquer ${name}` }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Runner révoqué.' })).toBeVisible()
  let revoked = page.locator('section', { has: page.getByRole('heading', { name: /Révoqués/ }) })
  await expect(revoked.getByRole('heading', { name, exact: true })).toBeVisible()

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

test('a token that expires without a runner shows the help and « Nouveau token »', async ({ page }, testInfo) => {
  let name = `gpu-${testInfo.project.name}`
  await signIn(page, 'alex')
  await createToken(page, name, 'gpu', 'app')
  let db = sql()
  try {
    await db`update runner_registrations set expires_at = now() - interval '1 minute' where name = ${name} and used_at is null`
  } finally {
    await db.end()
  }
  await page.goto('/runners')
  let card = page.locator('.runner', { hasText: name })
  await expect(card.getByText('Token expiré')).toBeVisible()
  await expect(card).toContainText('Vérifiez que le conteneur atteint 127.0.0.1')
  await expect(card).toContainText('en HTTPS sortant')
  await card.getByRole('button', { name: 'Nouveau token' }).click()
  await expect(page.getByRole('heading', { name: `Token de ${name}` })).toBeVisible()
  await expect(page.getByLabel('Commande docker run')).toHaveValue(/KENTO_RUNNER_LABELS=gpu/)
})

test('the form says what is wrong, and makes no token', async ({ page }) => {
  await signIn(page, 'alex')
  await page.goto('/runners')
  let form = page.locator('#nouveau-runner')
  await form.getByLabel('Nom').fill('mac mini')
  await form.getByRole('button', { name: 'Créer le token' }).click()
  await expect(form.getByLabel('Nom')).toHaveAttribute('aria-invalid', 'true')
  await expect(form.getByText('Lettres, chiffres, points, tirets ou soulignés')).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Token de/ })).toHaveCount(0)
  await expectNoAxeViolations(page)
})

for (let theme of ['paper', 'sumi'] as const) {
  test(`the Runners screen passes axe in the theme ${theme} for an admin, and fits the screen`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
    await signIn(page, 'alex')
    await page.goto('/runners')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.getByRole('heading', { name: 'Protocole' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Bail et tentatives' })).toBeVisible()
    await expectNoAxeViolations(page)
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
}

test('a member reads the runners and has no form', async ({ page, request }) => {
  await signIn(page, 'camille')
  await page.goto('/runners')
  await expect(page.getByRole('heading', { level: 1, name: 'Runners' })).toBeVisible()
  await expect(page.getByText('Lecture seule.')).toBeVisible()
  await expect(page.locator('form[action^="/runners"]')).toHaveCount(0)
  await expect(page.getByText('Révoquer…')).toHaveCount(0)
  await expectNoAxeViolations(page)
  // And a forged write without the session gets nothing.
  let forged = await request.post('/runners/new', { form: { name: 'x', keyMode: 'app' } })
  expect([401, 403]).toContain(forged.status())
})
