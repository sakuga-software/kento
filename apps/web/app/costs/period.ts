// KNT-188. The periods of the Costs screen, in UTC days as every cost of Kentō (app/db/costs.ts).

/** `?period=`: the month so far (the default, never in the URL), the last month, 30 or 90 days. */
export const COST_PERIODS = ['month', 'last-month', '30d', '90d'] as const
export type CostPeriod = (typeof COST_PERIODS)[number]

export const DEFAULT_PERIOD: CostPeriod = 'month'

export const PERIOD_LABELS: Record<CostPeriod, string> = {
  month: 'This month',
  'last-month': 'Last month',
  '30d': '30 days',
  '90d': '90 days',
}

/** What the period of the comparison line is called. */
export const PREVIOUS_LABELS: Record<CostPeriod, string> = {
  month: 'Last month, same days',
  'last-month': 'The month before',
  '30d': 'The 30 days before',
  '90d': 'The 90 days before',
}

/** The period of a query: an unknown value, or none, is the default (KNT-195). */
export function readPeriod(value: string | null): CostPeriod {
  return (COST_PERIODS as readonly string[]).includes(value ?? '') ? (value as CostPeriod) : DEFAULT_PERIOD
}

/** The query of a period: empty for the default, so that its URL stays `/costs`. */
export function periodQuery(period: CostPeriod): string {
  return period === DEFAULT_PERIOD ? '' : `?${new URLSearchParams({ period })}`
}

export interface PeriodRange {
  /** The first instant, at 00:00 UTC. */
  start: Date
  /** The end, excluded: 00:00 UTC of the day after the last day. */
  end: Date
  /** The days of the period, `2026-11-01`… */
  days: string[]
  /** The period of the comparison, of the same number of days, just before (the month before for a month). */
  previousStart: Date
  previousEnd: Date
  /** The days of the month of `start`, for the projection of the month so far. */
  monthDays: number
}

const DAY_MS = 86_400_000

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1))
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * The days of a period at `now`. "This month" ends today, and compares with the same days of the
 * month before (as many as that month has). "Last month" compares with the month before it. 30 and
 * 90 days end today, and compare with the as many days before them.
 */
export function periodRange(period: CostPeriod, now: Date): PeriodRange {
  let today = utcDay(now)
  let tomorrow = addDays(today, 1)
  let year = today.getUTCFullYear()
  let month = today.getUTCMonth()
  let start: Date
  let end: Date
  let previousStart: Date
  let previousEnd: Date
  if (period === 'month') {
    start = monthStart(year, month)
    end = tomorrow
    previousStart = monthStart(year, month - 1)
    // The same days of the month before, no further than its end.
    previousEnd = new Date(Math.min(addDays(previousStart, today.getUTCDate()).getTime(), start.getTime()))
  } else if (period === 'last-month') {
    start = monthStart(year, month - 1)
    end = monthStart(year, month)
    previousStart = monthStart(year, month - 2)
    previousEnd = start
  } else {
    let length = period === '30d' ? 30 : 90
    end = tomorrow
    start = addDays(end, -length)
    previousEnd = start
    previousStart = addDays(start, -length)
  }
  let days: string[] = []
  for (let day = start; day < end; day = addDays(day, 1)) days.push(dayKey(day))
  let monthDays = Math.round((monthStart(start.getUTCFullYear(), start.getUTCMonth() + 1).getTime() - monthStart(start.getUTCFullYear(), start.getUTCMonth()).getTime()) / DAY_MS)
  return { start, end, days, previousStart, previousEnd, monthDays }
}
