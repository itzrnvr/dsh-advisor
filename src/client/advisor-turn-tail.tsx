/**
 * Advisor turn-tail row (fork addition) — the INLINE chat surface for the
 * reviewer's advice. Registered into the live `conversation.chat.turnTail`
 * list slot, whose owner props are `{ turn, seq, openFile }`: the entry is
 * rendered at the end of a completed Turn, beside the other turn-tail
 * contributions (deliverables, plan, schedule). Notes delivered for that
 * turn appear right in the message flow — no trajectory viewer, no separate
 * tab.
 *
 * The host attributes each delivered note to the last completed Agent turn
 * (`AdvisorNoteView.turn`), so this component simply filters the session's
 * notes by `turn.turn`. The polling controller is SHARED per session with
 * the dock fallback, so one poll feeds every surface.
 *
 * Renders null while there is nothing for this turn — an entry without
 * content is explicitly supported by the slot contract.
 */

import { useEffect, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AdvisorNotesController, AdvisorNotesState } from './advisor-notes-store.ts'
import type { AdvisorKey } from './locales.ts'
import styles from './advisor-turn-tail.module.css'

/** Injected dependencies (one face per session scope binding). */
export interface AdvisorTurnTailInjected {
  /** The session this occurrence is bound to. */
  readonly sessionId: string
  /** The shared per-session notes controller. */
  readonly controller: AdvisorNotesController
  /** Bare snapshot source the renderer binds as the `useSnapshot` hook. */
  readonly hooks: {
    readonly snapshot: SnapshotStore<AdvisorNotesState>
  }
}

/**
 * Owner props supplied by the chat flow for one completed Turn (typed
 * locally: the chat slot contract lives in the shipped chat package, which is
 * not a plugin peer). `turn.turn` is the Agent turn number.
 */
export interface AdvisorTurnTailOwnerProps {
  readonly turn: { readonly turn: number }
  readonly seq: number
}

/** Props the renderer binds: the owner turn, locale seat, and injected face. */
export type AdvisorTurnTailProps =
  AdvisorTurnTailOwnerProps
  & AdvisorTurnTailInjected
  & {
    /** Synthesized locale seat for the `settings.advisor` namespace. */
    readonly t: (key: AdvisorKey) => string
    /** Renderer-bound selector hook over the injected snapshot. */
    readonly useSnapshot: <T>(selector: (state: AdvisorNotesState) => T) => T
  }

/**
 * Render this turn's advisor notes inline, or null when none were delivered.
 * @param props - the chat flow's turn owner props plus the injected face.
 * @returns the inline note rows or null.
 */
export function AdvisorTurnTail(props: AdvisorTurnTailProps): ReactNode {
  const { controller, useSnapshot, t, turn } = props
  const state = useSnapshot((s) => s)

  useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  const notes = state.notes.filter((note) => note.turn === turn.turn)
  if (state.status !== 'ready' || notes.length === 0) return null

  return (
    <div className={styles['wrap']} data-advisor-turn-tail="">
      <div className={styles['head']}>
        <span className={styles['glyph']} aria-hidden="true">✦</span>
        <span className={styles['title']}>{t('notesTitle')}</span>
      </div>
      {notes.map((note, index) => (
        <div key={`${note.at}-${index}`} className={styles['row']}>
          <span className={`${styles['dot']} ${styles[note.severity]}`} aria-hidden="true" />
          <span className={styles['severity']}>{note.severity}</span>
          <span className={styles['text']}>{note.text}</span>
        </div>
      ))}
    </div>
  )
}