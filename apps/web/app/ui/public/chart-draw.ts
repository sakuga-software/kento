// KNT-188, KNT-191. Draws a chart with Chart.js from numbers that the server rendered:
// - a table: the row labels (`tr[data-label]`), the series (`th[data-series]` of the head) and the
//   numbers (`td[data-value]`);
// - a list: one series named by `data-series` on the list, one row per child with `data-label`, its
//   number in its `data-value`.
// Only the parts of Chart.js that these charts use are registered. The colors are the tokens of
// kento.css, read again when the theme changes; no motion for prefers-reduced-motion.
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

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip, Legend)

/** `days`: bars per day and a line for the period before. `bars`: one horizontal bar per row. */
export type ChartKind = 'days' | 'bars'
/** `usd`: dollars. `pct`: a share from 0 to 100. */
export type ChartUnit = 'usd' | 'pct'
/** The color token of the bars. */
export type ChartTone = 'ai' | 'matsu'

export interface ChartOptions {
  kind: ChartKind
  unit: ChartUnit
  tone: ChartTone
}

export interface SourceData {
  labels: string[]
  series: { name: string; values: (number | null)[] }[]
}

/** An empty `data-value` is no value (a day that the period before does not have, a share under its minimum). */
function valueOf(text: string | undefined): number | null {
  return text === undefined || text === '' ? null : Number(text)
}

/** The numbers of a table or of a list that the server rendered. */
export function readSource(source: HTMLElement): SourceData {
  if (source instanceof HTMLTableElement) {
    let head = source.tHead?.rows[0]
    let columns = head ? [...head.cells].filter((cell) => cell.dataset.series !== undefined) : []
    let rows = [...(source.tBodies[0]?.rows ?? [])]
    return {
      labels: rows.map((row) => row.dataset.label ?? row.cells[0]?.textContent?.trim() ?? ''),
      series: columns.map((column) => ({
        name: column.dataset.series ?? '',
        values: rows.map((row) => valueOf(row.cells[column.cellIndex]?.dataset.value)),
      })),
    }
  }
  let rows = [...source.children].filter((row): row is HTMLElement => row instanceof HTMLElement && row.dataset.label !== undefined)
  return {
    labels: rows.map((row) => row.dataset.label ?? ''),
    series: [{ name: source.dataset.series ?? '', values: rows.map((row) => valueOf(row.dataset.value)) }],
  }
}

/**
 * The rows of a bar chart that have a value: a share under its minimum of closed findings has none,
 * and its row stays in the list under the chart, not as an empty bar.
 */
export function withValues(data: SourceData): SourceData {
  let keep = data.labels.map((_, i) => data.series.some((series) => series.values[i] !== null))
  return {
    labels: data.labels.filter((_, i) => keep[i]),
    series: data.series.map((series) => ({ ...series, values: series.values.filter((_, i) => keep[i]) })),
  }
}

/** The longest label on the axis of a bar chart; the tooltip and the table keep the whole name (Fable P3). */
export const LABEL_MAX = 24

/** A label cut to `max` characters, with an ellipsis. */
export function shortLabel(label: string, max = LABEL_MAX): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

/** The callback of the ticks of a category axis: each label cut to LABEL_MAX characters. */
export function tickLabel(labels: string[]): (value: number | string, index: number) => string {
  return (_value, index) => shortLabel(labels[index] ?? '')
}

/** "$0.004" under ten cents, "$12.50" above: `usdPrecise` of app/ui/format.ts. */
export function money(value: number): string {
  return value > 0 && value < 0.1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`
}

/** A number of the unit of a chart. */
export function formatValue(value: number, unit: ChartUnit): string {
  return unit === 'pct' ? `${Math.round(value)}%` : money(value)
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** The colors of the theme on screen. */
function palette(tone: ChartTone) {
  return {
    bar: token(tone === 'matsu' ? '--matsu' : '--ai'),
    previous: token('--nezumi'),
    ink: token('--ink'),
    muted: token('--ink-muted'),
    grid: token('--line'),
    surface: token('--paper-raised'),
    font: token('--font-ui'),
    mono: token('--font-mono'),
  }
}

function config({ kind, unit, tone }: ChartOptions, data: SourceData, reduce: boolean): ChartConfiguration {
  let colors = palette(tone)
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
        return `${item.dataset.label ?? ''}: ${value === null ? '–' : formatValue(value, unit)}`
      },
    },
  }
  let valueTicks = { color: colors.muted, font: { family: colors.mono, size: 11 }, callback: (value: number | string) => formatValue(Number(value), unit) }
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
          y: { beginAtZero: true, grid: { color: colors.grid }, border: { display: false }, ticks: { ...valueTicks, maxTicksLimit: 5 } },
        },
        plugins: {
          // The legend draws each series as its mark: a square for the bars, a line for the period before.
          legend: { position: 'top', align: 'end', labels: { color: colors.muted, font, usePointStyle: true, pointStyleWidth: 18, boxHeight: 8 } },
          tooltip,
        },
      },
    } as ChartConfiguration
  }
  let [series] = data.series
  return {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: series?.name ?? '',
          data: series?.values ?? [],
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
        // A share runs from 0 to 100 %, whatever the largest one.
        x: {
          beginAtZero: true,
          ...(unit === 'pct' ? { max: 100 } : {}),
          grid: { color: colors.grid },
          border: { display: false },
          ticks: { ...valueTicks, maxTicksLimit: unit === 'pct' ? 6 : 4 },
        },
        y: {
          grid: { display: false },
          border: { color: colors.grid },
          ticks: { color: colors.ink, font, callback: tickLabel(data.labels) },
        },
      },
      // One series: its title names it, no legend.
      plugins: { legend: { display: false }, tooltip },
    },
  } as ChartConfiguration
}

/** Draws the chart of `source` in `box`, shows the box and folds a table. `destroy()` undoes it. */
export function drawChart(box: HTMLElement, source: HTMLElement, options: ChartOptions): { destroy(): void } {
  let data = options.kind === 'bars' ? withValues(readSource(source)) : readSource(source)
  let caption = (source instanceof HTMLTableElement ? source.caption?.textContent : source.getAttribute('aria-label'))?.trim() || 'Chart'
  let canvas = document.createElement('canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute(
    'aria-label',
    source instanceof HTMLTableElement
      ? `${caption}: chart. The numbers are in the table "Show the data" below.`
      : `${caption}: chart. The numbers are in the list below.`,
  )
  // CSSOM, not a style attribute: the content security policy allows it.
  if (options.kind === 'bars') box.style.setProperty('--rows', String(Math.max(1, data.labels.length)))
  box.append(canvas)
  // Shown before the chart is built: Chart.js measures the box. The table folds only once the chart
  // stands (Fable P3): if Chart.js throws, the box goes and the table stays open.
  box.hidden = false
  let motion = matchMedia('(prefers-reduced-motion: reduce)')
  let chart: Chart
  try {
    chart = new Chart(canvas, config(options, data, motion.matches))
  } catch (error) {
    canvas.remove()
    box.hidden = true
    throw error
  }
  let details = source.closest('details')
  if (details) details.open = false
  let restyle = () => {
    let next = config(options, data, motion.matches)
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
