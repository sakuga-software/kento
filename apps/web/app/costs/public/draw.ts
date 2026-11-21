// KNT-188. Draws a chart of the Costs screen with Chart.js, from the table that the server rendered:
// the row labels (`data-label`), the series (`th[data-series]` of the head) and the numbers
// (`td[data-value]`). Only the parts of Chart.js that these charts use are registered. The colors
// are the tokens of kento.css, read again when the theme changes; no motion for
// prefers-reduced-motion.
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js'

import type { CostChartKind } from './cost-chart.tsx'

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip, Legend)

export interface TableData {
  labels: string[]
  series: { name: string; values: (number | null)[] }[]
}

/** The numbers of a table of the Costs screen. An empty `data-value` is no value (a day that the period before does not have). */
export function readTable(table: HTMLTableElement): TableData {
  let head = table.tHead?.rows[0]
  let columns = head ? [...head.cells].filter((cell) => cell.dataset.series !== undefined) : []
  let rows = [...(table.tBodies[0]?.rows ?? [])]
  return {
    labels: rows.map((row) => row.dataset.label ?? row.cells[0]?.textContent?.trim() ?? ''),
    series: columns.map((column) => ({
      name: column.dataset.series ?? '',
      values: rows.map((row) => {
        let value = row.cells[column.cellIndex]?.dataset.value
        return value === undefined || value === '' ? null : Number(value)
      }),
    })),
  }
}

/** The longest label on the axis of a bar chart; the tooltip and the table keep the whole name (Fable P3). */
export const LABEL_MAX = 24

/** A label cut to `max` characters, with an ellipsis. */
export function shortLabel(label: string, max = LABEL_MAX): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

/** "$0.004" under ten cents, "$12.50" above: `usdPrecise` of app/ui/format.ts. */
export function money(value: number): string {
  return value > 0 && value < 0.1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** The colors of the theme on screen. */
function palette() {
  return {
    bar: token('--ai'),
    previous: token('--nezumi'),
    ink: token('--ink'),
    muted: token('--ink-muted'),
    grid: token('--line'),
    surface: token('--paper-raised'),
    font: token('--font-ui'),
    mono: token('--font-mono'),
  }
}

function config(kind: CostChartKind, data: TableData, reduce: boolean): ChartConfiguration {
  let colors = palette()
  let font = { family: colors.font, size: 12 }
  let tooltip = {
    backgroundColor: colors.ink,
    titleColor: colors.surface,
    bodyColor: colors.surface,
    titleFont: font,
    bodyFont: { family: colors.mono, size: 12 },
    displayColors: data.series.length > 1,
    callbacks: {
      label: (item: { dataset: { label?: string }; parsed: { x: number | null; y: number | null } }) => {
        let value = kind === 'bars' ? item.parsed.x : item.parsed.y
        return `${item.dataset.label ?? ''}: ${value === null ? '–' : money(value)}`
      },
    },
  }
  let moneyTicks = { color: colors.muted, font: { family: colors.mono, size: 11 }, callback: (value: number | string) => money(Number(value)) }
  if (kind === 'days') {
    let [current, previous] = data.series
    return {
      type: 'bar',
      data: {
        labels: data.labels,
        datasets: [
          {
            type: 'bar',
            label: current?.name ?? '',
            data: current?.values ?? [],
            backgroundColor: colors.bar,
            borderRadius: { topLeft: 4, topRight: 4 },
            borderSkipped: 'start',
            maxBarThickness: 24,
            pointStyle: 'rect',
          },
          ...(previous
            ? [
                {
                  type: 'line' as const,
                  label: previous.name,
                  data: previous.values,
                  borderColor: colors.previous,
                  backgroundColor: colors.previous,
                  borderWidth: 2,
                  borderDash: [5, 4],
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  pointHitRadius: 8,
                  pointStyle: 'line',
                },
              ]
            : []),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduce ? false : { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, border: { color: colors.grid }, ticks: { color: colors.muted, font, maxRotation: 0, autoSkipPadding: 12 } },
          y: { beginAtZero: true, grid: { color: colors.grid }, border: { display: false }, ticks: { ...moneyTicks, maxTicksLimit: 5 } },
        },
        plugins: {
          // The legend draws each series as its mark: a square for the bars, a line for the period before.
          legend: { position: 'top', align: 'end', labels: { color: colors.muted, font, usePointStyle: true, pointStyleWidth: 18, boxHeight: 8 } },
          tooltip,
        },
      },
    } as ChartConfiguration
  }
  let [cost] = data.series
  return {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: cost?.name ?? 'Cost',
          data: cost?.values ?? [],
          backgroundColor: colors.bar,
          borderRadius: { topRight: 4, bottomRight: 4 },
          borderSkipped: 'start',
          maxBarThickness: 18,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: reduce ? false : { duration: 300 },
      scales: {
        x: { beginAtZero: true, grid: { color: colors.grid }, border: { display: false }, ticks: { ...moneyTicks, maxTicksLimit: 4 } },
        y: {
          grid: { display: false },
          border: { color: colors.grid },
          ticks: { color: colors.ink, font, callback: (_value: number | string, index: number) => shortLabel(data.labels[index] ?? '') },
        },
      },
      // One series: its title names it, no legend.
      plugins: { legend: { display: false }, tooltip },
    },
  } as ChartConfiguration
}

/** Draws the chart of `table` in `box`, shows the box and folds the table. `destroy()` undoes it. */
export function drawCostChart(box: HTMLElement, table: HTMLTableElement, kind: CostChartKind): { destroy(): void } {
  let data = readTable(table)
  let caption = table.caption?.textContent?.trim() ?? 'Costs'
  let canvas = document.createElement('canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', `${caption}: chart. The numbers are in the table "Show the data" below.`)
  // CSSOM, not a style attribute: the content security policy allows it.
  if (kind === 'bars') box.style.setProperty('--rows', String(Math.max(1, data.labels.length)))
  box.append(canvas)
  // Shown before the chart is built: Chart.js measures the box. The table folds only once the chart
  // stands (Fable P3): if Chart.js throws, the box goes and the table stays open.
  box.hidden = false
  let motion = matchMedia('(prefers-reduced-motion: reduce)')
  let chart: Chart
  try {
    chart = new Chart(canvas, config(kind, data, motion.matches))
  } catch (error) {
    canvas.remove()
    box.hidden = true
    throw error
  }
  let details = table.closest('details')
  if (details) details.open = false
  let restyle = () => {
    let next = config(kind, data, motion.matches)
    chart.data = next.data
    chart.options = next.options ?? {}
    chart.update('none')
  }
  // The theme of the page (data-theme) or of the system changed: the tokens did too.
  let observer = new MutationObserver(restyle)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  let dark = matchMedia('(prefers-color-scheme: dark)')
  dark.addEventListener('change', restyle)
  motion.addEventListener('change', restyle)
  return {
    destroy() {
      observer.disconnect()
      dark.removeEventListener('change', restyle)
      motion.removeEventListener('change', restyle)
      chart.destroy()
      canvas.remove()
      box.hidden = true
    },
  }
}
