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
  /** How the note was delivered: a direct session-log commit, or a waking steer. */
  readonly channel: 'commit' | 'steer'
  /** Turn the review belonged to (absent when the host could not attribute it). */
  readonly turn?: number
}

/** The strip's snapshot. */
export interface AdvisorNotesState {
  /** idle → pending (fetch in flight) → ready; every failure latches unavailable. */
  status: 'idle' | 'pending' | 'ready' | 'unavailable'
  /** Delivered notes, oldest → newest (the host's full derivation; every
   * surface bounds its own view — the strip shows 3, a turn tail 5). */
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
/** Shared controllers keyed by transport then session, so the dock and every
 * turn tail observe ONE poll per session. */
const sharedControllers = new WeakMap<ClientConnectionRpc, Map<string, AdvisorNotesController>>()

/** Return the shared per-session notes controller for one RPC transport. */
export function advisorNotesControllerFor(
  sessionId: string,
  rpc: ClientConnectionRpc,
): AdvisorNotesController {
  let perSession = sharedControllers.get(rpc)
  if (perSession === undefined) {
    perSession = new Map<string, AdvisorNotesController>()
    sharedControllers.set(rpc, perSession)
  }
  let controller = perSession.get(sessionId)
  if (controller === undefined) {
    controller = new AdvisorNotesController(sessionId, rpc)
    perSession.set(sessionId, controller)
  }
  return controller
}

export class AdvisorNotesController {
  readonly sessionId: string

  /** The snapshot the in-chat strip renders from (uSES-safe store). */
  readonly store: SnapshotStore<AdvisorNotesState> = createSnapshotStore<AdvisorNotesState>({
    status: 'idle',
    notes: [],
    enabled: false,
    runtimeStatus: 'disabled',
    dismissed: false,
  })

  /** Fence token: a newer fetch makes every older settle stale. */
  private requestSeq = 0
  /** Signature of the last published payload (change guard — no churn on polls). */
  private lastSignature: string | undefined

  /** The mounted poll timer (owned by start/stop, not the component). */
  private timer: ReturnType<typeof setInterval> | undefined

  /** Mount count: the controller is shared across surfaces (dock + turn tails). */
  private mounts = 0

  constructor(sessionId: string, private readonly rpc: ClientConnectionRpc) {
    this.sessionId = sessionId
  }

  /** Begin polling: fetch once immediately, then on the idle cadence (reference-counted). */
  start(): void {
    this.mounts += 1
    if (this.timer !== undefined) return
    void this.fetch()
    this.timer = setInterval(() => { void this.fetch() }, ADVISOR_NOTES_POLL_MS)
  }

  /** Release one mount; polling stops when the last surface unmounts. */
  stop(): void {
    this.mounts = Math.max(0, this.mounts - 1)
    if (this.mounts > 0 || this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Hide the strip for now. A newly arriving concern/blocker re-arms it (see
   * fetch) — interrupting advice the user has not seen must not stay hidden
   * behind a dismiss clicked for an older batch.
   */
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
    // First load only: `pending` is a loading state, not a per-poll flip. A
// persistently failing RPC must not oscillate pending↔unavailable, and a
// loaded list must keep rendering untouched while a poll is in flight.
    if (this.store.getSnapshot().status === 'idle') {
      this.store.update((s) => { s.status = 'pending' })
    }
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
          && (note.channel === 'commit' || note.channel === 'steer')
        ))
        .map((note) => ({
          ...note,
          ...(typeof (note as { turn?: unknown }).turn === 'number' ? { turn: (note as { turn?: number }).turn } : {}),
        }))
      const next = {
        notes,
        enabled: wire.enabled === true,
        runtimeStatus: typeof wire.runtimeStatus === 'string' ? wire.runtimeStatus : 'disabled',
        provider: typeof wire.provider === 'string' ? wire.provider : undefined,
        model: typeof wire.model === 'string' ? wire.model : undefined,
        lastActivityAt: typeof wire.lastActivityAt === 'number' ? wire.lastActivityAt : undefined,
      }
      // Dismiss re-arm: a concern/blocker NEWER than anything published lifts
      // a dismissed strip — interrupting advice the user has not seen must
      // not stay hidden behind a dismiss clicked for an older batch. Keyed on
      // the UNTAGGED bucket: tagged notes render in turn tails, so re-arming
      // for them would pop the strip only for it to render null.
      const previous = this.store.getSnapshot()
      const previousUntagged = previous.notes.filter((note) => note.turn === undefined)
      const previousLastAt = previousUntagged.length > 0 ? previousUntagged[previousUntagged.length - 1]!.at : 0
      const importantArrival = previous.dismissed
        && notes.some((note) => note.turn === undefined && note.severity !== 'nit' && note.at > previousLastAt)
      // Change guard: identical payloads publish nothing. `lastActivityAt` is
      // excluded from the comparison (it moves on any accepted note, which
      // already changes `notes`) so a timestamp-only change cannot churn
      // every tail.
      const signature = JSON.stringify({ notes: next.notes, enabled: next.enabled, runtimeStatus: next.runtimeStatus, provider: next.provider, model: next.model })
      if (signature === this.lastSignature && this.store.getSnapshot().status === 'ready') {
        const previousActivity = this.store.getSnapshot().lastActivityAt
        if (previousActivity !== next.lastActivityAt) {
          this.store.update((s) => { s.lastActivityAt = next.lastActivityAt })
        }
        return
      }
      this.lastSignature = signature
      this.store.update((s) => {
        s.status = 'ready'
        s.notes = next.notes
        s.enabled = next.enabled
        s.runtimeStatus = next.runtimeStatus
        s.provider = next.provider
        s.model = next.model
        s.lastActivityAt = next.lastActivityAt
        if (importantArrival) s.dismissed = false
      })
      return
    }
    // Tagged error, transport fold, malformed payload, or a throw: keep the
    // last good notes and let the next scheduled poll retry.
    if (this.store.getSnapshot().status !== 'unavailable') {
      this.store.update((s) => { s.status = 'unavailable' })
    }
  }
}