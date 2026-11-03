/**
 * Notes derivation from the session log (fork addition): the single source
 * of truth every notes view (strip, turn tails) reads. A note committed as a
 * user/message with the advisor producer kind must be recovered with the
 * turn it reviewed, its original event time, and unparsable legacy rows
 * skipped.
 *
 * Fixture shape is the REAL host envelope, verified against a production
 * session log: a `user/message` event carries the message object as
 * `event.data` ITSELF (content/source/role/id at the top of data — NOT
 * wrapped in `.message`, which is the `system/message` / `tool/result`
 * convention). The first version of these fixtures wrapped the message in
 * `.message`, the derivation matched that wrong shape, green tests hid the
 * production miss, and rehydration returned [] for every real session —
 * these fixtures must never drift from the host shape again.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { notesFromSessionEvents } from '../src/seed'

let seq = 0
function event(type: string, data: unknown, time = 1_000, surfaceOp?: string): SessionEvent {
  seq += 1
  return { type, seq, time, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } as unknown as SessionEvent
}

/** A human prompt — REAL shape: the message is `event.data` itself. */
function humanMessage(text: string, time = 1_000): SessionEvent {
  return event('user/message', {
    id: `human-${text}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, time)
}

/** A committed advisor note — REAL shape incl. surfaceOp. */
function advisorMessage(text: string, kind: 'advisor' | 'plugin:advisor' = 'advisor'): SessionEvent {
  return event('user/message', {
    id: `note-${text}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, form: 'notice', summary: text.slice(0, 60) },
  }, 2_000, 'append')
}

function turnEnd(turn: number): SessionEvent {
  return event('turn/end', { turn, reason: { kind: 'completed' } })
}

/** An assistant output — `assistant/message` DOES wrap in `.message`. */
function assistantMessage(text: string): SessionEvent {
  return event('assistant/message', {
    message: { id: `a-${text}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
    turn: 1,
    step: 1,
  })
}

describe('notesFromSessionEvents — turn attribution', () => {
  it('attributes a note committed in the next turn to the turn that closed', () => {
    seq = 0
    const notes = notesFromSessionEvents([
      humanMessage('fix it'),
      assistantMessage('done'),
      turnEnd(1),
      // Next turn starts: the review note is committed after the prompt.
      humanMessage('next question'),
      advisorMessage('[advisor:concern] check the edge case'),
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.turn).toBe(1)
    expect(notes[0]!.severity).toBe('concern')
    expect(notes[0]!.text).toBe('check the edge case')
    // Original event time, never Date.now().
    expect(notes[0]!.at).toBe(2_000)
    expect(notes[0]!.channel).toBe('commit')
  })

  it('attributes a mid-turn note to the turn that closes next', () => {
    seq = 0
    const notes = notesFromSessionEvents([
      humanMessage('fix it'),
      assistantMessage('working'),
      turnEnd(1),
      // Turn 2 opens with its own prompt and already produced output: a note
      // committed mid-turn must attach to the turn IN PROGRESS (2), not to
      // the turn that closed (1).
      humanMessage('turn two'),
      assistantMessage('step one output'),
      advisorMessage('[advisor:nit] tighten the loop'),
      assistantMessage('more work'),
      turnEnd(2),
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.turn).toBe(2)
  })

  it('parses legacy plugin:advisor rows and skips unparsable ones', () => {
    seq = 0
    const notes = notesFromSessionEvents([
      humanMessage('fix it'),
      assistantMessage('done'),
      turnEnd(1),
      humanMessage('again'),
      advisorMessage('[advisor:blocker] stop', 'plugin:advisor'),
      advisorMessage('free-form legacy note'),
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('blocker')
    expect(notes[0]!.turn).toBe(1)
  })

  it('leaves agentic notes turn-less (no turn/end at all)', () => {
    seq = 0
    const notes = notesFromSessionEvents([
      humanMessage('start'),
      assistantMessage('reply'),
      humanMessage('again'),
      advisorMessage('[advisor:nit] consider the cache'),
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.turn).toBeUndefined()
  })

  it('ignores the old wrong `.message`-wrapped shape instead of matching it', () => {
    // Regression pin: the ORIGINAL buggy fixtures (message wrapped in
    // `.message`) must never be re-accepted — that shape does not exist on
    // real user/message events, so matching it would re-break production.
    seq = 0
    const notes = notesFromSessionEvents([
      turnEnd(1),
      event('user/message', {
        message: {
          id: 'ghost',
          role: 'user',
          content: [{ type: 'text', text: '[advisor:nit] ghost note' }],
          source: { kind: 'advisor' },
        },
      }),
    ])
    expect(notes).toHaveLength(0)
  })
})
