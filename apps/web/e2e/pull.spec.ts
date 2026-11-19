import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { replyText } from '../app/findings/dismiss.ts'
import { PULL_NUMBER, PULL_REPO, seedPull } from './pull-seed.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The end-to-end test of REV-17 on orchard #142 (e2e/pull-seed.ts): four reviews, a finding moved
// with no new comment, a fix, a dismissal and a wontfix.

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

let repoId = ''
let repoExisted = false

test.beforeAll(async () => {
  let sql = database()
  try {
    repoExisted = (await sql`select 1 from repos where github_repo_id = ${PULL_REPO.githubRepoId}`).length > 0
  } finally {
    await sql.end()
  }
})

test.afterAll(async () => {
  let sql = database()
  try {
    // The other specs read orchard as the check of the Repos screen leaves it.
    if (repoExisted) {
      await sql`delete from jobs where repo_id = ${repoId} and pr_number = ${PULL_NUMBER}`
      await sql`delete from findings where repo_id = ${repoId} and pr_number = ${PULL_NUMBER}`
    } else {
      await sql`delete from repos where github_repo_id = ${PULL_REPO.githubRepoId}`
    }
  } finally {
    await sql.end()
  }
})

test.beforeEach(async ({ page }) => {
  await signIn(page, 'camille')
  let sql = database()
  try {
    repoId = (await seedPull(sql)).repoId
  } finally {
    await sql.end()
  }
})

test('the sheet shows a finding found again after its lines moved, with no new comment', async ({ page }, info) => {
  let errors = watchConsole(page)
  await page.goto(`/repos/${repoId}/pulls/${PULL_NUMBER}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sessions: expiry and rotation of the keys')
  await expect(page.getByText('orchard #142', { exact: true })).toBeVisible()
  await expect(page.getByText('@camille')).toBeVisible()
  await expect(page.getByText('feat/session-expiry → main')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', /\/sakuga-software\/orchard\/pull\/142$/)

  let tiles = page.getByRole('region', { name: 'At a glance' })
  await expect(tiles).toContainText('4/5')
  await expect(tiles).toContainText('1 open · 1 fixed · 1 dismissed · 1 wontfix')

  let sheet = page.getByRole('table')
  let row = (title: string) => sheet.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(title) }) })
  let moved = row('The session token')
  // REV-91: the last cell is the status of today.
  await expect(moved.getByRole('cell')).toHaveText(['posted l.42', 'moved l.47', 'found again', 'found again', 'open'])
  await expect(row('API key').getByRole('cell')).toHaveText(['posted l.88', 'fixed', 'fixed', 'fixed', 'fixed'])
  await expect(row('List with no').getByRole('cell')).toHaveText(['posted l.12', 'found again', 'dismissed', 'dismissed', 'dismissed'])
  // On a phone, the card leaves out the reviews from before the finding.
  let before = info.project.name === 'mobile' ? [] : ['not found yet']
  await expect(row('SQL query').getByRole('cell')).toHaveText([...before, 'posted l.30', 'absent', 'wontfix', 'wontfix'])

  if (info.project.name === 'mobile') {
    // A finding is a card: the label of each review sits over its cell, with no horizontal scroll.
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  }

  await page.getByRole('link', { name: /dismissed/ }).first().click()
  await expect(page).toHaveURL(/status=dismissed/)
  await expect(sheet.getByRole('rowheader')).toHaveCount(1)
  await expect(sheet.getByRole('rowheader')).toContainText('List with no stable key')

  await expectNoAxeViolations(page)
  expect(errors).toEqual([])
})

test('the dashboard leads to the screen of the pull request', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('region', { name: 'Latest reviews' }).getByRole('link', { name: 'orchard #142' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/repos/${repoId}/pulls/142$`))
  await expect(page.getByRole('heading', { name: 'Exposure sheet' })).toBeVisible()
})

test('the detail of a finding: source, model, scenario, its code at its line, history, thread', async ({ page }) => {
  let errors = watchConsole(page)
  await page.goto(`/repos/${repoId}/pulls/${PULL_NUMBER}`)
  await page.getByRole('link', { name: 'List with no stable key' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('List with no stable key')
  await expect(page.getByText('Model pass')).toBeVisible()
  await expect(page.getByText('claude-opus-4-1 (R3, heavy)')).toBeVisible()
  await expect(page.getByText('Scenario of C.')).toBeVisible()
  await expect(page.getByText('Reason: False positive')).toBeVisible()
  let code = page.getByRole('group', { name: 'Lines 8 to 16' })
  await expect(code.locator('.code-line-hit')).toContainText('12')
  let history = page.getByRole('region', { name: 'History' })
  await expect(history.getByRole('listitem')).toHaveCount(2)
  await expect(history.getByRole('listitem').nth(1)).toContainText('@camille · "False positive"')
  await expect(page.getByRole('link', { name: 'Open the thread' })).toHaveAttribute('href', /\/sakuga-software\/orchard\/pull\/142#discussion_r914203$/)
  await page.getByRole('link', { name: 'orchard #142' }).click()
  await expect(page.getByRole('heading', { name: 'Exposure sheet' })).toBeVisible()
  await page.goBack()
  await expectNoAxeViolations(page)
  expect(errors).toEqual([])
})

const GITHUB = `http://127.0.0.1:${process.env.E2E_GITHUB_PORT ?? 3499}`

test('a member dismisses a finding as "False positive": status, reply in the GitHub thread, history; then reopens it', async ({ page }) => {
  let errors = watchConsole(page)
  let before = ((await (await fetch(`${GITHUB}/_test/replies`)).json()) as unknown[]).length
  await page.goto(`/repos/${repoId}/pulls/${PULL_NUMBER}`)
  await page.getByRole('link', { name: 'The session token never expires' }).click()

  await page.getByText('Mark dismissed…').click()
  await page.getByRole('radio', { name: 'False positive' }).check()
  await page.getByRole('button', { name: 'Mark dismissed', exact: true }).click()

  await expect(page.getByRole('status').filter({ hasText: 'Finding marked dismissed.' })).toContainText('Kentō posted the reply in the GitHub thread.')
  await expect(page.locator('.finding-tags')).toContainText('dismissed')
  await expect(page.locator('.finding-tags')).toContainText('Reason: False positive')
  let history = page.getByRole('region', { name: 'History' }).getByRole('listitem')
  await expect(history.last()).toContainText('@camille · "False positive"')
  let replies = (await (await fetch(`${GITHUB}/_test/replies`)).json()) as { repo: string; pr: number; commentId: number; body: string }[]
  expect(replies.slice(before)).toEqual([
    {
      repo: 'sakuga-software/orchard',
      pr: 142,
      commentId: 914201,
      body: replyText('dismissed', 'False positive', 'camille'),
    },
  ])
  await expectNoAxeViolations(page)

  await page.getByRole('button', { name: 'Reopen' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Finding reopened.' })).toBeVisible()
  await expect(page.locator('.finding-tags')).toContainText('open')
  await expect(history.last()).toContainText('@camille')

  // "Mark wontfix" shares the form of the page with "Mark dismissed": its button posts to /wontfix.
  await page.getByText('Mark wontfix…').click()
  await page.getByRole('button', { name: 'Mark wontfix', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Finding marked wontfix.' })).toBeVisible()
  await expect(page.locator('.finding-tags')).toContainText('wontfix')
  await page.getByRole('button', { name: 'Reopen' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Finding reopened.' })).toBeVisible()
  expect(errors).toEqual([])
})

test('an admin re-runs the review in heavy: a column R5 waits, then shows the published review', async ({ page }) => {
  let errors = watchConsole(page)
  // beforeEach signed camille in: the admin signs in from a fresh session.
  await page.context().clearCookies()
  await signIn(page, 'octocat')
  await page.goto(`/repos/${repoId}/pulls/${PULL_NUMBER}`)
  // REV-91: "Run R5…" beside the title opens the three levels.
  await page.getByText('Run R5…').click()
  let rerun = page.getByRole('group', { name: 'Run R5' })
  await expect(rerun.getByRole('button', { name: /Run at heavy · ≈ \$0\.41/ })).toBeVisible()
  await rerun.getByRole('button', { name: /Run at heavy/ }).click()

  await expect(page.getByText('Review started again. It is queued. A new push cancels it.')).toBeVisible()
  await expect(page.getByText(/R5 queued…/)).toBeVisible()
  await expect(page.getByText('Run R5…')).toHaveCount(0)
  let sheet = page.getByRole('table')
  await expect(sheet.getByRole('columnheader', { name: /R5/ })).toContainText('Queued…')
  await expectNoAxeViolations(page)

  // The runner takes the job and publishes its review.
  let sql = database()
  let jobId = ''
  try {
    let [job] = await sql<{ id: string; level: string; head_sha: string }[]>`
      select id, level, head_sha from jobs where repo_id = ${repoId} and pr_number = ${PULL_NUMBER} and state = 'queued'`
    expect(job?.level).toBe('heavy')
    expect(job?.head_sha).toBe('d'.repeat(40))
    jobId = job!.id
    await sql`update jobs set state = 'done', started_at = now(), finished_at = now() where id = ${jobId}`
    await sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at)
      values (${jobId}, ${repoId}, ${PULL_NUMBER}, ${'d'.repeat(40)}, 5, 'claude-opus-4-1', 0.39,
        ${JSON.stringify({ findings: [] })}::text::jsonb, now())`
    await page.reload()
    await expect(sheet.getByRole('columnheader', { name: /R5/ })).toContainText('5/5')
    await expect(page.getByText(/R5 queued…/)).toHaveCount(0)
  } finally {
    if (jobId) await sql`delete from jobs where id = ${jobId}`
    await sql.end()
  }
  expect(errors).toEqual([])
})
