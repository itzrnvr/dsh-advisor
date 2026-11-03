/**
 * Advisor session fallback strip (fork addition) — the surface for notes that
 * carry NO turn number.
 *
 * Turn-scoped notes render inline in the reviewed turn's tail. Notes
 * committed while a turn is still OPEN (mid-turn step reviews, and sessions
 * that never emit turn/end) have no tail yet, so they render here until the
 * turn closes — the next poll then attributes them to that turn and the tail
 * takes over (one owner at a time).
 *
 * HEIGHT IS BOUNDED (fork fix): the strip sits BELOW the composer card in the
 * dock (and in the sidechat split), so it must never push the composer up.
 * Rows render COLLAPSED by default (header line only) and the section itself
 * is capped with an internal scrollbar — even a wall of 4000-char notes keeps
 * the composer in place. The dismiss button hides the strip for the page
 * lifetime.
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
  const dismissed = useSnapshot((s) => s.dismissed)

  useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  const untagged = notes.filter((note) => note.turn === undefined)
  if (status !== 'ready' || dismissed || untagged.length === 0) return null
  // Bounded twice over: rows render collapsed by default (a header line each,
  // expanded manually), and the section's height is capped by CSS with an
  // internal scrollbar — a long agentic session can never push the composer
  // off-screen.
  const shown = untagged.slice(-MAX_STRIP_NOTES)
  const hidden = untagged.length - shown.length

  return (
    <section className={styles.wrap ?? ''} aria-label={t('notesTitle')}>
      <div className={styles.title ?? ''}>
        <span>{t('notesTitle')}</span>
        <button
          type="button"
          className={styles.dismiss ?? ''}
          aria-label={t('notesDismiss')}
          title={t('notesDismiss')}
          onClick={() => { controller.dismiss() }}
        >
          ×
        </button>
      </div>
      {shown.map((note, index) => (
        <AdvisorNoteRow key={`${note.at}-${index}`} node={{ data: note }} t={t} defaultCollapsed />
      ))}
      {hidden > 0 && <div className={styles.more ?? ''}>{t('notesMore', { count: hidden })}</div>}
    </section>
  )
}
