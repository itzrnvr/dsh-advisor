/**
 * Advisor notes strip (fork addition) — the in-chat surface for what the
 * reviewer actually said. The host commits advisor notes to the session log
 * as `source.kind: 'advisor'` user messages, which the stock chat view does
 * not render in the conversation stream; the ONLY stock way to see them was
 * the trajectory viewer. This dock occupant (registered into the SAME
 * `conversation.composer.dock` list slot as the next-prompt tip) surfaces the
 * latest delivered note directly under the composer, with click-to-expand
 * history (last 10) and a dismiss control.
 *
 * Read-only: it fetches `/api/advisor/notes` through the shared controller
 * (polling every few seconds while mounted) and never touches the session,
 * the config, or the reviewer runtime.
 */

import { useEffect, type ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AdvisorNotesController, AdvisorNotesState } from './advisor-notes-store.ts'
import styles from './advisor-notes.module.css'

/** Injected dependencies of {@link AdvisorNotesDock} (built per session binding). */
export interface AdvisorNotesInjected {
  /** The session this occurrence is bound to (framework-resolved). */
  readonly sessionId: string
  /** The per-session notes controller (one per binding). */
  readonly controller: AdvisorNotesController
  /** Bare snapshot source the renderer binds as the `useSnapshot` hook. */
  readonly hooks: {
    readonly snapshot: SnapshotStore<AdvisorNotesState>
  }
}

/** Props the renderer binds: the localized `t` seat and the injected face. */
export type AdvisorNotesProps =
  PropsLocale<'settings.advisor'>
  & InjectFace<AdvisorNotesInjected>

/**
 * Render the delivered-note strip, or nothing when there is nothing to show
 * (not ready, no notes yet, or dismissed for this page lifetime).
 * @param props - slot-delivered injected dependencies and the `t` seat.
 * @returns the strip occupant or null.
 */
export function AdvisorNotesDock(props: AdvisorNotesProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const state = useSnapshot((s) => s)

  // Poll while mounted; the controller owns the timer so a re-render never
  // stacks intervals.
  useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  // Fork addition: turn-driven sessions render notes inline at each turn's
  // tail; the dock is the fallback surface for notes the host could not
  // attribute to a turn (agentic sessions without turn/end).
  const unattributed = state.notes.filter((note) => note.turn === undefined)
  if (state.dismissed || state.status !== 'ready' || unattributed.length === 0) return null
  const latest = unattributed[unattributed.length - 1]
  if (latest === undefined) return null
  const shown = [...unattributed].reverse().slice(0, 10)
  const extra = unattributed.length - 1

  return (
    <div className={styles['wrap']} data-advisor-notes="">
      <div className={styles['bar']}>
        <button
          type="button"
          className={styles['row']}
          aria-expanded={state.expanded}
          onClick={() => controller.toggleExpanded()}
        >
          <span className={`${styles['dot']} ${styles[latest.severity]}`} aria-hidden="true" />
          <span className={styles['label']}>{t('notesTitle')}</span>
          <span className={styles['summary']}>{latest.text}</span>
          {extra > 0 ? <span className={styles['meta']}>+{extra}</span> : null}
        </button>
        <button
          type="button"
          className={styles['dismiss']}
          aria-label={t('notesDismiss')}
          title={t('notesDismiss')}
          onClick={() => controller.dismiss()}
        >
          ×
        </button>
      </div>
      {state.expanded ? (
        <div className={styles['list']} role="list">
          {shown.map((note, index) => (
            <div key={`${note.at}-${index}`} className={styles['item']} role="listitem">
              <span className={`${styles['dot']} ${styles[note.severity]}`} aria-hidden="true" />
              <span className={styles['time']}>{new Date(note.at).toLocaleTimeString()}</span>
              <span className={styles['text']}>{note.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}