import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The end-to-end test of REV-11: an admin adds an Anthropic provider; the database holds no key in
// clear; a trusted runner of the org gets the key with a job; the provider refuses the key (401),
// and the screen shows « refusée, 401 » with a banner; the admin replaces the key; a member reads
// and changes nothing.

function sql() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** A trusted runner of the org, registered with a token of the Runners screen (key mode « app »). */
async function trustedRunner(page: Page, request: APIRequestContext, name: string): Promise<string> {
  await page.goto('/runners')
  let form = page.locator('#nouveau-runner')
  await form.getByLabel('Nom').fill(name)
  await form.getByRole('radio', { name: /Clé du service/ }).check()
  await form.getByRole('button', { name: 'Créer le token' }).click()
  let command = await page.getByLabel('Commande docker run').inputValue()
  let token = /KENTO_REGISTRATION_TOKEN=(kento_reg_\S+)/.exec(command)![1]!
  let registered = await request.post('/api/runner/register', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name, labels: [], version: '0.2.0' },
  })
  expect(registered.status()).toBe(201)
  return (await registered.json()).token
}

test('an admin adds a provider; a trusted runner gets its key; a refused key shows on the screen until it is replaced', async ({ page, request }, testInfo) => {
  let errors = watchConsole(page)
  let project = testInfo.project.name
  let key = `sk-ant-e2e-${project}-0123456789-ABCD`
  let label = `Anthropic ${project}`
  let db = sql()
  try {
    await signIn(page, 'alex')
    let [org] = await db<{ id: string }[]>`select id from orgs where github_installation_id = ${FAKE_ORG.installationId}`
    await db`delete from jobs where repo_id in (select id from repos where org_id = ${org!.id})`
    await db`delete from providers where org_id = ${org!.id}`

    // 1. The admin adds the provider.
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Providers et clés' })).toBeVisible()
    await expectNoAxeViolations(page)
    // REV-29: the form is folded; the table of contents opens it.
    let form = page.locator('#nouveau-provider')
    await expect(form.getByLabel('Type')).toBeHidden()
    // REV-91: the button of the section opens it.
    await form.getByText('Ajouter un provider', { exact: true }).click()
    await form.getByLabel('Type').selectOption('anthropic')
    await form.getByLabel('Nom').fill(label)
    await form.getByLabel('Clé', { exact: true }).fill(key)
    await form.getByRole('button', { name: 'Ajouter le provider' }).click()
    await expect(page.getByText('Provider ajouté.')).toBeVisible()
    let card = page.locator('.provider', { hasText: label })
    await expect(card.getByText('••••ABCD')).toBeVisible()
    await expect(card.getByText('Par défaut', { exact: true })).toBeVisible()
    await expect(card.getByText('Jamais appelé')).toBeVisible()
    expect(await page.content()).not.toContain(key)
    await expectNoAxeViolations(page)

    // 2. No key in clear in the database.
    let rows = await db`select * from providers where org_id = ${org!.id}`
    expect(JSON.stringify(rows)).not.toContain(key)
    expect(String(rows[0]!.key_ciphertext)).toMatch(/^v1:[0-9a-f]{16}:/)

    // 3. A trusted runner of the org claims a job, and gets the key with it.
    let runnerToken = await trustedRunner(page, request, `providers-runner-${project}`)
    let [repo] = await db<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${org!.id}, ${project === 'desktop' ? 71001 : 71002}, ${`sakuga-software/providers-${project}`}, true)
      on conflict (github_repo_id) do update set enabled = true returning id`
    let [job] = await db<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repo!.id}, 'lite', 7, ${'c'.repeat(40)}, 'main') returning id`
    let claimed = await request.post('/api/runner/jobs/claim', {
      headers: { Authorization: `Bearer ${runnerToken}` },
      data: { hasProviderKey: false, kinds: ['review'], features: ['providers'], ownProvider: null },
      timeout: 45_000,
    })
    expect(claimed.status()).toBe(200)
    let body = await claimed.json()
    expect(body.id).toBe(job!.id)
    expect(body.provider).toBeNull()
    expect(body.providers).toEqual([{ id: rows[0]!.id, kind: 'anthropic', apiKey: key, baseUrl: null, models: [] }])

    // 4. The provider refused the key: the runner sends the failure with the status.
    let result = await request.post(`/api/runner/jobs/${job!.id}/result`, {
      headers: { Authorization: `Bearer ${runnerToken}` },
      data: { outcome: 'failed', attempt: body.attempt, reason: 'no model gave a usable answer: ProviderError: Anthropic answered 401: invalid x-api-key', providerStatus: 401 },
    })
    expect(result.status()).toBe(204)
    let [failed] = await db<{ failure_reason: string }[]>`select failure_reason from jobs where id = ${job!.id}`
    expect(failed!.failure_reason).toMatch(new RegExp(`^the provider « ${label} » refused its key \\(401\\)`))

    await page.goto('/settings')
    await expect(page.getByRole('alert')).toContainText(`La clé de « ${label} » est refusée (401) depuis`)
    await expect(card.getByText(/Refusée · 401 depuis/)).toBeVisible()
    await expectNoAxeViolations(page)

    // 5. The admin replaces the key: the refusal goes, the new last 4 characters show.
    await card.getByLabel('Nouvelle clé Anthropic').fill(`sk-ant-e2e-${project}-replaced-WXYZ`)
    // Escape in the field keeps the form and what was typed: it closes a destructive confirmation only.
    await card.getByLabel('Nouvelle clé Anthropic').press('Escape')
    await expect(card.getByLabel('Nouvelle clé Anthropic')).toBeVisible()
    await expect(card.getByLabel('Nouvelle clé Anthropic')).toHaveValue(`sk-ant-e2e-${project}-replaced-WXYZ`)
    await card.getByRole('button', { name: 'Remplacer', exact: true }).click()
    await expect(page.getByText('Clé remplacée.')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(card.getByText('••••WXYZ')).toBeVisible()

    // 6. A member reads the section and has no form.
    await page.context().clearCookies()
    await signIn(page, 'camille')
    await page.goto('/settings')
    await expect(card.getByText('••••WXYZ')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ajouter le provider' })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Tester' })).toHaveCount(0)
    await expectNoAxeViolations(page)

    expect(errors).toEqual([])
  } finally {
    await db.end()
  }
})

// REV-28. A form sent back with its errors opens on its first field in error, in view, with the
// focus: « Ajouter un provider » is at the bottom of a long page.
test('a provider form with an error opens on its first field in error, in view and focused', async ({ page }) => {
  let errors = watchConsole(page)
  await signIn(page, 'alex')
  // A malformed hash stops nothing: settings.js still opens the form on a later change of the hash.
  await page.goto('/settings#%E0%A4%A')
  // A link to #nouveau-provider in the page (the home screen has one) changes the hash: settings.js opens the form.
  await page.evaluate(() => {
    location.hash = 'nouveau-provider'
  })
  await expect(page.locator('#nouveau-provider').getByLabel('Type')).toBeVisible()
  expect(errors.filter((e) => /URI/i.test(e))).toEqual([])

  // A link to the anchor opens the folded form (the home screen has one).
  await page.goto('/settings#nouveau-provider')
  let form = page.locator('#nouveau-provider')
  await form.getByLabel('Type').selectOption('openai_compatible')
  await form.getByLabel('Nom').fill('vLLM')
  await form.getByLabel('URL du serveur').fill('http://llm.example.com/v1')
  await form.getByRole('button', { name: 'Ajouter le provider' }).click()
  let url = form.getByLabel('URL du serveur')
  await expect(url).toBeFocused()
  await expect(url).toBeInViewport()
  await expect(form.getByRole('alert')).toContainText('Rien n’est enregistré')
  await expect(form.getByText('Une URL en https://')).toBeVisible()
  await expectNoAxeViolations(page)

  // The limits of the org: the same rule.
  await page.goto('/settings')
  await page.locator('#cap-alert').fill('0')
  await page.getByRole('button', { name: 'Enregistrer le plafond' }).click()
  await expect(page.locator('#cap-alert')).toBeFocused()
  await expect(page.locator('#cap-alert')).toBeInViewport()
  // The two 422 answers are the only errors of the console.
  expect(errors.filter((e) => !/status of 422/.test(e))).toEqual([])
})

test('the form refuses a model id of the wrong form for its kind, and keeps what was typed (REV-66)', async ({ page }, testInfo) => {
  let errors = watchConsole(page)
  let project = testInfo.project.name
  let key = `sk-ant-e2e-form-${project}-0123456789-WXYZ`
  let label = `Anthropic form ${project}`
  let db = sql()
  try {
    await signIn(page, 'alex')
    let [org] = await db<{ id: string }[]>`select id from orgs where github_installation_id = ${FAKE_ORG.installationId}`
    await db`delete from jobs where repo_id in (select id from repos where org_id = ${org!.id})`
    await db`delete from providers where org_id = ${org!.id}`

    await page.goto('/settings#nouveau-provider')
    let form = page.locator('#nouveau-provider')
    await form.getByLabel('Type').selectOption('anthropic')
    await form.getByLabel('Nom').fill(label)
    await form.getByLabel('Clé', { exact: true }).fill(key)
    await form.getByLabel('heavy').fill('anthropic/claude-opus-5.5')
    await form.getByRole('button', { name: 'Ajouter le provider' }).click()

    // Refused, with what Anthropic expects; nothing is kept, and the typed id stays to be corrected.
    let refused = page.locator('#nouveau-provider')
    await expect(refused.getByText('heavy : « anthropic/claude-opus-5.5 ». Anthropic attend son propre identifiant')).toBeVisible()
    await expect(refused.getByLabel('heavy')).toHaveValue('anthropic/claude-opus-5.5')
    await expect(refused.getByLabel('heavy')).toHaveAttribute('aria-invalid', 'true')
    expect(await db`select id from providers where org_id = ${org!.id}`).toHaveLength(0)
    await expectNoAxeViolations(page)

    // Corrected: the provider is added with that model.
    await refused.getByLabel('heavy').fill('claude-opus-5-5')
    await refused.getByLabel('Clé', { exact: true }).fill(key)
    await refused.getByRole('button', { name: 'Ajouter le provider' }).click()
    await expect(page.getByText('Provider ajouté.')).toBeVisible()
    let [row] = await db<{ models: unknown }[]>`select models from providers where org_id = ${org!.id}`
    expect(row!.models).toEqual({ heavy: ['claude-opus-5-5'] })
    expect(errors.filter((line) => !line.includes('422'))).toEqual([])
  } finally {
    await db.end()
  }
})
