import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { capSentence } from './notice.ts'
import {
  capAlerts,
  capReached,
  checkPermissions,
  missingEvents,
  nextReset,
  readCapsForm,
  readMoney,
  readTrustedBots,
  readTrustedBotsForm,
} from './model.ts'

function form(values: Record<string, string>): FormData {
  let data = new FormData()
  for (let [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

const NOW = new Date('2026-10-29T22:30:00Z')

describe('the cost limits of an org', () => {
  it('ends the day at midnight UTC, and the month on the first day of the next one', () => {
    assert.equal(nextReset('day', NOW).toISOString(), '2026-10-30T00:00:00.000Z')
    assert.equal(nextReset('month', NOW).toISOString(), '2026-11-01T00:00:00.000Z')
    assert.equal(nextReset('month', new Date('2026-12-31T23:59:00Z')).toISOString(), '2027-01-01T00:00:00.000Z')
  })

  it('stops at the limit of the day first, then of the month; no limit stops nothing', () => {
    assert.equal(capReached({ dailyCapUsd: null, monthlyCapUsd: null }, { dayUsd: 1e6, monthUsd: 1e6 }, NOW), null)
    assert.equal(capReached({ dailyCapUsd: 8, monthlyCapUsd: 100 }, { dayUsd: 7.99, monthUsd: 99.99 }, NOW), null)
    let day = capReached({ dailyCapUsd: 8, monthlyCapUsd: 100 }, { dayUsd: 8, monthUsd: 120 }, NOW)
    assert.deepEqual(day, { period: 'day', spentUsd: 8, capUsd: 8, resetsAt: new Date('2026-10-30T00:00:00Z') })
    let month = capReached({ dailyCapUsd: 8, monthlyCapUsd: 100 }, { dayUsd: 1, monthUsd: 100 }, NOW)
    assert.equal(month?.period, 'month')
    assert.equal(month?.resetsAt.toISOString(), '2026-11-01T00:00:00.000Z')
  })

  it('a limit of 0 stops every new job, even before any cost', () => {
    assert.equal(capReached({ dailyCapUsd: 0, monthlyCapUsd: null }, { dayUsd: 0, monthUsd: 0 }, NOW)?.period, 'day')
  })

  it('warns from the alert percentage, and not once the limit is reached', () => {
    let caps = { dailyCapUsd: 10, monthlyCapUsd: 100, alertPct: 80 }
    assert.deepEqual(capAlerts(caps, { dayUsd: 7.99, monthUsd: 79 }), [])
    assert.deepEqual(capAlerts(caps, { dayUsd: 8, monthUsd: 80 }), ['day', 'month'])
    assert.deepEqual(capAlerts(caps, { dayUsd: 10, monthUsd: 80 }), ['month'])
    assert.deepEqual(capAlerts({ dailyCapUsd: 0, monthlyCapUsd: null, alertPct: 80 }, { dayUsd: 0, monthUsd: 0 }), [])
  })

  it('tells the pull request why, until when, and who can change it', () => {
    let text = capSentence({ period: 'day', spentUsd: 8.03, capUsd: 8, resetsAt: new Date('2026-10-30T00:00:00Z') })
    assert.match(text, /plafond de coût du jour de l’organisation est atteint \(8,03\s\$ dépensés sur 8,00\s\$\)/)
    assert.match(text, /reprennent le 30 oct\. à 01:00 \(heure de Paris\)/)
    assert.match(text, /un admin relève le plafond/)
  })

  it('reads the numeric of Postgres', () => {
    assert.equal(readMoney('8.00'), 8)
    assert.equal(readMoney(null), null)
    assert.equal(readMoney('-1'), null)
    assert.equal(readMoney('abc'), null)
  })

  it('reads the form of the limits', () => {
    assert.deepEqual(readCapsForm(form({ dailyCapUsd: '0,01', monthlyCapUsd: '', alertPct: '80 %' })), {
      ok: true,
      value: { dailyCapUsd: 0.01, monthlyCapUsd: null, alertPct: 80 },
    })
    assert.deepEqual(readCapsForm(form({ dailyCapUsd: ' 8 ', monthlyCapUsd: '150', alertPct: '100' })), {
      ok: true,
      value: { dailyCapUsd: 8, monthlyCapUsd: 150, alertPct: 100 },
    })
    let bad = readCapsForm(form({ dailyCapUsd: '-3', monthlyCapUsd: '1e9', alertPct: '0' }))
    assert.equal(bad.ok, false)
    assert.deepEqual(Object.keys(bad.ok ? {} : bad.errors).sort(), ['alertPct', 'dailyCapUsd', 'monthlyCapUsd'])
    assert.equal(readCapsForm(form({ dailyCapUsd: '100001', alertPct: '80' })).ok, false)
    assert.equal(readCapsForm(form({ dailyCapUsd: '1.234', alertPct: '80' })).ok, false)
  })
})

describe('the trusted bots of an org', () => {
  it('reads one login per line or per comma, in lowercase, and adds [bot]', () => {
    assert.deepEqual(readTrustedBotsForm(form({ trustedBots: 'Renovate[bot]\nsakuga-agent[bot], dependabot\n\n' })), {
      ok: true,
      value: ['renovate[bot]', 'sakuga-agent[bot]', 'dependabot[bot]'],
    })
    assert.deepEqual(readTrustedBotsForm(form({ trustedBots: '' })), { ok: true, value: [] })
  })

  it('refuses what is not the login of a bot, and too many bots', () => {
    assert.equal(readTrustedBotsForm(form({ trustedBots: 'evil[bot]x' })).ok, false)
    assert.equal(readTrustedBotsForm(form({ trustedBots: '-dash[bot]' })).ok, false)
    assert.equal(readTrustedBotsForm(form({ trustedBots: 'a<b>[bot]' })).ok, false)
    let many = Array.from({ length: 21 }, (_, i) => `bot${i}[bot]`).join('\n')
    assert.equal(readTrustedBotsForm(form({ trustedBots: many })).ok, false)
  })

  it('drops a wrong value of the database, and keeps the default without a row', () => {
    assert.deepEqual(readTrustedBots(['Renovate[bot]', 'person', 42]), ['renovate[bot]'])
    assert.deepEqual(readTrustedBots(null), ['sakuga-agent[bot]'])
  })
})

describe('the GitHub App', () => {
  it('checks each permission: write covers read, read does not cover write', () => {
    let checks = checkPermissions({ contents: 'write', pull_requests: 'read', issues: 'write', checks: 'write', metadata: 'read' })
    let byName = Object.fromEntries(checks.map((c) => [c.name, c.ok]))
    assert.deepEqual(byName, { contents: true, pull_requests: false, issues: true, checks: true, members: false, metadata: true })
  })

  it('names the missing events', () => {
    assert.deepEqual(missingEvents(['pull_request', 'issue_comment', 'push']), [])
    assert.deepEqual(missingEvents(['push']), ['pull_request', 'issue_comment'])
  })
})
