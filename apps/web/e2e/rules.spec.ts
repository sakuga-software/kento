import { createHash, createHmac, randomBytes } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { E2E_WEBHOOK_SECRET, FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, goToSettingsLink, openRepoConfig, signIn, watchConsole } from './helpers.ts'

// The rules of a repository and of the org (REV-19) in a browser, with the test of the ticket: a
// rule written in Config › Rules goes with the next job to a runner that reads the rules; disabled,
// it no longer goes. A rule of the org, written in the settings, goes with it.

const ORCHARD = { id: 7001, full_name: 'sakuga-software/orchard', owner: { id: FAKE_ORG.accountId, login: FAKE_ORG.login } }
const FK_RULE = 'Every drizzle migration has an index for each FK'

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** orchard enabled, with no job and no rule. */
async function reset(page: Page) {
  await page.goto('/repos')
  await page.getByRole('button', { name: 'Read GitHub again' }).click()
  await expect(page.getByText('List up to date.')).toBeVisible()
  let sql = database()
  try {
    await sql`delete from jobs where repo_id in (select id from repos where full_name = ${ORCHARD.full_name})`
    // As the Config spec leaves it: no config, no provider of the org, so the job runs on the key of
    // the service and the runner of the test can claim it.
    await sql`update repos set enabled = true, config = '{}', config_version = 0, default_level = 'lite', default_runner_pool = null
      where full_name = ${ORCHARD.full_name}`
    await sql`update orgs set config = '{}', daily_cap_usd = null, monthly_cap_usd = null`
    await sql`delete from providers`
    await sql`delete from rules`
  } finally {
    await sql.end()
  }
}

let delivery = 0
const head = (n: number) => (0xe000 + n).toString(16).padStart(40, '0')

/** A push on a pull request of orchard, signed as GitHub signs it; returns the id of its job. */
async function push(page: Page, n: number): Promise<string> {
  let body = JSON.stringify({
    action: 'synchronize',
    number: 41,
    pull_request: {
      number: 41,
      draft: false,
      user: { login: 'octocat', type: 'User' },
      head: { sha: head(n), ref: 'feature', repo: { id: ORCHARD.id } },
      base: { sha: 'f'.repeat(40), ref: 'main', repo: { id: ORCHARD.id } },
    },
    repository: ORCHARD,
    sender: { login: 'octocat', type: 'User' },
    installation: { id: FAKE_ORG.installationId },
  })
  delivery++
  let response = await page.request.post('/webhooks/github', {
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': `e2e-rules-${Date.now()}-${delivery}`,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    data: body,
  })
  let answer = (await response.json()) as { outcome: string; jobId?: string }
  expect(answer.outcome).toBe('queued')
  return answer.jobId!
}

/** A runner of this release, with its own OpenRouter key, claims the job. */
async function claim(page: Page, jobId: string) {
  let token = `kento_rt_${randomBytes(24).toString('hex')}`
  let sql = database()
  try {
    await sql`update jobs set state = 'cancelled', failure_reason = 'e2e' where state = 'queued' and id <> ${jobId}`
    await sql`insert into runners (name, token_hash) values ('e2e-rules', ${createHash('sha256').update(token).digest('hex')})`
  } finally {
    await sql.end()
  }
  let response = await page.request.post('/api/runner/jobs/claim', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { hasProviderKey: true, kinds: ['review'], features: ['providers', 'models', 'rules'], ownProvider: 'openrouter' },
  })
  expect(response.status()).toBe(200)
  return (await response.json()) as { id: string; rules?: { title: string; paths: string[]; severityFloor: string | null; scope: string }[] }
}

test.describe('the rules of a repository and of the org', () => {
  test('an admin writes a rule of orchard, the next job carries it, and once disabled it no longer goes', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await reset(page)

    await openRepoConfig(page, 'orchard')
    await page.getByRole('link', { name: 'Rules', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Rules of orchard/ })).toBeVisible()
    await expect(page.getByText('No rule for this repo.')).toBeVisible()
    await expect(page.getByText(/never from the code of a PR/)).toBeVisible()
    await expectNoAxeViolations(page)

    let form = page.locator('#repo-rule-new')
    await form.getByLabel('Title').fill(FK_RULE)
    await form.getByLabel('What the rule asks for').fill('Each foreign key that a migration adds has its index, in the same migration.')
    await form.getByLabel('Paths').fill('**/migrations/**')
    await form.getByLabel('Lowest priority of a finding of this rule').selectOption('major')
    await form.getByRole('button', { name: 'Add the rule' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Rule added.' })).toBeVisible()
    let item = page.getByRole('listitem').filter({ hasText: FK_RULE })
    await expect(item.locator('.rule-tags').getByText('**/migrations/**', { exact: true })).toBeVisible()
    await expect(item.getByText('at least P1')).toBeVisible()
    await expectNoAxeViolations(page)

    let job = await claim(page, await push(page, 1))
    expect(job.rules?.map((r) => [r.title, r.paths, r.severityFloor, r.scope])).toEqual([[FK_RULE, ['**/migrations/**'], 'major', 'repo']])

    await item.getByRole('button', { name: `Disable the rule ${FK_RULE}` }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Rule disabled' })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: FK_RULE }).getByText(/disabled by octocat on/).first()).toBeVisible()
    let after = await claim(page, await push(page, 2))
    expect(after.rules).toEqual([])

    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })

  test('a rule of the org, written in the settings, goes with the jobs of orchard; a wrong form keeps its values', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await reset(page)

    await page.goto('/settings')
    await goToSettingsLink(page, 'Org rules')
    let section = page.locator('#org-rules')
    await expect(section.getByRole('heading', { name: /Org rules/ })).toBeVisible()

    await section.getByLabel('Title').fill('No console.log')
    await section.getByLabel('Paths').fill('/src/**')
    await section.getByRole('button', { name: 'Add the rule' }).click()
    await expect(page.getByText(/"\/src\/\*\*": a path starts without "\/"/)).toBeVisible()
    await expect(page.locator('#org-rules').getByLabel('Title')).toHaveValue('No console.log')
    await expectNoAxeViolations(page)

    section = page.locator('#org-rules')
    await section.getByLabel('What the rule asks for').fill('No console.log in the shipped code.')
    await section.getByLabel('Paths').fill('')
    await section.getByRole('button', { name: 'Add the rule' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Rule added.' })).toBeVisible()
    await expectNoAxeViolations(page)

    await page.goto('/repos')
    await openRepoConfig(page, 'orchard')
    await page.getByRole('link', { name: 'Rules', exact: true }).click()
    await expect(page.getByRole('link', { name: '1 active org rule' })).toBeVisible()

    let job = await claim(page, await push(page, 3))
    expect(job.rules?.map((r) => [r.title, r.paths, r.scope])).toEqual([['No console.log', [], 'org']])
    // The wrong form answers 422 on purpose; nothing else may fail.
    expect(errors.filter((e) => !e.includes('status of 422'))).toEqual([])
  })

  test('a member reads the rules, with no form', async ({ page }) => {
    await signIn(page, 'octocat')
    await reset(page)
    let sql = database()
    try {
      await sql`insert into rules (org_id, repo_id, title, body, paths)
        select repos.org_id, repos.id, ${FK_RULE}, 'Each FK has its index.', ${['**/migrations/**']} from repos where full_name = ${ORCHARD.full_name}`
    } finally {
      await sql.end()
    }
    await page.context().clearCookies()
    await signIn(page, 'camille')
    await page.goto('/repos')
    await openRepoConfig(page, 'orchard')
    await page.getByRole('link', { name: 'Rules', exact: true }).click()
    await page.getByText(FK_RULE).click()
    await expect(page.getByText('Each FK has its index.')).toBeVisible()
    await expect(page.getByRole('button', { name: /Add the rule|Disable|Save/ })).toHaveCount(0)
    await expectNoAxeViolations(page)
  })
})
