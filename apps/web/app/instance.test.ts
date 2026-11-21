// REV-127. The names of an instance (KENTO_COMMAND_NAMES, KENTO_CHECK_NAME, KENTO_RUNNER_IMAGE,
// KENTO_DEFAULT_TRUSTED_BOTS) reach the parser of the commands, the texts that the bot posts and the
// screens. The tests of each module keep the defaults; these ones change the names.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { withInstance } from '../test/instance.ts'
import { publishRichReview } from '../test/rich-review.ts'
import { fakeAuth } from './auth/test-helpers.ts'
import { DOCS_PATH, hintText, namesReject } from './commands/hint.ts'
import { loadConfig } from './config.ts'
import { feedbackEmptyText } from './feedback/handler.ts'
import { requestText } from './feedback/request.ts'
import { parseCommentCommand, rejectProblemText, usageText } from './github/comment-command.ts'
import { commandFor, type EventPolicy } from './github/events.ts'
import { issueCommentPayload, spyStore, webhookDeps } from './github/test-helpers.ts'
import { DEFAULT_INSTANCE, instance } from './instance.ts'
import { readTrustedBots } from './org-settings/model.ts'
import { failureComment } from './publish/failure.ts'
import { checkName } from './publish/publish.ts'
import { createAppRouter } from './router.ts'
import { dockerCommand } from './ui/runners.tsx'

const ACME = { commandNames: ['acme-review', 'acme'] as [string, ...string[]] }

describe('the names of the instance', () => {
  it('are the names of the first instance by default', () => {
    assert.equal(instance(), DEFAULT_INSTANCE)
    assert.equal(checkName(), 'Sakuga Review')
    assert.deepEqual(parseCommentCommand('@kento-review heavy'), { verb: 'review', level: 'heavy', force: false })
    assert.deepEqual(parseCommentCommand('@sakuga-review review balanced'), { verb: 'review', level: 'balanced', force: false })
    assert.deepEqual(readTrustedBots(null), ['sakuga-agent[bot]'])
    assert.ok(dockerCommand({ kentoUrl: 'https://review.test', token: 't', name: 'n', labels: [], trusted: true, version: '1.2.3' }).endsWith('ghcr.io/sakuga-software/kento-runner:1.2.3'))
  })

  it('a test that changes them puts the defaults back, even when it fails', async () => {
    await assert.rejects(() => withInstance(ACME, () => Promise.reject(new Error('boom'))), /boom/)
    assert.equal(instance(), DEFAULT_INSTANCE)
  })
})

describe('KENTO_COMMAND_NAMES', () => {
  it('starts a command with each name, in any case, and with no other name', () =>
    withInstance(ACME, () => {
      assert.deepEqual(parseCommentCommand('@acme-review heavy force'), { verb: 'review', level: 'heavy', force: true })
      assert.deepEqual(parseCommentCommand('@ACME resolve balanced'), { verb: 'resolve', level: 'balanced', force: false })
      assert.deepEqual(parseCommentCommand('> @acme heavy\n\n@Acme-Review reject #3cf454 a cause'), { verb: 'reject', id: '3cf454', reason: 'a cause' })
      assert.deepEqual(parseCommentCommand('@acme-review dance'), { verb: 'unknown', text: '@acme-review dance' })
      // The defaults are not read any more.
      assert.equal(parseCommentCommand('@kento-review heavy'), null)
      assert.equal(parseCommentCommand('@sakuga-review heavy'), null)
      // Another account, and the account of an App.
      assert.equal(parseCommentCommand('@acme-reviewer heavy'), null)
      assert.equal(parseCommentCommand('@acme-review[bot] thanks'), null)
      assert.equal(parseCommentCommand('@Acme[bot] thanks'), null)
    }))

  it('the bot writes the first name in its answers, and lists the aliases', () =>
    withInstance(ACME, () => {
      let usage = usageText()
      assert.ok(usage.startsWith('Kentō commands, in a comment of the PR (`@acme` works too):\n'), usage)
      assert.ok(usage.includes('- `@acme-review reject <cause>`, as a reply'))
      assert.ok(!/kento-review|sakuga-review/.test(usage), usage)
      for (let problem of ['reason_missing', 'id_missing'] as const) assert.match(rejectProblemText(problem), /`@acme-review reject /)
      assert.match(hintText(null), /`@acme-review reject <cause>`/)
      assert.ok(namesReject('Refuted.\n@acme reject the schema validates it'))
      assert.ok(!namesReject('@kento-review reject the schema validates it'))
      assert.match(failureComment({ id: 'j', kind: 'resolve', level: 'lite', headSha: 'a'.repeat(40), failureReason: null, commenter: null, configUrl: null }), /`@acme-review resolve lite`/)
      assert.match(feedbackEmptyText(), /`@acme-review feedback <your opinion>`/)
      assert.match(requestText('octocat', 3), /`@acme-review feedback <your opinion>`/)
    }))

  it('a published review names the command of the instance in every text, and never a default name', () =>
    withInstance(ACME, async () => {
      let posted = await publishRichReview()
      let all = posted.join('\n')
      // The thread of a finding, the comment on a file, and the footer of the block.
      assert.equal(all.split('Reply `@acme-review reject <cause>` in this thread').length - 1, 3, 'the two inline comments and the comment on the file')
      assert.ok(all.includes('`@acme-review feedback <opinion>`'), 'the footer of the block')
      let defaults = posted.flatMap((text) => text.match(/.{0,60}@(?:kento-review|sakuga-review)\b.{0,20}/g) ?? [])
      assert.deepEqual(defaults, [])
    }))

  it('one name: no alias in the list of the commands', () =>
    withInstance({ commandNames: ['acme-review'] }, () => {
      assert.ok(usageText().startsWith('Kentō commands, in a comment of the PR:\n'))
      assert.deepEqual(parseCommentCommand('@acme-review'), { verb: 'review', level: 'lite', force: false })
    }))

  it('the public page of the commands shows the names of the instance', () =>
    withInstance(ACME, async () => {
      let router = createAppRouter({
        checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
        version: '1.2.3',
        commit: null,
        webhook: webhookDeps(spyStore().apply),
        auth: fakeAuth().deps,
      })
      let response = await router.fetch(new Request(`https://review.test${DOCS_PATH}`, { headers: { Accept: 'text/html' } }))
      let html = await response.text()
      assert.match(html, /starts with <code>@acme-review<\/code> \(<code>@acme<\/code> works too\), outside a quote/)
      assert.match(html, /@acme-review reject #3cf454 (&lt;|<)cause(&gt;|>)/)
      assert.ok(!/@kento-review|@sakuga-review/.test(html))
    }))
})

describe('KENTO_DEFAULT_TRUSTED_BOTS', () => {
  it('a new org trusts the bots of the variable, compared without case', () =>
    withInstance({ defaultTrustedBots: loadConfig({ DATABASE_URL: 'postgres://x', KENTO_DEFAULT_TRUSTED_BOTS: 'Renovate' }).instance.defaultTrustedBots }, () => {
      assert.deepEqual(readTrustedBots(null), ['renovate[bot]'])
      // The webhook reads the trusted bots of the org: lowercase, as GitHub logins ignore the case.
      let policy: EventPolicy = { trustedBots: new Set(readTrustedBots(null)) }
      let renovate = commandFor('issue_comment', issueCommentPayload({ user: { login: 'Renovate[bot]', type: 'Bot' } }), policy)
      assert.equal(renovate.type, 'comment_command')
      let agent = commandFor('issue_comment', issueCommentPayload({ user: { login: 'sakuga-agent[bot]', type: 'Bot' } }), policy)
      assert.deepEqual(agent, { type: 'ignore', reason: 'command of an untrusted bot' })
    }))

  it('set and empty: a new org trusts no bot', () =>
    withInstance({ defaultTrustedBots: loadConfig({ DATABASE_URL: 'postgres://x', KENTO_DEFAULT_TRUSTED_BOTS: '' }).instance.defaultTrustedBots }, () => {
      assert.deepEqual(readTrustedBots(null), [])
    }))
})

describe('KENTO_CHECK_NAME and KENTO_RUNNER_IMAGE', () => {
  it('name the check of a review and the image of the docker run', () =>
    withInstance({ checkName: 'Acme Review', runnerImage: 'registry.example.com/acme/kento-runner' }, () => {
      assert.equal(checkName(), 'Acme Review')
      let command = dockerCommand({ kentoUrl: 'https://review.test', token: 't', name: 'n', labels: [], trusted: true, version: '1.2.3' })
      assert.ok(command.endsWith('registry.example.com/acme/kento-runner:1.2.3'), command)
    }))
})
