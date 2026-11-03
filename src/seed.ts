/**
 * Rehydrate the delivered-notes log from a session's own event log (fork
 * addition). Used after a plugin reload/remount, when the in-memory log is
 * gone: opening an older session must show the notes it already received
 * instead of an empty surface that only fills on the next review.
 *
 * Attribution reconstruction: the turn a note REVIEWED is not stored on the
 * message (the durable source shape is untouched), so it is derived from the
 * note's position relative to turn boundaries:
 *
 * - a note committed AFTER the next turn's human prompt is the review of the
 *   turn that just closed → the last `turn/end` before it;
 * - a note committed while the agent is still working (no human prompt since
 *   the boundary) is a mid-turn step review → the turn that closes next;
 * - agentic sessions with no turn/end at all stay turn-less (the client's
 *   session strip renders those).
 *
 * `at` comes from the session event's own time (never Date.now()) so
 * rehydrated rows keep their original timestamp; the delivery channel is
 * genuinely unrecoverable from the message (inject and steer commit the same
 * shape), so rehydrated rows default to `inject` — a display-only difference.
 *
 * KNOWN approximation: a turn/end review that finishes very slowly can commit
 * AFTER the following turn has already closed; from the log alone it is then
 * indistinguishable from a review of that later turn. The live path is exact
 * (the delta carries the reviewed turn); only rehydration can drift, by at
 * most one turn, and only when the primary outran the reviewer.
 *
 * @module dsh-advisor/seed
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One note rehydrated from the session log (wire-compatible with AdvisorNoteView). */
export interface SeededAdvisorNote {
  readonly at: number
  readonly severity: 'nit' | 'concern' | 'blocker'
  readonly text: string
  readonly channel: 'inject' | 'steer'
  readonly turn?: number
}

/** `[advisor:<severity>] <note>` — the one durable cue the message carries. */
const NOTE_PATTERN = /^\[advisor:(nit|concern|blocker)\]\s*([\s\S]*)$/

interface NoteEvent {
  readonly index: number
  readonly seq: number
  readonly at: number
}

/**
 * Extract the delivered notes from a session event log, oldest → newest.
 * @param events - the session's live event log (already ordered by seq).
 * @returns the rehydrated notes; unparsable advisor rows are skipped.
 */
export function seedNotesFromEvents(events: readonly SessionEvent[]): SeededAdvisorNote[] {
  const turnEnds: { readonly seq: number; readonly turn: number }[] = []
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const turn = (event.data as { readonly turn?: unknown }).turn
    if (typeof turn === 'number') turnEnds.push({ seq: event.seq, turn })
  }

  const notes: SeededAdvisorNote[] = []
  let lastEndedTurn: number | undefined
  let humanSinceEnd = false
  for (const event of events) {
    if (event.type === 'turn/end') {
      const turn = (event.data as { readonly turn?: unknown }).turn
      if (typeof turn === 'number') lastEndedTurn = turn
      humanSinceEnd = false
      continue
    }
    if (event.type !== 'user/message') continue
    const message = (event.data as {
      readonly message?: {
        readonly source?: { readonly kind?: string }
        readonly content?: readonly { readonly type?: string; readonly text?: string }[]
      }
    }).message
    const kind = message?.source?.kind
    if (kind === 'user') {
      humanSinceEnd = true
      continue
    }
    if (kind !== 'advisor' && kind !== 'plugin:advisor') continue
    const text = (message?.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
    const match = NOTE_PATTERN.exec(text)
    if (match === null || match[2].trim().length === 0) continue
    // Mid-turn reviews take the turn that closes NEXT; turn-end reviews take
    // the turn that just closed (a human prompt was seen after the boundary).
    const nextEnd = humanSinceEnd ? undefined : turnEnds.find((entry) => entry.seq > event.seq)
    const turn = humanSinceEnd ? lastEndedTurn : (nextEnd?.turn ?? lastEndedTurn)
    const at = (event as { readonly time?: unknown }).time
    // A row without an event time cannot be placed in time; skip it rather
    // than render it as 1970.
    if (typeof at !== 'number') continue
    notes.push({
      at,
      severity: match[1] as 'nit' | 'concern' | 'blocker',
      text: match[2].trim(),
      channel: 'inject',
      ...(turn === undefined ? {} : { turn }),
    })
  }
  return notes
}