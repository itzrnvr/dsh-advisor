import { describe, expect, it } from 'vitest'
import type { AdvisorTrace } from '../src/advisor-runtime'
import { findTraceEntry, renderTraceEntry } from '../src/trace-entry'

const review = (at: number, extra: Partial<AdvisorTrace> = {}): AdvisorTrace => ({
  at, kind: 'review', userText: `delta at ${at}`, replyText: `reply at ${at}`, ...extra,
})

describe('trace-entry — expand lookup and rendering (fork addition)', () => {
  it('renders a review with the sent text and the raw reply', () => {
    const text = renderTraceEntry(review(1))
    expect(text).toContain('[Sent to the advisor]\ndelta at 1')
    expect(text).toContain('[Raw reply]\nreply at 1')
  })

  it('renders a compaction summary and a failure', () => {
    expect(renderTraceEntry({ at: 2, kind: 'compaction', summary: 'summary text' }))
      .toContain('[Compaction summary]\nsummary text')
    expect(renderTraceEntry({ at: 3, kind: 'compaction', error: 'boom' }))
      .toContain('[Compaction failed]\nboom')
  })

  it('resolves the right attempt after the rings wrap at different sizes', () => {
    // Turn ring keeps 80, trace ring keeps 40: attempts 0-44 exist as turns,
    // traces hold only 5-44. Timestamp lookup must still find the right one.
    const traces = Array.from({ length: 40 }, (_, index) => review(index + 5))
    expect(findTraceEntry(traces, 10)?.userText).toBe('delta at 10')
    expect(findTraceEntry(traces, 44)?.userText).toBe('delta at 44')
    expect(findTraceEntry(traces, 4)).toBeUndefined()
  })
})