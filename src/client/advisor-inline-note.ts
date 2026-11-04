/**
 * 0.6.50 — INLINE LIVE ADVISOR NOTES (user ruling 2026-11-04: "THEY SHOULD
 * IMMEDIATELY RENDER INLINE WHILE RIGHT WHEN THEY APPEAR IN TRAJECTORY TRACE,
 * NOT AFTER THE TURN COMPLETES BUT IN BETWEEN STEPS AND ONE MORE IMPORTANT
 * THING IS WE NEED TO MAKE IT BLOCKING — THIS WAY EVERYTHING MUST APPEAR
 * INLINE AND IN THE ORDER THEY ARRIVE").
 *
 * The blocking half shipped in 0.6.48 (the pre-step gate holds the next step
 * until the review lands). This module fixes the DISPLAY half: until now the
 * only surfaces were the closed-turn tail (the host's `tailData()` returns
 * null while a turn is open — proven against the shipped chat bundle, see the
 * HOST FACT in src/seed.ts) and the removed above-composer strip. Advisor
 * messages themselves are hidden from the chat flow by the host's
 * `isVisibleChatNode` (kind `context`), so the committed note was invisible
 * until the turn closed and the tail grouped it — the wall the user sees.
 *
 * The host's conversation engine exposes a public extension surface for
 * exactly this: `uiConversation.events.register(definition)` contributes a
 * NODE for matched session events (the host's own turn-tail/goals/deliverables
 * rows are built through the same API), and every chat node renders through
 * the keyed `conversation.chat.node` slot by `node.kind` — with a JSON
 * fallback for kinds nobody renders. This module:
 *
 * 1. registers kind `advisor-note`: matches committed advisor `user/message`
 *    events (source.kind `advisor`, `[advisor:<severity>] <text>` body),
 *    publishes IMMEDIATELY (the node appears the moment the note commits —
 *    mid-turn, between steps, in arrival order), anchors at the event's own
 *    seq (the flow position IS the delivery position), and carries the parsed
 *    severity/text/summary/at data;
 * 2. registers the `conversation.chat.node` renderer for that entryKey,
 *    drawing the same collapsible note card the tails used (AdvisorNoteRow).
 *
 * Conditional by service presence: the wiring injects `uiConversation` and
 * activates ONLY when the host provides it (older shells no-op cleanly and
 * keep the closed-turn tails). `index.ts` owns the either/or: inline nodes
 * when available, tails as the fallback — never both (no double render).
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Producer kind of every committed advisor note (src/kinds.ts ADVISOR_PLUGIN_ID). */
const ADVISOR_SOURCE_KIND = 'advisor'

/** `[advisor:<severity>] <note>` — the one durable cue the message carries. */
const NOTE_PATTERN = /^\[advisor:(nit|concern|blocker)\]\s*([\s\S]*)$/

/** The node kind registered with the conversation engine + the slot entryKey. */
export const ADVISOR_NOTE_KIND = 'advisor-note'

/** Slot the host routes EVERY chat node through, keyed by node.kind. */
export const CHAT_NODE_SLOT = 'conversation.chat.node'

/** Parsed note payload carried by the node (rendered by the slot entry). */
export interface AdvisorInlineNote {
  readonly seq: number
  readonly at: number
  readonly severity: 'nit' | 'concern' | 'blocker'
  readonly text: string
  readonly summary?: string
}

/**
 * Derive the inline node payload from one session event, or undefined when
 * the event is not a committed advisor note. Pure and defensive: malformed
 * rows (no source, no text blocks, empty note) yield undefined and the
 * framework never sees them.
 */
export function deriveInlineNote(event: SessionEvent | unknown): AdvisorInlineNote | undefined {
  const e = event as { readonly type?: unknown; readonly seq?: unknown; readonly time?: unknown; readonly data?: unknown }
  if (e.type !== 'user/message') return undefined
  const data = e.data as {
    readonly source?: { readonly kind?: unknown; readonly summary?: unknown }
    readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[]
  } | undefined
  if (data?.source?.kind !== ADVISOR_SOURCE_KIND) return undefined
  if (typeof e.seq !== 'number' || typeof e.time !== 'number') return undefined
  const text = (Array.isArray(data.content) ? data.content : [])
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
  const match = NOTE_PATTERN.exec(text.trim())
  if (match === null || match[2].trim().length === 0) return undefined
  const summary = data.source.summary
  return {
    seq: e.seq,
    at: e.time,
    severity: match[1] as 'nit' | 'concern' | 'blocker',
    text: match[2].trim(),
    ...(typeof summary === 'string' && summary.trim().length > 0 ? { summary: summary.trim() } : {}),
  }
}

/** Minimal view of the conversation engine service used here (typed loosely:
 * the service lives in the host's conversation bundle, not a plugin peer). */
export interface UiConversationEvents {
  register(definition: unknown): unknown
}

export interface UiConversationLike {
  readonly events: UiConversationEvents
}

/**
 * Build the node Definition for the conversation engine — shaped exactly like
 * the host's own chat definitions (kind/target/match/start/publication/
 * buildViewNode). `match` claims advisor-note user/message events; `start`
 * derives the payload; publication is `immediate` so the node lands the moment
 * the event is appended (mid-turn, live); buildViewNode returns the final chat
 * node the flow renders (visibility `visible` — this is a plugin-OWNED node,
 * not the hidden context row the host builds from the same message).
 */
export function buildAdvisorNoteDefinition() {
  return {
    kind: ADVISOR_NOTE_KIND,
    target: 'chat',
    /**
     * Claim only committed advisor notes; every other event yields null.
     * The framework enriches the returned `{id, role}` into a match carrying
     * the `event` itself (the host's own definitions read `match.event`), so
     * the payload is derived in `start` from the event, never smuggled here.
     * ROLE: 'start' — the id is the event's own seq, so this context opens
     * exactly once per note and the engine's duplicate-seq guard in
     * mergeMatches can never fire for it (verified against the shipped
     * conversation bundle; the host's own definitions likewise key 'start'
     * to the single event that opens each id).
     * Defensive: any throw contributes null — the flow never breaks on a
     * malformed row.
     */
    match: (event: SessionEvent | unknown) => {
      try {
        if (deriveInlineNote(event) === undefined) return null
        const seq = (event as { readonly seq?: unknown }).seq
        return { id: String(seq), role: 'start' }
      } catch {
        return null
      }
    },
    start: (_context: unknown, match: { readonly event?: unknown }) => {
      try {
        return deriveInlineNote(match?.event)
      } catch {
        return undefined
      }
    },
    /**
     * Idempotent update (engine contract verified: replay rebuilds state
     * from the existing matches array and never re-opens a context, so this
     * is only reached if a future engine ever folds another match into this
     * one-context id): re-derive from the delivered event — the same note
     * for the same seq, a different valid note row replaces it cleanly.
     * Never throws.
     */
    update: (context: { readonly state?: AdvisorInlineNote }, match: { readonly event?: unknown }) => {
      try {
        return deriveInlineNote(match?.event) ?? context.state
      } catch {
        return context.state
      }
    },
    /** Live: publish the node the moment the note commits — no turn boundary. */
    publication: () => 'immediate' as const,
    /**
     * The framework hands the definition context the stable key/id/location
     * of the matched event; the node mirrors the host's chatNode shape:
     * { key, kind, id, target, anchorSeq, location, visibility, groupTree,
     * data }. anchorSeq = the event seq → the card sits exactly where the
     * note landed in the log: between the steps it was delivered between.
     */
    buildViewNode: (context: {
      readonly key?: string
      readonly id?: string
      readonly state?: AdvisorInlineNote
      readonly start?: { readonly event?: unknown; readonly location?: unknown }
      readonly matches?: readonly { readonly event?: unknown; readonly location?: unknown }[]
    }) => {
      try {
        const data = context.state
        if (data === undefined) return null
        const location = context.start?.location ?? context.matches?.[0]?.location
        return {
          key: context.key ?? `advisor-note-${data.seq}`,
          kind: ADVISOR_NOTE_KIND,
          id: context.id ?? `advisor-note-${data.seq}`,
          target: 'chat',
          anchorSeq: data.seq,
          ...(location === undefined ? {} : { location }),
          visibility: 'visible',
          groupTree: 'turn',
          data,
        }
      } catch {
        return null
      }
    },
  }
}
