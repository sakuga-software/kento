import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import packageJson from '../package.json' with { type: 'json' }
import { ConfigError, loadConfig } from './config.ts'

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
    })
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
