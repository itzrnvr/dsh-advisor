/**
 * Derive the delivered notes from a session's own event log (fork addition).
 *
 * This is the notes SOURCE OF TRUTH for every read surface (the in-chat
 * strip, the turn tails, the tab's delivered-note rows): notes are committed
 * to the session as user messages with this plugin's producer kind
 * (`source.kind: 'advisor'`), and any view of "what did the advisor say in
 * this session" is a projection of those committed events — never a second
 * in-memory log that can drift or be wiped by a reload.
 *
 * Event shape ground truth (host-verified against a real session log): a
 * `user/message` event carries the message object as `event.data` itself —
 * NOT wrapped in `.message` (that wrapper belongs to `system/message`,
 * `assistant/message` and `tool/result`). The derivation therefore goes
 * through `deriveEventMessage` from `@deepseek-ai/dsh-session`, the same
 * blessed helper the observer's renderer uses, instead of hand-drilling
 * event fields. The first version of this module hand-drilled
 * `event.data.message` — a field that does not exist on `user/message`
 * events — so rehydration silently matched nothing; that is fixed by
 * construction here.
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
 * `at` comes from the session event's own time (never Date.now()) so rows
 * keep their original timestamp. The delivery channel is genuinely
 * unrecoverable from the message (a steer and a committed note write the same
 * shape), so rows default to `commit` — a display-only difference.
 *
 * KNOWN approximation: a turn/end review that finishes very slowly can commit
 * AFTER the following turn has already closed; from the log alone it is then
 * indistinguishable from a review of that later turn. Only rehydration can
 * drift, by at most one turn, and only when the primary outran the reviewer.
 *
 * @module dsh-advisor/seed
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import { isAdvisorMessage } from './kinds.js'

/** One note derived from the session log (wire-compatible with AdvisorNoteView). */
export interface SeededAdvisorNote {
  readonly at: number
  readonly severity: 'nit' | 'concern' | 'blocker'
  readonly text: string
  readonly channel: 'commit' | 'steer'
  readonly turn?: number
}

/** `[advisor:<severity>] <note>` — the one durable cue the message carries. */
const NOTE_PATTERN = /^\[advisor:(nit|concern|blocker)\]\s*([\s\S]*)$/

/** Visible text of a message's text blocks, joined (defensive: malformed rows yield ''). */
function textOf(message: Message): string {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((block) => (block?.type === 'text' ? block.text : ''))
    .join('\n')
}

/** The turn number of a `turn/end` event's data, when well-formed. */
function turnOf(event: SessionEvent): number | undefined {
  const turn = (event.data as { readonly turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

/**
 * Extract the delivered notes from a session event log, oldest → newest.
 * @param events - the session's live event log (already ordered by seq).
 * @returns the derived notes; unparsable advisor rows are skipped.
 */
export function notesFromSessionEvents(events: readonly SessionEvent[]): SeededAdvisorNote[] {
  // Pre-index the turn/end boundaries for the mid-turn attribution below.
  const turnEnds: { readonly seq: number; readonly turn: number }[] = []
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const turn = turnOf(event)
    if (turn !== undefined) turnEnds.push({ seq: event.seq, turn })
  }

  const notes: SeededAdvisorNote[] = []
  let lastEndedTurn: number | undefined
  let humanSinceEnd = false
  /** Assistant output already produced since the next turn's opening prompt. */
  let assistantSincePrompt = false
  /** Running pointer into `turnEnds` (both advance in seq order) — the pass stays O(events). */
  let turnEndIndex = 0
  for (const event of events) {
    if (event.type === 'turn/end') {
      const turn = turnOf(event)
      if (turn !== undefined) lastEndedTurn = turn
      humanSinceEnd = false
      assistantSincePrompt = false
      continue
    }
    if (event.type === 'assistant/message') {
      if (humanSinceEnd) assistantSincePrompt = true
      continue
    }
    if (event.type !== 'user/message') continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    // Structural safety: a malformed event (or an old wrong shape) can carry
    // no source at all — read defensively, never throw on a bad log row.
    const kind = (message as { readonly source?: { readonly kind?: string } }).source?.kind
    if (kind === 'user') {
      humanSinceEnd = true
      assistantSincePrompt = false
      continue
    }
    if (!isAdvisorMessage(message)) continue
    const match = NOTE_PATTERN.exec(textOf(message))
    if (match === null || match[2].trim().length === 0) continue
    // Two deliveries share the "after a human prompt" position:
    // - a turn/end review is delivered at the START of the next turn, before
    //   that turn produced any output → the turn that just CLOSED;
    // - a mid-turn (step) review commits only after the running turn already
    //   produced assistant output → the turn in progress, i.e. the one that
    //   closes NEXT.
    while (turnEndIndex < turnEnds.length && turnEnds[turnEndIndex]!.seq <= event.seq) turnEndIndex++
    const nextEnd = turnEnds[turnEndIndex]
    const turn = assistantSincePrompt ? nextEnd?.turn : lastEndedTurn
    const at = (event as { readonly time?: unknown }).time
    // A row without an event time cannot be placed in time; skip it rather
    // than render it as 1970.
    if (typeof at !== 'number') continue
    notes.push({
      at,
      severity: match[1] as 'nit' | 'concern' | 'blocker',
      text: match[2].trim(),
      channel: 'commit',
      ...(turn === undefined ? {} : { turn }),
    })
  }
  return notes
}
