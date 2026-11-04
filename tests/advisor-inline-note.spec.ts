/**
 * 0.6.50 — inline live advisor notes: the derivation (deriveInlineNote) and
 * the conversation-engine Definition contract (buildAdvisorNoteDefinition)
 * that turns committed advisor `user/message` events into chat nodes that
 * publish the moment the note lands (mid-turn, between steps, in arrival
 * order) instead of waiting for the closed-turn tail.
 *
 * Fixture shape is the REAL host envelope, same pin as tests/seed.test.ts:
 * a `user/message` event carries the message object as `event.data` ITSELF
 * (content/source/role/id at the top of data — NOT wrapped in `.message`).
 * Derivation tests must never drift from that shape again.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ADVISOR_NOTE_KIND,
  CHAT_NODE_SLOT,
  buildAdvisorNoteDefinition,
  deriveInlineNote,
} from '../src/client/advisor-inline-note'

let seq = 0
function event(type: string, data: unknown, time = 2_000, surfaceOp?: string): SessionEvent {
  seq += 1
  return { type, seq, time, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } as unknown as SessionEvent
}

/** A committed advisor note — REAL shape (data IS the message) incl. surfaceOp. */
function advisorNoteEvent(text = '[advisor:concern] check the edge case', time = 2_000): SessionEvent {
  return event('user/message', {
    id: `note-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'advisor', form: 'notice', summary: text.slice(0, 60) },
  }, time, 'append')
}

const def = buildAdvisorNoteDefinition()

describe('deriveInlineNote — committed advisor note parsing', () => {
  it('parses a well-formed committed note from the real host envelope', () => {
    seq = 0
    const note = deriveInlineNote(event('user/message', {
      id: 'note-1',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:concern] check the edge case' }],
      source: { kind: 'advisor', form: 'notice', summary: '[concern] check the edge' },
    }, 4_321, 'append'))
    expect(note).toEqual({
      seq: 1,
      // `at` is the EVENT's own time (the delivery position in the log),
      // never a payload time.
      at: 4_321,
      severity: 'concern',
      text: 'check the edge case',
      summary: '[concern] check the edge',
    })
  })

  it('recognizes all three severities', () => {
    for (const severity of ['nit', 'concern', 'blocker'] as const) {
      seq = 0
      expect(deriveInlineNote(advisorNoteEvent(`[advisor:${severity}] body text`)))
        .toMatchObject({ severity, text: 'body text' })
    }
  })

  it('carries a non-blank source.summary and omits it when absent, blank or not a string', () => {
    seq = 0
    const withSummary = deriveInlineNote(event('user/message', {
      id: 'note-s',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] tighten this' }],
      // Blank-padded summaries are surfaced trimmed (collapsed-row preview).
      source: { kind: 'advisor', form: 'notice', summary: '  one-line account  ' },
    }, 2_000, 'append'))
    expect(withSummary!.summary).toBe('one-line account')

    seq = 0
    const noSummary = deriveInlineNote(event('user/message', {
      id: 'note-n',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] tighten this' }],
      source: { kind: 'advisor', form: 'notice' },
    }, 2_000, 'append'))
    expect(noSummary).toBeDefined()
    expect(noSummary).not.toHaveProperty('summary')

    seq = 0
    const blankSummary = deriveInlineNote(event('user/message', {
      id: 'note-b',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] tighten this' }],
      source: { kind: 'advisor', form: 'notice', summary: '   ' },
    }, 2_000, 'append'))
    expect(blankSummary).not.toHaveProperty('summary')

    seq = 0
    const numericSummary = deriveInlineNote(event('user/message', {
      id: 'note-x',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] tighten this' }],
      source: { kind: 'advisor', form: 'notice', summary: 42 },
    }, 2_000, 'append'))
    expect(numericSummary).not.toHaveProperty('summary')
  })

  it('rejects every event that is not a user/message', () => {
    seq = 0
    // The old wrong `.message`-wrapped shape (assistant convention) must stay
    // rejected on `assistant/message` too — same regression pin as seed.test.
    expect(deriveInlineNote(event('assistant/message', {
      message: {
        id: 'ghost',
        role: 'user',
        content: [{ type: 'text', text: '[advisor:nit] ghost note' }],
        source: { kind: 'advisor', form: 'notice' },
      },
    }))).toBeUndefined()
    expect(deriveInlineNote(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))).toBeUndefined()
  })

  it('rejects user/message rows produced by any source other than the advisor producer', () => {
    seq = 0
    // A plain human prompt.
    expect(deriveInlineNote(event('user/message', {
      id: 'human-1',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] looks like a note but is not' }],
      source: { kind: 'user' },
    }, 2_000, 'append'))).toBeUndefined()
    // Another plugin wearing the marker.
    expect(deriveInlineNote(event('user/message', {
      id: 'other-1',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] forged note' }],
      source: { kind: 'plugin:some-other-plugin' },
    }, 2_000, 'append'))).toBeUndefined()
    // The inline surface claims ONLY the current producer kind; legacy
    // plugin:advisor rows stay on the closed-turn tails (src/seed.ts handles them).
    expect(deriveInlineNote(event('user/message', {
      id: 'legacy-1',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] legacy row' }],
      source: { kind: 'plugin:advisor' },
    }, 2_000, 'append'))).toBeUndefined()
    // No source at all.
    expect(deriveInlineNote(event('user/message', {
      id: 'bare-1',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] sourceless' }],
    }, 2_000, 'append'))).toBeUndefined()
  })

  it('rejects note text that does not match the [advisor:<severity>] marker', () => {
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('free-form advice, no marker'))).toBeUndefined()
    // Unknown severity is not a note.
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('[advisor:warning] bad severity'))).toBeUndefined()
    // The marker must anchor at the start of the body.
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('prefix [advisor:nit] marker mid-string'))).toBeUndefined()
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('[advisor] no severity'))).toBeUndefined()
  })

  it('rejects empty or whitespace-only note bodies after the marker', () => {
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('[advisor:nit]'))).toBeUndefined()
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('[advisor:concern]    '))).toBeUndefined()
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('[advisor:blocker] \n \t '))).toBeUndefined()
    // Content with no text block at all derives the empty string.
    seq = 0
    expect(deriveInlineNote(event('user/message', {
      id: 'notext-1',
      role: 'user',
      content: [{ type: 'image', data: 'x' }],
      source: { kind: 'advisor', form: 'notice' },
    }, 2_000, 'append'))).toBeUndefined()
  })

  it('rejects malformed rows: missing seq, missing time, non-array content, missing data', () => {
    const advisorData = {
      id: 'm-1',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] fine body, broken envelope' }],
      source: { kind: 'advisor', form: 'notice' },
    }
    // No seq → no anchor → never claimed.
    expect(deriveInlineNote({ type: 'user/message', time: 1_000, data: advisorData })).toBeUndefined()
    // No time → no delivery stamp.
    expect(deriveInlineNote({ type: 'user/message', seq: 5, data: advisorData })).toBeUndefined()
    // Non-numeric envelope numbers are just as malformed.
    expect(deriveInlineNote({ type: 'user/message', seq: '7', time: 1_000, data: advisorData })).toBeUndefined()
    expect(deriveInlineNote({ type: 'user/message', seq: 7, time: new Date(), data: advisorData })).toBeUndefined()
    // content not an array is read as no content, never as a string body.
    expect(deriveInlineNote({
      type: 'user/message', seq: 7, time: 1_000,
      data: { ...advisorData, content: '[advisor:nit] sneaky string content' },
    })).toBeUndefined()
    // data undefined / null.
    expect(deriveInlineNote({ type: 'user/message', seq: 7, time: 1_000 })).toBeUndefined()
    expect(deriveInlineNote({ type: 'user/message', seq: 7, time: 1_000, data: null })).toBeUndefined()
  })

  it('keeps multi-line note bodies ([\\s\\S] capture) and trims the edges', () => {
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('[advisor:concern] first line\nsecond line')))
      .toMatchObject({ text: 'first line\nsecond line' })
    // Leading/trailing whitespace of the whole body is trimmed away.
    seq = 0
    expect(deriveInlineNote(advisorNoteEvent('  [advisor:nit] alpha\nbeta  \n')))
      .toMatchObject({ text: 'alpha\nbeta' })
    // Multiple text blocks join with newlines and can carry the body.
    seq = 0
    expect(deriveInlineNote(event('user/message', {
      id: 'multi-block',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:blocker] stop here' }, { type: 'text', text: 'and read the diff' }],
      source: { kind: 'advisor', form: 'notice' },
    }, 2_000, 'append')))
      .toMatchObject({ severity: 'blocker', text: 'stop here\nand read the diff' })
  })
})

describe('buildAdvisorNoteDefinition — shape pins', () => {
  it('pins the exported constants used by the slot registration', () => {
    expect(ADVISOR_NOTE_KIND).toBe('advisor-note')
    expect(CHAT_NODE_SLOT).toBe('conversation.chat.node')
  })

  it('contributes kind advisor-note with target chat', () => {
    // The host's assertDefinitionTarget requires `target` and `buildViewNode`
    // to ship TOGETHER — a chat definition without a view builder is rejected
    // at registration, so target 'chat' and the builder are pinned as a pair.
    expect(def.kind).toBe('advisor-note')
    expect(def.target).toBe('chat')
    expect(typeof def.buildViewNode).toBe('function')
  })
})

describe('buildAdvisorNoteDefinition.match — claiming advisor notes', () => {
  it('claims a committed advisor note with { id: String(seq), role: "start" }', () => {
    seq = 0
    expect(def.match(advisorNoteEvent())).toEqual({ id: '1', role: 'start' })
    // The id tracks the event's OWN seq, not a counter of claims.
    expect(def.match(advisorNoteEvent())).toEqual({ id: '2', role: 'start' })
  })

  it('returns null for plain messages, assistant rows and garbage input', () => {
    seq = 0
    expect(def.match(event('user/message', {
      id: 'human-1',
      role: 'user',
      content: [{ type: 'text', text: 'fix it' }],
      source: { kind: 'user' },
    }, 1_000, 'append'))).toBeNull()
    expect(def.match(event('assistant/message', {
      message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }))).toBeNull()
    expect(def.match(null)).toBeNull()
    expect(def.match(undefined)).toBeNull()
    expect(def.match({})).toBeNull()
    // user/message envelope, foreign producer.
    expect(def.match(event('user/message', {
      id: 'other-1',
      role: 'user',
      content: [{ type: 'text', text: '[advisor:nit] not ours' }],
      source: { kind: 'plugin:some-other-plugin' },
    }, 2_000, 'append'))).toBeNull()
  })

  it('never throws on hostile payloads — null data, null blocks, string source, exploding rows', () => {
    // The flow must not break on a malformed row: every payload below is
    // answered with null, not an exception.
    expect(def.match({ type: 'user/message', seq: 1, time: 1, data: null })).toBeNull()
    expect(def.match({
      type: 'user/message', seq: 1, time: 1,
      data: {
        source: { kind: 'advisor' },
        content: [null, undefined, { type: 'text' }, { type: 'text', text: 7 }],
      },
    })).toBeNull()
    expect(def.match({
      type: 'user/message', seq: 1, time: 1,
      data: { source: 'advisor', content: [{ type: 'text', text: '[advisor:nit] string source' }] },
    })).toBeNull()
    const exploding = {
      type: 'user/message', seq: 1, time: 1,
      data: {
        content: [{ type: 'text', text: '[advisor:nit] boom' }],
        get source(): never { throw new Error('hostile row') },
      },
    }
    expect(def.match(exploding)).toBeNull()
  })
})

describe('buildAdvisorNoteDefinition.start — payload derivation', () => {
  it('re-derives the note from match.event (the framework carries the event)', () => {
    seq = 0
    const ev = advisorNoteEvent('[advisor:blocker] stop here')
    const note = def.start(null, { event: ev })
    expect(note).toEqual(deriveInlineNote(ev))
    expect(note).toMatchObject({ severity: 'blocker', text: 'stop here', seq: 1 })
  })

  it('returns undefined when match.event is missing or garbage (defensive)', () => {
    expect(def.start(undefined, {})).toBeUndefined()
    expect(def.start(null, { event: null })).toBeUndefined()
    expect(def.start(null, { event: 'not an event' })).toBeUndefined()
    expect(def.start(null, { event: { type: 'user/message', data: { source: { kind: 'user' } } } })).toBeUndefined()
    // A fully hostile match object never throws.
    expect(def.start(null, null as never)).toBeUndefined()
  })
})

describe('buildAdvisorNoteDefinition.publication — live rendering', () => {
  it('publishes immediately: the node lands the moment the note commits', () => {
    // Live inline rendering is the whole point of 0.6.50 — no turn boundary.
    expect(def.publication()).toBe('immediate')
  })
})

describe('buildAdvisorNoteDefinition.buildViewNode — chat node shape', () => {
  const turnLocation = { kind: 'turn', turn: { turn: 7 } }

  function derivedState(): NonNullable<ReturnType<typeof deriveInlineNote>> {
    seq = 0
    return deriveInlineNote(advisorNoteEvent('[advisor:concern] check the edge case'))!
  }

  it('mirrors the host chatNode shape: kind/target/anchorSeq/visibility/groupTree/data + location passthrough', () => {
    const state = derivedState()
    const node = def.buildViewNode({ key: 'k1', id: 'i1', state, start: { location: turnLocation } })
    expect(node).toEqual({
      key: 'k1',
      kind: 'advisor-note',
      id: 'i1',
      target: 'chat',
      // anchorSeq = the note's own event seq → the card sits exactly where
      // the note landed in the log, between the steps it arrived between.
      anchorSeq: state.seq,
      location: turnLocation,
      visibility: 'visible',
      groupTree: 'turn',
      data: state,
    })
    // The node carries the derived object itself — no copy, no reshape.
    expect(node!.data).toBe(state)
  })

  it('falls back to matches[0].location when start carries none', () => {
    const state = derivedState()
    const matchesLocation = { kind: 'turn', turn: { turn: 3 } }
    // start exists but has no location → matches[0].location wins.
    expect(def.buildViewNode({ key: 'k2', id: 'i2', state, start: {}, matches: [{ location: matchesLocation }] })!.location)
      .toEqual(matchesLocation)
    // No start at all → same fallback.
    expect(def.buildViewNode({ key: 'k2', id: 'i2', state, matches: [{ location: matchesLocation }] })!.location)
      .toEqual(matchesLocation)
  })

  it('omits the location key entirely when neither start nor matches carry one', () => {
    const state = derivedState()
    expect(def.buildViewNode({ key: 'k3', id: 'i3', state })).not.toHaveProperty('location')
    // An empty matches list is not a location either.
    expect(def.buildViewNode({ key: 'k3', id: 'i3', state, matches: [] })).not.toHaveProperty('location')
  })

  it('derives stable key/id from the note seq when the context omits them', () => {
    const state = derivedState()
    const node = def.buildViewNode({ state, start: { location: turnLocation } })
    expect(node).toMatchObject({ key: `advisor-note-${state.seq}`, id: `advisor-note-${state.seq}` })
  })

  it('returns null when there is no derived state', () => {
    expect(def.buildViewNode({})).toBeNull()
    expect(def.buildViewNode({ key: 'k', id: 'i', state: undefined })).toBeNull()
  })

  it('never throws on a garbage context', () => {
    expect(def.buildViewNode(undefined as never)).toBeNull()
    expect(def.buildViewNode(null as never)).toBeNull()
  })
})
