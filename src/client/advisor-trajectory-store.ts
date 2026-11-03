/**
 * Advisor trajectory controller (fork addition). One instance per session
 * scope binding: it polls the host's READ-ONLY `/api/advisor/trajectory`
 * endpoint for the advisor's own model attempts — prompt/cached/output
 * tokens, duration, outcome and the history budget in force — and exposes
 * them through a uSES-safe snapshot store the Advisor tab renders from.
 *
 * The endpoint only reads the host's bounded per-session attempt log, so the
 * idle poll is cheap. Ordering is fenced by a monotonic `requestSeq`: a newer
 * fetch supersedes an unresolved older one, whose settle is discarded.
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { DEFAULT_HISTORY_MAX_TOKENS } from '../limits'

/** How often the Advisor tab refreshes while mounted (no model calls involved). */
export const ADVISOR_TRAJECTORY_POLL_MS = 3_000

/** One advisor model attempt, client mirror of the host's `AdvisorTurnView`. */
export interface AdvisorTrajectoryTurn {
  readonly at: number
  readonly durationMs: number
  readonly outcome: 'note' | 'no-note' | 'failure' | 'aborted'
  /** Stable attempt id — keys the expand lookup. */
  readonly id: number
  /** Which call this row describes (fork addition); absent = review. */
  readonly kind?: 'review' | 'compaction'
  /** Bounded text of the delta actually sent (user row for the Advisor tab). */
  readonly userText?: string
  readonly severity?: 'nit' | 'concern' | 'blocker'
  readonly note?: string
  /** Whether the accepted note actually reached the primary session. */
  readonly delivered?: boolean
  readonly deltaChars: number
  readonly historyTokens: number
  readonly systemChars: number
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly reasoningTokens?: number
    readonly totalTokens?: number
  }
  readonly error?: string
}

/**
 * Validate and cap the wire turns at the poll boundary (fork addition).
 * Exported for direct tests: the poll ships previews every few seconds, so
 * both text slots are type-checked and capped, and a row whose outcome is not
 * in the host's union is dropped instead of reaching the view.
 */
export function normalizeTrajectoryTurns(raw: readonly unknown[]): AdvisorTrajectoryTurn[] {
  return raw
    .filter((turn): turn is AdvisorTrajectoryTurn => (
      typeof turn === 'object' && turn !== null
      && typeof (turn as { at?: unknown }).at === 'number'
      && typeof (turn as { durationMs?: unknown }).durationMs === 'number'
      && typeof (turn as { id?: unknown }).id === 'number'
      && ['note', 'no-note', 'failure', 'aborted'].includes((turn as { outcome?: string }).outcome ?? '')
    ))
    .map((turn) => {
      const userText = (turn as { userText?: unknown }).userText
      const note = (turn as { note?: unknown }).note
      return {
        ...turn,
        ...(typeof userText === 'string'
          ? { userText: userText.length > 8_000 ? `${userText.slice(0, 8_000)}…[truncated]` : userText }
          : {}),
        ...(typeof note === 'string'
          ? { note: note.length > 2_000 ? `${note.slice(0, 2_000)}…[truncated]` : note }
          : {}),
      }
    })
}

/** The Advisor tab's snapshot. */
export interface AdvisorTrajectoryState {
  /** idle → pending (fetch in flight) → ready; every failure latches unavailable. */
  status: 'idle' | 'pending' | 'ready' | 'unavailable'
  /** Attempts, oldest → newest (bounded by the host, ≤ 80). */
  turns: AdvisorTrajectoryTurn[]
  /** Whether the advisor is effectively on for this session. */
  enabled: boolean
  /** The reviewer runtime status ('running' | 'disabled' | 'halted' | …). */
  runtimeStatus: string
  /** Configured append-only history budget in estimated tokens. */
  historyMaxTokens: number
  /** The effective reviewer route, when resolved. */
  provider?: string
  model?: string
}

/** The wire payload of `/api/advisor/trajectory`. */
type AdvisorTrajectoryRpcPayload =
  | {
    readonly turns: readonly AdvisorTrajectoryTurn[]
    readonly enabled: boolean
    readonly runtimeStatus: string
    readonly historyMaxTokens: number
    readonly provider?: string
    readonly model?: string
  }
  | { readonly error: { readonly tag: string; readonly message: string } }

/** Shared controllers keyed by transport then session (one poll per session). */
const sharedControllers = new WeakMap<ClientConnectionRpc, Map<string, AdvisorTrajectoryController>>()

/** Return the shared per-session trajectory controller for one RPC transport. */
export function advisorTrajectoryControllerFor(
  sessionId: string,
  rpc: ClientConnectionRpc,
): AdvisorTrajectoryController {
  let perSession = sharedControllers.get(rpc)
  if (perSession === undefined) {
    perSession = new Map()
    sharedControllers.set(rpc, perSession)
  }
  let controller = perSession.get(sessionId)
  if (controller === undefined) {
    controller = new AdvisorTrajectoryController(sessionId, rpc)
    perSession.set(sessionId, controller)
  }
  return controller
}

export class AdvisorTrajectoryController {
  readonly sessionId: string

  /** The snapshot the Advisor tab renders from (uSES-safe store). */
  readonly store: SnapshotStore<AdvisorTrajectoryState> = createSnapshotStore<AdvisorTrajectoryState>({
    status: 'idle',
    turns: [],
    enabled: false,
    runtimeStatus: 'disabled',
    historyMaxTokens: DEFAULT_HISTORY_MAX_TOKENS,
  })

  /** Fence token: a newer fetch makes every older settle stale. */
  private requestSeq = 0
  /** The mounted poll timer (owned by start/stop, not the component). */
  private timer: number | undefined
  /** Mount count: one controller can feed more than one surface. */
  private mounts = 0
  /** Expand-on-demand cache: full text by row index (never polled). */
  private readonly entryCache = new Map<number, string>()

  constructor(sessionId: string, private readonly rpc: ClientConnectionRpc) {
    this.sessionId = sessionId
  }

  /**
   * Fetch the full text of one trajectory row on demand (fork addition).
   * Cached per index; a failure returns `undefined` and the row keeps its
   * preview (the poll must never grow to carry full text).
   */
  async fetchEntry(id: number): Promise<string | undefined> {
    const cached = this.entryCache.get(id)
    if (cached !== undefined) return cached
    try {
      const result = await this.rpc.call('/api', 'advisor/trajectoryEntry', {
        args: { sessionId: this.sessionId, id },
      })
      if (!result.ok) return undefined
      const payload = result.value as { readonly text?: unknown } | undefined
      if (payload === null || typeof payload !== 'object' || typeof payload.text !== 'string') return undefined
      this.entryCache.set(id, payload.text)
      return payload.text
    } catch {
      return undefined
    }
  }

  /** Begin polling: fetch once immediately, then on the idle cadence (reference-counted). */
  start(): void {
    this.mounts += 1
    if (this.timer !== undefined) return
    void this.fetch()
    this.timer = window.setInterval(() => { void this.fetch() }, ADVISOR_TRAJECTORY_POLL_MS)
  }

  /** Release one mount; polling stops when the last surface unmounts. */
  stop(): void {
    this.mounts = Math.max(0, this.mounts - 1)
    if (this.mounts > 0 || this.timer === undefined) return
    window.window.clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Fetch the session's advisor attempts. A stale settle is discarded
   * wholesale. Every failure shape keeps the last good turns and latches
   * `unavailable`; never throws.
   */
  async fetch(): Promise<void> {
    const seq = ++this.requestSeq
    this.store.update((s) => { s.status = 'pending' })
    let payload: AdvisorTrajectoryRpcPayload | undefined
    try {
      const result = await this.rpc.call('/api', 'advisor/trajectory', { args: { sessionId: this.sessionId } })
      if (result.ok) payload = result.value as AdvisorTrajectoryRpcPayload
    } catch {
      // Transport failure → payload stays undefined (unavailable below).
    }
    if (seq !== this.requestSeq) return
    if (
      payload !== undefined
      && typeof payload === 'object'
      && payload !== null
      && Array.isArray((payload as { turns?: unknown }).turns)
    ) {
      const wire = payload as Exclude<AdvisorTrajectoryRpcPayload, { error: unknown }>
      const turns = normalizeTrajectoryTurns(wire.turns)
      this.store.update((s) => {
        s.status = 'ready'
        s.turns = turns
        s.enabled = wire.enabled === true
        s.runtimeStatus = typeof wire.runtimeStatus === 'string' ? wire.runtimeStatus : 'disabled'
        s.historyMaxTokens = typeof wire.historyMaxTokens === 'number' ? wire.historyMaxTokens : DEFAULT_HISTORY_MAX_TOKENS
        s.provider = typeof wire.provider === 'string' ? wire.provider : undefined
        s.model = typeof wire.model === 'string' ? wire.model : undefined
      })
      return
    }
    this.store.update((s) => { s.status = 'unavailable' })
  }
}