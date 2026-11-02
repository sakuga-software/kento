import { createHmac } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { E2E_WEBHOOK_SECRET, FAKE_ORG, FAKE_PULLS } from './fake-github.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The assignment rules of a repository (REV-21) in a browser, with the test of the ticket on orchard:
// rule 1 gives the pull requests of the agent balanced; rule 2 gives a pull request that touches a
// migration heavy, and mentions alex; a pull request that matches none gets the default level.

const ORCHARD = { id: 7001, full_name: 'sakuga-software/orchard', owner: { id: FAKE_ORG.accountId, login: FAKE_ORG.login } }

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** orchard enabled, with no job, no config and no assignment rule. */
async function reset(page: Page) {
  await page.goto('/repos')
  await page.getByRole('button', { name: 'Actualiser' }).click()
  await expect(page.getByText('Liste à jour.')).toBeVisible()
  let sql = database()
  try {
    await sql`delete from jobs where repo_id in (select id from repos where full_name = ${ORCHARD.full_name})`
    await sql`update repos set enabled = true, config = '{}', config_version = 0, default_level = 'lite' where full_name = ${ORCHARD.full_name}`
    await sql`update orgs set config = '{}', daily_cap_usd = null, monthly_cap_usd = null`
    await sql`delete from assignment_rules`
  } finally {
    await sql.end()
  }
}

let delivery = 0

/** A push on pull request `number` of orchard by `author`, signed as GitHub signs it; returns the level of its job. */
async function push(page: Page, number: number, author: { login: string; type: string; id: number }): Promise<string> {
  let head = FAKE_PULLS[`${ORCHARD.full_name}#${number}`] ?? (0xa000 + number).toString(16).padStart(40, '0')
  let body = JSON.stringify({
    action: 'synchronize',
    number,
    pull_request: {
      number,
      draft: false,
      user: author,
      labels: [],
      head: { sha: head, ref: 'feature', repo: { id: ORCHARD.id } },
      base: { sha: 'f'.repeat(40), ref: 'main', repo: { id: ORCHARD.id } },
    },
    repository: ORCHARD,
    sender: author,
    installation: { id: FAKE_ORG.installationId },
  })
  delivery++
  let response = await page.request.post('/webhooks/github', {
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': `e2e-assign-${Date.now()}-${delivery}`,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    data: body,
  })
  let answer = (await response.json()) as { outcome: string; jobId?: string }
  expect(answer.outcome).toBe('queued')
  let sql = database()
  try {
    let [job] = await sql<{ level: string }[]>`select level::text from jobs where id = ${answer.jobId!}`
    return job!.level
  } finally {
    await sql.end()
  }
}

test.describe('the assignment rules of a repository', () => {
  // The other specs push on orchard too: they must find no rule of this one.
  test.afterEach(async () => {
    let sql = database()
    try {
      await sql`delete from assignment_rules`
    } finally {
      await sql.end()
    }
  })

  test('an admin writes two rules on orchard; the agent gets balanced, a migration heavy and a mention, the rest the default', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'alex')
    await reset(page)

    await page.getByRole('link', { name: 'Config de orchard' }).click()
    await page.getByRole('link', { name: 'Assignation', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Assignation/ })).toBeVisible()
    await expect(page.getByText(/puis le niveau par défaut du repo, lite/)).toBeVisible()
    await expectNoAxeViolations(page)

    let form = page.locator('#assignment-new')
    await form.getByLabel('L’auteur de la PR est').fill('sakuga-agent[bot]')
    await form.getByLabel('Alors').selectOption('balanced')
    await form.getByRole('button', { name: 'Ajouter la règle' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Règle ajoutée en dernier.' })).toBeVisible()

    await page.locator('#assignment-new > summary').click()
    await form.getByLabel('La PR touche l’un de ces chemins').fill('**/migrations/**')
    await form.getByLabel('Alors').selectOption('heavy')
    await form.getByLabel('Mentionner dans la review (facultatif)').fill('alex')
    await form.getByRole('button', { name: 'Ajouter la règle' }).click()
    let list = page.locator('.assignment-list')
    await expect(list.getByText('Si la PR touche **/migrations/**')).toBeVisible()
    await expect(list.getByText(/alors heavy, et la review mentionne @alex\./)).toBeVisible()
    await expectNoAxeViolations(page)

    // 1. A pull request of the agent: balanced. 2. A person touches a migration: heavy. 3. Neither: lite.
    expect(await push(page, 42, { login: 'sakuga-agent[bot]', type: 'Bot', id: 900 })).toBe('balanced')
    expect(await push(page, 43, { login: 'camille', type: 'User', id: 2 })).toBe('heavy')
    expect(await push(page, 44, { login: 'camille', type: 'User', id: 2 })).toBe('lite')

    // The screen of the pull request says which rule set its level.
    await page.goto(`/repos/${await repoId()}/pulls/43`)
    await expect(page.getByText('Assignation : règle 2, la PR touche db/migrations/0007_sessions.sql, donc heavy à chaque push.')).toBeVisible()
    await expectNoAxeViolations(page)

    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })
})

async function repoId(): Promise<string> {
  let sql = database()
  try {
    let [row] = await sql<{ id: string }[]>`select id from repos where full_name = ${ORCHARD.full_name}`
    return row!.id
  } finally {
    await sql.end()
  }
}
