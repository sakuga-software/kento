import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { chooseOption, expectNoAxeViolations, goToSettingsLink, hydrated, signIn, watchConsole, withLabelLineHeight } from './helpers.ts'

// The end-to-end test of REV-11: an admin adds an Anthropic provider; the database holds no key in
// clear; a trusted runner of the org gets the key with a job; the provider refuses the key (401),
// and the screen shows "refused, 401" with a banner; the admin replaces the key; a member reads
// and changes nothing.

function sql() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** A trusted runner of the org, registered with a token of the Runners screen (key mode "app"). */
async function trustedRunner(page: Page, request: APIRequestContext, name: string): Promise<string> {
  await page.goto('/runners')
  let form = page.locator('#new-runner')
  await form.getByLabel('Name').fill(name)
  await form.getByRole('radio', { name: /Keys stored in Kentō/ }).check()
  await form.getByRole('button', { name: 'Create the token' }).click()
  let command = await page.getByLabel('docker run command').inputValue()
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
    await signIn(page, 'octocat')
    let [org] = await db<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await db`delete from jobs where repo_id in (select id from repos where org_id = ${org!.id})`
    await db`delete from providers where org_id = ${org!.id}`

    // 1. The admin adds the provider.
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Providers and keys' })).toBeVisible()
    await expectNoAxeViolations(page)
    // REV-29: the form is folded; the table of contents opens it.
    let form = page.locator('#new-provider')
    // KNT-165: the field "Type" is a custom select: its button (the list is labelled "Type" too).
    await expect(form.getByRole('button', { name: /^Type / })).toBeHidden()
    // REV-91: the button of the section opens it.
    await form.getByText('Add a provider', { exact: true }).click()
    await chooseOption(form, 'Type', 'anthropic')
    await form.getByLabel('Name').fill(label)
    await form.getByLabel('Key', { exact: true }).fill(key)
    await form.getByRole('button', { name: 'Add the provider' }).click()
    await expect(page.getByText('Provider added.')).toBeVisible()
    let card = page.locator('.provider', { hasText: label })
    await expect(card.getByText('••••ABCD')).toBeVisible()
    await expect(card.getByText('Default', { exact: true })).toBeVisible()
    await expect(card.getByText('Never called')).toBeVisible()
    expect(await page.content()).not.toContain(key)
    await expectNoAxeViolations(page)

    // 2. No key in clear in the database.
    let rows = await db`select * from providers where org_id = ${org!.id}`
    expect(JSON.stringify(rows)).not.toContain(key)
    expect(String(rows[0]!.key_ciphertext)).toMatch(/^v1:[0-9a-f]{16}:/)

    // 3. A trusted runner of the org claims a job, and gets the key with it.
    let runnerToken = await trustedRunner(page, request, `providers-runner-${project}`)
    let [repo] = await db<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), ${project === 'desktop' ? 71001 : 71002}, ${`sakuga-software/providers-${project}`}, true)
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
    expect(failed!.failure_reason).toMatch(new RegExp(`^the provider "${label}" refused its key \\(401\\)`))

    await page.goto('/settings')
    await expect(page.getByRole('alert')).toContainText(`The key of "${label}" is refused (401) since`)
    await expect(card.getByText(/Refused · 401 since/)).toBeVisible()
    await expectNoAxeViolations(page)

    // 5. The admin replaces the key: the refusal goes, the new last 4 characters show.
    await card.getByLabel('New Anthropic key').fill(`sk-ant-e2e-${project}-replaced-WXYZ`)
    // Escape in the field keeps the form and what was typed: it closes a destructive confirmation only.
    await card.getByLabel('New Anthropic key').press('Escape')
    await expect(card.getByLabel('New Anthropic key')).toBeVisible()
    await expect(card.getByLabel('New Anthropic key')).toHaveValue(`sk-ant-e2e-${project}-replaced-WXYZ`)
    await card.getByRole('button', { name: 'Replace', exact: true }).click()
    await expect(page.getByText('Key replaced.')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(card.getByText('••••WXYZ')).toBeVisible()

    // KNT-149. The sidebar lists the provider under "Providers and keys": its link leads to the card,
    // and leaves "Replace the key" folded. "Add a provider" opens the form.
    await goToSettingsLink(page, 'Costs and cap')
    await goToSettingsLink(page, label)
    await expect(page).toHaveURL(/\/settings\?notice=replaced#provider-[0-9a-f-]+$/)
    await expect(card).toBeInViewport()
    await expect(card.getByLabel('New Anthropic key')).toBeHidden()
    // The card is at the bottom of the page: the sidebar marks it and its section all the same.
    let nav = page.getByRole('navigation', { name: 'Sections of the settings' })
    await expect(nav.getByRole('link', { name: 'Providers and keys', includeHidden: true })).toHaveAttribute('aria-current', 'location')
    await expect(nav.getByRole('link', { name: label, exact: true, includeHidden: true })).toHaveAttribute('aria-current', 'true')
    await goToSettingsLink(page, 'Add a provider')
    await expect(page.locator('#new-provider').getByRole('button', { name: /^Type / })).toBeVisible()

    // 6. A member reads the section and has no form.
    await page.context().clearCookies()
    await signIn(page, 'camille')
    await page.goto('/settings')
    await expect(card.getByText('••••WXYZ')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add the provider' })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Test' })).toHaveCount(0)
    await expectNoAxeViolations(page)

    expect(errors).toEqual([])
  } finally {
    await db.end()
  }
})

// REV-28. A form sent back with its errors opens on its first field in error, in view, with the
// focus: "Add a provider" is at the bottom of a long page.
test('a provider form with an error opens on its first field in error, in view and focused', async ({ page }) => {
  let errors = watchConsole(page)
  await signIn(page, 'octocat')
  // A malformed hash stops nothing: settings.js still opens the form on a later change of the hash.
  await page.goto('/settings#%E0%A4%A')
  // A link to #new-provider in the page (the home screen has one) changes the hash: settings.js opens the form.
  await page.evaluate(() => {
    location.hash = 'new-provider'
  })
  await expect(page.locator('#new-provider').getByRole('button', { name: /^Type / })).toBeVisible()
  expect(errors.filter((e) => /URI/i.test(e))).toEqual([])

  // A link to the anchor opens the folded form (the home screen has one).
  await page.goto('/settings#new-provider')
  let form = page.locator('#new-provider')
  await chooseOption(form, 'Type', 'openai_compatible')
  await form.getByLabel('Name').fill('vLLM')
  await form.getByLabel('Server URL').fill('http://llm.example.com/v1')
  await form.getByRole('button', { name: 'Add the provider' }).click()
  let url = form.getByLabel('Server URL')
  await expect(url).toBeFocused()
  await expect(url).toBeInViewport()
  await expect(form.getByRole('alert')).toContainText('Nothing is saved')
  await expect(form.getByText('A URL with https://')).toBeVisible()
  await expectNoAxeViolations(page)

  // The limits of the org: the same rule.
  await page.goto('/settings')
  await page.locator('#cap-alert').fill('0')
  await page.getByRole('button', { name: 'Save the cap' }).click()
  await expect(page.locator('#cap-alert')).toBeFocused()
  await expect(page.locator('#cap-alert')).toBeInViewport()
  // The two 422 answers are the only errors of the console.
  expect(errors.filter((e) => !/status of 422/.test(e))).toEqual([])
})

// KNT-165: "Type" is a select that hydrates. Its error stays on the button that takes the place of
// the native select: the focus (the server gave it to the native one), aria-invalid, and the error
// first in its description.
test('an error on the select "Type" stays on its button after hydration: focus, aria-invalid, the error read', async ({ page }, testInfo) => {
  let errors = watchConsole(page)
  await signIn(page, 'octocat')
  await page.goto('/settings#new-provider')
  await hydrated(page)
  let form = page.locator('#new-provider')
  // A type that the server refuses, through the hidden input of the select: no option offers it.
  await form.locator('input[data-select][name="kind"]').evaluate((el) => ((el as HTMLInputElement).value = 'not-a-kind'))
  await form.getByLabel('Name').fill('vLLM')
  await form.getByRole('button', { name: 'Add the provider' }).click()
  await expect(form.getByRole('alert')).toContainText('Nothing is saved')
  await hydrated(page)
  let type = form.getByRole('button', { name: /^Type / })
  await expect(type).toBeFocused()
  await expect(type).toHaveAttribute('aria-invalid', 'true')
  await expect(type).toHaveAttribute('aria-describedby', 'provider-kind-error provider-kind-hint')
  await expect(type).toHaveAccessibleDescription(/^Choose the type of provider\. /)
  await expect(form.locator('select#provider-kind-native')).toBeHidden()
  await expectNoAxeViolations(page)
  if (testInfo.project.name === 'mobile') {
    // Under 900 px: Escape in the list closes the list only, not the open "Sections" (settings.js).
    let toggle = page.getByRole('navigation', { name: 'Sections of the settings' }).locator('[data-settings-nav-toggle]')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await type.focus()
    await page.keyboard.press('ArrowDown')
    let list = page.getByRole('listbox', { name: 'Type' })
    await expect(list).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden()
    await expect(type).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
  expect(errors.filter((e) => !/status of 422/.test(e))).toEqual([])
})

test('the form refuses a model id of the wrong form for its kind, and keeps what was typed (REV-66)', async ({ page }, testInfo) => {
  let errors = watchConsole(page)
  let project = testInfo.project.name
  let key = `sk-ant-e2e-form-${project}-0123456789-WXYZ`
  let label = `Anthropic form ${project}`
  let db = sql()
  try {
    // KNT-164: with labels of 18 px, the field in error of a phone went under the sticky bar.
    await withLabelLineHeight(page, '18px')
    await signIn(page, 'octocat')
    let [org] = await db<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await db`delete from jobs where repo_id in (select id from repos where org_id = ${org!.id})`
    await db`delete from providers where org_id = ${org!.id}`

    await page.goto('/settings#new-provider')
    let form = page.locator('#new-provider')
    await chooseOption(form, 'Type', 'anthropic')
    await form.getByLabel('Name').fill(label)
    await form.getByLabel('Key', { exact: true }).fill(key)
    await form.getByLabel('heavy').fill('anthropic/claude-opus-5.5')
    await form.getByRole('button', { name: 'Add the provider' }).click()

    // Refused, with what Anthropic expects; nothing is kept, and the typed id stays to be corrected.
    let refused = page.locator('#new-provider')
    await expect(refused.getByText('heavy: "anthropic/claude-opus-5.5". Anthropic expects its own id')).toBeVisible()
    await expect(refused.getByLabel('heavy')).toHaveValue('anthropic/claude-opus-5.5')
    await expect(refused.getByLabel('heavy')).toHaveAttribute('aria-invalid', 'true')
    expect(await db`select id from providers where org_id = ${org!.id}`).toHaveLength(0)
    await expectNoAxeViolations(page)

    // Corrected: the provider is added with that model.
    await refused.getByLabel('heavy').fill('claude-opus-5-5')
    await refused.getByLabel('Key', { exact: true }).fill(key)
    await refused.getByRole('button', { name: 'Add the provider' }).click()
    await expect(page.getByText('Provider added.')).toBeVisible()
    let [row] = await db<{ models: unknown }[]>`select models from providers where org_id = ${org!.id}`
    expect(row!.models).toEqual({ heavy: ['claude-opus-5-5'] })
    expect(errors.filter((line) => !line.includes('422'))).toEqual([])
  } finally {
    await db.end()
  }
})

// KNT-164. On a phone the bar "Sections" is at the top of the page and does not follow the scroll: a
// form sent back with its errors scrolls to its field, and no bar covers that field or the fields
// around it. Also with labels of 18 px, which moved a field under the sticky bar of KNT-149.
test('on a phone, a provider form sent back with its errors has no field under the bar "Sections"', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'the bar exists under 900 px only')
  await withLabelLineHeight(page, '18px')
  await signIn(page, 'octocat')
  await page.goto('/settings#new-provider')
  let form = page.locator('#new-provider')
  await chooseOption(form, 'Type', 'anthropic')
  await form.getByLabel('Name').fill('Phone form')
  await form.getByLabel('Key', { exact: true }).fill('sk-ant-e2e-phone-0123456789-WXYZ')
  await form.getByLabel('heavy').fill('anthropic/claude-opus-5.5')
  await form.getByRole('button', { name: 'Add the provider' }).click()
  // The first field in error is "heavy" of the models: the form focuses the first model field.
  let lite = page.locator('#new-provider').getByLabel('lite')
  await expect(lite).toBeFocused()
  await expect(page.locator('.field-label').first()).toHaveCSS('line-height', '18px')
  let bar = page.locator('[data-settings-nav]')
  await expect(bar).toHaveCSS('position', 'static')
  // The page scrolled down to the field, and the bar did not follow: it ends above the field,
  // wherever the page stopped, so it covers none of it.
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  let barBox = await bar.boundingBox()
  let fieldBox = await lite.boundingBox()
  expect(barBox, 'the bar has a box').not.toBeNull()
  expect(fieldBox, 'the field has a box').not.toBeNull()
  expect(fieldBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height)
  await expect(lite).toBeInViewport({ ratio: 1 })
  await expectNoAxeViolations(page)
})

// KNT-204. "Add a provider" starts with the provider: a preset fills the form, which stays editable;
// the list and the Config screen name the preset. The keyboard alone does it.
test('an admin adds a provider from a preset with the keyboard, and the list names the preset', async ({ page }, testInfo) => {
  let errors = watchConsole(page)
  let project = testInfo.project.name
  let db = sql()
  try {
    await signIn(page, 'octocat')
    let [org] = await db<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await db`delete from jobs where repo_id in (select id from repos where org_id = ${org!.id})`
    await db`delete from providers where org_id = ${org!.id}`

    await page.goto('/settings#new-provider')
    await hydrated(page)
    let form = page.locator('#new-provider')
    // The keyboard: the list of the picker, Mistral, then the button of the picker.
    let picker = form.getByRole('button', { name: /^Provider / })
    await picker.focus()
    await page.keyboard.press('ArrowDown')
    let list = page.getByRole('listbox', { name: 'Provider' })
    await expect(list).toBeFocused()
    // Typeahead in the list, then Enter.
    await page.keyboard.type('Mis')
    await expect(list.getByRole('option', { name: 'Mistral', exact: true })).toHaveAttribute('data-highlighted', 'true')
    await page.keyboard.press('Enter')
    await expect(picker).toBeFocused()
    await expect(picker).toContainText('Mistral')
    await page.keyboard.press('Tab')
    await expect(form.getByRole('button', { name: 'Fill in the form' })).toBeFocused()
    await page.keyboard.press('Enter')

    // The form is filled, open, and the key has the focus.
    await expect(page).toHaveURL(/\/settings\?preset=mistral$/)
    await hydrated(page)
    await expect(form.getByLabel('Key', { exact: true })).toBeFocused()
    await expect(form.getByLabel('Name')).toHaveValue('Mistral')
    await expect(form.getByLabel('Server URL')).toHaveValue('https://api.mistral.ai/v1')
    await expect(form.getByLabel('lite', { exact: true })).toHaveValue('mistral-small-2603, ministral-14b-2512')
    await expect(form.getByRole('button', { name: /^Type / })).toContainText('OpenAI-compatible')
    await expect(form.getByRole('link', { name: /the page of the Mistral keys/ })).toHaveAttribute('href', 'https://console.mistral.ai/api-keys')
    await expect(form.getByText('The diff of each review goes to Mistral.')).toBeVisible()
    await expectNoAxeViolations(page)

    // Everything stays editable: the name, and the models of a level.
    let label = `Mistral ${project}`
    await form.getByLabel('Name').fill(label)
    await form.getByLabel('heavy', { exact: true }).fill('mistral-large-4')
    await form.getByLabel('Key', { exact: true }).fill(`e2e-mistral-${project}-0123456789-WXYZ`)
    await form.getByRole('button', { name: 'Add the provider' }).click()
    await expect(page.getByText('Provider added.')).toBeVisible()
    let card = page.locator('.provider', { hasText: label })
    await expect(card.locator('.tag').first()).toHaveText('Mistral')
    // balanced, as the preset gave it, and heavy, as the admin left it.
    await expect(card.getByText('mistral-large-4', { exact: true })).toHaveCount(2)
    await expect(card.getByText('no price: not counted in the cap')).toHaveCount(0)
    let [row] = await db<{ kind: string; base_url: string; models: Record<string, string[]> }[]>`
      select kind, base_url, models from providers where org_id = ${org!.id} and label = ${label}`
    expect(row).toEqual({ kind: 'openai_compatible', base_url: 'https://api.mistral.ai/v1', models: { lite: ['mistral-small-2603', 'ministral-14b-2512'], balanced: ['mistral-large-4', 'mistral-small-2603'], heavy: ['mistral-large-4'] } })
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  } finally {
    await db`delete from providers where org_id = (select org_id from installations where github_installation_id = ${FAKE_ORG.installationId}) and label like 'Mistral %'`
    await db.end()
  }
})
