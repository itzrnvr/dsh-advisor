import { describe, expect, it } from 'vitest'
import { reviewedAnchor } from '../src/client/advisor-note-anchor'

describe('reviewedAnchor — advisor note row placement (fork addition)', () => {
  it('anchors a first-step note just before the next turn starts', () => {
    // The inbox drains at the next turn's first pre-step: the raw event seq
    // (105) sits after that turn's user message; the anchor moves it to the
    // end of the previous turn, just before the turn/start at 100.
    expect(reviewedAnchor(105, { step: { step: 1 }, turn: { start: { seq: 100 } } })).toBe(99.99)
  })

  it('keeps the real position for a mid-turn note', () => {
    expect(reviewedAnchor(130, { step: { step: 2 }, turn: { start: { seq: 100 } } })).toBe(130)
  })

  it('keeps the real position when the location is unknown', () => {
    expect(reviewedAnchor(42, undefined)).toBe(42)
    expect(reviewedAnchor(42, { step: { step: 1 } })).toBe(42)
  })

  it('keeps the real position for a degenerate turn start', () => {
    expect(reviewedAnchor(42, { step: { step: 1 }, turn: { start: { seq: 0 } } })).toBe(42)
  })
})