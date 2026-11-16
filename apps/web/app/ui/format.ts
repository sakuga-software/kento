/**
 * How the screens write an amount, an hour, a date and a count. In English, at the hour of Paris.
 *
 * Two ways to say how old something is, one per kind of thing:
 * - `agoShort` for a live state: the last signal of a runner, a job in the queue or in progress,
 *   the last call to a provider. The number keeps moving, and seconds count.
 * - `agoOrDate` for an event of the past: a review, a failed job, a delivery, a check on GitHub.
 *   After a day, the date is what a person looks up, not "4 d ago".
 */

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const USD_3 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 3, maximumFractionDigits: 3 })
const PARIS = 'Europe/Paris'
const HOUR = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: PARIS })
const HOUR_SECONDS = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: PARIS })
const DATE_PARTS = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric', year: 'numeric', weekday: 'short', timeZone: PARIS })
const UTC_PARTS = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric', year: 'numeric', weekday: 'short', timeZone: 'UTC' })
const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: PARIS })
// Intl writes "Sept" in en-GB and puts the month first in en-US: the screens write "28 Sep".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dateParts(format: Intl.DateTimeFormat, date: Date): { weekday: string; day: string; month: string; year: string } {
  let parts = format.formatToParts(date)
  let part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return { weekday: part('weekday'), day: part('day'), month: MONTHS[Number(part('month')) - 1] ?? '', year: part('year') }
}

/** "27 Oct" in Paris. */
export function dayMonth(date: Date): string {
  let { day, month } = dateParts(DATE_PARTS, date)
  return `${day} ${month}`
}

/** A number with the separators of English: "1,234". */
export function count(value: number): string {
  return value.toLocaleString('en-US')
}

/** "$12.50", "$0.00". */
export function usd(value: number): string {
  return USD.format(value)
}

/** Like `usd`, with three decimals above zero and under ten cents: "$0.004". A review often costs less than one cent. */
export function usdPrecise(value: number): string {
  return value > 0 && value < 0.1 ? USD_3.format(value) : USD.format(value)
}

/** "3.42" or "12" in the field of an amount: a point, no symbol. Empty for no amount. */
export function moneyInput(value: number | null): string {
  if (value === null) return ''
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** "27 Oct 2026, 18:02". */
export function clock(date: Date): string {
  let { day, month, year } = dateParts(DATE_PARTS, date)
  return `${day} ${month} ${year}, ${HOUR.format(date)}`
}

/** "09:40". */
export function hour(date: Date): string {
  return HOUR.format(date)
}

/** "09:40:12". */
export function hourSeconds(date: Date): string {
  return HOUR_SECONDS.format(date)
}

/** "on 27 Oct at 18:02". */
export function when(date: Date): string {
  return `on ${dayMonth(date)} at ${HOUR.format(date)}`
}

/** "Wed 28 Oct" for a day `YYYY-MM-DD` of the statistics, which are in UTC. */
export function weekday(day: string): string {
  let parts = dateParts(UTC_PARTS, new Date(`${day}T00:00:00Z`))
  return `${parts.weekday} ${parts.day} ${parts.month}`
}

/** "09:40" on the day of `now` in Paris, "28 Oct 2026, 09:40" before. */
export function hourOrDate(date: Date, now: Date): string {
  return DATE.format(date) === DATE.format(now) ? hour(date) : clock(date)
}

/** "42 s", "3 min 05 s": how long a job took. */
export function duration(ms: number): string {
  let seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  let minutes = Math.floor(seconds / 60)
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
}

/** "12 s", "5 min", "3 h" (under 48 h), "2 d": the time from `date` to `now`, in whole units. */
export function elapsed(date: Date, now: Date): string {
  let seconds = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds} s`
  let minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  let hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** "12 s ago", "5 min ago", "3 h ago", "2 d ago": for a live state. */
export function agoShort(date: Date, now: Date): string {
  return `${elapsed(date, now)} ago`
}

/** "just now", "5 min ago", "3 h ago", then "on 27 Oct at 18:02" after a day: for an event of the past. */
export function agoOrDate(date: Date, now: Date): string {
  let minutes = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  let hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return when(date)
}

/** `word` with an "s" when `n` is not one: `plural(0, 'step')` is "steps". `many` for another plural. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return n === 1 ? word : many
}
