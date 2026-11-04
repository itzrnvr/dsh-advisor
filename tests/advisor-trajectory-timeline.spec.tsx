// @vitest-environment jsdom
/**
 * Advisor overview timeline (fork addition) — pins the strip's projection and
 * interaction contract: `sequence` renders one equal slot per attempt in array
 * order, `duration` places spans by real start/end, a click on a span selects
 * that attempt, a left-pointer drag past the 3px threshold commits a range in
 * full domain units, an empty-space click focuses the nearest attempt, and
 * Escape clears the committed range.
 *
 * jsdom does not implement pointer capture, and every element reports a
 * zero-sized rect, so the track is given both before any pointer sequence —
 * the assertions read the style the component would have computed from a real
 * layout.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AdvisorTimeline } from '../src/client/advisor-trajectory-timeline'
import type { AdvisorTimelineItem, AdvisorTimelineProps } from '../src/client/advisor-trajectory-timeline'

afterEach(() => { cleanup() })

/** Track width the component sees in these cases (layout is faked). */
const TRACK_WIDTH = 400

const item = (overrides: Partial<AdvisorTimelineItem> & { key: string }): AdvisorTimelineItem => ({
  lane: 0,
  start: 1_000,
  end: 1_100,
  kind: 'prompt',
  title: 'prompt',
  durationMs: 100,
  ...overrides,
})

/** Three attempts: prompt → note → compaction, one per lane. */
const THREE: readonly AdvisorTimelineItem[] = [
  item({ key: 'a', lane: 0, start: 1_000, end: 1_400, kind: 'prompt', title: 'prompt' }),
  item({ key: 'b', lane: 1, start: 1_050, end: 1_150, kind: 'note', title: 'note', detail: 'concern', durationMs: 100 }),
  item({ key: 'c', lane: 2, start: 2_000, end: 2_040, kind: 'compaction', title: 'compaction' }),
]

function props(overrides: Partial<AdvisorTimelineProps> = {}): AdvisorTimelineProps {
  return {
    items: [],
    mode: 'sequence',
    range: null,
    selectedKey: null,
    labels: { input: 'in', review: 'review', compaction: 'compact' },
    t: (key: string) => key,
    onRangeChange: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  }
}

/** Render the strip and give its track a fixed 400 × 50 layout. */
function mount(overrides: Partial<AdvisorTimelineProps> = {}) {
  const view = render(<AdvisorTimeline {...props(overrides)} />)
  const track = view.container.querySelector('[data-advisor-track]') as HTMLElement
  const rect = {
    left: 0,
    top: 0,
    right: TRACK_WIDTH,
    bottom: 50,
    width: TRACK_WIDTH,
    height: 50,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
  Object.defineProperty(track, 'getBoundingClientRect', { configurable: true, value: () => rect })
  Object.defineProperty(track, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(track, 'releasePointerCapture', { configurable: true, value: vi.fn() })
  return { ...view, track }
}

/** The rendered spans, in ledger order. */
function spans(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-advisor-key]'))
}

describe('AdvisorTimeline — 50px advisor overview', () => {
  it('renders one span per attempt and the three lane labels in sequence mode', () => {
    const { container } = mount({ items: THREE })

    expect(spans(container)).toHaveLength(3)
    const labels = Array.from(container.querySelectorAll('[data-advisor-lane-label]')).map((el) => el.textContent)
    expect(labels).toEqual(['in', 'review', 'compact'])

    // Sequence mode ignores the timestamps: three equal slots in array order.
    const lefts = spans(container).map((el) => Number.parseFloat(el.style.left))
    expect(lefts[0]).toBeCloseTo(0, 2)
    expect(lefts[1]).toBeCloseTo(100 / 3, 2)
    expect(lefts[2]).toBeCloseTo(200 / 3, 2)
    // Lanes are honoured vertically.
    expect(spans(container).map((el) => el.dataset.lane)).toEqual(['0', '1', '2'])
  })

  it('places duration-mode spans by real start/end, so a longer attempt is wider', () => {
    const { container } = mount({
      mode: 'duration',
      items: [
        item({ key: 'short', start: 1_000, end: 1_100, durationMs: 100 }),
        item({ key: 'long', start: 1_100, end: 1_500, durationMs: 400, kind: 'note' }),
      ],
    })

    const [short, long] = spans(container)
    expect(Number.parseFloat(short.style.width)).toBeCloseTo(20, 2)
    expect(Number.parseFloat(long.style.width)).toBeCloseTo(80, 2)
    expect(Number.parseFloat(long.style.left)).toBeCloseTo(20, 2)
    expect(Number.parseFloat(long.style.width)).toBeGreaterThan(Number.parseFloat(short.style.width))
  })

  it('selects the attempt whose span was clicked', () => {
    const onSelect = vi.fn()
    const onRangeChange = vi.fn()
    const { container, track } = mount({ items: THREE, onSelect, onRangeChange })

    const target = container.querySelector('[data-advisor-key="b"]') as HTMLElement
    fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: 200 })
    fireEvent.pointerUp(track, { pointerId: 1, button: 0, clientX: 200 })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toMatchObject({ key: 'b', kind: 'note' })
    // A click on a span is a selection, not a range change.
    expect(onRangeChange).not.toHaveBeenCalled()
  })

  it('commits a full-domain range when a left-pointer drag passes the 3px threshold', () => {
    const onRangeChange = vi.fn()
    const { track } = mount({ items: THREE, onRangeChange })

    // 40px → 300px of a 400px track over a 3-slot domain.
    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 40 })
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 300 })
    fireEvent.pointerUp(track, { pointerId: 1, button: 0, clientX: 300 })

    expect(onRangeChange).toHaveBeenCalledTimes(1)
    const range = onRangeChange.mock.calls[0][0] as { start: number; end: number }
    expect(range.start).toBeCloseTo(0.3, 5)
    expect(range.end).toBeCloseTo(2.25, 5)
  })

  it('focuses the nearest attempt and commits a one-slot band on an empty click', () => {
    const onSelect = vi.fn()
    const onRangeChange = vi.fn()
    const { track } = mount({ items: THREE, onSelect, onRangeChange })

    // The domain ends at x = 400; no span exists at the exact right edge.
    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: TRACK_WIDTH })
    fireEvent.pointerUp(track, { pointerId: 1, button: 0, clientX: TRACK_WIDTH })

    expect(onRangeChange).toHaveBeenCalledWith({ start: 2, end: 3 })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toMatchObject({ key: 'c' })
  })

  it('clears the committed range on Escape', () => {
    const onRangeChange = vi.fn()
    const { track } = mount({
      items: THREE,
      range: { start: 0.5, end: 2 },
      onRangeChange,
    })

    fireEvent.keyDown(track, { key: 'Escape' })
    expect(onRangeChange).toHaveBeenCalledWith(null)
  })
})