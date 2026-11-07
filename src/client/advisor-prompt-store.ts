/**
 * Session prompt-layer controller (fork addition, 2026-11-07).
 *
 * The session header panel's four editable surfaces: the profile-wide append,
 * the workspace instructions, the session instructions, and the active-rule
 * list. Every call carries ITS OWN sessionId and commits only into its own
 * snapshot store (the structural binding fence the model controller uses); a
 * monotonic request sequence discards stale settles.
 *
 * The host reads the four surfaces together and returns them after every
 * write, so the panel always renders server truth — no optimistic local
 * merge can drift from what the reviewer will actually see.
 *
 * @module dsh-advisor/client/advisor-store
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One of the three prompt scopes (mirrors the host wire type). */
export type AdvisorPromptScope = 'system' | 'workspace' | 'session'

/** One active rule with its scope-local index. */
export interface AdvisorPromptRuleView {
  readonly scope: AdvisorPromptScope
  readonly index: number
  readonly text: string
}

/** The four editable surfaces, as the host composes them. */
export interface AdvisorPromptStateView {
  readonly systemWide: string
  readonly workspace: string
  readonly session: string
  readonly rules: readonly AdvisorPromptRuleView[]
  /** False when the session has no cwd — the workspace layer is unavailable. */
  readonly workspaceKnown: boolean
}

/** The RPC result union for `/api/advisor/*Prompt*`. */
export interface AdvisorPromptRpcPayload {
  readonly state?: AdvisorPromptStateView
  readonly error?: { readonly tag: string; readonly message: string }
}

/** The session panel's prompt tab snapshot. */
export interface AdvisorPromptMenuState {
  phase: 'idle' | 'loading' | 'ready'
  state: AdvisorPromptStateView | null
  error: string | null
  pending: boolean
  unavailable: boolean
}

/**
 * Per-session prompt controller (one per session binding). Reads on open /
 * refresh; every write returns the refreshed state.
 */
export class AdvisorSessionPromptController {
  readonly sessionId: string
  readonly store: SnapshotStore<AdvisorPromptMenuState> = createSnapshotStore<AdvisorPromptMenuState>({
    phase: 'idle',
    state: null,
    error: null,
    pending: false,
    unavailable: false,
  })

  private requestSeq = 0
  /** Last consumed refresh-signal epoch (reconnect / focus bumps). */
  private lastSignal: number | undefined

  constructor(sessionId: string, private readonly rpc: ClientConnectionRpc) {
    this.sessionId = sessionId
  }

  /** Idempotent per epoch: true once per new refresh signal. */
  takeSignal(epoch: number): boolean {
    if (this.lastSignal === epoch) return false
    this.lastSignal = epoch
    return true
  }

  /** Fetch the four surfaces (`/api/advisor/getPromptState`). */
  async refresh(): Promise<void> {
    const seq = ++this.requestSeq
    this.store.update((s) => {
      s.phase = 'loading'
      s.pending = false
      s.error = null
    })
    let payload: AdvisorPromptRpcPayload | undefined
    let transport: string | undefined
    try {
      const result = await this.rpc.call('/api', 'advisor/getPromptState', { args: { sessionId: this.sessionId } })
      if (seq !== this.requestSeq) return
      if (result.ok) payload = result.value as AdvisorPromptRpcPayload
      else transport = result.error.message
    } catch (error) {
      if (seq !== this.requestSeq) return
      transport = error instanceof Error ? error.message : String(error)
    }
    this.applyOutcome(payload, transport, seq)
  }

  /** Replace one free-text layer. */
  async setLayer(layer: AdvisorPromptScope, text: string): Promise<void> {
    await this.write('advisor/setPromptLayer', { layer, text })
  }

  /** Append one rule to a scope. */
  async addRule(scope: AdvisorPromptScope, text: string): Promise<void> {
    await this.write('advisor/addPromptRule', { scope, text })
  }

  /** Replace one rule by its scope-local index. */
  async updateRule(scope: AdvisorPromptScope, index: number, text: string): Promise<void> {
    await this.write('advisor/updatePromptRule', { scope, index, text })
  }

  /** Delete one rule by its scope-local index. */
  async deleteRule(scope: AdvisorPromptScope, index: number): Promise<void> {
    await this.write('advisor/deletePromptRule', { scope, index })
  }

  private async write(method: string, args: Record<string, unknown>): Promise<void> {
    if (this.store.getSnapshot().unavailable) {
      this.store.update((s) => {
        s.error = 'advisor: the session prompt surface is unavailable — writes are not offered'
      })
      return
    }
    const seq = ++this.requestSeq
    this.store.update((s) => {
      s.pending = true
      s.error = null
    })
    let payload: AdvisorPromptRpcPayload | undefined
    let transport: string | undefined
    try {
      const result = await this.rpc.call('/api', method, { args: { sessionId: this.sessionId, ...args } })
      if (seq !== this.requestSeq) return
      if (result.ok) payload = result.value as AdvisorPromptRpcPayload
      else transport = result.error.message
    } catch (error) {
      if (seq !== this.requestSeq) return
      transport = error instanceof Error ? error.message : String(error)
    }
    this.applyOutcome(payload, transport, seq)
  }

  private applyOutcome(payload: AdvisorPromptRpcPayload | undefined, transport: string | undefined, seq: number): void {
    if (seq !== this.requestSeq) return
    const tagged = payload?.error
    if (transport !== undefined || tagged?.tag === 'advisor/unavailable' || tagged?.tag === 'advisor/session-unknown') {
      this.store.update((s) => {
        s.phase = 'ready'
        s.unavailable = true
        s.pending = false
        s.error = transport ?? tagged?.message ?? 'advisor: the session prompt surface is unavailable'
      })
      return
    }
    if (tagged !== undefined) {
      this.store.update((s) => {
        s.phase = 'ready'
        s.pending = false
        s.error = tagged.message
      })
      return
    }
    if (payload?.state === undefined) {
      this.store.update((s) => {
        s.phase = 'ready'
        s.unavailable = true
        s.pending = false
        s.error = 'advisor: the prompt endpoint returned no state'
      })
      return
    }
    this.store.update((s) => {
      s.phase = 'ready'
      s.state = payload.state!
      s.unavailable = false
      s.pending = false
      s.error = null
    })
  }
}