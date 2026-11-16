import { createHash, createHmac, randomBytes } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { E2E_WEBHOOK_SECRET, FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, openRepoConfig, signIn, watchConsole } from './helpers.ts'

// The Config screen of a repository (REV-12) in a browser, against the server, Postgres and the
// fake GitHub, with the tests of the ticket: a model replaced on balanced goes into the next job and
// to the runner; "Back to the org value" takes the value back; "Ready for review" leaves the pushes of a
// draft without a job, and its passage to ready creates one.

const ORCHARD = { id: 7001, full_name: 'sakuga-software/orchard', owner: { id: FAKE_ORG.accountId, login: FAKE_ORG.login } }

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/**
 * orchard enabled, at its first config, with no job; the org sets nothing and has no provider. A
 * "Default" provider left by another spec would run the levels without a choice (REV-27).
 */
async function reset(page: Page) {
  await page.goto('/repos')
  await page.getByRole('button', { name: 'Read GitHub again' }).click()
  await expect(page.getByText('List up to date.')).toBeVisible()
  let sql = database()
  try {
    await sql`delete from jobs where repo_id in (select id from repos where full_name = ${ORCHARD.full_name})`
    await sql`update repos set enabled = true, config = '{}', config_version = 0, config_updated_by = null, config_updated_at = null, default_level = 'lite'
      where full_name = ${ORCHARD.full_name}`
    await sql`update orgs set config = '{}'`
    await sql`delete from providers`
  } finally {
    await sql.end()
  }
}

let delivery = 0

/** A `pull_request` event of orchard, signed as GitHub signs it. */
async function pullRequest(page: Page, options: { action: string; head: string; draft?: boolean; number?: number }) {
  let number = options.number ?? 31
  let body = JSON.stringify({
    action: options.action,
    number,
    pull_request: {
      number,
      draft: options.draft ?? false,
      user: { login: 'alex', type: 'User' },
      head: { sha: options.head, ref: 'feature', repo: { id: ORCHARD.id } },
      base: { sha: 'f'.repeat(40), ref: 'main', repo: { id: ORCHARD.id } },
    },
    repository: ORCHARD,
    sender: { login: 'alex', type: 'User' },
    installation: { id: FAKE_ORG.installationId },
  })
  let signature = `sha256=${createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex')}`
  delivery++
  let response = await page.request.post('/webhooks/github', {
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': `e2e-config-${Date.now()}-${delivery}`,
      'X-Hub-Signature-256': signature,
    },
    data: body,
  })
  return (await response.json()) as { outcome: string; reason?: string; jobId?: string }
}

async function jobsOforchard() {
  let sql = database()
  try {
    return await sql<{ id: string; head_sha: string; level: string; config: any }[]>`
      select jobs.id, head_sha, level, jobs.config from jobs join repos on repos.id = jobs.repo_id
      where repos.full_name = ${ORCHARD.full_name} order by jobs.created_at, jobs.id`
  } finally {
    await sql.end()
  }
}

/** A runner of the service with its own OpenRouter key claims the job, as a runner of this release. */
async function claim(page: Page, jobId: string) {
  let token = `kento_rt_${randomBytes(24).toString('hex')}`
  let sql = database()
  try {
    // Only this job waits: the claim takes the oldest queued job of every repository.
    await sql`update jobs set state = 'cancelled', failure_reason = 'e2e' where state = 'queued' and id <> ${jobId}`
    await sql`insert into runners (name, token_hash) values ('e2e-config', ${createHash('sha256').update(token).digest('hex')})`
  } finally {
    await sql.end()
  }
  let response = await page.request.post('/api/runner/jobs/claim', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { hasProviderKey: true, kinds: ['review'], features: ['providers', 'models'], ownProvider: 'openrouter' },
  })
  expect(response.status()).toBe(200)
  return response.json()
}

const head = (n: number) => n.toString(16).padStart(40, '0')

test.describe('the Config screen of a repository', () => {
  for (let theme of ['paper', 'sumi'] as const) {
    test(`an admin replaces the model of balanced, the next push and its runner use it, and "Back to the org value" takes it back (${theme})`, async ({
      page,
      context,
      baseURL,
    }) => {
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      await signIn(page, 'alex')
      await reset(page)

      await openRepoConfig(page, 'orchard')
      await expect(page.getByRole('heading', { level: 1, name: 'Config of orchard' })).toBeVisible()
      await expect(page.getByText('config v0, everything comes from the organization')).toBeVisible()
      let balanced = page.getByRole('region', { name: 'balanced' })
      await expect(balanced.getByText('from the org', { exact: true })).toBeVisible()
      await expect(balanced.getByLabel('Model', { exact: true })).toHaveValue('anthropic/claude-sonnet-5.5')
      await expectNoAxeViolations(page)

      await balanced.getByLabel('Model', { exact: true }).fill('anthropic/claude-sonnet-5.6')
      await balanced.getByLabel('Fallback if the call fails').fill('anthropic/claude-sonnet-5.5')
      await balanced.getByRole('button', { name: 'Set here for balanced' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Config saved (v1)' })).toBeVisible()
      await expect(page.getByText(/config v1, changed by alex on/)).toBeVisible()
      await expect(page.getByRole('region', { name: 'balanced' }).getByText('set for this repo')).toBeVisible()
      await expectNoAxeViolations(page)

      await page.getByRole('link', { name: 'Levels and passes' }).click()
      await page.getByRole('radio', { name: /balanced/ }).check()
      await page.getByRole('button', { name: 'Set here the level' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Config saved (v2)' })).toBeVisible()
      await expect(page.getByText('One pass')).toBeVisible()
      await expectNoAxeViolations(page)

      // The next push: a balanced job with the models of the repository, and its runner gets them.
      expect((await pullRequest(page, { action: 'synchronize', head: head(1) })).outcome).toBe('queued')
      let [job] = await jobsOforchard()
      expect(job!.level).toBe('balanced')
      expect(job!.config).toEqual({
        repoConfigVersion: 2,
        models: { provider: 'service', model: 'anthropic/claude-sonnet-5.6', fallback: 'anthropic/claude-sonnet-5.5' },
        source: 'repo',
      })
      let claimed = await claim(page, job!.id)
      expect(claimed.models).toEqual({ provider: 'service', model: 'anthropic/claude-sonnet-5.6', fallback: 'anthropic/claude-sonnet-5.5' })

      // "Back to the org value": the next push takes the value of the org (here, of Kentō).
      await page.getByRole('link', { name: 'Provider and models' }).click()
      await page.getByRole('button', { name: 'Back to the org value for balanced' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Value of the organization restored (v3)' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'balanced' }).getByText('from the org', { exact: true })).toBeVisible()
      expect((await pullRequest(page, { action: 'synchronize', head: head(2) })).outcome).toBe('queued')
      let last = (await jobsOforchard()).at(-1)!
      expect(last.config.models).toEqual({ provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: null })
      expect(last.config.source).toBe('kento')

      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })
  }

  test('a model id of the wrong form already in the database shows in error, with what to do (REV-62)', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'alex')
    await reset(page)
    // As `sakuga-review` on 2026-10-29: an OpenRouter id on an Anthropic provider, kept before the
    // form refused it (#66). Written in the database, since the form refuses it now.
    let sql = database()
    try {
      let [provider] = await sql<{ id: string }[]>`
        insert into providers (id, org_id, kind, label, runner_held)
        select gen_random_uuid(), org_id, 'anthropic', 'Sakuga Anthropic', true from repos where full_name = ${ORCHARD.full_name}
        returning id`
      let models = { balanced: { provider: provider!.id, model: 'anthropic/claude-opus-5.5', fallback: null } }
      await sql`update repos set config = ${sql.json({ models })}, config_version = 1 where full_name = ${ORCHARD.full_name}`
    } finally {
      await sql.end()
    }

    await openRepoConfig(page, 'orchard')
    let balanced = page.getByRole('region', { name: 'balanced' })
    let alert = balanced.getByRole('alert')
    await expect(alert).toContainText('The id anthropic/claude-opus-5.5 is not in the form that Anthropic expects.')
    await expect(alert).toContainText('without "anthropic/", for example claude-sonnet-5-5')
    await expect(alert).toContainText('The next job of this level fails before it calls the provider.')
    await expect(alert).toContainText('change the model of this level in the form below')
    // The other levels have ids of the right form.
    await expect(page.getByRole('region', { name: 'lite' }).getByRole('alert')).toHaveCount(0)
    await expectNoAxeViolations(page)

    // Corrected in the form, the error goes.
    await balanced.getByLabel('Model', { exact: true }).fill('claude-opus-5-5')
    await balanced.getByRole('button', { name: 'Save for balanced' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Config saved (v2)' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'balanced' }).getByRole('alert')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('"Ready for review": a push of a draft creates no job, its passage to ready creates one, a later push none', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'alex')
    await reset(page)
    await openRepoConfig(page, 'orchard')
    await page.getByRole('link', { name: 'Trigger' }).click()
    await expectNoAxeViolations(page)

    await page.getByRole('radio', { name: /When the PR becomes "Ready for review"/ }).check()
    await page.getByRole('button', { name: 'Set here the trigger' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Config saved (v1)' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Trigger' }).getByText('set for this repo')).toBeVisible()

    expect((await pullRequest(page, { action: 'synchronize', head: head(3), draft: true })).outcome).toBe('ignored')
    expect(await jobsOforchard()).toHaveLength(0)
    expect((await pullRequest(page, { action: 'ready_for_review', head: head(3) })).outcome).toBe('queued')
    expect(await pullRequest(page, { action: 'synchronize', head: head(4) })).toEqual({ outcome: 'skipped', reason: 'trigger of the config is ready' })
    expect((await jobsOforchard()).map((j) => j.head_sha)).toEqual([head(3)])

    // A wrong path and a wrong limit come back with their error, under their field.
    await page.getByLabel(/An automatic review only if the PR changes/).fill('/etc/passwd')
    await page.getByRole('button', { name: 'Set here the paths' }).click()
    await expect(page.getByText(/"\/etc\/passwd": a path starts without "\/"/)).toBeVisible()
    await expect(page.getByLabel(/An automatic review only if the PR changes/)).toHaveAttribute('aria-invalid', 'true')
    await expectNoAxeViolations(page)
    await page.getByLabel(/Cap of the automatic reviews/).fill('beaucoup')
    await page.getByRole('button', { name: 'Set here the cap' }).click()
    await expect(page.getByText(/An amount in dollars/)).toBeVisible()
    await page.getByLabel(/Cap of the automatic reviews/).fill('12,50')
    await page.getByRole('button', { name: 'Set here the cap' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Config saved (v2)' })).toBeVisible()
    await expect(page.getByText(/of \$12\.50/)).toBeVisible()
    // The two wrong forms answer 422 on purpose; nothing else may fail.
    expect(errors.filter((e) => !e.includes('status of 422'))).toEqual([])
  })

  test('a member reads the config under "Read only", with no form', async ({ page }) => {
    await signIn(page, 'alex')
    await reset(page)
    await page.context().clearCookies()
    await signIn(page, 'camille')
    await page.goto('/repos')
    await openRepoConfig(page, 'orchard')
    await expect(page.getByText('Read only', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'lite' }).getByText('anthropic/claude-haiku-5.5')).toBeVisible()
    await expect(page.getByRole('button', { name: /Set here|Back to the org value/ })).toHaveCount(0)
    await expectNoAxeViolations(page)
    await page.getByRole('link', { name: 'Trigger' }).click()
    await expect(page.getByText('At each push')).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expectNoAxeViolations(page)
  })
})
