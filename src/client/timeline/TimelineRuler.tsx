/**
 * client/timeline/TimelineRuler.tsx — the normalized 0..1 time ruler
 * (0/25/50/75/100% ticks). Display-only; all editing happens on the lanes.
 */
import type { JSX } from 'react'
import styles from './timeline.module.css'

const TICKS = [0, 25, 50, 75, 100] as const

export function TimelineRuler(): JSX.Element {
  return (
    <div className={styles.ruler} aria-hidden="true">
      {TICKS.map((tick) => (
        <span key={tick} className={styles.rulerTick} style={{ left: `${tick}%` }}>
          {tick}%
        </span>
      ))}
    </div>
  )
}
