/**
 * Advisor session fallback strip (fork addition) — the surface for notes that
 * carry NO turn number.
 *
 * Turn-scoped notes render inline in the reviewed turn's tail. Sessions
 * without turn numbering (agentic runs that never emit `turn/end`, so neither
 * `reviewedTurn` nor `lastTurn` exists) would otherwise render NOWHERE — this
 * dock entry shows exactly those untagged notes, and nothing else. Turn-tagged
 * notes never appear here, so there is no duplication.
 */

import { useEffect, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AdvisorNotesController, AdvisorNotesState } from './advisor-notes-store.ts'
import { AdvisorNoteRow } from './advisor-note-node.tsx'
import type { AdvisorKey } from './locales.ts'
import styles from './advisor-notes-strip.module.css'

/** Most untagged notes the strip shows (older ones collapse into '+N more'). */
const MAX_STRIP_NOTES = 3

/** Injected dependencies (one face per session scope binding). */
export interface AdvisorNotesStripInjected {
  /** The session this occurrence is bound to. */
  readonly sessionId: string
  /** The shared per-session notes controller. */
  readonly controller: AdvisorNotesController
  /** Bare snapshot source the renderer binds as the `useSnapshot` hook. */
  readonly hooks: {
    readonly snapshot: SnapshotStore<AdvisorNotesState>
  }
}

/** Props the renderer binds: the injected face, locale seat, and snapshot hook. */
export type AdvisorNotesStripProps =
  AdvisorNotesStripInjected
  & {
    /** Synthesized locale seat for the `settings.advisor` namespace. */
    readonly t: (key: AdvisorKey, params?: Record<string, string | number>) => string
    /** Renderer-bound selector hook over the injected snapshot. */
    readonly useSnapshot: <T>(selector: (state: AdvisorNotesState) => T) => T
  }

/**
 * Render the session's turn-less advisor notes (or null when there are none).
 * @param props - the injected face, locale seat and snapshot hook.
 * @returns the strip or null.
 */
export function AdvisorNotesStrip(props: AdvisorNotesStripProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const status = useSnapshot((s) => s.status)
  const notes = useSnapshot((s) => s.notes)

  useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  const untagged = notes.filter((note) => note.turn === undefined)
  if (status !== 'ready' || untagged.length === 0) return null
  // Bounded: the strip sits under the composer (and in the sidechat split), so
  // a long agentic session must not push the composer off-screen.
  const shown = untagged.slice(-MAX_STRIP_NOTES)
  const hidden = untagged.length - shown.length

  return (
    <section className={styles.wrap ?? ''} aria-label={t('notesTitle')}>
      <div className={styles.title ?? ''}>{t('notesTitle')}</div>
      {shown.map((note, index) => (
        <AdvisorNoteRow key={`${note.at}-${index}`} node={{ data: note }} t={t} />
      ))}
      {hidden > 0 && <div className={styles.more ?? ''}>{t('notesMore', { count: hidden })}</div>}
    </section>
  )
}