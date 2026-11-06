/**
 * Delivery routing (spec §6, restructured 0.6.48) — the ONE rule for how an
 * accepted advice note reaches the primary agent.
 *
 * One {@link AdvisorDelivery} exists per plugin load and owns:
 *
 * - **The KD-4 per-session agent map**: keyed by `agent.id` (=== `session.id`),
 *   maintained by `index.ts` on `agent/created` / `agent/disposed`, with a
 *   registry fallback (`ctx.agents.get(sessionId)`, injected as
 *   `lookupAgent`) that covers agents published before this plugin loaded.
 *   A missing agent at delivery time drops the note with a log — advisory
 *   only, never throw, never stall.
 * - **The hold flag (pre-step review gate, `index.ts`)**: while a session's
 *   gate is HOLDING the primary loop (waiting for the review of the steps that
 *   just completed), the extracted note is COMMITTED directly to the session
 *   log — `session.append('user/message', …, { surfaceOp: 'append' })`. The
 *   host derives every step request from the session surface
 *   (`buildRequest` → `session.deriveMessages()`), so a note committed during
 *   the hold is part of the very next step's model call — it cannot miss it.
 *   (A steer during the hold WOULD miss it: the loop claims the inbox BEFORE
 *   the pre-step waterfall runs, so a steer inserted during the hold is only
 *   consumed at the FOLLOWING boundary.)
 * - **Everything else STEERS**: outside a hold every note is steered —
 *   `agent.steer`, which inserts into the durable next-step inbox and WAKES an
 *   idle agent (the host's `send(…, true)` semantics; `inject` does not wake
 *   and was retired with the 0.6.48 gate because an idle agent never claims
 *   what nobody wakes it for). A steered message is committed to the log by
 *   the loop itself when the next step claims it, so the durable shape is
 *   byte-identical to the commit arm: the notes read path (src/seed.ts)
 *   derives every view from exactly these committed `user/message` events.
 *
 * The old severity routing (nit → passive commit, concern/blocker → waking
 * steer), the reviewer's `wake` override, and the `immuneTurns` interrupt
 * cooldown are REMOVED (2026-11-04 user ruling: "all the notes are steer
 * immediately, remove other options"). The inter-note pacing now comes from
 * the gate itself — a review only runs after N completed steps and the loop
 * waits for it, so notes are separated by real agent work by construction.
 *
 * Message shape (spec §6): a user-role message via `createUserMessage` whose
 * source is this plugin's own producer kind (`kind: 'advisor'`, pinned to the
 * `notice` form; src/kinds.ts) and whose content is self-describing
 * `[advisor:{severity}] {note}` — the only cue the primary model gets about
 * how to treat it ("weigh, don't blindly obey" spirit). The kind is claimed by
 * declaration-merging `MessageSourceMap` in dsh-llm, and the V3→V4 format edge
 * preserves direct source kinds, so this identity is cross-generation-safe.
 *
 * Delivery is synchronous and fire-and-forget; the runtime path (T4 F1) is
 * what contains a throwing `steer`/`append` — this module lets agent-method
 * throws propagate to that containment seam.
 *
 * @module dsh-advisor/delivery
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AdvisorSource } from './kinds.js'
import type { AdviceNote } from './advisor-runtime.js'

/**
 * The channel one accepted note was delivered on (post-gate rule):
 * `commit` — appended directly to the session log, either DURING the pre-step
 * gate hold (so it joins the held step's own model request) or because the
 * advisor set `wake: false` at a turn boundary (recorded without interrupting);
 * `steer` — the default waking delivery, consumed at the next step boundary
 * (or the first step of the turn it wakes).
 */
export type DeliveryChannel = 'commit' | 'steer'

/** Minimal live-session surface the delivery router commits through. */
export interface AdvisorDeliverySession {
  /**
   * Append one event to the session log. Structurally satisfied by dsh's
   * `Session.append`; only the `user/message` + `surfaceOp: 'append'` shape
   * is ever used here.
   */
  append(type: 'user/message', data: UserMessage, intent: { surfaceOp: 'append' }): unknown
}

/** Minimal `Agent` surface the delivery router drives (spec §4, KD-4). */
export interface AdvisorDeliveryAgent {
  /** `Agent.id` — equals the session id by construction (KD-4). */
  readonly id: string
  /** The agent's live session — the gate-hold commit target (see module doc). */
  readonly session: AdvisorDeliverySession
  /** Waking: submit steering for the nearest step (spec §6). */
  steer(message: UserMessage): void
}

/** Logger seam (cordis `ctx.logger('advisor')` satisfies it; console works too). */
export interface AdvisorDeliveryLogger {
  debug(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Options for one {@link AdvisorDelivery}. */
export interface AdvisorDeliveryOptions {
  /**
   * KD-4 registry fallback (`ctx.agents.get(sessionId)`) — resolves agents
   * published before this plugin loaded, whose `agent/created` was never
   * observed. Absent → the map alone is authoritative.
   */
  readonly lookupAgent?: (sessionId: string) => AdvisorDeliveryAgent | undefined
  readonly logger?: AdvisorDeliveryLogger
}

/**
 * Build the advisor message for one note (spec §6): a user-role message whose
 * source carries this plugin's own producer kind and whose content is
 * self-describing `[advisor:{severity}] {note}`.
 *
 * Bounds (qc3 F-2 / qc2 S-1): the note itself is already capped at
 * `ADVISOR_NOTE_MAX_CHARS` by extraction; the collapsed-row summary is
 * additionally bounded via `boundContextSummary` (120 chars — the platform
 * `CONTEXT_SUMMARY_MAX_CHARS` convention), so the durable log and the
 * collapsed context row never carry an unbounded account.
 */
export function buildAdvisorMessage(note: AdviceNote): UserMessage {
  // One formatter for content and summary: the summary is derived from the
  // same string as the content via a fixed slice of the `[advisor:` marker
  // (`[` + everything after it), so the severity formatting can never drift
  // between the two — and note text mentioning "advisor:" cannot affect it.
  const text = `[advisor:${note.severity}] ${note.note}`
  const summary = `[${text.slice('[advisor:'.length)}`
  const source: AdvisorSource = {
    kind: 'advisor',
    // n4 (user direction): declare the notice form + a collapsed-row summary so
    // the web shell's ContextInjectionRow shows "… · advisor · [nit] <note>"
    // instead of a bare producer label. The severity tag is part of the summary
    // text; per-severity COLOR needs the shell UI (out of plugin reach).
    form: 'notice',
    summary: boundContextSummary(summary),
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
}

/**
 * Per-plugin delivery router: the KD-4 agent map and the hold flag.
 * Cordis-free, so the routing logic is unit-testable.
 */
export class AdvisorDelivery {
  private readonly lookupAgent: (sessionId: string) => AdvisorDeliveryAgent | undefined
  private readonly logger: AdvisorDeliveryLogger
  /** KD-4 per-session agent map, keyed by `agent.id` (=== session.id). */
  private readonly agents = new Map<string, AdvisorDeliveryAgent>()
  /**
   * Sessions whose pre-step review gate is currently HOLDING the primary loop
   * (`index.ts` brackets `runtime.waitQuiet` with hold/release). Notes for a
   * held session commit to the session log during the hold — the only way
   * they join the held step's own request (an inbox steer would be claimed a
   * step too late, because the loop claims before the pre-step waterfall).
   */
  private readonly holding = new Set<string>()

  constructor(options: AdvisorDeliveryOptions = {}) {
    this.lookupAgent = options.lookupAgent ?? (() => undefined)
    this.logger = options.logger ?? console
  }

  /** KD-4: register an agent on `agent/created` (keyed by `agent.id`). */
  registerAgent(agent: AdvisorDeliveryAgent): void {
    this.agents.set(agent.id, agent)
  }

  /** KD-4: drop an agent — and its hold flag with the session — on dispose. */
  unregisterAgent(sessionId: string): void {
    this.agents.delete(sessionId)
    this.holding.delete(sessionId)
  }

  /** Gate wiring: notes for this session now commit during the hold. */
  hold(sessionId: string): void {
    this.holding.add(sessionId)
  }

  /** Gate wiring: the hold ended — later notes steer again. Total. */
  release(sessionId: string): void {
    this.holding.delete(sessionId)
  }

  /** True while one gate hold is open for the session (tests/diagnostics). */
  isHeld(sessionId: string): boolean {
    return this.holding.has(sessionId)
  }

  /**
   * Route one accepted advice note (the post-gate ONE rule, KD-4).
   *
   * Resolves the primary agent via the map, falling back to the registry; a
   * missing agent drops the note with a log (advisory only — never throw,
   * never stall). While the session's gate holds the loop, the note is
   * COMMITTED to the session log (it joins the held step's model request);
   * every other note STEERS (waking, consumed at the next step boundary).
   *
   * @returns the channel delivered on, or `undefined` when dropped (no agent).
   */
  route(sessionId: string, note: AdviceNote): DeliveryChannel | undefined {
    const agent = this.agents.get(sessionId) ?? this.lookupAgent(sessionId)
    if (agent === undefined) {
      this.logger.warn('advisor: note dropped — no agent for session', {
        sessionId,
        severity: note.severity,
      })
      return undefined
    }
    const message = buildAdvisorMessage(note)
    // Fork addition: `wake: false` is the advisor's explicit "record, don't
    // interrupt" choice at a turn boundary. It uses the same durable shape as
    // the hold commit (a user/message event), just without a steer — the
    // primary sees it on its next run instead of being started for it. Inside
    // a hold the note already commits; there is no wake to suppress.
    if (this.holding.has(sessionId) || note.wake === false) {
      // Gate-hold commit / passive record: durable immediately, visible in the
      // chat flow, and (during a hold) part of that very step's request
      // (`buildRequest` derives from the session surface AFTER the pre-step
      // waterfall resolves). src/seed.ts derives the notes views from this
      // exact event shape.
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      return 'commit'
    }
    // Default: steer (wake if idle, consume at the next step boundary). The
    // loop commits the claimed message itself as the same user/message shape.
    agent.steer(message)
    return 'steer'
  }
}
