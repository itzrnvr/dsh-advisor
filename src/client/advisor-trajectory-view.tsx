/**
 * Advisor tab — the reviewer's OWN session, restyled to mirror the built-in
 * Trajectory view (fork addition):
 *
 * - a 32px toolbar (duration mode, collapse-all attempts, search);
 * - a 50px three-lane overview timeline (prompt / review / compaction);
 * - a 30px-row ledger grouped by attempt, with chip rows and a live filter;
 * - a 320–720px inspector for the selected attempt.
 *
 * Everything is per-session: the controller is keyed by (transport, sessionId),
 * so another session's advisor data can never appear. Attempts live in the
 * plugin's memory (they reset on a plugin reload); the delivered notes live in
 * the session log. The scope footer says so.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  AdvisorTimeline,
  type AdvisorTimelineItem,
} from './advisor-trajectory-timeline.tsx'
import type {
  AdvisorTrajectoryController,
  AdvisorTrajectoryState,
  AdvisorTrajectoryTurn,
} from './advisor-trajectory-store.ts'
import type { AdvisorKey } from './locales.ts'
import styles from './advisor-trajectory-view.module.css'

/** Injected dependencies (one face per session scope binding). */
export interface AdvisorTrajectoryInjected {
  /** The session this occurrence is bound to. */
  readonly sessionId: string
  /** The shared per-session trajectory controller. */
  readonly controller: AdvisorTrajectoryController
  /** Bare snapshot source the renderer binds as the `useSnapshot` hook. */
  readonly hooks: {
    readonly snapshot: SnapshotStore<AdvisorTrajectoryState>
  }
}

/** Props the renderer binds: the injected face, locale seat, and snapshot hook. */
export type AdvisorTrajectoryViewProps =
  AdvisorTrajectoryInjected
  & {
    /** Synthesized locale seat for the `settings.advisor` namespace. */
    readonly t: (key: AdvisorKey, params?: Record<string, string | number>) => string
    /** Renderer-bound selector hook over the injected snapshot. */
    readonly useSnapshot: <T>(selector: (state: AdvisorTrajectoryState) => T) => T
  }

/** Inspector tab ids. */
type InspectorTab = 'overview' | 'trace' | 'timing'

/** Ledger row roles. */
type RowRole = 'prompt' | 'note' | 'compaction'

/** A committed timeline selection, in the active mode's domain units. */
interface TimelineRange {
  readonly start: number
  readonly end: number
}

/** One ledger row (one attempt can contribute two). */
interface LedgerRow {
  readonly key: string
  readonly attempt: number
  readonly turn: AdvisorTrajectoryTurn
  readonly role: RowRole
  readonly text: string
  /** Lower-cased haystack for the search field. */
  readonly searchText: string
  readonly attemptStart: boolean
  readonly attemptEnd: boolean
  readonly error: boolean
  readonly silent: boolean
  readonly collapsed: boolean
  readonly collapsedSummary?: string
}

/** Maximum characters of a one-line preview. */
const PREVIEW_LIMIT = 220

/** Persisted duration-mode preference (browser-wide). */
const DURATION_STORAGE_KEY = 'dsh.advisor.trajectory.duration'

/** Compact integer formatting (1234 → 1.2k). */
function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

/** Compact duration formatting (840 → "840 ms", 6400 → "6.40 s"). */
function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '—'
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`
  return `${(milliseconds / 1_000).toFixed(2)} s`
}

/** One attempt's prompt token total: uncached + cache reads + cache writes. */
function promptTokens(turn: AdvisorTrajectoryTurn): number | undefined {
  const usage = turn.usage
  if (usage === undefined) return undefined
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Cache-read share of one attempt's prompt, 0 when it sent no prompt tokens. */
function cacheHit(turn: AdvisorTrajectoryTurn): number {
  const usage = turn.usage
  const prompt = promptTokens(turn)
  if (usage === undefined || prompt === undefined || prompt <= 0) return 0
  return (usage.cacheReadTokens ?? 0) / prompt
}

/** Percent label with one decimal below 100% ("87.3%", "100%"). */
function formatPercent(ratio: number): string {
  const percent = Math.max(0, Math.min(1, ratio)) * 100
  return `${percent >= 99.95 ? '100' : percent.toFixed(1)}%`
}

/** Local wall-clock label with seconds ("14:02:11"). */
function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Flatten and clip one text slot for a single ledger line. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT)}…` : flat
}

/** Per-attempt outcome chip copy. */
function outcomeKey(turn: AdvisorTrajectoryTurn): AdvisorKey {
  if (turn.outcome === 'note') return 'trajNote'
  if (turn.outcome === 'no-note') return 'trajSilent'
  if (turn.outcome === 'failure') return 'trajFailed'
  return 'trajAborted'
}

/** Read the persisted duration-mode preference without failing the mount. */
function readDurationPreference(): boolean {
  try {
    return window.localStorage.getItem(DURATION_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the duration-mode preference without failing the click. */
function writeDurationPreference(value: boolean): void {
  try {
    window.localStorage.setItem(DURATION_STORAGE_KEY, value ? '1' : '0')
  } catch {
    // A blocked localStorage keeps the in-memory choice only.
  }
}

/** Build the unfiltered row set: prompt + note per review, one compaction row. */
function buildRows(
  turns: readonly AdvisorTrajectoryTurn[],
  t: (key: AdvisorKey, params?: Record<string, string | number>) => string,
): LedgerRow[] {
  const rows: LedgerRow[] = []
  turns.forEach((turn, index) => {
    const attempt = index + 1
    const made: LedgerRow[] = []
    const push = (
      role: RowRole,
      text: string,
      extra: Pick<LedgerRow, 'error' | 'silent'>,
    ): void => {
      made.push({
        key: `a${turn.id}-${role === 'prompt' ? 'p' : role === 'note' ? 'n' : 'c'}`,
        attempt,
        turn,
        role,
        text: preview(text),
        searchText: text.toLowerCase(),
        attemptStart: false,
        attemptEnd: false,
        collapsed: false,
        ...extra,
      })
    }
    if (turn.kind === 'compaction') {
      const text = turn.note ?? turn.error ?? t('trajCompaction')
      push('compaction', text, { error: turn.error !== undefined, silent: turn.note === undefined && turn.error === undefined })
    } else {
      if (turn.userText !== undefined) push('prompt', turn.userText, { error: false, silent: false })
      if (turn.note !== undefined) push('note', turn.note, { error: false, silent: false })
      else if (turn.error !== undefined) push('note', turn.error, { error: true, silent: false })
      else push('note', t(outcomeKey(turn)), { error: false, silent: true })
    }
    rows.push(...made)
  })
  return rows
}

/** Mark the first/last row of every attempt after any transform. */
function markBoundaries(rows: readonly LedgerRow[]): LedgerRow[] {
  return rows.map((row, index) => ({
    ...row,
    attemptStart: index === 0 || rows[index - 1]?.attempt !== row.attempt,
    attemptEnd: index === rows.length - 1 || rows[index + 1]?.attempt !== row.attempt,
  }))
}

/** Collapse every attempt in `collapsed` into one summary row. */
function applyCollapse(
  rows: readonly LedgerRow[],
  collapsed: ReadonlySet<number>,
  t: (key: AdvisorKey, params?: Record<string, string | number>) => string,
): LedgerRow[] {
  const out: LedgerRow[] = []
  let index = 0
  while (index < rows.length) {
    const first = rows[index]
    if (first === undefined) break
    let end = index
    while (end < rows.length && rows[end]?.attempt === first.attempt) end += 1
    const group = rows.slice(index, end)
    if (collapsed.has(first.attempt) && group.length > 1) {
      out.push({
        ...first,
        key: `collapsed-${first.attempt}`,
        text: '',
        collapsed: true,
        collapsedSummary: t('trajCollapsedRows', {
          count: group.length,
          duration: formatDuration(first.turn.durationMs),
        }),
      })
    } else {
      out.push(...group)
    }
    index = end
  }
  return out
}

/** Attempt numbers that own more than one row. */
function collapsibleAttempts(rows: readonly LedgerRow[]): number[] {
  const counts = new Map<number, number>()
  for (const row of rows) counts.set(row.attempt, (counts.get(row.attempt) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([attempt]) => attempt)
}

/** Show the trace text the host retained, or the best local fallback. */
function traceText(
  turn: AdvisorTrajectoryTurn,
  trace: string | undefined,
  t: (key: AdvisorKey) => string,
): string {
  if (trace !== undefined) return trace
  const text = turn.note ?? turn.userText
  if (text === undefined) return t('trajTraceEmpty')
  return text.endsWith('…[truncated]') ? t('trajNotRetained') : text
}

/**
 * Render the advisor's attempts with the built-in Trajectory anatomy.
 * @param props - the injected face, locale seat and snapshot hook.
 * @returns the toolbar, timeline, ledger and inspector.
 */
export function AdvisorTrajectoryView(props: AdvisorTrajectoryViewProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const state = useSnapshot((snapshot) => snapshot)
  const [tab, setTab] = useState<InspectorTab>('overview')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())
  const [query, setQuery] = useState('')
  const [actualDuration, setActualDuration] = useState<boolean>(() => readDurationPreference())
  const [range, setRange] = useState<TimelineRange | null>(null)
  const [traceById, setTraceById] = useState<Readonly<Record<number, string>>>({})
  const [tracePending, setTracePending] = useState<ReadonlySet<number>>(() => new Set())
  const [detailsWidth, setDetailsWidth] = useState<number | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const splitRef = useRef<HTMLDivElement | null>(null)
  const resizeDrag = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    splitWidth: number
  } | null>(null)
  const requestedTraces = useRef<Set<number>>(new Set())

  useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  const allRows = useMemo(() => buildRows(state.turns, t), [state.turns, t])
  const collapsible = useMemo(() => collapsibleAttempts(allRows), [allRows])
  const allCollapsed = collapsible.length > 0 && collapsible.every((attempt) => collapsed.has(attempt))
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle !== '') {
      return markBoundaries(allRows.filter((row) => row.searchText.includes(needle)))
    }
    return markBoundaries(applyCollapse(allRows, collapsed, t))
  }, [allRows, collapsed, query, t])

  const timelineItems = useMemo<AdvisorTimelineItem[]>(() => {
    const items: AdvisorTimelineItem[] = []
    for (const turn of state.turns) {
      const start = turn.at
      const end = turn.at + Math.max(0, turn.durationMs)
      if (turn.kind === 'compaction') {
        items.push({
          key: `a${turn.id}-c`,
          lane: 2,
          start,
          end,
          kind: turn.error === undefined ? 'compaction' : 'error',
          title: turn.error === undefined ? t('trajKindCompaction') : t('trajKindFailed'),
          detail: turn.error,
          durationMs: turn.durationMs,
        })
        continue
      }
      if (turn.userText !== undefined) {
        items.push({
          key: `a${turn.id}-p`,
          lane: 0,
          start,
          end: start,
          kind: 'prompt',
          title: t('trajKindPrompt'),
          durationMs: 0,
        })
      }
      items.push({
        key: `a${turn.id}-n`,
        lane: 1,
        start,
        end,
        kind: turn.outcome === 'note' ? 'note' : turn.outcome === 'failure' ? 'error' : 'silent',
        title: t(turn.outcome === 'note' ? 'trajKindNote' : turn.outcome === 'failure' ? 'trajKindFailed' : 'trajKindSilent'),
        detail: turn.severity,
        durationMs: turn.durationMs,
      })
    }
    return items
  }, [state.turns, t])

  const attemptOfItem = useMemo(() => {
    const map = new Map<string, number>()
    state.turns.forEach((turn, index) => {
      map.set(`a${turn.id}-p`, index + 1)
      map.set(`a${turn.id}-n`, index + 1)
      map.set(`a${turn.id}-c`, index + 1)
    })
    return map
  }, [state.turns])

  const durationMode = actualDuration
  const timelineTranslate = useCallback((key: string): string => t(key as AdvisorKey), [t])
  const focusedAttempts = useMemo<ReadonlySet<number> | null>(() => {
    if (range === null) return null
    const focused = new Set<number>()
    if (!durationMode) {
      timelineItems.forEach((item, index) => {
        if (index + 1 >= range.start && index <= range.end) {
          const attempt = attemptOfItem.get(item.key)
          if (attempt !== undefined) focused.add(attempt)
        }
      })
      return focused
    }
    state.turns.forEach((turn, index) => {
      const start = turn.at
      const end = turn.at + Math.max(0, turn.durationMs)
      if (start <= range.end && end >= range.start) focused.add(index + 1)
    })
    return focused
  }, [attemptOfItem, durationMode, range, state.turns, timelineItems])

  const selectedRow = useMemo(
    () => (selectedKey === null ? undefined : allRows.find((row) => row.key === selectedKey)),
    [allRows, selectedKey],
  )
  const selectedTurn = selectedRow?.turn

  const loadTrace = useCallback((turn: AdvisorTrajectoryTurn): void => {
    if (traceById[turn.id] !== undefined || requestedTraces.current.has(turn.id)) return
    requestedTraces.current.add(turn.id)
    setTracePending((previous) => {
      const next = new Set(previous)
      next.add(turn.id)
      return next
    })
    void controller.fetchEntry(turn.id).then((text) => {
      setTracePending((previous) => {
        const next = new Set(previous)
        next.delete(turn.id)
        return next
      })
      if (text !== undefined) setTraceById((previous) => ({ ...previous, [turn.id]: text }))
    })
  }, [controller, traceById])

  const selectRow = useCallback((row: LedgerRow): void => {
    setSelectedKey(row.key)
    if (focusedAttempts !== null && !focusedAttempts.has(row.attempt)) setRange(null)
    loadTrace(row.turn)
  }, [focusedAttempts, loadTrace])

  const toggleAttempt = useCallback((attempt: number): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(attempt)) next.delete(attempt)
      else next.add(attempt)
      return next
    })
  }, [])

  const toggleAll = useCallback((): void => {
    setCollapsed(allCollapsed ? new Set() : new Set(collapsible))
  }, [allCollapsed, collapsible])

  const setDurationMode = useCallback((next: boolean): void => {
    setActualDuration(next)
    writeDurationPreference(next)
    setRange(null)
  }, [])

  const copyTrace = useCallback((text: string): void => {
    const clipboard = navigator.clipboard
    if (clipboard === undefined) {
      setCopyState('failed')
      return
    }
    try {
      void clipboard.writeText(text).then(
        () => { setCopyState('copied') },
        () => { setCopyState('failed') },
      )
    } catch {
      setCopyState('failed')
    }
  }, [])

  // Return the copy affordance to its idle label shortly after it settles.
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => { setCopyState('idle') }, 1_200)
    return () => { window.clearTimeout(timer) }
  }, [copyState])

  const measured = state.turns.filter((turn) => turn.usage !== undefined)
  const totalPrompt = measured.reduce((sum, turn) => sum + (promptTokens(turn) ?? 0), 0)
  const totalCached = measured.reduce((sum, turn) => sum + (turn.usage?.cacheReadTokens ?? 0), 0)
  const totalOutput = measured.reduce((sum, turn) => sum + (turn.usage?.outputTokens ?? 0), 0)
  const overallHit = totalPrompt > 0 ? totalCached / totalPrompt : 0
  const route = state.provider === undefined && state.model === undefined
    ? t('trajNoModel')
    : `${state.provider ?? ''}${state.provider !== undefined && state.model !== undefined ? ' · ' : ''}${state.model ?? ''}`

  const emptyLabel = state.status === 'unavailable'
    ? t('trajUnavailable')
    : state.status === 'pending' || state.status === 'idle'
      ? t('trajPending')
      : t('trajEmpty')

  const selectedTrace = selectedTurn === undefined
    ? ''
    : traceText(selectedTurn, traceById[selectedTurn.id], t)
  const selectedTraceLoading = selectedTurn !== undefined && tracePending.has(selectedTurn.id)

  const tabs: readonly { id: InspectorTab; labelKey: AdvisorKey }[] = [
    { id: 'overview', labelKey: 'trajTabOverview' },
    { id: 'trace', labelKey: 'trajTabTrace' },
    { id: 'timing', labelKey: 'trajTabTiming' },
  ]

  const splitStyle = detailsWidth === null ? undefined : { width: `${detailsWidth}px` }

  return (
    <div className={styles.root} data-conversation-composer-overlay="">
      <div className={styles.toolbar} role="toolbar" aria-label={t('trajToolbarAria')}>
        <button
          type="button"
          className={`${styles.toolbarButton} ${actualDuration ? styles.toolbarButtonOn : ''}`}
          aria-pressed={actualDuration}
          title={actualDuration ? t('trajUseEqualWidth') : t('trajUseActualDuration')}
          onClick={() => { setDurationMode(!actualDuration) }}
        >
          <svg className={styles.toolbarIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="5.25" />
            <path d="M8 4.75V8l2.25 1.5" />
          </svg>
          {t('trajDuration')}
        </button>
        <button
          type="button"
          className={styles.toolbarButton}
          aria-pressed={allCollapsed}
          aria-label={allCollapsed ? t('trajExpandAttempts') : t('trajCollapseAttempts')}
          title={allCollapsed ? t('trajExpandAttempts') : t('trajCollapseAttempts')}
          onClick={toggleAll}
        >
          <span className={styles.toolbarGlyph} aria-hidden="true">{allCollapsed ? '⊞' : '⊟'}</span>
          {t('trajAttempts')}
        </button>
        <div className={styles.search}>
          <svg className={styles.searchIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            type="search"
            className={styles.searchInput}
            value={query}
            placeholder={t('trajSearchPlaceholder')}
            aria-label={t('trajSearch')}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
        </div>
      </div>

      <AdvisorTimeline
        items={timelineItems}
        mode={durationMode ? 'duration' : 'sequence'}
        range={range}
        selectedKey={selectedKey}
        labels={{
          input: t('trajLanePrompt'),
          review: t('trajLaneReview'),
          compaction: t('trajLaneCompaction'),
        }}
        t={timelineTranslate}
        onRangeChange={setRange}
        onSelect={(item) => {
          const row = allRows.find((candidate) => candidate.key === item.key)
          if (row !== undefined) selectRow(row)
        }}
      />

      <div className={styles.summary} aria-label={t('trajSummaryAria')}>
        <span className={styles.summaryItem}>
          <span className={styles.summaryLabel}>{t('trajCalls')}</span> {state.turns.length}
        </span>
        <span className={styles.summaryItem}>
          <span className={styles.summaryLabel}>{t('trajCacheHit')}</span> {formatPercent(overallHit)}
        </span>
        <span className={styles.summaryItem}>
          <span className={styles.summaryLabel}>{t('trajPromptTokens')}</span> {formatCount(totalPrompt)}
        </span>
        <span className={styles.summaryItem}>
          <span className={styles.summaryLabel}>{t('trajCachedTokens')}</span> {formatCount(totalCached)}
        </span>
        <span className={styles.summaryItem}>
          <span className={styles.summaryLabel}>{t('trajOutputTokens')}</span> {formatCount(totalOutput)}
        </span>
        <span className={styles.summaryItem}>
          <span className={styles.summaryLabel}>{t('trajHistoryBudget')}</span> {formatCount(state.historyMaxTokens)}
        </span>
        <span className={styles.summaryRight}>
          <span className={styles.summaryLabel}>{t('trajModel')}</span> {route}
          <span className={styles.summaryStatus}>{state.runtimeStatus}</span>
        </span>
      </div>

      <div ref={splitRef} className={styles.split} style={splitStyle}>
        <div
          className={styles.tablePane}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedKey(null)
              setRange(null)
            }
          }}
        >
          {rows.length === 0
            ? (
              <div className={styles.emptyState}>
                {state.enabled === false && (
                  <p className={styles.notice}>{t('trajOffNotice')}</p>
                )}
                {state.enabled !== false && state.runtimeStatus === 'disabled' && (
                  <p className={styles.notice}>{t('trajRuntimeNotice')}</p>
                )}
                <p className={styles.empty}>{emptyLabel}</p>
              </div>
            )
            : (
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.eventColumn} />
                  <col />
                </colgroup>
                <tbody>
                  {rows.map((row) => {
                    const outside = focusedAttempts !== null && !focusedAttempts.has(row.attempt)
                    const kindLabel = row.role === 'prompt'
                      ? t('trajKindPrompt')
                      : row.role === 'compaction'
                        ? t('trajKindCompaction')
                        : row.silent
                          ? t('trajKindSilent')
                          : t('trajKindNote')
                    const selected = selectedKey === row.key
                    return (
                      <tr
                        key={row.key}
                        tabIndex={0}
                        aria-selected={selected}
                        aria-label={`${t('trajAttemptLabel', { n: row.attempt })} ${kindLabel}: ${row.text}`}
                        data-selected={selected || undefined}
                        data-outside={outside || undefined}
                        data-error={row.error || undefined}
                        className={row.collapsed ? styles.collapsedRow : undefined}
                        onClick={() => {
                          if (row.collapsed) toggleAttempt(row.attempt)
                          else selectRow(row)
                        }}
                        onDoubleClick={() => {
                          if (!row.collapsed) toggleAttempt(row.attempt)
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          if (row.collapsed) toggleAttempt(row.attempt)
                          else selectRow(row)
                        }}
                      >
                        <td className={styles.eventCell}>
                          {row.attemptStart && (
                            <span className={styles.turnLabel}>
                              {t('trajAttemptLabel', { n: row.attempt })}
                            </span>
                          )}
                          {row.attemptStart && <span className={styles.turnRail} aria-hidden="true" />}
                          {selected && <span className={styles.selectionRail} aria-hidden="true" />}
                          <div className={styles.eventInner}>
                            <span className={styles.kindSlot}>
                              <span className={`${styles.kindTag} ${row.role === 'prompt' ? styles.kindPrompt : row.role === 'compaction' ? styles.kindCompaction : row.silent ? styles.kindSilent : styles.kindNote}`}>
                                {row.error ? t('trajKindFailed') : kindLabel}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className={styles.contentCell}>
                          {row.collapsed
                            ? (
                              <span className={styles.collapsedText} title={row.collapsedSummary}>
                                <span className={styles.collapsedEllipsis} aria-hidden="true">…</span>
                                {' '}
                                {row.collapsedSummary}
                              </span>
                            )
                            : (
                              <>
                                <span className={styles.contentText} title={row.text}>{row.text}</span>
                                {row.role === 'note' && row.turn.delivered === false && (
                                  <span className={styles.chipMuted}>{t('trajNotDelivered')}</span>
                                )}
                                {row.role === 'note' && row.turn.severity !== undefined && (
                                  <span className={row.turn.severity === 'blocker' ? styles.chipError : row.turn.severity === 'concern' ? styles.chipWarn : styles.chipMuted}>
                                    {row.turn.severity}
                                  </span>
                                )}
                              </>
                            )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          {state.turns.length > 0 && <p className={styles.footer}>{t('trajScope')}</p>}
        </div>

        {selectedRow !== undefined && selectedTurn !== undefined && (
          <aside className={styles.details} aria-label={t('trajDetails')}>
            <div
              className={styles.resizeHandle}
              role="separator"
              aria-label={t('trajResize')}
              aria-orientation="vertical"
              tabIndex={0}
              title={t('trajResizeTitle')}
              onDoubleClick={() => { setDetailsWidth(null) }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                const split = splitRef.current
                if (split === null) return
                const current = detailsWidth ?? split.getBoundingClientRect().width * 0.38
                const delta = event.key === 'ArrowLeft' ? 16 : -16
                setDetailsWidth(clampDetailsWidth(current + delta, split.getBoundingClientRect().width))
                event.preventDefault()
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                const split = splitRef.current
                const aside = event.currentTarget.parentElement
                if (split === null || aside === null) return
                resizeDrag.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startWidth: aside.getBoundingClientRect().width,
                  splitWidth: split.getBoundingClientRect().width,
                }
                event.currentTarget.setPointerCapture(event.pointerId)
                event.preventDefault()
              }}
              onPointerMove={(event) => {
                const drag = resizeDrag.current
                if (drag === null || drag.pointerId !== event.pointerId) return
                const next = drag.startWidth + drag.startX - event.clientX
                setDetailsWidth(clampDetailsWidth(next, drag.splitWidth))
              }}
              onPointerUp={(event) => {
                if (resizeDrag.current?.pointerId !== event.pointerId) return
                resizeDrag.current = null
                event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              onPointerCancel={() => { resizeDrag.current = null }}
            />
            <div className={styles.detailsHeader}>
              <span className={`${styles.kindTag} ${selectedRow.role === 'prompt' ? styles.kindPrompt : selectedRow.role === 'compaction' ? styles.kindCompaction : selectedRow.silent ? styles.kindSilent : styles.kindNote}`}>
                {selectedRow.role === 'prompt'
                  ? t('trajKindPrompt')
                  : selectedRow.role === 'compaction'
                    ? t('trajKindCompaction')
                    : selectedRow.silent
                      ? t('trajKindSilent')
                      : t('trajKindNote')}
              </span>
              <span className={styles.detailsLocation}>
                {t('trajAttemptLabel', { n: selectedRow.attempt })}
                {' · '}
                {selectedTurn.kind === 'compaction' ? t('trajCompaction') : t('trajReview')}
              </span>
              <button
                type="button"
                className={styles.close}
                aria-label={t('trajClose')}
                onClick={() => { setSelectedKey(null) }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <div className={styles.detailTabs} role="tablist" aria-label={t('trajDetails')}>
              {tabs.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  className={`${styles.detailTab} ${tab === entry.id ? styles.detailTabActive : ''}`}
                  onClick={() => { setTab(entry.id); if (entry.id === 'trace') loadTrace(selectedTurn) }}
                >
                  {t(entry.labelKey)}
                </button>
              ))}
            </div>

            <div className={styles.detailBody}>
              {tab === 'overview' && (
                <dl className={styles.overview}>
                  <OverviewRow label={t('trajStatusLabel')} value={t(outcomeKey(selectedTurn))} />
                  {selectedTurn.severity !== undefined && (
                    <OverviewRow label={t('trajFieldSeverity')} value={selectedTurn.severity} />
                  )}
                  {selectedTurn.kind !== 'compaction' && selectedTurn.note !== undefined && (
                    <OverviewRow
                      label={t('trajFieldDelivered')}
                      value={selectedTurn.delivered === false ? t('trajNotDelivered') : t('trajDeliveredYes')}
                    />
                  )}
                  <OverviewRow label={t('trajFieldProvider')} value={state.provider ?? '—'} />
                  <OverviewRow label={t('trajFieldModel')} value={state.model ?? '—'} />
                  <OverviewRow label={t('trajFieldDuration')} value={formatDuration(selectedTurn.durationMs)} />
                  <OverviewRow
                    label={t('trajFieldPrompt')}
                    value={promptTokens(selectedTurn) === undefined ? '—' : formatCount(promptTokens(selectedTurn) ?? 0)}
                  />
                  <OverviewRow
                    label={t('trajFieldCached')}
                    value={selectedTurn.usage === undefined
                      ? '—'
                      : `${formatCount(selectedTurn.usage.cacheReadTokens ?? 0)} (${formatPercent(cacheHit(selectedTurn))})`}
                  />
                  <OverviewRow
                    label={t('trajFieldOutput')}
                    value={selectedTurn.usage === undefined ? '—' : formatCount(selectedTurn.usage.outputTokens)}
                  />
                  {selectedTurn.usage?.reasoningTokens !== undefined && (
                    <OverviewRow label={t('trajFieldReasoning')} value={formatCount(selectedTurn.usage.reasoningTokens)} />
                  )}
                  <OverviewRow label={t('trajFieldHistory')} value={formatCount(selectedTurn.historyTokens)} />
                  <OverviewRow label={t('trajFieldDeltaChars')} value={formatCount(selectedTurn.deltaChars)} />
                  <OverviewRow label={t('trajFieldSystemChars')} value={formatCount(selectedTurn.systemChars)} />
                  <OverviewRow label={t('trajFieldBudget')} value={`${formatCount(state.historyMaxTokens)} tok`} />
                  {selectedTurn.error !== undefined && (
                    <OverviewRow label={t('trajFailed')} value={selectedTurn.error} tone="error" />
                  )}
                </dl>
              )}

              {tab === 'trace' && (
                <div className={styles.tracePanel}>
                  <div className={styles.traceActions}>
                    <button
                      type="button"
                      className={styles.traceButton}
                      onClick={() => { copyTrace(selectedTrace) }}
                    >
                      {copyState === 'copied' ? t('trajCopied') : copyState === 'failed' ? t('trajCopyFailed') : t('trajCopy')}
                    </button>
                  </div>
                  {selectedTraceLoading && <p className={styles.hint}>{t('trajTraceLoading')}</p>}
                  <pre className={styles.tracePre}>{selectedTrace}</pre>
                </div>
              )}

              {tab === 'timing' && (
                <dl className={styles.overview}>
                  <OverviewRow label={t('trajFieldStarted')} value={formatClock(selectedTurn.at)} />
                  <OverviewRow label={t('trajFieldFinished')} value={formatClock(selectedTurn.at + selectedTurn.durationMs)} />
                  <OverviewRow label={t('trajFieldDuration')} value={formatDuration(selectedTurn.durationMs)} />
                  <OverviewRow label={t('trajFieldBudget')} value={`${formatCount(state.historyMaxTokens)} tok`} />
                </dl>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

/** Clamp one requested inspector width against the split that hosts it. */
function clampDetailsWidth(width: number, splitWidth: number): number {
  const ceiling = Math.max(320, Math.min(720, splitWidth - 280))
  return Math.max(320, Math.min(ceiling, width))
}

/** One label/value row of the inspector's overview panel. */
function OverviewRow(props: { readonly label: string; readonly value: string; readonly tone?: 'error' }): ReactNode {
  return (
    <div className={styles.overviewRow}>
      <dt className={styles.overviewLabel}>{props.label}</dt>
      <dd className={props.tone === 'error' ? `${styles.overviewValue} ${styles.errorText}` : styles.overviewValue}>
        {props.value}
      </dd>
    </div>
  )
}