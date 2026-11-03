/**
 * Advisor tab (fork addition) — the reviewer's OWN session, rendered as a
 * third view beside Chat and Trajectory in the conversation header.
 *
 * Two inner tabs:
 * - Trajectory: the message view — the delta the reviewer received, the note
 *   it returned, and compaction summaries, in order (expandable rows);
 * - Stats: the numeric view — cache hit rate, token totals, and one row per
 *   model attempt (including compaction calls).
 *
 * Everything here is per-session: the controller is keyed by (transport,
 * sessionId), so another session's advisor data can never appear.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
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

/** Compact integer formatting (1234 → 1.2k). */
function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
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

/** Per-attempt outcome chip copy. */
function outcomeKey(turn: AdvisorTrajectoryTurn): AdvisorKey {
  if (turn.outcome === 'note') return 'trajNote'
  if (turn.outcome === 'no-note') return 'trajSilent'
  if (turn.outcome === 'failure') return 'trajFailed'
  return 'trajAborted'
}

/** One message row of the trajectory tab. */
interface TrajectoryEntry {
  readonly key: string
  readonly role: 'user' | 'assistant' | 'compaction'
  readonly turn: AdvisorTrajectoryTurn
  readonly text: string
}

/**
 * Render the advisor's trajectory and stats for this session.
 * @param props - the injected face, locale seat and snapshot hook.
 * @returns the tabbed ledger.
 */
export function AdvisorTrajectoryView(props: AdvisorTrajectoryViewProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const state = useSnapshot((snapshot) => snapshot)
  const [tab, setTab] = useState<'trajectory' | 'stats'>('trajectory')

  useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  const measured = state.turns.filter((turn) => turn.usage !== undefined)
  const totalPrompt = measured.reduce((sum, turn) => sum + (promptTokens(turn) ?? 0), 0)
  const totalCached = measured.reduce((sum, turn) => sum + (turn.usage?.cacheReadTokens ?? 0), 0)
  const totalOutput = measured.reduce((sum, turn) => sum + (turn.usage?.outputTokens ?? 0), 0)
  const overallHit = totalPrompt > 0 ? totalCached / totalPrompt : 0

  const route = state.provider === undefined && state.model === undefined
    ? t('trajNoModel')
    : `${state.provider ?? ''}${state.provider !== undefined && state.model !== undefined ? ' · ' : ''}${state.model ?? ''}`

  const entries: TrajectoryEntry[] = state.turns.flatMap((turn, index) => {
    if (turn.kind === 'compaction') {
      return turn.note === undefined
        ? []
        : [{ key: `c-${turn.at}-${index}`, role: 'compaction' as const, turn, text: turn.note }]
    }
    const out: TrajectoryEntry[] = []
    if (turn.userText !== undefined) {
      out.push({ key: `u-${turn.at}-${index}`, role: 'user', turn, text: turn.userText })
    }
    if (turn.note !== undefined) {
      out.push({ key: `a-${turn.at}-${index}`, role: 'assistant', turn, text: turn.note })
    }
    return out
  })

  return (
    <div className={styles.page ?? ''}>
      <header className={styles.header ?? ''}>
        <div className={styles.title ?? ''}>{t('trajHeading')}</div>
        <div className={styles.meta ?? ''}>
          <span>{t('trajModel')}: <span className={styles.metaStrong ?? ''}>{route}</span></span>
          <span>{t('trajStatusLabel')}: <span className={styles.metaStrong ?? ''}>{state.runtimeStatus}</span></span>
        </div>
      </header>

      <div className={styles.tabs ?? ''} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'trajectory'}
          className={`${styles.tab ?? ''} ${tab === 'trajectory' ? styles.tabActive ?? '' : ''}`}
          onClick={() => { setTab('trajectory') }}
        >
          {t('trajTabTrajectory')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'stats'}
          className={`${styles.tab ?? ''} ${tab === 'stats' ? styles.tabActive ?? '' : ''}`}
          onClick={() => { setTab('stats') }}
        >
          {t('trajTabStats')}
        </button>
      </div>

      {tab === 'trajectory'
        ? (
          <div>
            <p className={styles.hint ?? ''}>{t('trajHint')}</p>
            {entries.length === 0
              ? <p className={styles.empty ?? ''}>{state.status === 'unavailable' ? t('trajUnavailable') : t('trajEmpty')}</p>
              : (
                <div className={styles.entries ?? ''}>
                  {entries.map((entry) => (
                    <details key={entry.key} className={styles.entry ?? ''}>
                      <summary className={styles.entryHead ?? ''}>
                        <span className={`${styles.role ?? ''} ${entry.role === 'user' ? styles.roleUser ?? '' : entry.role === 'assistant' ? styles.roleAssistant ?? '' : styles.roleCompaction ?? ''}`}>
                          {entry.role === 'user' ? t('trajRoleUser') : entry.role === 'assistant' ? t('trajRoleAdvisor') : t('trajCompaction')}
                        </span>
                        <span className={styles.time ?? ''}>{new Date(entry.turn.at).toLocaleTimeString()}</span>
                        {entry.role !== 'compaction' && entry.turn.usage !== undefined && (
                          <span className={styles.metric ?? ''}>
                            <span className={styles.metricLabel ?? ''}>{t('trajCached')} </span>
                            {formatCount(entry.turn.usage.cacheReadTokens ?? 0)}
                          </span>
                        )}
                      </summary>
                      <pre className={styles.entryText ?? ''}>{entry.text}</pre>
                    </details>
                  ))}
                </div>
              )}
          </div>
        )
        : (
          <div>
            <p className={styles.hint ?? ''}>{t('trajStatsHint')}</p>
            <div className={styles.statGrid ?? ''}>
              <Stat label={t('trajCalls')} value={String(state.turns.length)} />
              <Stat label={t('trajCacheHit')} value={formatPercent(overallHit)} accent={overallHit > 0} />
              <Stat label={t('trajPromptTokens')} value={formatCount(totalPrompt)} />
              <Stat label={t('trajCachedTokens')} value={formatCount(totalCached)} />
              <Stat label={t('trajOutputTokens')} value={formatCount(totalOutput)} />
              <Stat label={t('trajHistoryBudget')} value={`${formatCount(state.historyMaxTokens)} tok`} />
            </div>
            {state.status === 'unavailable' && state.turns.length === 0
              ? <p className={styles.empty ?? ''}>{t('trajUnavailable')}</p>
              : state.turns.length === 0
                ? <p className={styles.empty ?? ''}>{state.status === 'pending' ? t('trajPending') : t('trajEmpty')}</p>
                : (
                  <ol className={styles.list ?? ''}>
                    {state.turns.map((turn, index) => {
                      const prompt = promptTokens(turn)
                      const hit = cacheHit(turn)
                      return (
                        <li key={`${turn.at}-${index}`} className={styles.row ?? ''}>
                          <div className={styles.rowHead ?? ''}>
                            <span className={styles.outcome ?? ''}>
                              {t(turn.kind === 'compaction' ? 'trajCompaction' : outcomeKey(turn))}
                            </span>
                            {turn.severity !== undefined && <span className={styles.outcome ?? ''}>{turn.severity}</span>}
                            <span className={styles.time ?? ''}>{new Date(turn.at).toLocaleTimeString()}</span>
                            <span className={styles.duration ?? ''}>{formatCount(turn.durationMs)} ms</span>
                          </div>
                          <div className={styles.metrics ?? ''}>
                            <span className={styles.metric ?? ''}>
                              <span className={styles.metricLabel ?? ''}>{t('trajPrompt')} </span>
                              {prompt === undefined ? '—' : formatCount(prompt)}
                            </span>
                            <span className={styles.metric ?? ''}>
                              <span className={styles.metricLabel ?? ''}>{t('trajCached')} </span>
                              {turn.usage === undefined ? '—' : `${formatCount(turn.usage.cacheReadTokens ?? 0)} (${formatPercent(hit)})`}
                            </span>
                            <span className={styles.metric ?? ''}>
                              <span className={styles.metricLabel ?? ''}>{t('trajOutput')} </span>
                              {turn.usage === undefined ? '—' : formatCount(turn.usage.outputTokens)}
                            </span>
                            <span className={styles.metric ?? ''}>
                              <span className={styles.metricLabel ?? ''}>{t('trajHistory')} </span>
                              {formatCount(turn.historyTokens)}
                            </span>
                            <span className={styles.metric ?? ''}>
                              <span className={styles.metricLabel ?? ''}>{t('trajDelta')} </span>
                              {formatCount(turn.deltaChars)} ch
                            </span>
                          </div>
                          {turn.note !== undefined && turn.kind !== 'compaction' && (
                            <p className={styles.note ?? ''}>{turn.note}</p>
                          )}
                          {turn.error !== undefined && <p className={styles.error ?? ''}>{turn.error}</p>}
                        </li>
                      )
                    })}
                  </ol>
                )}
          </div>
        )}
    </div>
  )
}

/** One summary metric cell. */
function Stat(props: { readonly label: string; readonly value: string; readonly accent?: boolean }): ReactNode {
  return (
    <div className={styles.stat ?? ''}>
      <span className={styles.statLabel ?? ''}>{props.label}</span>
      <span className={`${styles.statValue ?? ''} ${props.accent === true ? styles.statValueAccent ?? '' : ''}`}>
        {props.value}
      </span>
    </div>
  )
}