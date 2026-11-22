// KNT-188. A chart of the Costs screen, drawn in the browser from a table of the page. The server
// renders the table (the page without JavaScript) and an empty, hidden box; this component draws the
// chart in the box with Chart.js (./draw.ts, imported statically: the import map of the page only
// lists the modules that the entry imports), then folds the table under "Show the data". The props
// are the id of the table and the kind of chart: the numbers cross once, in the table.
import { clientEntry, ref, type Handle } from 'remix/component'

import { drawCostChart } from './draw.ts'

export type CostChartKind = 'days' | 'bars'

export interface CostChartProps {
  /** The id of the table that holds the numbers. */
  table: string
  /** `days`: bars per day and a line for the period before. `bars`: one horizontal bar per row. */
  kind: CostChartKind
}

export const CostChart = clientEntry(import.meta.url, function CostChart(handle: Handle<CostChartProps>) {
  let box: HTMLElement | null = null
  // In the browser only (queueTask): the server renders the empty box and draws nothing.
  handle.queueTask(() => {
    let table = document.getElementById(handle.props.table)
    if (!box || !(table instanceof HTMLTableElement)) return
    let chart: ReturnType<typeof drawCostChart>
    try {
      chart = drawCostChart(box, table, handle.props.kind)
    } catch (error) {
      // The table stays open: it is the content without a chart.
      console.error('Chart error:', error)
      return
    }
    handle.signal.addEventListener('abort', () => chart.destroy(), { once: true })
  })
  return () => <div class="cost-chart" data-kind={handle.props.kind} hidden mix={ref((node: HTMLElement) => (box = node))} />
})
