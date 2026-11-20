import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createRulesStore, MAX_RULES, type RulesStore } from '../../app/rules/store.ts'
import { createTestDatabase } from './helpers.ts'

const VALUES = { title: 'FK indexes', body: 'Each FK has its index.', paths: ['**/migrations/**'], severityFloor: 'major' as const }

describe('the store of the rules (REV-19)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let store: RulesStore
  let orgId: string
  let otherOrgId: string
  let repoId: string
  let otherRepoId: string
  let userId: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    store = createRulesStore(database.sql)
    let [org] = await database.sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 77, 2001, 'sakuga-software' from org returning org_id as id`
    let [other] = await database.sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('orchard', lower('orchard')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 78, 2002, 'orchard' from org returning org_id as id`
    orgId = org!.id
    otherOrgId = other!.id
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name) values (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 3001, 'sakuga-software/orchard') returning id`
    let [otherRepo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name) values (${otherOrgId}, (select id from installations where org_id = ${otherOrgId} order by created_at limit 1), 3002, 'orchard/app') returning id`
    repoId = repo!.id
    otherRepoId = otherRepo!.id
    let [user] = await database.sql<{ id: string }[]>`
      insert into users (github_id, login) values (1, 'octocat') returning id`
    userId = user!.id
  })

  beforeEach(async () => {
    await database.sql`delete from rules`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('adds, lists, edits, disables with its author, enables and removes a rule of a repository', async () => {
    let added = await store.create(orgId, repoId, userId, VALUES)
    assert.equal(added.kind, 'saved')
    if (added.kind !== 'saved') return
    let [rule] = await store.list(orgId, repoId)
    assert.deepEqual(
      { title: rule!.title, paths: rule!.paths, floor: rule!.severityFloor, active: rule!.active, version: rule!.version, by: rule!.updatedBy },
      { title: 'FK indexes', paths: ['**/migrations/**'], floor: 'major', active: true, version: 1, by: 'octocat' },
    )
    assert.deepEqual(await store.list(orgId, null), [], 'a rule of a repository is not a rule of the org')

    let saved = await store.update(orgId, added.id, userId, 1, { ...VALUES, title: 'Indexed FKs', severityFloor: null })
    assert.deepEqual(saved, { kind: 'saved', id: added.id, title: 'Indexed FKs', version: 2, repoId })

    let stale = await store.update(orgId, added.id, userId, 1, VALUES)
    assert.equal(stale.kind, 'conflict')

    await store.setActive(orgId, added.id, userId, 2, false)
    let [off] = await store.list(orgId, repoId)
    assert.equal(off!.active, false)
    assert.equal(off!.disabledBy, 'octocat')
    assert.ok(off!.disabledAt instanceof Date)

    await store.setActive(orgId, added.id, userId, 3, true)
    let [on] = await store.list(orgId, repoId)
    assert.deepEqual({ active: on!.active, by: on!.disabledBy, at: on!.disabledAt }, { active: true, by: null, at: null })

    assert.deepEqual(await store.remove(orgId, added.id), { title: 'Indexed FKs', repoId })
    assert.deepEqual(await store.list(orgId, repoId), [])
  })

  it('keeps each org to its own rules and repositories', async () => {
    assert.deepEqual(await store.create(orgId, otherRepoId, userId, VALUES), { kind: 'not_found' })
    let added = await store.create(orgId, null, userId, VALUES)
    if (added.kind !== 'saved') return assert.fail(added.kind)
    assert.equal(await store.activeOrgRules(orgId), 1)
    assert.equal(await store.activeOrgRules(otherOrgId), 0)
    assert.deepEqual(await store.update(otherOrgId, added.id, userId, 1, VALUES), { kind: 'not_found' })
    assert.deepEqual(await store.setActive(otherOrgId, added.id, userId, 1, false), { kind: 'not_found' })
    assert.equal(await store.remove(otherOrgId, added.id), null)
    assert.deepEqual(await store.list(otherOrgId, null), [])
  })

  // postgres.js 4 writes a JavaScript array as an array literal for the type that the server names.
  // Each element is quoted, so a comma, a brace, a quote or a backslash stays in its element.
  it('keeps each pattern as it was written, with commas, braces, quotes and backslashes', async () => {
    let paths = ['src/{a,b}/**', 'docs/*.{md,mdx}', 'say "hi".ts', "it's.ts", 'back\\slash', 'a,b', '{}', 'NULL', 'é/日本/*.ts']
    let added = await store.create(orgId, repoId, userId, { ...VALUES, paths })
    if (added.kind !== 'saved') return assert.fail(added.kind)
    assert.deepEqual((await store.list(orgId, repoId))[0]!.paths, paths)
    let [stored] = await database.sql<{ n: number; second: string }[]>`select cardinality(paths) as n, paths[2] as second from rules where id = ${added.id}`
    assert.deepEqual(stored, { n: paths.length, second: 'docs/*.{md,mdx}' })

    let next = ['{x,y}/"z"', '\\']
    assert.equal((await store.update(orgId, added.id, userId, 1, { ...VALUES, paths: next })).kind, 'saved')
    assert.deepEqual((await store.list(orgId, repoId))[0]!.paths, next)
    assert.equal((await store.update(orgId, added.id, userId, 2, { ...VALUES, paths: [] })).kind, 'saved')
    assert.deepEqual((await store.list(orgId, repoId))[0]!.paths, [])
  })

  it(`holds ${MAX_RULES} rules at most for a repository, even with additions at the same time`, async () => {
    await database.sql`
      insert into rules (org_id, repo_id, title, body)
      select ${orgId}, ${repoId}, 'R' || n, 'Text' from generate_series(1, ${MAX_RULES - 1}) n`
    let outcomes = await Promise.all([store.create(orgId, repoId, userId, VALUES), store.create(orgId, repoId, userId, VALUES)])
    assert.deepEqual(outcomes.map((o) => o.kind).sort(), ['full', 'saved'])
    assert.equal((await store.list(orgId, repoId)).length, MAX_RULES)
  })
})
