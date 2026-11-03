/**
 * Advisor note card (fork addition) — the readable, collapsible advice row
 * rendered by the turn-tail seat at the end of the turn the note reviewed.
 *
 * The body renders in full (no line clamp; the extraction bound is 4000
 * chars) and can be collapsed from the header.
 */

import { useState, type ReactNode } from 'react'
import type { AdvisorKey } from './locales.ts'
import { en } from './locales.ts'
import styles from './advisor-note-node.module.css'

/** The severity vocabulary the runtime emits. */
type NoteSeverity = 'nit' | 'concern' | 'blocker'

/** Business data carried by one advisor note. */
export interface AdvisorNoteData {
  readonly text: string
  readonly severity: NoteSeverity
  readonly at: number
}

/** Props the turn-tail renderer binds for one note row. */
export interface AdvisorNoteRowProps {
  readonly node?: { readonly id?: string; readonly data?: AdvisorNoteData }
  readonly t?: (key: AdvisorKey) => string
  /**
   * Start the row collapsed (fork fix): the dock strip renders this row BELOW
   * the composer, so its rows must never open with a multi-thousand-pixel
   * body. The turn tails keep the expanded default — they sit in the message
   * flow, where full height is free.
   */
  readonly defaultCollapsed?: boolean
}

/**
 * Render one advisor note as a readable card: a header with the severity
 * marker, label, time and collapse toggle, then the full note body (wrapped,
 * never clamped).
 * @param props - the note data and the locale seat.
 * @returns the card, or null for a row without data.
 */
export function AdvisorNoteRow(props: AdvisorNoteRowProps): ReactNode {
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed === true)
  const data = props.node?.data
  if (data === undefined) return null
  const t = props.t ?? ((key: AdvisorKey) => en[key])
  const at = new Date(data.at)
  const toggleLabel = t(collapsed ? 'notesExpand' : 'notesCollapse')
  return (
    <section className={`${styles['row']} ${styles[data.severity]}`} data-advisor-note="">
      <div className={styles['head']}>
        <span className={styles['dot']} aria-hidden="true" />
        <span className={styles['label']}>{t('notesTitle')}</span>
        <span className={styles['pill']}>{data.severity}</span>
        <time className={styles['time']} dateTime={at.toISOString()}>
          {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        <button
          type="button"
          className={styles['toggle']}
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => setCollapsed((value) => !value)}
        >
          {toggleLabel}
        </button>
      </div>
      {collapsed ? null : <p className={styles['text']}>{data.text}</p>}
    </section>
  )
}