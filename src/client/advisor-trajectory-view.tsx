/**
 * Advisor tab (fork addition) — the reviewer's OWN session, rendered as a
 * third view beside Chat and Trajectory in the conversation header.
 *
 * It shows one row per model ATTEMPT (a retry is its own row) with the token
 * accounting the provider reported: prompt tokens (uncached + cache reads +
 * cache writes), how many of those came from the prefix cache, output tokens,
 * latency, and how much history was re-sent. The summary strip adds the
 * session-wide cache hit rate and the configured history budget, so "is the
 * append-only history actually being cached?" is answerable at a glance.
 */

import { useEffect, type ReactNode } from 'react'
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

/** Outcome chip class (severity colours a delivered note). */
function outcomeClass(turn: AdvisorTrajectoryTurn): string {
  if (turn.outcome !== 'note') return styles[`outcome${turn.outcome === 'no-note' ? 'Silent' : turn.outcome === 'failure' ? 'Failure' : 'Aborted'}`] ?? ''
  return styles.outcomeNote ?? ''
}

/**
 * Render the advisor's trajectory for this session.
 * @param props - the injected face, locale seat and snapshot hook.
 * @returns the ledger, or a short empty/unavailable state.
 */
export function AdvisorTrajectoryView(props: AdvisorTrajectoryViewProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const state = useSnapshot((snapshot) => snapshot)

  useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  const measured = state.turns.filter((turn) => turn.usage !== undefined)
  const totalPrompt = measured.reduce((sum, turn) => sum + (promptTokens(turn) ?? 0), 0)
  const totalCached = measured.reduce((sum, turn) => sum + (turn.usage?.cacheReadTokens ?? 0), 0)
  const totalOutput = measured.reduce((sum, turn) => sum + (turn.usage?.outputTokens ?? 0), 0)
  const overallHit = totalPrompt > 0 ? totalCached / totalPrompt : 0

  const statusLight = state.status === 'pending' || state.status === 'idle'
  const route = state.provider === undefined && state.model === undefined
    ? t('trajNoModel')
    : `${state.provider ?? ''}${state.provider !== undefined && state.model !== undefined ? ' · ' : ''}${state.model ?? ''}`

  return (
    <div className={styles.page ?? ''}>
      <header className={styles.header ?? ''}>
        <div className={styles.title ?? ''}>{t('trajHeading')}</div>
        <div className={styles.meta ?? ''}>
          <span>{t('trajModel')}: <span className={styles.metaStrong ?? ''}>{route}</span></span>
          <span>{t('trajStatusLabel')}: <span className={styles.metaStrong ?? ''}>{state.runtimeStatus}</span></span>
        </div>
      </header>
      <p className={styles.hint ?? ''}>{t('trajHint')}</p>

      <div className={styles.statGrid ?? ''}>
        <Stat label={t('trajCalls')} value={String(state.turns.length)} />
        <Stat label={t('trajCacheHit')} value={formatPercent(overallHit)} accent={overallHit > 0} />
        <Stat label={t('trajPromptTokens')} value={formatCount(totalPrompt)} />
        <Stat label={t('trajCachedTokens')} value={formatCount(totalCached)} />
        <Stat label={t('trajOutputTokens')} value={formatCount(totalOutput)} />
        <Stat
          label={t('trajHistoryBudget')}
          value={state.effectiveHistoryMaxTokens < state.historyMaxTokens
            ? t('trajBudgetOf', {
              effective: formatCount(state.effectiveHistoryMaxTokens),
              configured: formatCount(state.historyMaxTokens),
            })
            : `${formatCount(state.historyMaxTokens)} tok`}
        />
      </div>

      {state.status === 'unavailable' && state.turns.length === 0
        ? <p className={styles.empty ?? ''}>{t('trajUnavailable')}</p>
        : state.turns.length === 0
          ? <p className={styles.empty ?? ''}>{statusLight ? t('trajPending') : t('trajEmpty')}</p>
          : (
            <ol className={styles.list ?? ''}>
              {state.turns.map((turn, index) => {
                const prompt = promptTokens(turn)
                const hit = cacheHit(turn)
                return (
                  <li key={`${turn.at}-${index}`} className={styles.row ?? ''}>
                    <div className={styles.rowHead ?? ''}>
                      <span className={styles.outcome ?? ''}>{t(outcomeKey(turn))}</span>
                      {turn.severity !== undefined && (
                        <span className={styles.outcome ?? ''}>
                          {turn.severity}
                        </span>
                      )}
                      <span className={styles.time ?? ''}>
                        {new Date(turn.at).toLocaleTimeString()}
                      </span>
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
                    {turn.note !== undefined && <p className={styles.note ?? ''}>{turn.note}</p>}
                    {turn.error !== undefined && <p className={styles.error ?? ''}>{turn.error}</p>}
                  </li>
                )
              })}
            </ol>
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