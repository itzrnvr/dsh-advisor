/**
 * Advisor turn-tail row (fork addition) — the INLINE chat surface for the
 * reviewer's advice. Registered into the live `conversation.chat.turnTail`
 * list slot, whose owner props are `{ turn, seq, openFile }`: the entry is
 * rendered at the end of a completed Turn, beside the other turn-tail
 * contributions (deliverables, plan, schedule). Notes delivered for that
 * turn appear right in the message flow — no trajectory viewer, no separate
 * tab.
 *
 * The host attributes each delivered note to the turn it reviewed
 * (`AdvisorNoteView.turn`, derived from the session log), so this component
 * simply filters the session's notes by `turn.turn`. The polling controller
 * is SHARED per session with the dock fallback, so one poll feeds every
 * surface.
 *
 * BOUNDED (fork fix): one turn can carry dozens of notes (57 observed in a
 * live turn), and every row opens with its full body — an uncapped tail would
 * be a wall. Past {@link TURN_TAIL_MAX} rows the tail collapses into a
 * '+N more' reveal; the hidden rows stay one click away, nothing is lost.
 *
 * Renders null while there is nothing for this turn — an entry without
 * content is explicitly supported by the slot contract.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AdvisorNotesController, AdvisorNotesState } from './advisor-notes-store.ts'
import { AdvisorNoteRow } from './advisor-note-node.tsx'
import type { AdvisorKey } from './locales.ts'
import styles from './advisor-note-node.module.css'

/** Most note rows one turn tail shows before collapsing into '+N more'. */
const TURN_TAIL_MAX = 5

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
    readonly t: (key: AdvisorKey, params?: Record<string, string | number>) => string
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
  const [showAll, setShowAll] = useState(false)
  // Subscribe to the exact slices this surface needs: the notes array only
  // changes when the host payload actually changed (the controller guards
  // identical polls), so a 4 s tick no longer re-renders every mounted tail.
  const status = useSnapshot((s) => s.status)
  const notes = useSnapshot((s) => s.notes)

  useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  const turnNotes = notes.filter((note) => note.turn === turn.turn)
  if (status !== 'ready' || turnNotes.length === 0) return null

  // Reuse the same collapsible note card as a chat row; the turn-tail seat
  // guarantees the note renders at the end of the turn it reviewed (the chat
  // node seat could not: the inbox commits the note inside the NEXT turn, and
  // the flow groups nodes by their turn location, not by anchorSeq alone).
  //
  // NEWEST WINDOW when a turn carries more than the cap: the notes a user has
  // just watched arrive in the dock strip (the open turn) must not vanish when
  // that turn closes — the newest ones stay visible and the OLDER ones wait
  // behind the reveal above them. Order INSIDE the window stays chronological
  // (oldest → newest), so the cards read as they were given.
  const shown = showAll || turnNotes.length <= TURN_TAIL_MAX
    ? turnNotes
    : turnNotes.slice(-TURN_TAIL_MAX)
  const hidden = turnNotes.length - shown.length
  return (
    <>
      {hidden > 0 && (
        <button
          type="button"
          className={styles.toggle ?? ''}
          onClick={() => { setShowAll(true) }}
        >
          {t('notesEarlier', { count: hidden })}
        </button>
      )}
      {shown.map((note) => (
        <AdvisorNoteRow key={`${note.at}-${note.text.length}`} node={{ data: note }} t={t} />
      ))}
    </>
  )
}
