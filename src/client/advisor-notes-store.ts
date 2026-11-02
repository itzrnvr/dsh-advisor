/**
 * Advisor notes controller (fork addition). One instance per session scope
 * binding: it polls the host's READ-ONLY `/api/advisor/notes` endpoint for the
 * notes the reviewer actually delivered in this session (severity, text,
 * channel, time) plus the live switch/route state, and exposes them through a
 * uSES-safe snapshot store the in-chat Advisor strip renders from.
 *
 * The endpoint is side-effect-free (it only reads the host's bounded per-
 * session note log), so a short idle poll is cheap and cannot perturb the
 * reviewer. Ordering is fenced by a monotonic `requestSeq`: a newer fetch
 * supersedes an unresolved older one, whose settle is discarded wholesale.
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** How often the strip refreshes while mounted (no model calls involved). */
export const ADVISOR_NOTES_POLL_MS = 4_000

/** One delivered note, client mirror of the host's `AdvisorNoteView`. */
export interface AdvisorNote {
  readonly at: number
  readonly severity: 'nit' | 'concern' | 'blocker'
  readonly text: string
  readonly channel: 'inject' | 'steer'
}

/** The strip's snapshot. */
export interface AdvisorNotesState {
  /** idle → pending (fetch in flight) → ready; every failure latches unavailable. */
  status: 'idle' | 'pending' | 'ready' | 'unavailable'
  /** Delivered notes, oldest → newest (bounded by the host, ≤ 30). */
  notes: AdvisorNote[]
  /** Whether the advisor is effectively on for this session. */
  enabled: boolean
  /** The reviewer runtime status ('running' | 'disabled' | 'halted' | …). */
  runtimeStatus: string
  /** The effective reviewer route, when resolved. */
  provider?: string
  model?: string
  /** Epoch-ms of the last accepted note, when known. */
  lastActivityAt?: number
  /** Whether the expanded note list is open. */
  expanded: boolean
  /** Whether the user dismissed the strip for this page lifetime. */
  dismissed: boolean
}

/** The wire payload of `/api/advisor/notes`. */
type AdvisorNotesRpcPayload =
  | {
    readonly notes: readonly AdvisorNote[]
    readonly enabled: boolean
    readonly runtimeStatus: string
    readonly provider?: string
    readonly model?: string
    readonly lastActivityAt?: number
  }
  | { readonly error: { readonly tag: string; readonly message: string } }

/** Per-session notes controller (one per session scope binding). */
export class AdvisorNotesController {
  readonly sessionId: string

  /** The snapshot the in-chat strip renders from (uSES-safe store). */
  readonly store: SnapshotStore<AdvisorNotesState> = createSnapshotStore<AdvisorNotesState>({
    status: 'idle',
    notes: [],
    enabled: false,
    runtimeStatus: 'disabled',
    expanded: false,
    dismissed: false,
  })

  /** Fence token: a newer fetch makes every older settle stale. */
  private requestSeq = 0

  /** The mounted poll timer (owned by start/stop, not the component). */
  private timer: number | undefined

  constructor(sessionId: string, private readonly rpc: ClientConnectionRpc) {
    this.sessionId = sessionId
  }

  /** Begin polling: fetch once immediately, then on the idle cadence. */
  start(): void {
    if (this.timer !== undefined) return
    void this.fetch()
    this.timer = window.setInterval(() => { void this.fetch() }, ADVISOR_NOTES_POLL_MS)
  }

  /** Stop polling (component unmount). Safe to call repeatedly. */
  stop(): void {
    if (this.timer === undefined) return
    window.clearInterval(this.timer)
    this.timer = undefined
  }

  /** Toggle the expanded note list. */
  toggleExpanded(): void {
    this.store.update((s) => { s.expanded = !s.expanded })
  }

  /** Hide the strip for this page lifetime (a reload brings it back). */
  dismiss(): void {
    this.store.update((s) => { s.dismissed = true })
  }

  /**
   * Fetch the session's recent notes. A stale settle (a newer fetch
   * superseded this one) is discarded wholesale. Every failure shape (tagged
   * error, `ok:false`, malformed payload, or a throw) latches `unavailable`
   * and keeps the last good notes; never throws.
   */
  async fetch(): Promise<void> {
    const seq = ++this.requestSeq
    this.store.update((s) => { s.status = 'pending' })
    let payload: AdvisorNotesRpcPayload | undefined
    try {
      const result = await this.rpc.call('/api', 'advisor/notes', { args: { sessionId: this.sessionId } })
      if (result.ok) payload = result.value as AdvisorNotesRpcPayload
    } catch {
      // Transport failure → payload stays undefined (unavailable below).
    }
    if (seq !== this.requestSeq) return
    if (
      payload !== undefined
      && typeof payload === 'object'
      && payload !== null
      && Array.isArray((payload as { notes?: unknown }).notes)
    ) {
      const wire = payload as Exclude<AdvisorNotesRpcPayload, { error: unknown }>
      const notes = wire.notes
        .filter((note): note is AdvisorNote => (
          typeof note === 'object' && note !== null
          && typeof note.at === 'number'
          && typeof note.text === 'string'
          && (note.severity === 'nit' || note.severity === 'concern' || note.severity === 'blocker')
          && (note.channel === 'inject' || note.channel === 'steer')
        ))
      this.store.update((s) => {
        s.status = 'ready'
        s.notes = notes
        s.enabled = wire.enabled === true
        s.runtimeStatus = typeof wire.runtimeStatus === 'string' ? wire.runtimeStatus : 'disabled'
        s.provider = typeof wire.provider === 'string' ? wire.provider : undefined
        s.model = typeof wire.model === 'string' ? wire.model : undefined
        s.lastActivityAt = typeof wire.lastActivityAt === 'number' ? wire.lastActivityAt : undefined
      })
      return
    }
    // Tagged error, transport fold, malformed payload, or a throw: keep the
    // last good notes and let the next scheduled poll retry.
    this.store.update((s) => { s.status = 'unavailable' })
  }
}