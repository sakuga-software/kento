/**
 * How the screens write an amount, an hour, a date and a count. In French, at the hour of Paris.
 *
 * Two ways to say how old something is, one per kind of thing:
 * - `agoShort` for a live state: the last signal of a runner, a job in the queue or in progress,
 *   the last call to a provider. The number keeps moving, and seconds count.
 * - `agoOrDate` for an event of the past: a review, a failed job, a delivery, a check on GitHub.
 *   After a day, the date is what a person looks up, not « il y a 4 j ».
 */

const USD = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const USD_3 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 3, maximumFractionDigits: 3 })
const CLOCK = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' })
const HOUR = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
const HOUR_SECONDS = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Paris' })
const DAY_MONTH = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' })
const WEEKDAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const HOUR_PARTS = new Intl.DateTimeFormat('fr-FR', { hour: 'numeric', minute: '2-digit', timeZone: 'Europe/Paris' })
const DATE = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris' })

/** « 12,50 $ », « 0,00 $ ». */
export function usd(value: number): string {
  return USD.format(value)
}

/** Like `usd`, with three decimals above zero and under ten cents: « 0,004 $ ». A review often costs less than one cent. */
export function usdPrecise(value: number): string {
  return value > 0 && value < 0.1 ? USD_3.format(value) : USD.format(value)
}

/** « 3,42 » or « 12 » in the field of an amount: a comma, no symbol. Empty for no amount. */
export function moneyInput(value: number | null): string {
  if (value === null) return ''
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',')
}

/** « 28/10/2026 09:40 ». */
export function clock(date: Date): string {
  return CLOCK.format(date)
}

/** « 09:40 ». */
export function hour(date: Date): string {
  return HOUR.format(date)
}

/** « 09:40:12 ». */
export function hourSeconds(date: Date): string {
  return HOUR_SECONDS.format(date)
}

/** « le 27 oct. à 18:02 ». */
export function when(date: Date): string {
  return `le ${DAY_MONTH.format(date)} à ${HOUR.format(date)}`
}

/** « mar. 28 oct. » for a day `YYYY-MM-DD` of the statistics, which are in UTC. */
export function weekday(day: string): string {
  return WEEKDAY.format(new Date(`${day}T00:00:00Z`))
}

/** « 9 h 40 »: the hour in Paris, as a sentence writes it. */
export function frenchHour(date: Date): string {
  let parts = HOUR_PARTS.formatToParts(date)
  let h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  let minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return `${h} h ${minute}`
}

/** « 9 h 40 » on the day of `now`, « 28/10/2026 9 h 40 » before. */
export function hourOrDate(date: Date, now: Date): string {
  let day = DATE.format(date)
  return day === DATE.format(now) ? frenchHour(date) : `${day} ${frenchHour(date)}`
}

/** « 42 s », « 3 min 05 s »: how long a job took. */
export function duration(ms: number): string {
  let seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  let minutes = Math.floor(seconds / 60)
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
}

/** « 12 s », « 5 min », « 3 h » (under 48 h), « 2 j »: the time from `date` to `now`, in whole units. */
export function elapsed(date: Date, now: Date): string {
  let seconds = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds} s`
  let minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  let hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} j`
}

/** « il y a 12 s », « il y a 5 min », « il y a 3 h », « il y a 2 j »: for a live state. */
export function agoShort(date: Date, now: Date): string {
  return `il y a ${elapsed(date, now)}`
}

/** « à l’instant », « il y a 5 min », « il y a 3 h », then « le 27 oct. à 18:02 » after a day: for an event of the past. */
export function agoOrDate(date: Date, now: Date): string {
  let minutes = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 60_000)
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  let hours = Math.floor(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  return when(date)
}

/** `word` with an « s » when `n` is more than one: `plural(3, 'étape')` is « étapes ». `many` for another plural. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return n > 1 ? many : word
}
