/**
 * Derive the delivered notes from a session's own event log (fork addition).
 *
 * This is the notes SOURCE OF TRUTH for every read surface (the turn tails,
 * the tab's delivered-note rows): notes are committed
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
 * - a note committed AFTER the next turn's opening human prompt (and before
 *   that turn produced output) is the review of the turn that just closed →
 *   the last `turn/end` before it;
 * - a note committed while the agent is still working is a mid-turn step
 *   review → the turn that closes next (the OPEN turn while it runs);
 * - a human message that arrives WHILE a turn is open is STEERING into that
 *   turn, not a turn boundary: it does not reset the mid-turn attribution
 *   state (without this rule a note following a mid-turn steer fell back to
 *   the already-closed turn — one note in 249 did exactly that in a live
 *   log); with no open turn the old reset semantics apply;
 * - agentic sessions with no turn/end at all stay turn-less (no surface
 *   renders those today — the turn tails need a turn, and the above-composer
 *   strip that once showed untagged notes was removed in 0.6.49).
 *
 * HOST FACT (verified 2026-11-04 against the shipped chat bundle,
 * `tailData()`): the host's turn-tail node EXISTS ONLY ONCE THE TURN ENDED —
 * `tailData` returns null while a turn is open, so `conversation.chat.turnTail`
 * never renders for the running turn. Do NOT re-propose an "openTurn
 * fallback" that renders untagged notes under the live turn's tail: the slot
 * is not mounted there, the change would be dead code and cost a restart
 * cycle to discover that (it happened). The only live-turn surfaces the host
 * offers plugins are outside the chat flow (`conversation.input.dock` above
 * the composer — removed by user ruling 0.6.49 — and `conversation.view`
 * tabs). Untagged notes therefore become visible exactly when their turn
 * closes and the derivation tags them.
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
  /**
   * The committed message's own one-line account (`source.summary`) — the
   * same field dsh-ttsr puts on its injected reminders, so a collapsed row
   * can show WHAT the note was about without opening it.
   */
  readonly summary?: string
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
 * The committed message's own one-line account (`source.summary`) — the field
 * dsh-ttsr sets on its injected reminders so a collapsed row can say what
 * the injection was about. Absent on older notes (pre-summary) → undefined.
 */
function summaryOf(message: Message): string | undefined {
  const summary = (message.source as { readonly summary?: unknown }).summary
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : undefined
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
  /** The turn a `turn/start` opened and no `turn/end` has closed yet. */
  let openTurn: number | undefined
  /** Running pointer into `turnEnds` (both advance in seq order) — the pass stays O(events). */
  let turnEndIndex = 0
  for (const event of events) {
    if (event.type === 'turn/end') {
      const turn = turnOf(event)
      if (turn !== undefined) lastEndedTurn = turn
      openTurn = undefined
      humanSinceEnd = false
      assistantSincePrompt = false
      continue
    }
    if (event.type === 'turn/start') {
      const turn = turnOf(event)
      if (turn !== undefined) openTurn = turn
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
      // A human message while a turn is OPEN is steering into that turn, not
      // a turn boundary: keep the mid-turn attribution state, or the next
      // note would fall back to the already-closed turn (observed live: one
      // note in 249 landed a turn early through a mid-turn steer). With no
      // open turn (session start, turn-less agentic sessions) the old reset
      // semantics apply.
      if (openTurn === undefined) assistantSincePrompt = false
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
      ...(summaryOf(message) === undefined ? {} : { summary: summaryOf(message) }),
    })
  }
  return notes
}
