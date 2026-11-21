// KNT-188. The Costs screen: what the reviews and resolutions of the org cost over a period, by day,
// repository, level and model, and the most expensive ones. The server renders every number as a
// table; in the browser, `CostChart` draws a chart from each table and folds the table under
// "Show the data". Without JavaScript the tables are the page.
import type { Handle } from 'remix/component'

import { COST_PERIODS, PERIOD_LABELS, PREVIOUS_LABELS, periodQuery, type CostPeriod } from '../costs/period.ts'
import type { CostReport, CostShare } from '../costs/store.ts'
import { CostChart } from '../costs/public/cost-chart.tsx'
import { costRoutes, pageRoutes as routes, pullRoutes } from '../routes.ts'
import { count, plural, usdPrecise } from './format.ts'
import { Shell, type PageFrame } from './shell.tsx'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "5 Nov" from the UTC day `2026-11-05`: the days of the costs are UTC days. */
export function dayLabel(day: string): string {
  let [, month, date] = day.split('-')
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? ''}`
}

/**
 * "6 Nov, 22:23 UTC": the time of a run in UTC, as its day on this screen (Fable P3). `when()` of
 * format.ts writes the time of Paris, which can fall on another day than the bucket of the run.
 */
export function utcWhen(date: Date): string {
  let iso = date.toISOString()
  return `${dayLabel(iso.slice(0, 10))}, ${iso.slice(11, 16)} UTC`
}

/** "+12%", "−40%", or null when the period before cost nothing. */
export function change(now: number, before: number): string | null {
  if (before <= 0) return null
  let pct = Math.round(((now - before) / before) * 100)
  return pct === 0 ? 'same' : pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`
}

/** The share of `part` in `total`, "12%". */
function share(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '–'
}

/** The URL of a period of the screen. */
export function periodHref(period: CostPeriod): string {
  return `${costRoutes.costs.href()}${periodQuery(period)}`
}

export function CostsPage(handle: Handle<{ frame: PageFrame; report: CostReport; charts?: boolean }>) {
  return () => {
    let { frame, report } = handle.props
    let charts = handle.props.charts ?? true
    let { period } = report
    return (
      <Shell
        frame={frame}
        section="costs"
        title="Costs"
        lead="What the reviews and resolutions of the organization cost, by day, repo, level and model. Days are UTC days, as for the cap."
      >
        <nav class="cost-periods" aria-label="Period, in UTC days">
          {COST_PERIODS.map((key) => (
            <a href={periodHref(key)} aria-current={key === period ? 'page' : undefined}>
              {PERIOD_LABELS[key]}
            </a>
          ))}
        </nav>

        <Summary report={report} />

        {report.count === 0 ? (
          <section class="card cost-empty" aria-labelledby="cost-empty-title">
            <h2 id="cost-empty-title" class="section-title">
              No cost over {PERIOD_LABELS[period].toLowerCase()}
            </h2>
            <p class="hint">No review or resolution of the organization in this period. Choose a longer period above.</p>
          </section>
        ) : (
          <>
            <DaysSection report={report} charts={charts} />
            <div class="cost-grid">
              <SharesSection
                id="repos"
                title="By repo"
                head="Repo"
                shares={report.byRepo}
                total={report.totalUsd}
                charts={charts}
                link={(row) => (row.key ? routes.repoConfig.href({ id: row.key }) : null)}
                // The repos of one org share its name: the chart keeps the part after it.
                short={(row) => (row.key ? (row.label.split('/').pop() ?? row.label) : row.label)}
              />
              <SharesSection id="levels" title="By level" head="Level" shares={report.byLevel} total={report.totalUsd} mono charts={charts} />
              <SharesSection id="models" title="By model" head="Model" shares={report.byModel} total={report.totalUsd} mono charts={charts} />
            </div>
            <TopSection report={report} />
          </>
        )}
      </Shell>
    )
  }
}

function Summary(handle: Handle<{ report: CostReport }>) {
  return () => {
    let { report } = handle.props
    let delta = change(report.totalUsd, report.previousTotalUsd)
    let cap = report.caps.monthlyCapUsd
    let mean = report.count > 0 ? report.totalUsd / report.count : null
    let busiest = report.days.reduce<{ day: string; usd: number } | null>((top, day) => (day.usd > (top?.usd ?? 0) ? day : top), null)
    return (
      <section class="dash-kpis card cost-kpis" aria-label="Summary">
        <div class="kpi">
          <span class="kpi-label">{PERIOD_LABELS[report.period]} (UTC)</span>
          <span class="kpi-value">{usdPrecise(report.totalUsd)}</span>
          <span class="kpi-sub">
            {usdPrecise(report.previousTotalUsd)} {PREVIOUS_LABELS[report.period].toLowerCase()}
            {delta ? ` · ${delta}` : ''}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Reviews and resolutions</span>
          <span class="kpi-value">{count(report.count)}</span>
          <span class="kpi-sub">{mean !== null ? `${usdPrecise(mean)} each on average` : 'none'}</span>
        </div>
        {report.period === 'month' ? (
          <>
            <div class="kpi">
              <span class="kpi-label">Projection of the month</span>
              <span class="kpi-value">{report.projectionUsd !== null ? usdPrecise(report.projectionUsd) : '–'}</span>
              <span class="kpi-sub">
                at the pace of {report.days.length} {plural(report.days.length, 'day')}
              </span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Cap of the month</span>
              <span class="kpi-value">{cap !== null ? usdPrecise(cap) : '–'}</span>
              <span class={`kpi-sub ${cap !== null && report.totalUsd >= cap ? 'kpi-alert' : ''}`}>
                {cap === null ? (
                  <>
                    no cap · <a href={`${routes.settings.href()}#cap`}>Settings</a>
                  </>
                ) : (
                  `${share(report.totalUsd, cap)} used · alert at ${report.caps.alertPct}%`
                )}
              </span>
            </div>
          </>
        ) : (
          <div class="kpi">
            <span class="kpi-label">Most expensive day</span>
            <span class="kpi-value">{busiest ? usdPrecise(busiest.usd) : '–'}</span>
            <span class="kpi-sub">{busiest ? dayLabel(busiest.day) : 'no cost'}</span>
          </div>
        )}
        {report.unknown > 0 ? (
          <p class="hint cost-unknown">
            {count(report.unknown)} {plural(report.unknown, 'review or resolution', 'reviews or resolutions')} with no known cost: the runner did
            not report one, so {report.unknown === 1 ? 'it counts' : 'they count'} $0 here, as for the cap.
          </p>
        ) : null}
      </section>
    )
  }
}

function DaysSection(handle: Handle<{ report: CostReport; charts: boolean }>) {
  return () => {
    let { report, charts } = handle.props
    let previous = PREVIOUS_LABELS[report.period]
    return (
      <section class="card cost-section" aria-labelledby="cost-days-title">
        <h2 id="cost-days-title" class="section-title">
          Cost per day
        </h2>
        {charts ? <CostChart table="cost-days-table" kind="days" /> : null}
        <details class="chart-data" open>
          {/* A name of its own in the list of the controls of a screen reader (Fable P3). */}
          <summary>
            Show the data<span class="visually-hidden">: cost per day</span>
          </summary>
          <table class="dash-table cost-table" id="cost-days-table">
            <caption class="visually-hidden">Cost per day, {PERIOD_LABELS[report.period].toLowerCase()}, and {previous.toLowerCase()}</caption>
            <thead>
              <tr>
                <th scope="col">Day (UTC)</th>
                <th scope="col" class="num" data-series={PERIOD_LABELS[report.period]}>
                  Cost
                </th>
                <th scope="col" class="num" data-series={previous}>
                  {previous}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.days.map((day) => (
                <tr data-label={dayLabel(day.day)}>
                  <th scope="row">
                    <time dateTime={day.day}>{dayLabel(day.day)}</time>
                  </th>
                  <td class="num" data-value={String(day.usd)}>
                    {usdPrecise(day.usd)}
                  </td>
                  <td class="num" data-value={day.previousUsd === null ? '' : String(day.previousUsd)}>
                    {day.previousUsd === null ? '–' : usdPrecise(day.previousUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
    )
  }
}

function SharesSection(
  handle: Handle<{
    id: string
    title: string
    head: string
    shares: CostShare[]
    total: number
    mono?: boolean
    /** Fable P2-2: false when the asset server cannot serve the charts. */
    charts: boolean
    link?: (row: CostShare) => string | null
    /** The label of a row on the chart, when the one of the table is too long for its axis. */
    short?: (row: CostShare) => string
  }>,
) {
  return () => {
    let { id, title, head, shares, total, mono, charts, link, short } = handle.props
    let table = `cost-${id}-table`
    return (
      <section class="card cost-section" aria-labelledby={`cost-${id}-title`}>
        <h2 id={`cost-${id}-title`} class="section-title">
          {title}
        </h2>
        {charts ? <CostChart table={table} kind="bars" /> : null}
        <details class="chart-data" open>
          <summary>
            Show the data<span class="visually-hidden">: cost {title.toLowerCase()}</span>
          </summary>
          <table class="dash-table cost-table" id={table}>
            <caption class="visually-hidden">Cost {title.toLowerCase()}</caption>
            <thead>
              <tr>
                <th scope="col">{head}</th>
                <th scope="col" class="num" data-series="Cost">
                  Cost
                </th>
                <th scope="col" class="num">
                  Share
                </th>
                <th scope="col" class="num">
                  Runs
                </th>
              </tr>
            </thead>
            <tbody>
              {shares.map((row) => {
                let href = link?.(row) ?? null
                return (
                  <tr data-label={short ? short(row) : row.label}>
                    <th scope="row" class={mono ? 'mono' : undefined}>
                      {href ? <a href={href}>{row.label}</a> : row.label}
                    </th>
                    <td class="num" data-value={String(row.usd)}>
                      {usdPrecise(row.usd)}
                    </td>
                    <td class="num">{share(row.usd, total)}</td>
                    <td class="num">{count(row.count)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </details>
      </section>
    )
  }
}

function TopSection(handle: Handle<{ report: CostReport }>) {
  return () => {
    let { report } = handle.props
    return (
      <section class="card cost-section" aria-labelledby="cost-top-title">
        <h2 id="cost-top-title" class="section-title">
          Most expensive
        </h2>
        {report.top.length === 0 ? (
          <p class="hint">No run with a known cost in this period.</p>
        ) : (
          <div class="cost-scroll">
            <table class="dash-table cost-table">
              <caption class="visually-hidden">The most expensive reviews and resolutions of the period</caption>
              <thead>
                <tr>
                  <th scope="col">Pull request</th>
                  <th scope="col">Run</th>
                  <th scope="col">Model</th>
                  <th scope="col" class="num">
                    Cost
                  </th>
                  <th scope="col">When (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {report.top.map((run) => (
                  <tr>
                    <th scope="row">
                      <a href={pullRoutes.pull.href({ id: run.repoId, number: String(run.prNumber) })}>
                        {run.repo}#{run.prNumber}
                      </a>
                    </th>
                    <td>
                      <span class="tag">{run.kind === 'resolve' ? 'resolution' : run.level}</span>
                    </td>
                    <td class="mono">{run.model ?? '–'}</td>
                    <td class="num">{usdPrecise(run.usd)}</td>
                    <td>
                      <time dateTime={run.createdAt.toISOString()}>{utcWhen(run.createdAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    )
  }
}
