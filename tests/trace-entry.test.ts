import { describe, expect, it } from 'vitest'
import type { AdvisorTrace } from '../src/advisor-runtime'
import { findTraceEntry, renderTraceEntry } from '../src/trace-entry'

const review = (id: number, extra: Partial<AdvisorTrace> = {}): AdvisorTrace => ({
  id, at: 1_000 + id, kind: 'review', userText: `delta ${id}`, replyText: `reply ${id}`, ...extra,
})

describe('trace-entry — expand lookup and rendering (fork addition)', () => {
  it('renders a review with the sent text and the raw reply', () => {
    const text = renderTraceEntry(review(1))
    expect(text).toContain('[Sent to the advisor]\ndelta 1')
    expect(text).toContain('[Raw reply]\nreply 1')
  })

  it('renders a compaction summary and a failure', () => {
    expect(renderTraceEntry({ id: 2, at: 2, kind: 'compaction', summary: 'summary text' }))
      .toContain('[Compaction summary]\nsummary text')
    expect(renderTraceEntry({ id: 3, at: 3, kind: 'compaction', error: 'boom' }))
      .toContain('[Compaction failed]\nboom')
  })

  it('resolves the right attempt after the rings wrap at different sizes', () => {
    // Turn ring keeps 80, trace ring keeps 40: attempts 0-44 exist as turns,
    // traces hold only 5-44. The stable id lookup must still find attempt 10.
    const traces = Array.from({ length: 40 }, (_, index) => review(index + 5))
    expect(findTraceEntry(traces, 10)?.userText).toBe('delta 10')
    expect(findTraceEntry(traces, 44)?.userText).toBe('delta 44')
    expect(findTraceEntry(traces, 4)).toBeUndefined()
  })

  it('distinguishes attempts that share a timestamp', () => {
    const a: AdvisorTrace = { id: 7, at: 500, kind: 'review', userText: 'first', replyText: 'a' }
    const b: AdvisorTrace = { id: 8, at: 500, kind: 'review', userText: 'second', replyText: 'b' }
    expect(findTraceEntry([a, b], 7)?.userText).toBe('first')
    expect(findTraceEntry([a, b], 8)?.userText).toBe('second')
  })
})