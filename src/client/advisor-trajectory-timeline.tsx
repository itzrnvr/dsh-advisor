/**
 * Advisor overview timeline (fork addition).
 *
 * The 50px Chrome-Network-style strip that sits above the advisor ledger and
 * mirrors the built-in DSH Trajectory overview: three 14px lanes in a 44px
 * caption gutter, one 8px span per advisor model attempt, click-to-select,
 * drag-to-focus, wheel zoom, right-drag pan and Escape reset.
 *
 * The component OWNS its viewport (zoom + pan) and reports the committed
 * selection in FULL domain units — slot indices in `sequence` mode, epoch
 * milliseconds in `duration` mode — so a zoomed viewport never leaks into the
 * parent's range state.
 *
 * Isolated on purpose: no host primitives, no new dependencies, tokens come
 * from the host's `--dsw-alias-*` variables (with hex fallbacks).
 */

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './advisor-trajectory-timeline.module.css'

/** Left-pointer travel below this many pixels is a click, not a range drag. */
const MINIMUM_DRAG_PX = 3
/** Tightest zoom in `sequence` mode, counted in slots. */
const MINIMUM_SEQUENCE_ZOOM_SLOTS = 4
/** Tightest zoom in `duration` mode, in milliseconds. */
const MINIMUM_DURATION_ZOOM_MS = 20
/** Share of the track width that acts as the drag auto-pan zone. */
const EDGE_PAN_ZONE_FRACTION = 0.08
/** Viewport share panned per pointer move at full edge pressure. */
const EDGE_PAN_STEP_FRACTION = 0.025
/** Upper bound for the auto-pan zone, in pixels. */
const MAXIMUM_EDGE_PAN_PX = 32
/** Hover delay before the tooltip appears. */
const TOOLTIP_DELAY_MS = 500

/** One attempt row projected onto the overview strip. */
export interface AdvisorTimelineItem {
  /** Stable row key (React key + selection identity). */
  readonly key: string
  /** Vertical lane: 0 prompt/delta, 1 review/note, 2 compaction. */
  readonly lane: 0 | 1 | 2
  /** Epoch milliseconds. */
  readonly start: number
  /** Epoch milliseconds, never below `start`. */
  readonly end: number
  /** Outcome category driving the span colour. */
  readonly kind: 'prompt' | 'note' | 'silent' | 'error' | 'compaction'
  /** Tooltip heading, e.g. `note`. */
  readonly title: string
  /** Optional extra tooltip line. */
  readonly detail?: string
  /** Recorded latency, shown as the tooltip's duration label. */
  readonly durationMs: number
  /** Convenience flag, used only when `selectedKey` is null. */
  readonly selected?: boolean
}

/** Props of {@link AdvisorTimeline}. */
export interface AdvisorTimelineProps {
  /** Attempts in ledger order; `sequence` mode ignores their timestamps. */
  readonly items: readonly AdvisorTimelineItem[]
  /** Equal slots, or a true recorded-time projection. */
  readonly mode: 'sequence' | 'duration'
  /** Committed selection in FULL domain units (slots or epoch ms), or null. */
  readonly range: { readonly start: number; readonly end: number } | null
  /** Key of the attempt to ring as current. */
  readonly selectedKey: string | null
  /** Lane captions, top to bottom. */
  readonly labels: { readonly input: string; readonly review: string; readonly compaction: string }
  /** Locale seat: called with plain strings, used for aria labels only. */
  readonly t: (key: string) => string
  /** Committed selection observer; `null` clears it. */
  readonly onRangeChange: (range: { start: number; end: number } | null) => void
  /** Attempt observer for clicks (span or nearest empty-space hit). */
  readonly onSelect: (item: AdvisorTimelineItem) => void
}

/** One attempt placed in the component's own domain units. */
interface ProjectedSpan {
  readonly item: AdvisorTimelineItem
  readonly start: number
  readonly end: number
}

interface DragState {
  readonly pointerId: number
  readonly anchorClientX: number
  readonly anchorPoint: number
  readonly spanKey: string | null
  moved: boolean
}

interface PanState {
  readonly pointerId: number
  readonly anchorClientX: number
  readonly anchorStart: number
  readonly pannable: boolean
  moved: boolean
}

interface HoverState {
  /** Pointer position as a fraction of the track width. */
  readonly fraction: number
  /** Attempt under the pointer, or null over empty track. */
  readonly key: string | null
}

interface SelectionBox {
  readonly left: number
  readonly width: number
}

/** Clamp to [0, 1]; keeps NaN out of every fraction. */
function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Clamp into an inclusive range that may be inverted by bad input. */
function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  const ceiling = Math.max(minimum, maximum)
  return Math.min(Math.max(value, minimum), ceiling)
}

/** Put two domain points in ascending order. */
function orderedRange(left: number, right: number): { start: number; end: number } {
  return left <= right ? { start: left, end: right } : { start: right, end: left }
}

/** Widest range of `width` centred on `center`, fitted inside the domain. */
function centeredRange(
  center: number,
  width: number,
  minimum: number,
  maximum: number,
): { start: number; end: number } {
  const span = Math.max(0, maximum - minimum)
  const clampedWidth = Math.min(span, Math.max(0, width))
  const start = Math.min(Math.max(center - clampedWidth / 2, minimum), Math.max(minimum, maximum - clampedWidth))
  return { start, end: start + clampedWidth }
}

/** Map a full-domain range into viewport fractions, or null when it misses. */
function selectionBox(
  range: { readonly start: number; readonly end: number } | null,
  viewportStart: number,
  viewportDuration: number,
  fullStart: number,
  fullEnd: number,
): SelectionBox | null {
  if (range === null) return null
  const lower = Math.min(range.start, range.end)
  const upper = Math.max(range.start, range.end)
  if (upper < fullStart || lower > fullEnd) return null
  const start = clamp(lower, fullStart, fullEnd)
  const end = clamp(upper, fullStart, fullEnd)
  return {
    left: (start - viewportStart) / viewportDuration,
    width: Math.max(0, end - start) / viewportDuration,
  }
}

/** Compact duration label for the tooltip's third line. */
function formatDurationLabel(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  if (milliseconds >= 10_000) return `${Math.round(milliseconds / 1_000)}s`
  if (milliseconds >= 1_000) return `${(milliseconds / 1_000).toFixed(1)}s`
  return `${Math.round(milliseconds)}ms`
}

/** Begin pointer capture when the environment implements it (jsdom does not). */
function capturePointer(element: HTMLElement, pointerId: number): void {
  if (typeof element.setPointerCapture !== 'function') return
  element.setPointerCapture(pointerId)
}

/** End pointer capture when the environment implements it. */
function releasePointer(element: HTMLElement, pointerId: number): void {
  if (typeof element.releasePointerCapture !== 'function') return
  element.releasePointerCapture(pointerId)
}

/** Stable identity of the attempt a pointer event landed on. */
function spanKeyAt(event: ReactPointerEvent<HTMLDivElement>): string | null {
  const target = event.target as { closest?: (selector: string) => { getAttribute(name: string): string | null } | null } | null
  if (target === null || typeof target.closest !== 'function') return null
  const element = target.closest('[data-advisor-key]')
  if (element === null) return null
  return element.getAttribute('data-advisor-key')
}

/**
 * Render the advisor overview timeline.
 * @param props - attempts, projection mode, committed range and observers.
 * @returns the 50px overview strip.
 */
export function AdvisorTimeline(props: AdvisorTimelineProps): ReactNode {
  const { items, mode, range, selectedKey, labels, t, onRangeChange, onSelect } = props

  const rootRef = useRef<HTMLElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const panRef = useRef<PanState | null>(null)
  const modeRef = useRef(mode)

  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [tooltipKey, setTooltipKey] = useState<string | null>(null)
  const [panning, setPanning] = useState(false)
  const [viewport, setViewport] = useState<{ start: number; end: number } | null>(null)

  // `sequence` projects array order to equal slots; `duration` uses the real
  // recorded start/end. Both land in the same full-domain unit space.
  const spans = useMemo<readonly ProjectedSpan[]>(() => items.map((entry, index) => {
    if (mode === 'sequence') return { item: entry, start: index, end: index + 1 }
    const start = Number.isFinite(entry.start) ? entry.start : 0
    const end = Number.isFinite(entry.end) ? Math.max(start, entry.end) : start
    return { item: entry, start, end }
  }), [items, mode])

  const domain = useMemo<{ start: number; end: number } | null>(() => {
    if (spans.length === 0) return null
    let start = Number.POSITIVE_INFINITY
    let end = Number.NEGATIVE_INFINITY
    for (const span of spans) {
      if (span.start < start) start = span.start
      if (span.end > end) end = span.end
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    // A degenerate domain (every attempt at the same instant) still needs a
    // positive width for the projection to divide by.
    return { start, end: end > start ? end : start + 1 }
  }, [spans])

  const fullStart = domain === null ? 0 : domain.start
  const fullEnd = domain === null ? 1 : domain.end
  const fullDuration = Math.max(1, fullEnd - fullStart)

  // Viewport is internal zoom/pan state in full-domain units. Rendering
  // clamps it, so a stale viewport (items shrank, mode switched) can never
  // push spans out of the track.
  const viewportDuration = viewport === null
    ? fullDuration
    : Math.min(fullDuration, Math.max(1, viewport.end - viewport.start))
  const viewportStart = viewport === null
    ? fullStart
    : clamp(viewport.start, fullStart, fullStart + fullDuration - viewportDuration)
  const viewportEnd = viewportStart + viewportDuration

  const hoverKey = hover === null ? null : hover.key

  // Reset the viewport when the projection mode changes: slot units and
  // milliseconds are not comparable, so a kept viewport would be nonsense.
  useEffect(() => {
    if (modeRef.current === mode) return
    modeRef.current = mode
    setViewport(null)
    setDraft(null)
  }, [mode])

  // Wheel zoom, anchored at the pointer. Registered natively because a
  // React synthetic wheel listener is passive and cannot preventDefault.
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (domain === null) return
      const track = trackRef.current
      if (track === null) return
      event.preventDefault()
      const rect = track.getBoundingClientRect()
      const anchorFraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))
      const minimumDuration = Math.min(
        mode === 'sequence' ? MINIMUM_SEQUENCE_ZOOM_SLOTS : MINIMUM_DURATION_ZOOM_MS,
        fullDuration,
      )
      const nextDuration = Math.min(
        fullDuration,
        Math.max(minimumDuration, viewportDuration * Math.exp(event.deltaY * 0.0015)),
      )
      // Zooming all the way back out clears the viewport entirely.
      if (nextDuration >= fullDuration * 0.999) {
        setViewport(null)
        return
      }
      const anchorPoint = viewportStart + anchorFraction * viewportDuration
      const nextStart = clamp(
        anchorPoint - anchorFraction * nextDuration,
        fullStart,
        fullStart + fullDuration - nextDuration,
      )
      setViewport({ start: nextStart, end: nextStart + nextDuration })
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => { root.removeEventListener('wheel', onWheel) }
  }, [domain, fullDuration, fullStart, mode, viewportDuration, viewportStart])

  // Tooltip delay: one timer per hovered attempt, always cleared on leave,
  // key change and unmount (no timer outlives the hover).
  useEffect(() => {
    if (hoverKey === null) {
      setTooltipKey(null)
      return undefined
    }
    const timer = setTimeout(() => { setTooltipKey(hoverKey) }, TOOLTIP_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [hoverKey])

  const activeRange = draft === null ? range : draft
  const activeBounds = activeRange === null
    ? null
    : { start: Math.min(activeRange.start, activeRange.end), end: Math.max(activeRange.start, activeRange.end) }
  const selection = selectionBox(activeRange, viewportStart, viewportDuration, fullStart, fullEnd)
  const selectionStyle = selection === null
    ? undefined
    : {
      '--advisor-selection-left': `${selection.left * 100}%`,
      '--advisor-selection-width': `${Math.max(0, selection.width) * 100}%`,
    } as CSSProperties
  const domainStyle = {
    '--advisor-domain-left': `${-((viewportStart - fullStart) / viewportDuration) * 100}%`,
    '--advisor-domain-width': `${(fullDuration / viewportDuration) * 100}%`,
  } as CSSProperties
  const hoverLine = hover !== null && hover.key === null && draft === null && !panning
    ? hover.fraction
    : null

  const tooltipSpan = tooltipKey !== null && hoverKey === tooltipKey
    ? spans.find((span) => span.item.key === tooltipKey) ?? null
    : null
  const tooltipLeft = tooltipSpan === null
    ? 0
    : clampFraction((((tooltipSpan.start + tooltipSpan.end) / 2) - viewportStart) / viewportDuration)
  const tooltipStyle = { '--advisor-tooltip-left': `${tooltipLeft * 100}%` } as CSSProperties

  const visibleSpans = spans.filter((span) => (
    span.item.key === selectedKey || (span.end >= viewportStart && span.start <= viewportEnd)
  ))

  /** Domain point (full units) under a client X coordinate. */
  const pointAt = (clientX: number, rect: DOMRect): number => {
    const fraction = clampFraction((clientX - rect.left) / Math.max(1, rect.width))
    return viewportStart + fraction * viewportDuration
  }

  /** Attempt under a pointer event, or null over empty track. */
  const spanAt = (event: ReactPointerEvent<HTMLDivElement>): ProjectedSpan | null => {
    const key = spanKeyAt(event)
    if (key === null) return null
    return spans.find((span) => span.item.key === key) ?? null
  }

  /** One equal slot in `sequence`, an average attempt spacing in `duration`. */
  const minimumSelectionWidth = Math.min(fullDuration, fullDuration / Math.max(1, spans.length))

  /** Closest attempt to a domain point (click on empty track). */
  const nearestSpanAt = (point: number): ProjectedSpan | null => {
    let nearest: ProjectedSpan | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const span of spans) {
      const distance = point < span.start
        ? span.start - point
        : point > span.end ? point - span.end : 0
      if (distance < nearestDistance) {
        nearest = span
        nearestDistance = distance
      }
    }
    return nearest
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.button === 2) {
      // Right button: pan a zoomed viewport; a right-click with no travel
      // clears the committed range on pointerup.
      panRef.current = {
        pointerId: event.pointerId,
        anchorClientX: event.clientX,
        anchorStart: viewportStart,
        pannable: viewport !== null,
        moved: false,
      }
      setHover(null)
      setPanning(true)
      capturePointer(event.currentTarget, event.pointerId)
      return
    }
    if (event.button !== 0) return
    const fraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))
    const span = spanAt(event)
    dragRef.current = {
      pointerId: event.pointerId,
      anchorClientX: event.clientX,
      anchorPoint: viewportStart + fraction * viewportDuration,
      spanKey: span === null ? null : span.item.key,
      moved: false,
    }
    setHover({ fraction, key: span === null ? null : span.item.key })
    // A zero-width draft mirrors the built-in strip: pressing immediately
    // shows a hairline band that grows into the selection.
    setDraft({ start: viewportStart + fraction * viewportDuration, end: viewportStart + fraction * viewportDuration })
    capturePointer(event.currentTarget, event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))

    const pan = panRef.current
    if (pan !== null && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true
      setHover(null)
      if (!pan.pannable) return
      const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width)
      const nextStart = clamp(
        pan.anchorStart - delta * viewportDuration,
        fullStart,
        fullStart + fullDuration - viewportDuration,
      )
      setViewport({ start: nextStart, end: nextStart + viewportDuration })
      return
    }

    const span = spanAt(event)
    setHover({ fraction, key: span === null ? null : span.item.key })

    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    if (Math.abs(event.clientX - drag.anchorClientX) >= MINIMUM_DRAG_PX) drag.moved = true

    // Auto-pan while dragging inside the edge band of a zoomed viewport.
    let pointStart = viewportStart
    if (viewport !== null && domain !== null) {
      const width = Math.max(1, rect.width)
      const localX = event.clientX - rect.left
      const edgeWidth = Math.min(MAXIMUM_EDGE_PAN_PX, Math.max(1, width * EDGE_PAN_ZONE_FRACTION))
      const direction = localX < edgeWidth ? -1 : localX > width - edgeWidth ? 1 : 0
      if (direction !== 0) {
        const pressure = clampFraction(
          (direction < 0 ? edgeWidth - localX : localX - (width - edgeWidth)) / edgeWidth,
        )
        const desiredStart = viewportStart
          + direction * viewportDuration * EDGE_PAN_STEP_FRACTION * Math.max(0.2, pressure)
        const nextStart = clamp(desiredStart, fullStart, fullStart + fullDuration - viewportDuration)
        if (nextStart !== viewportStart) {
          pointStart = nextStart
          setViewport({ start: nextStart, end: nextStart + viewportDuration })
        }
      }
    }

    const point = pointStart + fraction * viewportDuration
    setDraft(orderedRange(drag.anchorPoint, point))
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX
      panRef.current = null
      setPanning(false)
      setHover(null)
      releasePointer(event.currentTarget, event.pointerId)
      if (!moved) onRangeChange(null)
      return
    }

    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDraft(null)
    releasePointer(event.currentTarget, event.pointerId)

    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))
    const point = viewportStart + fraction * viewportDuration
    setHover({ fraction, key: spanKeyAt(event) })

    const click = !drag.moved && Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX
    if (click) {
      const clicked = drag.spanKey === null
        ? null
        : spans.find((span) => span.item.key === drag.spanKey) ?? null
      if (clicked !== null) {
        onSelect(clicked.item)
        return
      }
      // Empty track: focus the nearest attempt and commit a visible band
      // centred on the click (a bare point would select nothing).
      const nearest = nearestSpanAt(point)
      onRangeChange(centeredRange(point, minimumSelectionWidth, fullStart, fullEnd))
      if (nearest !== null) onSelect(nearest.item)
      return
    }

    // A drag shorter than one attempt slot is widened around its middle so
    // the committed range is always visible against the spans.
    const drawn = orderedRange(drag.anchorPoint, point)
    onRangeChange(
      drawn.end - drawn.start < minimumSelectionWidth
        ? centeredRange((drawn.start + drawn.end) / 2, minimumSelectionWidth, fullStart, fullEnd)
        : drawn,
    )
  }

  const handlePointerLeave = (): void => {
    if (dragRef.current === null && panRef.current === null) setHover(null)
  }

  const handlePointerCancel = (): void => {
    dragRef.current = null
    panRef.current = null
    setDraft(null)
    setHover(null)
    setPanning(false)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onRangeChange(null)
  }

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    onRangeChange(null)
  }

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
  }

  return (
    <section
      ref={rootRef}
      className={styles.root ?? ''}
      aria-label={t('Advisor timeline')}
      data-advisor-timeline="true"
    >
      <div className={styles.plot ?? ''}>
        <div className={styles.labels ?? ''} aria-hidden="true">
          <span data-advisor-lane-label="input">{labels.input}</span>
          <span data-advisor-lane-label="review">{labels.review}</span>
          <span data-advisor-lane-label="compaction">{labels.compaction}</span>
        </div>
        <div
          ref={trackRef}
          className={styles.track ?? ''}
          data-advisor-track="true"
          data-panning={panning ? 'true' : undefined}
          role="group"
          tabIndex={0}
          aria-label={t('Advisor timeline overview')}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
        >
          {hoverLine !== null && (
            <div
              className={styles.hoverLine ?? ''}
              data-advisor-hover-line="true"
              aria-hidden="true"
              style={{ '--advisor-hover-left': `${hoverLine * 100}%` } as CSSProperties}
            />
          )}
          {selection !== null && (
            <>
              <div
                className={styles.selection ?? ''}
                data-advisor-selection="true"
                data-dragging={draft === null ? undefined : 'true'}
                aria-hidden="true"
                style={selectionStyle}
              />
              <div
                className={styles.selectionEdges ?? ''}
                data-advisor-selection-edges="true"
                data-dragging={draft === null ? undefined : 'true'}
                aria-hidden="true"
                style={selectionStyle}
              />
            </>
          )}
          <div className={styles.lanes ?? ''} data-advisor-lanes="true" style={domainStyle}>
            {visibleSpans.map((span) => {
              const left = (span.start - fullStart) / fullDuration
              const width = Math.max(0, span.end - span.start) / fullDuration
              const current = selectedKey !== null
                ? selectedKey === span.item.key
                : span.item.selected === true
              // With a committed range active, spans outside it fade back so
              // the focus interval is readable at a glance.
              const selected = activeBounds === null
                ? undefined
                : activeBounds.start <= span.end && activeBounds.end >= span.start ? 'true' : 'false'
              return (
                <span
                  key={span.item.key}
                  className={styles.span ?? ''}
                  data-advisor-span={span.item.kind}
                  data-advisor-key={span.item.key}
                  data-lane={span.item.lane}
                  data-selected={selected}
                  data-current={current ? 'true' : undefined}
                  data-hovered={hoverKey === span.item.key ? 'true' : undefined}
                  aria-hidden="true"
                  style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
                />
              )
            })}
          </div>
        </div>
      </div>
      {tooltipSpan !== null && (
        <div className={styles.tooltipOverlay ?? ''} aria-hidden="true">
          <div className={styles.tooltip ?? ''} data-advisor-tooltip="true" style={tooltipStyle}>
            <span className={styles.tooltipTitle ?? ''}>{tooltipSpan.item.title}</span>
            {tooltipSpan.item.detail !== undefined && tooltipSpan.item.detail !== '' && (
              <span className={styles.tooltipDetail ?? ''}>{tooltipSpan.item.detail}</span>
            )}
            <span className={styles.tooltipMeta ?? ''}>{formatDurationLabel(tooltipSpan.item.durationMs)}</span>
          </div>
        </div>
      )}
    </section>
  )
}