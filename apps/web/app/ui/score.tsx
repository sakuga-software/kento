import type { Handle } from 'remix/component'

/** The bands of a confidence score: its colour. The number and the marks say the same. */
export type ScoreBand = 'high' | 'mid' | 'low'

/** 4 and 5 are high, 3 is in the middle, 1 and 2 are low; an average takes the band of its value. */
export function scoreBand(value: number): ScoreBand {
  return value >= 3.5 ? 'high' : value >= 2.5 ? 'mid' : 'low'
}

/** "4/5" for a score, "4.2/5" for an average. */
export function scoreText(value: number, average: boolean): string {
  return `${average ? value.toFixed(1) : String(Math.round(value))}/5`
}

export interface ScoreProps {
  /** The confidence score of a review (1 to 5), or an average of them. */
  value: number
  /** An average: the number keeps one decimal. */
  average?: boolean
  /** What the number is, for the pointer (`title`): "Average of 12 reviews over 30 days". */
  title?: string
}

/**
 * KNT-183, KNT-187. A confidence score as a picture: five marks, filled up to the score (rounded),
 * in the colour of its band, and the number beside them. The number carries the value, for a
 * screen reader too; the marks and the colour only repeat it (aria-hidden). No inline style (CSP):
 * a class on the box says how many marks are filled, and kento.css draws them. The same on the
 * Repos screen (the average of 30 days) and on the dashboard (the score of each review).
 */
export function Score(handle: Handle<ScoreProps>) {
  return () => {
    let { value, average = false, title } = handle.props
    let filled = Math.max(0, Math.min(5, Math.round(value)))
    return (
      <span class={`score score-${scoreBand(value)} score-n${filled}`} title={title}>
        <span class="score-marks" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
          <span></span>
          <span></span>
        </span>
        <span class="score-value">{scoreText(value, average)}</span>
      </span>
    )
  }
}
