// REV-18. The Findings screen of an org with 300 repositories and 100 000 findings, against Postgres:
// one page of 50 rows by keyset, the filters in SQL, the counts of the tabs in one more query.
// Another org holds as many findings: they must cost the screen nothing.
import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { cookieOf, fakeAuth, ALEX, ORG } from '../../app/auth/test-helpers.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createFindingsScreenStore } from '../../app/findings/screen.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase } from './helpers.ts'

const COOKIE = '__Host-kento_session'
/** The budget of the server, and of the HTML of one page of 50 rows. */
const MAX_MS = 250
const MAX_BYTES = 110_000
const FINDINGS = 100_000

describe(`the Findings screen with 300 repositories and ${FINDINGS.toLocaleString('en')} findings`, () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let router: ReturnType<typeof createAppRouter>
  let cookie: string
  let repoId: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    sql = database.sql
    let [org] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (11, 900, 'sakuga-software') returning id`
    let [other] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (12, 901, 'orchard') returning id`
    for (let [orgId, offset, owner] of [[org!.id, 0, 'sakuga-software'], [other!.id, 1000, 'orchard']] as const) {
      await sql`
        insert into repos (org_id, github_repo_id, full_name, enabled)
        select ${orgId}, ${offset} + g, ${owner} || '/service-' || lpad(g::text, 3, '0'), true
        from generate_series(1, 300) g`
      await sql`
        insert into rules (org_id, title, body) select ${orgId}, 'Règle ' || g, 'Texte.' from generate_series(1, 20) g`
      // One finding every 26 s over 30 days; one in 3 open, then fixed, dismissed, wontfix and stale.
      await sql`
        with r as (select id, row_number() over (order by full_name) as n from repos where org_id = ${orgId}),
             c as (select count(*) as k from r),
             ru as (select id, row_number() over (order by title) as n from rules where org_id = ${orgId})
        insert into findings (repo_id, pr_number, fingerprint, key, rule_id, path, line, title, severity, category, confidence,
          status, status_reason, first_seen_sha, last_seen_sha, created_at, updated_at)
        select r.id, 1 + g % 900, md5('f' || g), md5('k' || g), (select id from ru where ru.n = 1 + g % 20 and g % 7 = 0),
          'apps/web/app/module_' || (g % 400) || '/file_' || (g % 37) || '.ts', 1 + g % 500,
          'Le constat numéro ' || g || ' sur une valeur nulle non gérée', (array['critical', 'major', 'minor'])[1 + g % 3],
          (array['bug', 'security', 'data', 'contract', 'test'])[1 + g % 5], 50 + g % 50,
          (array['open', 'open', 'open', 'fixed', 'fixed', 'dismissed', 'wontfix', 'stale'])[1 + g % 8]::finding_status,
          case when g % 8 in (5, 6) then (array['Hors sujet', 'Faux positif', 'Déjà connu'])[1 + g % 3] end,
          md5('s' || g), md5('s' || (g - g % 4)), now() - g * interval '26 seconds', now() - g * interval '20 seconds'
        from generate_series(1, ${FINDINGS}) g, c join r on true where r.n = 1 + g % c.k`
    }
    await sql`analyze`
    let [repo] = await sql<{ id: string }[]>`select id from repos where full_name = 'sakuga-software/service-042'`
    repoId = repo!.id

    let auth = fakeAuth({ orgs: [{ ...ORG, id: org!.id }] })
    auth.setRole({ ...ORG, id: org!.id }, ALEX, 'admin')
    router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '0.1.0',
      commit: null,
      webhook: disabledWebhook,
      auth: auth.deps,
      findings: { store: createFindingsScreenStore(sql), githubUrl: 'https://github.com' },
    })
    auth.as(ALEX)
    let start = await router.fetch(new Request('http://localhost/login/github'))
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await router.fetch(
      new Request(`http://localhost/auth/github/callback?code=good&state=${state}`, { headers: { Cookie: cookieOf(start, COOKIE)! } }),
    )
    cookie = cookieOf(callback, COOKIE)!
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  async function load(path: string) {
    let started = performance.now()
    let response = await router.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }))
    let html = await response.text()
    return { status: response.status, html, bytes: Buffer.byteLength(html), ms: performance.now() - started }
  }

  it(`answers /findings in under ${MAX_MS} ms with under ${MAX_BYTES / 1000} KB of HTML, page after page and filter after filter`, async () => {
    let first = await load('/findings')
    assert.equal(first.status, 200)
    assert.equal((first.html.match(/<tr id="finding-/g) ?? []).length, 50)
    assert.match(first.html, /1–50 sur 37\s500 findings/)

    let next = /href="\/findings\?after=([\w-]+)"/.exec(first.html)?.[1]
    assert.ok(next, 'a link to the next page')
    let deep = await load(`/findings?after=${next}`)
    let previous = /href="\/findings\?before=([\w-]+)"/.exec(deep.html)?.[1]
    assert.ok(previous, 'a link to the previous page')

    let report: string[] = []
    for (let path of [
      '/findings',
      `/findings?after=${next}`,
      `/findings?before=${previous}`,
      '/findings?status=closed',
      '/findings?status=dismissed&priority=critical',
      `/findings?repo=${repoId}`,
      `/findings?status=all&repo=${repoId}&q=file_3`,
      '/findings?q=module_16%2F',
      '/findings?status=all&q=aucun-titre-ne-contient-ceci',
    ]) {
      // The best of 5 loads: the budget is for the work of the screen, not for a busy machine.
      let runs = []
      for (let n = 0; n < 5; n++) runs.push(await load(path))
      let best = Math.min(...runs.map((run) => run.ms))
      report.push(`${path}: ${best.toFixed(1)} ms, ${(runs[0]!.bytes / 1000).toFixed(1)} KB`)
      assert.equal(runs[0]!.status, 200, path)
      assert.ok(best < MAX_MS, `${path}: ${best.toFixed(1)} ms`)
      assert.ok(runs[0]!.bytes < MAX_BYTES, `${path}: ${runs[0]!.bytes} bytes`)
    }
    if (process.env.KENTO_VOLUME_REPORT) console.log(report.join('\n'))
  })
})
