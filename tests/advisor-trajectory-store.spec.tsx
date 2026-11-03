// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { normalizeTrajectoryTurns } from '../src/client/advisor-trajectory-store'

const base = {
  at: 1_793_596_800_000,
  durationMs: 5,
  outcome: 'note',
  deltaChars: 10,
  historyTokens: 0,
  systemChars: 100,
}

describe('normalizeTrajectoryTurns — poll-boundary validation (fork addition)', () => {
  it('caps oversized userText and note with a visible marker', () => {
    const [turn] = normalizeTrajectoryTurns([
      { ...base, userText: 'u'.repeat(9_000), note: 'n'.repeat(3_000) },
    ])
    expect(turn!.userText!.endsWith('…[truncated]')).toBe(true)
    expect(turn!.userText!.length).toBe(8_000 + '…[truncated]'.length)
    expect(turn!.note!.endsWith('…[truncated]')).toBe(true)
    expect(turn!.note!.length).toBe(2_000 + '…[truncated]'.length)
  })

  it('passes a short row through unchanged', () => {
    const [turn] = normalizeTrajectoryTurns([{ ...base, kind: 'review', userText: 'short delta', note: 'short note' }])
    expect(turn!.userText).toBe('short delta')
    expect(turn!.note).toBe('short note')
  })

  it('drops a row whose outcome is outside the host union', () => {
    expect(normalizeTrajectoryTurns([{ ...base, outcome: 'mystery' }])).toEqual([])
    expect(normalizeTrajectoryTurns([{ ...base, outcome: 'mystery' }, { ...base, outcome: 'failure' }])).toHaveLength(1)
  })
})