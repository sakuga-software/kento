import { generateKeyPairSync } from 'node:crypto'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import packageJson from '../package.json' with { type: 'json' }
import { ConfigError, loadConfig } from './config.ts'
import { DEFAULT_INSTANCE } from './instance.ts'

const url = 'postgres://kento:secret@db.internal:5432/kento'

describe('loadConfig', () => {
  it('applies the defaults when only DATABASE_URL is set', () => {
    let config = loadConfig({ DATABASE_URL: url })
    assert.deepEqual(config, {
      databaseUrl: url,
      databasePoolMax: 10,
      host: '0.0.0.0',
      port: 3000,
      migrateOnStart: true,
      version: packageJson.version,
      commit: null,
      githubWebhookSecret: null,
      runnerRegistrationToken: null,
      githubApp: null,
      githubUrl: 'https://github.com',
      providerApiKey: null,
      secretsKeys: null,
      botLogin: 'kento-review[bot]',
      appSlug: 'kento-review',
      signIn: null,
      allowedOrgs: null,
      instance: DEFAULT_INSTANCE,
    })
  })

  describe('the names of the instance (REV-127)', () => {
    it('keeps the names of the first instance without a variable', () => {
      // Literal values: a change of DEFAULT_INSTANCE changes what every instance without a variable shows.
      let { instance } = loadConfig({ DATABASE_URL: url })
      assert.deepEqual(instance.commandNames, ['kento-review', 'sakuga-review'])
      assert.equal(instance.checkName, 'Sakuga Review')
      assert.equal(instance.runnerImage, 'ghcr.io/sakuga-software/kento-runner')
      assert.deepEqual(instance.defaultTrustedBots, ['sakuga-agent[bot]'])
      let blank = loadConfig({ DATABASE_URL: url, KENTO_COMMAND_NAMES: ' ', KENTO_CHECK_NAME: '', KENTO_RUNNER_IMAGE: '  ' }).instance
      assert.deepEqual(blank, DEFAULT_INSTANCE)
    })

    it('reads KENTO_COMMAND_NAMES: lowercase, without @, the first one shown, no duplicate', () => {
      let { instance } = loadConfig({ DATABASE_URL: url, KENTO_COMMAND_NAMES: ' @Acme-Review , acme,ACME-review,' })
      assert.deepEqual(instance.commandNames, ['acme-review', 'acme'])
      assert.deepEqual(loadConfig({ DATABASE_URL: url, KENTO_COMMAND_NAMES: 'acme-review' }).instance.commandNames, ['acme-review'])
    })

    it('refuses a command name that is no GitHub login, the login of an App, or too many names', () => {
      for (let value of ['acme review', 'acme-review[bot]', 'acme_review', '-acme', ',', 'a,b,c,d,e,f']) {
        assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_COMMAND_NAMES: value }), /KENTO_COMMAND_NAMES must be 1 to 5 names/, value)
      }
    })

    it('reads KENTO_CHECK_NAME, and refuses the name of the check of the cost limit and a second line', () => {
      assert.equal(loadConfig({ DATABASE_URL: url, KENTO_CHECK_NAME: ' Acme Review ' }).instance.checkName, 'Acme Review')
      assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_CHECK_NAME: 'kentō · CAP' }), /KENTO_CHECK_NAME must not be "Kentō · cap"/)
      assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_CHECK_NAME: 'Acme\nReview' }), /KENTO_CHECK_NAME must be one line/)
      assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_CHECK_NAME: 'x'.repeat(101) }), /KENTO_CHECK_NAME must be one line/)
    })

    it('reads KENTO_RUNNER_IMAGE without a tag', () => {
      for (let image of ['registry.example.com:5000/team/kento-runner', 'kento-runner', 'docker.io/acme/kento_runner']) {
        assert.equal(loadConfig({ DATABASE_URL: url, KENTO_RUNNER_IMAGE: image }).instance.runnerImage, image)
      }
      for (let image of ['ghcr.io/acme/kento-runner:1.0.0', 'ghcr.io/acme/kento-runner@sha256:abc', 'GHCR.io/Acme/Runner', 'ghcr.io/acme/kento runner']) {
        assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_RUNNER_IMAGE: image }), /KENTO_RUNNER_IMAGE must be a Docker image without a tag/, image)
      }
    })

    it('reads KENTO_DEFAULT_TRUSTED_BOTS as lowercase bot logins; set and empty, no bot', () => {
      let read = (value: string) => loadConfig({ DATABASE_URL: url, KENTO_DEFAULT_TRUSTED_BOTS: value }).instance.defaultTrustedBots
      assert.deepEqual(read('Renovate, acme-agent[bot],renovate[bot]'), ['renovate[bot]', 'acme-agent[bot]'])
      assert.deepEqual(read(''), [])
      assert.deepEqual(read(' '), [])
      assert.throws(() => read('acme<agent'), /KENTO_DEFAULT_TRUSTED_BOTS must be at most 20 bot logins/)
      assert.throws(() => read(Array.from({ length: 21 }, (_, i) => `bot${i}`).join(',')), /KENTO_DEFAULT_TRUSTED_BOTS must be at most 20/)
    })

    it('never prints the value of a wrong name', () => {
      let error: unknown
      try {
        loadConfig({ DATABASE_URL: url, KENTO_COMMAND_NAMES: 'secret-ish value', KENTO_DEFAULT_TRUSTED_BOTS: 'other<value>' })
      } catch (caught) {
        error = caught
      }
      assert.ok(error instanceof ConfigError)
      assert.ok(!error.message.includes('secret-ish') && !error.message.includes('other<value>'), error.message)
    })
  })

  it('reads KENTO_ALLOWED_ORGS as lowercase GitHub logins', () => {
    assert.deepEqual(loadConfig({ DATABASE_URL: url, KENTO_ALLOWED_ORGS: ' Sakuga-Software, acme ,' }).allowedOrgs, new Set(['sakuga-software', 'acme']))
    assert.equal(loadConfig({ DATABASE_URL: url, KENTO_ALLOWED_ORGS: ' ' }).allowedOrgs, null)
    assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_ALLOWED_ORGS: 'acme, not an org' }), /KENTO_ALLOWED_ORGS must be GitHub logins/)
    assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_ALLOWED_ORGS: ',' }), /KENTO_ALLOWED_ORGS must be GitHub logins/)
  })

  describe('the GitHub sign-in', () => {
    let { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    let app = {
      DATABASE_URL: url,
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }
    let signIn = {
      KENTO_PUBLIC_URL: 'https://review.sakuga.dev/',
      GITHUB_APP_CLIENT_ID: 'Iv23liesB1xzywavcnv2',
      GITHUB_APP_CLIENT_SECRET: 'client-secret-value-never-printed',
      KENTO_SESSION_SECRET: `${'s'.repeat(32)}, ${'t'.repeat(40)}`,
    }

    it('reads its four variables, with the App', () => {
      let config = loadConfig({ ...app, ...signIn })
      assert.equal(config.signIn?.publicUrl.href, 'https://review.sakuga.dev/')
      assert.equal(config.signIn?.clientId, 'Iv23liesB1xzywavcnv2')
      assert.deepEqual(config.signIn?.sessionSecrets, ['s'.repeat(32), 't'.repeat(40)])
      assert.equal(config.signIn?.oauthUrl, 'https://github.com')
      assert.equal(config.signIn?.apiUrl, 'https://api.github.com')
    })

    it('names the missing variables, and needs the App, never printing a value', () => {
      let { GITHUB_APP_CLIENT_SECRET: _secret, ...partial } = signIn
      let error = errorOf(() => loadConfig({ ...app, ...partial }))
      assert.match(error.message, /the GitHub sign-in also needs GITHUB_APP_CLIENT_SECRET/)
      assert.throws(() => loadConfig({ DATABASE_URL: url, ...signIn }), /needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/)
      let short = errorOf(() => loadConfig({ ...app, ...signIn, KENTO_SESSION_SECRET: 'short-secret' }))
      assert.match(short.message, /KENTO_SESSION_SECRET must have at least 32 characters/)
      assert.doesNotMatch(short.message, /short-secret|client-secret-value/)
    })

    it('wants the https origin of the service, or http on the machine itself', () => {
      for (let value of ['http://review.sakuga.dev', 'https://review.sakuga.dev/app', 'https://u:p@review.sakuga.dev', 'review']) {
        assert.throws(() => loadConfig({ ...app, ...signIn, KENTO_PUBLIC_URL: value }), /KENTO_PUBLIC_URL must be/, value)
      }
      assert.equal(loadConfig({ ...app, ...signIn, KENTO_PUBLIC_URL: 'http://127.0.0.1:3488' }).signIn?.publicUrl.origin, 'http://127.0.0.1:3488')
    })

    it('signs in on a fake GitHub of this machine over plain HTTP, and on GITHUB_URL otherwise', () => {
      let local = loadConfig({ ...app, ...signIn, GITHUB_API_URL: 'http://127.0.0.1:55492' })
      assert.equal(local.signIn?.oauthUrl, 'http://127.0.0.1:55492')
      let enterprise = loadConfig({ ...app, ...signIn, GITHUB_API_URL: 'https://ghe.example.com/api/v3' })
      assert.equal(enterprise.signIn?.oauthUrl, 'https://ghe.example.com')
    })
  })

  it('reads the login of the App, and refuses a login that is not one of an App', () => {
    assert.equal(loadConfig({ DATABASE_URL: url, KENTO_BOT_LOGIN: 'kento[bot]' }).botLogin, 'kento[bot]')
    assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_BOT_LOGIN: 'alex' }), /KENTO_BOT_LOGIN must be the login of an App/)
  })

  it('reads the slug of the App, or takes it from the login of its bot (REV-32)', () => {
    assert.equal(loadConfig({ DATABASE_URL: url, KENTO_BOT_LOGIN: 'Kento-Review[bot]' }).appSlug, 'kento-review')
    assert.equal(loadConfig({ DATABASE_URL: url, KENTO_APP_SLUG: 'kento-review-staging' }).appSlug, 'kento-review-staging')
    assert.throws(() => loadConfig({ DATABASE_URL: url, KENTO_APP_SLUG: 'Kentō Review' }), /KENTO_APP_SLUG must be the slug of the GitHub App/)
  })

  it('reads the runner settings, and the GitHub App with its key on one line', () => {
    let { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    let pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replaceAll('\n', '\\n')
    let config = loadConfig({
      DATABASE_URL: url,
      KENTO_RUNNER_REGISTRATION_TOKEN: 'r'.repeat(40),
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: pem,
      KENTO_PROVIDER_API_KEY: 'sk-or-test',
    })
    assert.equal(config.runnerRegistrationToken, 'r'.repeat(40))
    assert.equal(config.githubApp?.appId, '12345')
    assert.equal(config.githubApp?.privateKey.asymmetricKeyType, 'rsa')
    assert.equal(config.githubApp?.apiUrl, 'https://api.github.com')
    assert.equal(config.githubUrl, 'https://github.com')
    let enterprise = loadConfig({ DATABASE_URL: url, GITHUB_URL: 'https://ghe.example.com/', GITHUB_API_URL: 'https://ghe.example.com/api/v3' })
    assert.equal(enterprise.githubUrl, 'https://ghe.example.com')
    assert.throws(() => loadConfig({ DATABASE_URL: url, GITHUB_URL: 'http://ghe.example.com' }), /GITHUB_URL must be an https:\/\/ URL/)
    // The token of one server must never go to another: GITHUB_URL must be on the server of the API.
    let other = /GITHUB_URL must be on the server of GITHUB_API_URL/
    assert.throws(() => loadConfig({ DATABASE_URL: url, GITHUB_URL: 'https://ghe.example.com' }), other)
    assert.throws(
      () => loadConfig({ DATABASE_URL: url, GITHUB_API_URL: 'https://ghe-a.example.com/api/v3', GITHUB_URL: 'https://ghe-b.example.com' }),
      other,
    )
    // A GITHUB_API_URL that is not a URL is named as such, once, with or without the App.
    for (let env of [{ GITHUB_API_URL: 'not-a-url' }, { GITHUB_API_URL: 'not-a-url', GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: pem }]) {
      let error: unknown
      try {
        loadConfig({ DATABASE_URL: url, ...env })
      } catch (caught) {
        error = caught
      }
      assert.ok(error instanceof ConfigError)
      assert.equal(error.message, 'Invalid configuration: GITHUB_API_URL must be an http(s) URL')
    }
    // Without GITHUB_URL, the clone server is the server of the API, as for a local fake GitHub.
    assert.equal(loadConfig({ DATABASE_URL: url, GITHUB_API_URL: 'https://ghe.example.com/api/v3' }).githubUrl, 'https://ghe.example.com')
    assert.equal(loadConfig({ DATABASE_URL: url, GITHUB_API_URL: 'http://127.0.0.1:55492' }).githubUrl, 'https://127.0.0.1:55492')
    assert.equal(loadConfig({ DATABASE_URL: url, GITHUB_API_URL: 'https://api.github.com/' }).githubUrl, 'https://github.com')
    assert.equal(config.providerApiKey, 'sk-or-test')
  })

  it('refuses a short registration token and a GitHub App without a valid key, without the values', () => {
    let error: unknown
    try {
      loadConfig({
        DATABASE_URL: url,
        KENTO_RUNNER_REGISTRATION_TOKEN: 'short-secret',
        GITHUB_APP_ID: '12345',
        GITHUB_APP_PRIVATE_KEY: 'not-a-key-secret',
      })
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /KENTO_RUNNER_REGISTRATION_TOKEN must have at least 32 characters/)
    assert.match(error.message, /GITHUB_APP_PRIVATE_KEY must be the PEM private key of the App/)
    assert.doesNotMatch(error.message, /secret/)
  })

  it('reads every variable', () => {
    let config = loadConfig({
      DATABASE_URL: url,
      DATABASE_POOL_MAX: '4',
      HOST: '127.0.0.1',
      PORT: '8080',
      MIGRATE_ON_START: 'false',
      APP_COMMIT: 'abc1234',
    })
    assert.equal(config.databasePoolMax, 4)
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 8080)
    assert.equal(config.migrateOnStart, false)
    assert.equal(config.commit, 'abc1234')
  })

  it('reads the webhook secret, and neither a list of repositories nor of trusted bots', () => {
    let secret = ` ${'s'.repeat(40)} `
    let config = loadConfig({
      DATABASE_URL: url,
      GITHUB_WEBHOOK_SECRET: secret,
      KENTO_REPOS: ' Sakuga-Software/sakuga-review , sakuga-software/fruitback,,',
      KENTO_TRUSTED_BOTS: 'Renovate[bot], sakuga-agent[bot]',
    })
    // GitHub signs with the exact string: no trim.
    assert.equal(config.githubWebhookSecret, secret)
    // The Repos screen enables a repository: the variable of M2 is not read any more.
    assert.equal('kentoRepos' in config, false)
    // REV-13: the trusted bots are a setting of each org, in the database.
    assert.equal('trustedBots' in config, false)
  })

  it('refuses a short webhook secret and never prints it', () => {
    let error: unknown
    try {
      loadConfig({ DATABASE_URL: url, GITHUB_WEBHOOK_SECRET: 'short-secret-value' })
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /GITHUB_WEBHOOK_SECRET must have at least 32 characters/)
    assert.doesNotMatch(error.message, /short-secret-value/)
  })

  it('names every invalid variable and never prints a value', () => {
    let error: unknown
    try {
      loadConfig({ DATABASE_URL: 'mysql://kento:secret@db/kento', PORT: '99999', MIGRATE_ON_START: 'yes' })
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /DATABASE_URL must start with postgres/)
    assert.match(error.message, /PORT must be an integer from 1 to 65535/)
    assert.match(error.message, /MIGRATE_ON_START must be true or false/)
    assert.doesNotMatch(error.message, /secret/)
  })

  it('requires DATABASE_URL', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL is required/)
  })
})

function errorOf(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected an error')
}

describe('loadConfig: the master key of the providers (REV-11)', () => {
  it('reads KENTO_SECRETS_KEY and the earlier keys of a rotation', () => {
    let current = Buffer.alloc(32, 1).toString('base64')
    let previous = Buffer.alloc(32, 2).toString('base64')
    let config = loadConfig({ DATABASE_URL: 'postgres://u:p@h/d', KENTO_SECRETS_KEY: current, KENTO_SECRETS_PREVIOUS_KEYS: previous })
    assert.equal(config.secretsKeys!.current.toString('base64'), current)
    assert.equal(config.secretsKeys!.previous.length, 1)
  })

  it('names a key that is not 32 bytes of base64, never its value', () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: 'postgres://u:p@h/d', KENTO_SECRETS_KEY: 'my-secret-passphrase' }),
      (error: Error) => /KENTO_SECRETS_KEY must be 32 random bytes/.test(error.message) && !error.message.includes('my-secret-passphrase'),
    )
  })
})
