/**
 * Seed reconstruction (fork addition): rehydrating delivered notes after a
 * plugin reload must place each note on the turn it REVIEWED, keep the
 * original event time, and skip unparsable legacy rows.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { seedNotesFromEvents } from '../src/seed'

let seq = 0
function event(type: string, data: unknown, time = 1_000): SessionEvent {
  seq += 1
  return { type, seq, time, data } as unknown as SessionEvent
}

function humanMessage(text: string, time = 1_000): SessionEvent {
  return event('user/message', {
    message: {
      id: `human-${text}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }, time)
}

function advisorMessage(text: string, kind: 'advisor' | 'plugin:advisor' = 'advisor'): SessionEvent {
  return event('user/message', {
    message: {
      id: `note-${text}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind },
    },
  }, 2_000)
}

function turnEnd(turn: number): SessionEvent {
  return event('turn/end', { turn, reason: { kind: 'completed' } })
}

function assistantMessage(text: string): SessionEvent {
  return event('assistant/message', {
    message: { id: `a-${text}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
    turn: 1,
    step: 1,
  })
}

describe('seedNotesFromEvents — turn attribution on rehydrate', () => {
  it('attributes a review committed in the next turn to the turn that closed', () => {
    seq = 0
    const notes = seedNotesFromEvents([
      humanMessage('fix it'),
      assistantMessage('done'),
      turnEnd(1),
      // Next turn starts: the inbox commits the review note after the prompt.
      humanMessage('next question'),
      advisorMessage('[advisor:concern] check the edge case'),
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.turn).toBe(1)
    expect(notes[0]!.severity).toBe('concern')
    expect(notes[0]!.text).toBe('check the edge case')
    // Original event time, never Date.now().
    expect(notes[0]!.at).toBe(2_000)
  })

  it('attributes a mid-turn review to the turn that closes next', () => {
    seq = 0
    const notes = seedNotesFromEvents([
      humanMessage('fix it'),
      assistantMessage('working'),
      turnEnd(1),
      // Turn 2 is running (no human prompt since the boundary): a step review.
      advisorMessage('[advisor:nit] tighten the loop'),
      assistantMessage('more work'),
      turnEnd(2),
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.turn).toBe(2)
  })

  it('parses legacy plugin:advisor rows and skips unparsable ones', () => {
    seq = 0
    const notes = seedNotesFromEvents([
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
    const notes = seedNotesFromEvents([
      humanMessage('start'),
      assistantMessage('reply'),
      humanMessage('again'),
      advisorMessage('[advisor:nit] consider the cache'),
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.turn).toBeUndefined()
  })
})