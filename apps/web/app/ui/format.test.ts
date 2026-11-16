import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { agoOrDate, agoShort, clock, duration, elapsed, hour, hourOrDate, hourSeconds, moneyInput, plural, usd, usdPrecise, weekday, when } from './format.ts'

/** Intl can write a narrow no-break space in an amount. */
const plain = (text: string) => text.replace(/\s/g, ' ')

const NOW = new Date('2026-10-30T10:00:00Z')
const before = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)

describe('format', () => {
  it('writes dollars with two decimals, and three under ten cents when precision matters', () => {
    assert.equal(plain(usd(12.5)), '$12.50')
    assert.equal(plain(usd(0.004)), '$0.00')
    assert.equal(plain(usd(1234)), '$1,234.00')
    assert.equal(plain(usdPrecise(0.004)), '$0.004')
    assert.equal(plain(usdPrecise(0.09)), '$0.090')
    assert.equal(plain(usdPrecise(0.1)), '$0.10')
    assert.equal(plain(usdPrecise(0)), '$0.00')
  })

  it('writes an amount in a field with a point and no symbol', () => {
    assert.equal(moneyInput(null), '')
    assert.equal(moneyInput(12), '12')
    assert.equal(moneyInput(3.4), '3.40')
    assert.equal(moneyInput(3.456), '3.46')
  })

  it('writes hours and dates at the hour of Paris', () => {
    let at = new Date('2026-10-27T17:02:09Z')
    assert.equal(clock(at), '27 Oct 2026, 18:02')
    assert.equal(hour(at), '18:02')
    assert.equal(hourSeconds(at), '18:02:09')
    assert.equal(weekday('2026-09-28'), 'Mon 28 Sep')
    assert.equal(when(at), 'on 27 Oct at 18:02')
    assert.equal(weekday('2026-10-28'), 'Wed 28 Oct')
  })

  it('writes the hour alone on the same day in Paris, and the date before', () => {
    assert.equal(hourOrDate(new Date('2026-10-30T07:05:00Z'), NOW), '08:05')
    assert.equal(hourOrDate(new Date('2026-10-29T22:30:00Z'), NOW), '29 Oct 2026, 23:30')
    // 23:30 UTC on the 29th is already the 30th in Paris.
    assert.equal(hourOrDate(new Date('2026-10-29T23:30:00Z'), NOW), '00:30')
  })

  it('writes a duration in seconds, then in minutes and seconds', () => {
    assert.equal(duration(42_000), '42 s')
    assert.equal(duration(185_000), '3 min 05 s')
  })

  it('counts the time since a live state in whole seconds, minutes, hours, then days after 48 h', () => {
    assert.equal(elapsed(before(12), NOW), '12 s')
    assert.equal(elapsed(before(59.9), NOW), '59 s')
    assert.equal(elapsed(before(5 * 60), NOW), '5 min')
    assert.equal(elapsed(before(3601), NOW), '1 h')
    assert.equal(elapsed(before(47 * 3600), NOW), '47 h')
    assert.equal(elapsed(before(48 * 3600), NOW), '2 d')
    assert.equal(elapsed(before(3 * 86_400 + 600), NOW), '3 d')
    assert.equal(elapsed(new Date(NOW.getTime() + 5000), NOW), '0 s', 'a clock ahead of the server is not a negative age')
    assert.equal(agoShort(before(12), NOW), '12 s ago')
    assert.equal(agoShort(before(4 * 86_400), NOW), '4 d ago')
  })

  it('says how old an event is for a day, then gives its date', () => {
    assert.equal(agoOrDate(before(30), NOW), 'just now')
    assert.equal(agoOrDate(before(90), NOW), '1 min ago')
    assert.equal(agoOrDate(before(3 * 3600), NOW), '3 h ago')
    assert.equal(agoOrDate(before(23 * 3600 + 3599), NOW), '23 h ago')
    assert.equal(agoOrDate(new Date('2026-10-27T17:02:00Z'), NOW), 'on 27 Oct at 18:02')
  })

  it('puts a word in the plural for every count but one', () => {
    assert.equal(plural(0, 'step'), 'steps')
    assert.equal(plural(1, 'step'), 'step')
    assert.equal(plural(2, 'step'), 'steps')
    assert.equal(plural(2, 'waits', 'wait'), 'wait')
  })
})
