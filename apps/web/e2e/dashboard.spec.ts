import { createHmac } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { E2E_WEBHOOK_SECRET, FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, hydrated, signIn, watchConsole } from './helpers.ts'

// The end-to-end test of REV-14: the banner of a failed job and "Run again", a push that shows in
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
    let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`delete from repos where github_repo_id = ${REPO.id}`
    let [repo] = await sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled) values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), ${REPO.id}, ${REPO.full_name}, true) returning id`
    let [runner] = await sql<{ id: string }[]>`
      insert into runners (name, token_hash, last_seen_at) values ('shared-01', ${`e2e-dash-${Date.now()}`}, now()) returning id`
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
    await sql`delete from runners where name = 'shared-01' and org_id is null`
  } finally {
    await sql.end()
  }
}

/** A push on pull request 42 of the repository (or another event of a pull request), signed as GitHub signs it. */
async function push(page: Page, head: string, action = 'synchronize', number = 42) {
  let body = JSON.stringify({
    action,
    number,
    pull_request: {
      number,
      draft: false,
      user: { login: 'octocat', type: 'User' },
      head: { sha: head, ref: 'feature', repo: { id: REPO.id } },
      base: { sha: 'f'.repeat(40), ref: 'main', repo: { id: REPO.id } },
    },
    repository: REPO,
    sender: { login: 'octocat', type: 'User' },
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
    await signIn(page, 'octocat')
  })
  test.afterEach(async () => {
    await cleanUp()
  })

  test('an admin sees the failure, retries it in balanced, and the banner goes when its review is published', async ({ page }) => {
    let errors = watchConsole(page)
    let { failedJobId } = await seed()
    await page.goto('/')

    let banner = page.getByRole('region', { name: /The lite review of sakuga-software\/dash-e2e#41 failed/ })
    await expect(banner).toBeVisible()
    await expect(banner.getByText('Reason: the runner stopped answering during the job twice, last shared-01. Check on the Runners screen that a runner is online, then retry.')).toBeVisible()
    await expect(banner.getByText(/The previous review \(3\/5, published on .*\) stays on the pull request\./)).toBeVisible()
    await expect(banner.getByRole('link', { name: 'Open the PR' })).toHaveAttribute('href', /\/sakuga-software\/dash-e2e\/pull\/41$/)
    // The estimate of balanced: the mean of the balanced reviews of the repository.
    await expect(banner.getByRole('button', { name: /Run again at balanced · ≈ \$0\.13/ })).toBeVisible()
    await expect(banner.getByRole('button', { name: /Run again at heavy · unknown cost/ })).toBeVisible()

    // The cost of the day is the sum of the costs of the day in the database.
    let sql = database()
    let total: string
    try {
      let [row] = await sql<{ total: string }[]>`
        select (select coalesce(sum(r.cost_usd), 0) from reviews r join repos on repos.id = r.repo_id join installations on installations.id = repos.installation_id
            where installations.github_installation_id = ${FAKE_ORG.installationId}
              and r.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
          + (select coalesce(sum(s.cost_usd), 0) from resolutions s join repos on repos.id = s.repo_id join installations on installations.id = repos.installation_id
            where installations.github_installation_id = ${FAKE_ORG.installationId}
              and s.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as total`
      total = row!.total
    } finally {
      await sql.end()
    }
    let expected = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number(total) > 0 && Number(total) < 0.1 ? 3 : 2,
      maximumFractionDigits: Number(total) > 0 && Number(total) < 0.1 ? 3 : 2,
    }).format(Number(total))
    let cost = page.getByRole('region', { name: 'Cost' })
    await expect(cost.locator('.dash-cost').first().locator('.dash-cost-value')).toHaveText(expected)

    let recent = page.getByRole('region', { name: 'Latest reviews' })
    await expect(recent.getByRole('link', { name: 'dash-e2e #41' })).toBeVisible()
    await expect(recent.getByText('Comment', { exact: true })).toBeVisible()
    // KNT-187: the score of each review drawn with its five marks, its number beside them.
    let score = recent.locator('.dash-reviews tbody tr').first().locator('.score')
    await expect(score.locator('.score-value')).toHaveText(/^[1-5]\/5$/)
    await expect(score.locator('.score-marks > span')).toHaveCount(5)
    await expectNoAxeViolations(page)

    await banner.getByRole('button', { name: /Run again at balanced/ }).click()
    await expect(page.getByText('Review started again. The job is queued.')).toBeVisible()
    await expect(page.getByText('Retry at balanced queued')).toBeVisible()
    await expect(page.getByRole('button', { name: /Run again at/ })).toHaveCount(0)

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
    await expect(page.getByRole('region', { name: /review of .* failed/ })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Recent failures' }).getByText('the runner stopped answering during the job twice, last shared-01')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('an admin hides a failure with "Hide", and the merge of a pull request hides its failure (REV-59)', async ({ page }) => {
    let errors = watchConsole(page)
    let { failedJobId } = await seed()
    await page.goto('/')
    let failures = page.getByRole('region', { name: 'Recent failures' })
    let banner = page.getByRole('region', { name: /The lite review of sakuga-software\/dash-e2e#41 failed/ })
    await expect(banner).toBeVisible()
    await expect(failures.getByRole('button', { name: 'Hide the failure of sakuga-software/dash-e2e#41' })).toBeVisible()
    // REV-91: the head of a failure (and of a step of "Getting started", the same class) is one flex line.
    expect(await failures.locator('.dash-review-head').first().evaluate((el) => getComputedStyle(el).display)).toBe('flex')

    await banner.getByRole('button', { name: 'Hide the failure of sakuga-software/dash-e2e#41' }).click()
    await expect(page.getByText('Failure hidden. It still counts in "Failures · 7 d".')).toBeVisible()
    await expect(page.getByRole('region', { name: /review of .* failed/ })).toHaveCount(0)
    await expect(failures.getByText('No failure to handle over 7 days.')).toBeVisible()
    await expectNoAxeViolations(page)

    // Another failure, on pull request 43; GitHub then says that the pull request is merged.
    let sql = database()
    try {
      let [hidden] = await sql<{ by: string }[]>`select failure_dismissed_by as by from jobs where id = ${failedJobId}`
      expect(hidden!.by).toBe('octocat')
      await sql`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, attempts, failure_reason, created_at, finished_at)
        select repo_id, 'lite', 'failed', 43, ${'e'.repeat(40)}, 'main', 1, 'clone failed', now() - interval '5 minutes', now() - interval '1 minute'
        from jobs where id = ${failedJobId}`
    } finally {
      await sql.end()
    }
    await page.goto('/')
    await expect(page.getByRole('region', { name: /The lite review of sakuga-software\/dash-e2e#43 failed/ })).toBeVisible()
    expect((await push(page, 'e'.repeat(40), 'closed', 43)).outcome).toBe('cancelled')
    await page.goto('/')
    await expect(page.getByRole('region', { name: /review of .* failed/ })).toHaveCount(0)
    await expect(failures.getByText('No failure to handle over 7 days.')).toBeVisible()
    expect(errors).toEqual([])
  })

  // REV-91: the name of a job in "Queue and runners" wraps; nothing goes past the column.
  test('a queued job of a repository named with 80 characters stays in its column', async ({ page }) => {
    let name = `sakuga-software/${'very-long-repository-name-'.repeat(3)}xx`.slice(0, 96)
    let sql = database()
    try {
      let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
      await sql`delete from repos where github_repo_id = 7199`
      let [repo] = await sql<{ id: string }[]>`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled) values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7199, ${name}, true) returning id`
      await sql`insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref) values (${repo!.id}, 'lite', 'queued', 12, ${'e'.repeat(40)}, 'main')`
      await page.goto('/')
      let queue = page.locator('.dash-queue')
      await expect(queue.getByRole('link', { name: `${name}#12` })).toBeVisible()
      let overflow = await queue.evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    } finally {
      await sql`delete from repos where github_repo_id = 7199`
      await sql.end()
    }
  })

  test('a push shows in the queue within 15 s, with no reload', async ({ page }) => {
    let errors = watchConsole(page)
    await seed()
    await page.goto('/')
    let queue = page.getByRole('region', { name: 'Queue and runners' })
    await expect(queue.getByText('No job waiting.')).toBeVisible()
    await expect(page.getByText(/Updated \d+ s ago/)).toBeVisible()

    let pushed = await push(page, 'e'.repeat(40))
    expect(pushed.outcome).toBe('queued')
    let started = Date.now()
    await expect(queue.getByRole('link', { name: 'sakuga-software/dash-e2e#42' })).toBeVisible({ timeout: 15_000 })
    expect(Date.now() - started).toBeLessThan(15_000)
    await expect(queue.getByText(/Queued for/)).toBeVisible()
    expect(errors).toEqual([])
  })

  test('the card of the queue is live: a push and a claim show within 6 s, and the ready count follows (KNT-189)', async ({ page }) => {
    let errors = watchConsole(page)
    await seed()
    await page.goto('/')
    await hydrated(page)
    let queue = page.getByRole('region', { name: 'Queue and runners' })
    await expect(queue.getByRole('status')).toHaveText('Live')
    await expect(queue.locator('.runner-ready')).toHaveText(/^\d+ ready \/ \d+ online$/)
    // The row of shared-01, the runner of this spec: other specs may leave runners in the database,
    // online, late or busy, so the counts of all the runners prove nothing here (Fable P3-4).
    let shared = queue.locator('li.dash-job').filter({ has: page.locator('.dash-job-head .mono', { hasText: /^shared-01$/ }) })
    await expect(shared).toContainText('No job in progress')

    // Faster than the read of the whole page every 10 s: the stream sends the card within a tick of 3 s.
    let pushed = await push(page, 'e'.repeat(40))
    expect(pushed.outcome).toBe('queued')
    await expect(queue.getByRole('link', { name: 'sakuga-software/dash-e2e#42' })).toBeVisible({ timeout: 6_000 })

    // shared-01 claims the job: it is no longer ready.
    let sql = database()
    try {
      await sql`
        update jobs set state = 'running', started_at = now(), lease_expires_at = now() + interval '2 minutes',
          runner_id = (select id from runners where name = 'shared-01' and org_id is null)
        where id = ${pushed.jobId!}`
      await expect(shared).toContainText('1 job in progress', { timeout: 6_000 })
      await expect(queue.getByText(/^On shared-01 for/)).toBeVisible()

      // dashboard.js reads the whole page again (here at once, on visibilitychange): the live section stays, and so does its stream.
      let marker = await queue.evaluate((el) => ((el as HTMLElement).dataset.marker = 'kept'))
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await expect(page.getByText(/Updated [0-2] s ago/)).toBeVisible()
      expect(await queue.evaluate((el) => (el as HTMLElement).dataset.marker)).toBe(marker)
      await sql`update jobs set state = 'done', finished_at = now(), lease_expires_at = null where id = ${pushed.jobId!}`
      await expect(shared).toContainText('No job in progress', { timeout: 6_000 })
      await expect(queue.getByRole('status')).toHaveText('Live')
    } finally {
      await sql.end()
    }
    expect(errors).toEqual([])
  })

  test('the live card says "Retrying…" while its stream fails, then "Live" again (KNT-189)', async ({ page }) => {
    await seed()
    await page.route('**/dashboard/live', (route) => route.abort())
    await page.goto('/')
    await hydrated(page)
    let queue = page.getByRole('region', { name: 'Queue and runners' })
    await expect(queue.getByRole('status')).toHaveText('Retrying…')
    await page.unroute('**/dashboard/live')
    // The waits grow from 1 s: the third try at the latest comes within 8 s.
    await expect(queue.getByRole('status')).toHaveText('Live', { timeout: 10_000 })
  })

  test('the live card waits out a server that restarts (503 and Retry-After), then is "Live" again (Fable P2-1)', async ({ page }) => {
    await seed()
    /** The time of each request of the stream, on the clock of the test. */
    let tries: number[] = []
    // KNT-200: the try after the 503 waits here until the test saw "Retrying…". Without this hold,
    // the card is "Retrying…" for 1 s only, and the page load and hydration can take longer.
    let release!: () => void
    let released = new Promise<void>((resolve) => (release = resolve))
    await page.route('**/dashboard/live', async (route) => {
      tries.push(Date.now())
      if (tries.length === 1) return route.fulfill({ status: 503, headers: { 'Retry-After': '1', 'Content-Type': 'text/plain' }, body: 'Service Unavailable' })
      await released
      return route.continue()
    })
    try {
      await page.goto('/')
      await hydrated(page)
      let queue = page.getByRole('region', { name: 'Queue and runners' })
      await expect(queue.getByRole('status')).toHaveText('Retrying…')
      release()
      // A 503 is a wait, never the end: the next try comes after the second that it asked for.
      await expect(queue.getByRole('status')).toHaveText('Live', { timeout: 6_000 })
      expect(tries.length).toBeGreaterThanOrEqual(2)
      // The second try came after the second of Retry-After. The 503 left after tries[0], so the
      // real wait of the card is longer than this difference.
      expect(tries[1]! - tries[0]!).toBeGreaterThanOrEqual(1_000)
    } finally {
      release()
    }
  })

  test('a changed ready count gets a short wash, and none with reduced motion (KNT-189)', async ({ page }) => {
    await page.goto('/')
    let animation = () =>
      page.evaluate(() => {
        let span = document.createElement('span')
        span.className = 'runner-ready is-changed'
        document.body.append(span)
        let name = getComputedStyle(span).animationName
        span.remove()
        return name
      })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await animation()).toBe('ready-changed')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await animation()).toBe('none')
  })

  test('the "Updated" line keeps its place beside the title while its text changes (KNT-141)', async ({ page }) => {
    // 332–356 px is where the line used to wrap and unwrap as its text grew and shrank.
    for (let width of [336, 350, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await expect(page.getByText(/Updated \d+ s ago/)).toBeVisible()
      let tops = await page.evaluate(() => {
        let stamp = document.querySelector<HTMLElement>('[data-updated]')!
        let live = document.getElementById('dashboard-live')!
        let texts = ['Updated at 23:59:59', 'Updated 0 s ago', 'Updated 10 s ago', 'Updated 59 s ago', 'Updated 1 min ago', 'Updated 59 min ago', 'Updated 23 h ago']
        // In one task: dashboard.js cannot write its own text between two measures.
        return texts.map((text) => {
          stamp.textContent = text
          return Math.round(live.getBoundingClientRect().top)
        })
      })
      expect(new Set(tops).size, `${width} px: ${tops.join(', ')}`).toBe(1)
    }
  })

  test('a member reads the dashboard and cannot retry or hide a failure', async ({ page, context }) => {
    await seed()
    await context.clearCookies()
    await signIn(page, 'camille')
    await page.goto('/')
    await expect(page.getByText('Read only', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: /review of .* failed/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Run again at/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Hide/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /manage the runners/ })).toHaveAttribute('href', '/runners')
    await expectNoAxeViolations(page)
  })
})

test.describe('the dashboard without JavaScript (KNT-189)', () => {
  test.use({ javaScriptEnabled: false })
  test.afterEach(async () => {
    await cleanUp()
  })

  test('the card of the queue shows the ready count, and no live state', async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
    await page.goto('/')
    let queue = page.getByRole('region', { name: 'Queue and runners' })
    // shared-01 is online and idle, so one runner at least is ready (other specs may leave more).
    await expect(queue.locator('.runner-ready')).toHaveText(/^[1-9]\d* ready \/ [1-9]\d* online$/)
    await expect(queue.getByText('shared-01')).toBeVisible()
    await expect(queue.locator('.live-state')).toBeHidden()
  })
})
