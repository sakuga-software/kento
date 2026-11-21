// KNT-188, KNT-191. A chart drawn in the browser from numbers that the server already rendered: a
// table (the Costs screen) or a list (the precision of the dashboard). The server renders the
// numbers (the page without JavaScript) and an empty, hidden box; this component draws the chart in
// the box with Chart.js (./chart-draw.ts, imported statically: the import map of the page only
// lists the modules that the entry imports), then folds a table under "Show the data". The props
// are the id of the source, the kind of chart, its unit and its tone: the numbers cross once, in the
// source.
import { clientEntry, ref, type Handle } from 'remix/component'

import { drawChart, type ChartKind, type ChartTone, type ChartUnit } from './chart-draw.ts'

export type { ChartKind, ChartTone, ChartUnit }

export interface TableChartProps {
  /** The id of the table, or of the list, that holds the numbers. */
  table: string
  /** `days`: bars per day and a line for the period before. `bars`: one horizontal bar per row. */
  kind: ChartKind
  /** `usd` (the default): dollars. `pct`: a share from 0 to 100. */
  unit?: ChartUnit
  /** The color token of the bars: `ai` (the default) or `matsu`. */
  tone?: ChartTone
}

export const TableChart = clientEntry(import.meta.url, function TableChart(handle: Handle<TableChartProps>) {
  let box: HTMLElement | null = null
  // In the browser only (queueTask): the server renders the empty box and draws nothing.
  handle.queueTask(() => {
    let source = document.getElementById(handle.props.table)
    if (!box || !source) return
    let { kind, unit = 'usd', tone = 'ai' } = handle.props
    let chart: ReturnType<typeof drawChart>
    try {
      chart = drawChart(box, source, { kind, unit, tone })
    } catch (error) {
      // The table or the list stays: it is the content without a chart.
      console.error('Chart error:', error)
      return
    }
    handle.signal.addEventListener('abort', () => chart.destroy(), { once: true })
  })
  return () => <div class="chart-box" data-kind={handle.props.kind} hidden mix={ref((node: HTMLElement) => (box = node))} />
})
