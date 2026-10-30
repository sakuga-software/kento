import { createHmac } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { E2E_WEBHOOK_SECRET, FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The end-to-end test of REV-14: the banner of a failed job and « Relancer », a push that shows in
// the queue without a reload, the cost of the day against the database, and a member who reads only.

const REPO = { id: 7099, full_name: 'sakuga-software/dash-e2e', owner: { id: FAKE_ORG.accountId, login: FAKE_ORG.login } }
const HEAD = 'c'.repeat(40)

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** The repository of this spec, enabled, with one failed job and one published review. */
async function seed(): Promise<{ failedJobId: string }> {
  let sql = database()
  try {
    let [org] = await sql<{ id: string }[]>`select id from orgs where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`delete from repos where github_repo_id = ${REPO.id}`
    let [repo] = await sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled) values (${org!.id}, ${REPO.id}, ${REPO.full_name}, true) returning id`
    let [runner] = await sql<{ id: string }[]>`
      insert into runners (name, token_hash, last_seen_at) values ('runners-host', ${`e2e-dash-${Date.now()}`}, now()) returning id`
    // An earlier review of the pull request, published, at a known cost.
    let [done] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, attempts, created_at, started_at, finished_at)
      values (${repo!.id}, 'balanced', 'done', 41, ${'d'.repeat(40)}, 'main', 1, now() - interval '20 minutes',
        now() - interval '20 minutes', now() - interval '18 minutes')
      returning id`
    await sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at, created_at)
      values (${done!.id}, ${repo!.id}, 41, ${'d'.repeat(40)}, 3, 'm', 0.125,
        ${JSON.stringify({ verdict: 'COMMENT', findings: [{}, {}], costSource: 'provider' })}::text::jsonb, now() - interval '17 minutes', now() - interval '18 minutes')`
    // The scenario of REV-6: the runner stopped twice during the job, and the sweep failed it.
    let [failed] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, attempts, failure_reason, runner_id, created_at, finished_at)
      values (${repo!.id}, 'lite', 'failed', 41, ${HEAD}, 'main', 2, 'lease expired 2 times', ${runner!.id},
        now() - interval '10 minutes', now() - interval '2 minutes')
      returning id`
    return { failedJobId: failed!.id }
  } finally {
    await sql.end()
  }
}

async function cleanUp() {
  let sql = database()
  try {
    await sql`delete from repos where github_repo_id = ${REPO.id}`
    await sql`delete from runners where name = 'runners-host' and org_id is null`
  } finally {
    await sql.end()
  }
}

/** A push on pull request 42 of the repository, signed as GitHub signs it. */
async function push(page: Page, head: string) {
  let body = JSON.stringify({
    action: 'synchronize',
    number: 42,
    pull_request: {
      number: 42,
      draft: false,
      user: { login: 'alex', type: 'User' },
      head: { sha: head, ref: 'feature', repo: { id: REPO.id } },
      base: { sha: 'f'.repeat(40), ref: 'main', repo: { id: REPO.id } },
    },
    repository: REPO,
    sender: { login: 'alex', type: 'User' },
    installation: { id: FAKE_ORG.installationId },
  })
  let response = await page.request.post('/webhooks/github', {
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': `e2e-dashboard-${Date.now()}`,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    data: body,
  })
  return (await response.json()) as { outcome: string; jobId?: string }
}

test.describe('the dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // The org exists once someone signed in.
    await signIn(page, 'alex')
  })
  test.afterEach(async () => {
    await cleanUp()
  })

  test('an admin sees the failure, retries it in balanced, and the banner goes when its review is published', async ({ page }) => {
    let errors = watchConsole(page)
    let { failedJobId } = await seed()
    await page.goto('/')

    let banner = page.getByRole('region', { name: /La review lite de sakuga-software\/dash-e2e#41 a échoué/ })
    await expect(banner).toBeVisible()
    await expect(banner.getByText('Raison : le runner a cessé de répondre pendant le job deux fois, en dernier runners-host.')).toBeVisible()
    await expect(banner.getByText(/La review précédente \(3\/5, publiée le .*\) reste publiée sur la PR\./)).toBeVisible()
    await expect(banner.getByRole('link', { name: 'Voir la PR' })).toHaveAttribute('href', /\/sakuga-software\/dash-e2e\/pull\/41$/)
    // The estimate of balanced: the mean of the balanced reviews of the repository.
    await expect(banner.getByRole('button', { name: /Relancer en balanced · ≈ 0,13\s\$/ })).toBeVisible()
    await expect(banner.getByRole('button', { name: /Relancer en heavy · coût inconnu/ })).toBeVisible()

    // The cost of the day is the sum of the costs of the day in the database.
    let sql = database()
    let total: string
    try {
      let [row] = await sql<{ total: string }[]>`
        select (select coalesce(sum(r.cost_usd), 0) from reviews r join repos on repos.id = r.repo_id join orgs on orgs.id = repos.org_id
            where orgs.github_installation_id = ${FAKE_ORG.installationId}
              and r.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
          + (select coalesce(sum(s.cost_usd), 0) from resolutions s join repos on repos.id = s.repo_id join orgs on orgs.id = repos.org_id
            where orgs.github_installation_id = ${FAKE_ORG.installationId}
              and s.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as total`
      total = row!.total
    } finally {
      await sql.end()
    }
    let expected = new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number(total) > 0 && Number(total) < 0.1 ? 3 : 2,
      maximumFractionDigits: Number(total) > 0 && Number(total) < 0.1 ? 3 : 2,
    }).format(Number(total))
    let cost = page.getByRole('region', { name: 'Coût' })
    await expect(cost.locator('.dash-cost').first().locator('.dash-cost-value')).toHaveText(expected)

    let recent = page.getByRole('region', { name: 'Dernières reviews' })
    await expect(recent.getByRole('link', { name: 'sakuga-software/dash-e2e#41' })).toBeVisible()
    await expect(recent.getByText('Commentaire', { exact: true })).toBeVisible()
    await expectNoAxeViolations(page)

    await banner.getByRole('button', { name: /Relancer en balanced/ }).click()
    await expect(page.getByText('Review relancée. Le job est en file.')).toBeVisible()
    await expect(page.getByText('Relance en balanced en file')).toBeVisible()
    await expect(page.getByRole('button', { name: /Relancer en/ })).toHaveCount(0)

    // The new job is a balanced review of the same head; a runner runs it and the service publishes it.
    let db = database()
    try {
      let jobs = await db<{ id: string; level: string; head_sha: string }[]>`
        select id, level, head_sha from jobs where state = 'queued' and repo_id = (select repo_id from jobs where id = ${failedJobId})`
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.level).toBe('balanced')
      expect(jobs[0]!.head_sha).toBe(HEAD)
      await db`update jobs set state = 'done', started_at = now() - interval '40 seconds', finished_at = now(), attempts = 1 where id = ${jobs[0]!.id}`
      await db`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at)
        select id, repo_id, pr_number, head_sha, 4, 'm', 0.11, ${JSON.stringify({ verdict: 'APPROVE', findings: [], costSource: 'provider' })}::text::jsonb, now()
        from jobs where id = ${jobs[0]!.id}`
    } finally {
      await db.end()
    }
    await page.goto('/')
    await expect(page.getByRole('region', { name: /a échoué/ })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Échecs récents' }).getByText('le runner a cessé de répondre pendant le job deux fois, en dernier runners-host')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('a push shows in the queue within 15 s, with no reload', async ({ page }) => {
    let errors = watchConsole(page)
    await seed()
    await page.goto('/')
    let queue = page.getByRole('region', { name: 'File de jobs' })
    await expect(queue.getByText('Aucun job en attente.')).toBeVisible()
    await expect(page.getByText(/Mis à jour il y a \d+ s/)).toBeVisible()

    let pushed = await push(page, 'e'.repeat(40))
    expect(pushed.outcome).toBe('queued')
    let started = Date.now()
    await expect(queue.getByRole('link', { name: 'sakuga-software/dash-e2e#42' })).toBeVisible({ timeout: 15_000 })
    expect(Date.now() - started).toBeLessThan(15_000)
    await expect(queue.getByText(/En file depuis/)).toBeVisible()
    expect(errors).toEqual([])
  })

  test('a member reads the dashboard and cannot retry', async ({ page, context }) => {
    await seed()
    await context.clearCookies()
    await signIn(page, 'camille')
    await page.goto('/')
    await expect(page.getByText('Lecture seule.')).toBeVisible()
    await expect(page.getByRole('region', { name: /a échoué/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Relancer en/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Gérer/ })).toHaveAttribute('href', '/runners')
    await expectNoAxeViolations(page)
  })
})
