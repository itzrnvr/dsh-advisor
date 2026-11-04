/**
 * T6 — delivery routing (0.6.48 one rule, spec §8.4 KD-4 retained).
 *
 * Contract under test:
 * - `AdvisorDelivery.route(sessionId, note)` resolves the primary agent for the
 *   session (per-session map from `agent/created`/`agent/disposed` keyed by
 *   `agent.id` === `session.id`, with a `ctx.agents.get(session.id)` registry
 *   fallback — KD-4) and routes the accepted note by the ONE rule:
 *   - session held by the pre-step review gate → direct session-log commit
 *     (non-waking — the held step's own request derives it from the surface,
 *     so the note cannot miss the step it gates);
 *   - otherwise → `agent.steer` (waking — idle driver starts a turn, running
 *     driver consumes at the next step boundary);
 *   - missing agent → drop the note + log (never throw, never stall).
 *   Severity NEVER selects the channel (the 2026-11-04 ruling retired
 *   nit→commit / concern→steer routing together with the `wake` reviewer flag
 *   and the immuneTurns cooldown — the gate's step clock paces notes).
 * - Advisor message shape (spec §6): a user-role message via `createUserMessage`
 *   whose source is this plugin's own producer kind (`kind: 'advisor'`,
 *   pinned to the `notice` form — src/kinds.ts) and whose content is
 *   self-describing `[advisor:{severity}] {note}`.
 * - The hold bracket (`hold`/`release`, driven by `index.ts` around
 *   `runtime.waitQuiet`): `isHeld` mirrors it; `unregisterAgent` clears it
 *   with the session; a release on one session never leaks into another.
 * - Observer hooks: `SessionTranscriptObserver` fires `onRewrite` on
 *   compact/replace events (the KD-5 latch reset). `onSteppedTurnEnd` is gone
 *   with the cooldown it fed.
 * - Containment (T4 F1): a throwing agent method inside `route` (the real
 *   delivery seam) never crashes the runtime drain.
 *
 * Events are synthetic but shaped exactly like dsh emits (same builders as the
 * T3 suite); the `feedAppend` helper mirrors the cordis `session/event`
 * listener (each appended event delivered once against the growing live log).
 */

import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { CONTEXT_SUMMARY_MAX_CHARS, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SurfaceOp } from '@deepseek-ai/dsh-session'
import { AdvisorDelivery, buildAdvisorMessage } from '../src/delivery'
import type { AdvisorDeliveryAgent, AdvisorDeliveryLogger } from '../src/delivery'
import { ADVISOR_PLUGIN_ID, isAdvisorMessage } from '../src/kinds'
import { SessionTranscriptObserver } from '../src/transcript'
import type { Delta } from '../src/transcript'
import { AdvisorRuntime } from '../src/advisor-runtime'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Silent logger default so tests don't spam console; pass a spy to assert. */
const silentLogger: AdvisorDeliveryLogger = { debug: () => {}, warn: () => {} }

function makeLogger(): { logger: AdvisorDeliveryLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  return { logger: { debug: () => {}, warn }, warn }
}

/** Fake agent with steer + direct-commit spies (structural `AdvisorDeliveryAgent`). */
function makeAgent(id = 's1'): {
  agent: AdvisorDeliveryAgent
  commit: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
  const steer = vi.fn()
  const commit = vi.fn()
  const agent: AdvisorDeliveryAgent = {
    id,
    session: { append: commit },
    steer,
  }
  return { agent, commit, steer }
}

function makeDelivery(
  overrides: Partial<ConstructorParameters<typeof AdvisorDelivery>[0]> = {},
): AdvisorDelivery {
  return new AdvisorDelivery({ logger: silentLogger, ...overrides })
}

// ---------------------------------------------------------------------------
// The one rule: held → commit, otherwise steer (0.6.48)
// ---------------------------------------------------------------------------

describe('AdvisorDelivery — one-rule routing (0.6.48)', () => {
  it('steers EVERY severity when the session is not held — severity never routes', () => {
    const { agent, commit, steer } = makeAgent()
    const delivery = makeDelivery()
    delivery.registerAgent(agent)

    expect(delivery.route('s1', { note: 'add a test for this branch', severity: 'nit' })).toBe('steer')
    expect(delivery.route('s1', { note: 'this loop looks wrong', severity: 'concern' })).toBe('steer')
    expect(delivery.route('s1', { note: 'continuing clearly wastes work', severity: 'blocker' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(3)
    expect(commit).not.toHaveBeenCalled()
  })

  it('commits to the session log while the pre-step gate holds the session', () => {
    const { agent, commit, steer } = makeAgent()
    const delivery = makeDelivery()
    delivery.registerAgent(agent)
    delivery.hold('s1')

    expect(delivery.route('s1', { note: 'mid-gate note', severity: 'concern' })).toBe('commit')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()

    // Release returns the session to the waking default.
    delivery.release('s1')
    expect(delivery.route('s1', { note: 'after release', severity: 'nit' })).toBe('steer')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('resolves the agent via the registry fallback when the map has no entry (KD-4)', () => {
    const { agent, steer } = makeAgent()
    // The map is empty; only the registry fallback can resolve the agent.
    const delivery = makeDelivery({ lookupAgent: (id) => (id === 's1' ? agent : undefined) })

    expect(delivery.route('s1', { note: 'fallback steering', severity: 'concern' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Advisor message construction (spec §6)
// ---------------------------------------------------------------------------

describe('AdvisorDelivery — advisor message construction (spec §6)', () => {
  it('builds a user-role message with the advisor source kind and self-describing content', () => {
    const message = buildAdvisorMessage({ note: 'extract the helper', severity: 'concern' })
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('advisor')
    expect(message.source).toMatchObject({
      form: 'notice',
      summary: '[concern] extract the helper',
    })
    expect(message.content).toEqual([{ type: 'text', text: '[advisor:concern] extract the helper' }])
  })

  it('pins the source to the advisor producer kind (cross-generation-safe)', () => {
    const message = buildAdvisorMessage({ note: 'extract the helper', severity: 'concern' })
    // The 0.1.7-rc.1 V3→V4 format edge PRESERVES direct source kinds (and V4
    // refuses the retired bare `plugin` arm outright), so a producer-owned
    // kind is the persistence-safe identity — the property the borrowed
    // `plugin` arm used to be relied on for.
    expect(message.source.kind).toBe('advisor')
    // The member set is locked exactly: `kind` plus the form-owned `form`/
    // `summary` are the only members all format edges admit, so any extra
    // member must fail here rather than in a refused session log.
    expect(Object.keys(message.source).sort()).toEqual(['form', 'kind', 'summary'])
    expect(message.source).toMatchObject({
      kind: 'advisor',
      form: 'notice',
      summary: '[concern] extract the helper',
    })
    // The self-review guard must recognize the shape the advisor actually writes.
    expect(isAdvisorMessage(message)).toBe(true)
  })

  it('pins the persisted source kind to the literal "advisor" (durable-log identity)', () => {
    // QC1-F-003, restated for the 0.1.7-rc.1 identity: every other assertion
    // in this suite — and `isAdvisorMessage` itself — reaches the persisted
    // key only THROUGH `ADVISOR_PLUGIN_ID`, so revaluing that constant would
    // keep the whole suite green while the notes already written into session
    // logs silently fell out of the self-review exclusion (a replay trigger
    // resets the renderer cursor and `rebuild()` re-filters the log through
    // `isAdvisorMessage`). This is the one assertion that reads the persisted
    // literal, so a rename fails here — where the author has to confront the
    // already-written logs — instead of in a session that quietly starts
    // reviewing the advisor's own advice.
    const message = buildAdvisorMessage({ note: 'extract the helper', severity: 'concern' })
    expect(message.source.kind).toBe('advisor')
  })

  it('rejects a migrated sibling-plugin note (self-review guard)', () => {
    // Counterpart of the positive case above, which proves the predicate
    // accepts the advisor's own shape. The source here is the 0.1.7-rc.1
    // V3→V4 migration of a sibling plugin's 0.1.6 note — `plugin:some-other-
    // plugin`, the same `plugin:<id>` shape the advisor's own migrated notes
    // carry — so a predicate that degenerated to a `plugin:`-prefix match
    // would silently exclude every sibling's note from advisor review; that
    // regression must fail here instead of shipping.
    // The migrated shape is a LOG reality the compile-time MessageSource
    // union intentionally has no arm for (the retired `plugin` family is not
    // writable), hence the cast through unknown.
    const message: UserMessage = {
      ...buildAdvisorMessage({ note: 'a sibling plugin note', severity: 'nit' }),
      source: { kind: 'plugin:some-other-plugin' } as unknown as UserMessage['source'],
    }

    expect(isAdvisorMessage(message)).toBe(false)
  })

  it('bounds the notice summary to CONTEXT_SUMMARY_MAX_CHARS with an ellipsis (qc3 F-2 / qc2 S-1)', () => {
    const message = buildAdvisorMessage({ note: 'n'.repeat(500), severity: 'concern' })
    const source = message.source as { kind: string; form?: string; summary?: string }
    expect(source.form).toBe('notice')
    expect(source.summary!.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    expect(source.summary!.endsWith('…')).toBe(true)
    // The bounded summary is derived from the same formatter as the content.
    expect(message.content).toEqual([{ type: 'text', text: `[advisor:concern] ${'n'.repeat(500)}` }])
  })

  it('routes the self-describing advisor message, not the raw note', () => {
    const { agent, commit } = makeAgent()
    const delivery = makeDelivery()
    delivery.registerAgent(agent)
    delivery.hold('s1')

    delivery.route('s1', { note: 'slow down and re-read the task', severity: 'nit' })
    // The commit seam's argument order is the host's Session.append:
    // (type, message, intent) — pin all three, because this is the durable
    // event the notes derivation reads back.
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]![0]).toBe('user/message')
    expect(commit.mock.calls[0]![2]).toEqual({ surfaceOp: 'append' })
    const message = commit.mock.calls[0]![1] as UserMessage
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe(ADVISOR_PLUGIN_ID)
    expect(message.source).toMatchObject({ kind: 'advisor', form: 'notice' })
    expect(message.content).toEqual([{ type: 'text', text: '[advisor:nit] slow down and re-read the task' }])
  })

  it('keeps the two channels mutually exclusive (no double delivery)', () => {
    // The load-bearing invariant against double delivery: a steer is
    // consumed AND committed by the host's step loop when claimed, so a
    // route that both steered and appended would deliver the note twice.
    const { agent, commit, steer } = makeAgent()
    const delivery = makeDelivery()
    delivery.registerAgent(agent)

    // Unheld: steer only — the session log is never touched directly.
    expect(delivery.route('s1', { note: 'wake up', severity: 'concern' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()

    // Held: commit only — the agent is never steered again for the same note.
    delivery.hold('s1')
    expect(delivery.route('s1', { note: 'gated note', severity: 'blocker' })).toBe('commit')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(steer).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The hold bracket (pre-step review gate wiring surface)
// ---------------------------------------------------------------------------

describe('AdvisorDelivery — the gate hold bracket', () => {
  it('isHeld mirrors hold/release', () => {
    const { agent } = makeAgent()
    const delivery = makeDelivery()
    delivery.registerAgent(agent)

    expect(delivery.isHeld('s1')).toBe(false)
    delivery.hold('s1')
    expect(delivery.isHeld('s1')).toBe(true)
    delivery.release('s1')
    expect(delivery.isHeld('s1')).toBe(false)
  })

  it('a hold never bleeds into another session', () => {
    const { agent } = makeAgent('s1')
    const { agent: other, commit: otherCommit, steer: otherSteer } = makeAgent('s2')
    const delivery = makeDelivery()
    delivery.registerAgent(agent)
    delivery.registerAgent(other)
    delivery.hold('s1')

    expect(delivery.route('s2', { note: 'separate session', severity: 'nit' })).toBe('steer')
    expect(otherSteer).toHaveBeenCalledTimes(1)
    expect(otherCommit).not.toHaveBeenCalled()
  })

  it('unregisterAgent clears the agent AND a live hold with the session (KD-4 dispose)', () => {
    const { agent, steer } = makeAgent()
    const delivery = makeDelivery()
    delivery.registerAgent(agent)

    delivery.hold('s1')
    delivery.unregisterAgent('s1')
    // No agent anymore → dropped, and the hold flag died with the session.
    expect(delivery.route('s1', { note: 'x', severity: 'concern' })).toBeUndefined()
    expect(delivery.isHeld('s1')).toBe(false)
    // A session id re-registered after dispose must not inherit the stale hold.
    const { agent: revived, steer: revivedSteer } = makeAgent('s1')
    delivery.registerAgent(revived)
    expect(delivery.route('s1', { note: 'after revive', severity: 'concern' })).toBe('steer')
    expect(revivedSteer).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Missing agent → drop (KD-4)
// ---------------------------------------------------------------------------

describe('AdvisorDelivery — missing agent → drop (KD-4)', () => {
  it('drops the note without throwing when no agent resolves, and logs a warning', () => {
    const { logger, warn } = makeLogger()
    const delivery = new AdvisorDelivery({ logger })

    expect(delivery.route('ghost-session', { note: 'no agent here', severity: 'blocker' })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('no agent')
  })
})

// ---------------------------------------------------------------------------
// Contained throw through the real routing seam (T4 F1)
// ---------------------------------------------------------------------------

/** Scripted fake for the runtime's `llm` option (same shape as the T4 suite). */
class FakeLlm {
  readonly calls: GenerateOptions[] = []
  constructor(private readonly responses: readonly { readonly chunks: readonly StreamChunk[] }[]) {}
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const response = this.responses[this.calls.length - 1]
    if (response === undefined) throw new Error(`FakeLlm: unexpected stream call #${this.calls.length}`)
    return streamOf(response.chunks)
  }
}

async function* streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield * chunks
}

const textReply = (text: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

const delta = (markdown: string): Delta => ({ markdown })

describe('AdvisorDelivery — contained throw through the routing seam (T4 F1)', () => {
  it('a throwing steer inside route never crashes the runtime drain', async () => {
    const { agent } = makeAgent()
    agent.steer = vi.fn(() => {
      throw new Error('steer exploded')
    })
    const delivery = makeDelivery()
    delivery.registerAgent(agent)

    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second","severity":"concern"}') },
    ])
    const runtime = new AdvisorRuntime({
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 's1' as SessionId,
      systemPrompt: 'review',
      llm,
      onNote: (note) => {
        delivery.route('s1', note)
      },
      retryBackoffMs: 0,
    })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    // The drain kicker must resolve, not reject (an unhandled rejection would
    // crash the process under Node ≥22/24 defaults) — T4 F1 containment holds
    // through the actual delivery routing seam.
    await expect(runtime.waitForDrain()).resolves.toBeUndefined()

    expect(llm.calls).toHaveLength(2) // the drain continued past both throws
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })

  it('a throwing session append (the held-commit arm) never crashes the drain either', async () => {
    const { agent } = makeAgent()
    agent.session.append = vi.fn(() => {
      throw new Error('append exploded')
    })
    const delivery = makeDelivery()
    delivery.registerAgent(agent)
    // The commit arm only runs while the gate holds the session.
    delivery.hold('s1')

    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second"}') },
    ])
    const runtime = new AdvisorRuntime({
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 's1' as SessionId,
      systemPrompt: 'review',
      llm,
      onNote: (note) => {
        delivery.route('s1', note)
      },
      retryBackoffMs: 0,
    })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    await expect(runtime.waitForDrain()).resolves.toBeUndefined()

    expect(llm.calls).toHaveLength(2)
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SessionTranscriptObserver — delivery hooks (latch reset)
// ---------------------------------------------------------------------------

/** Synthetic replace op — dsh brands seqs (`SessionSeq`), compile-time only here. */
type ReplaceSurfaceOp = { op: 'replace'; startSeq: number; endSeq: number }

interface EventSpec {
  type: string
  data: unknown
  surfaceOp?: SurfaceOp | ReplaceSurfaceOp
  sourceEventSeqs?: number[]
}

/** Number events contiguously from seq 0 and cast to the SessionEvent union. */
function buildEvents(specs: readonly EventSpec[]): SessionEvent[] {
  return specs.map((spec, index) => {
    const event: Record<string, unknown> = {
      type: spec.type,
      seq: index,
      time: 1_000 + index,
      data: spec.data,
    }
    if (spec.surfaceOp !== undefined) event.surfaceOp = spec.surfaceOp
    if (spec.sourceEventSeqs !== undefined) event.sourceEventSeqs = spec.sourceEventSeqs
    return event as unknown as SessionEvent
  })
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

function userMessage(
  value: string,
  source: MessageSource = { kind: 'user' },
  surfaceOp: SurfaceOp | ReplaceSurfaceOp = 'append',
  sourceEventSeqs?: number[],
): EventSpec {
  return {
    type: 'user/message',
    data: { id: MessageId(`user-${value}`), role: 'user', content: [text(value)], source },
    surfaceOp,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

function assistantMessage(value: string): EventSpec {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: MessageId(`assistant-${value}`),
        role: 'assistant',
        content: [text(value)],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    },
    surfaceOp: 'append',
  }
}

const turnStart = (turn: number): EventSpec => ({ type: 'turn/start', data: { turn } })
const stepStart = (turn: number, step: number): EventSpec => ({ type: 'step/start', data: { turn, step } })
const stepEnd = (turn: number, step: number): EventSpec => ({ type: 'step/end', data: { turn, step } })

type TurnEndKind = 'completed' | 'max-tokens' | 'error' | 'aborted' | 'blocked' | 'interrupted'

const turnEnd = (turn: number, reason: TurnEndKind = 'completed'): EventSpec => ({
  type: 'turn/end',
  data: {
    turn,
    reason: reason === 'error'
      ? { kind: 'error', error: { message: 'model failed', code: 'UNKNOWN' } }
      : { kind: reason },
  },
})

const compactStart = (): EventSpec => ({ type: 'compact/start', data: { compactionId: 'c1', turn: null } })

/** One standard stepped turn: turn/start, user, step/start, assistant, step/end, turn/end. */
function simpleTurn(turn: number, userText: string, agentText: string): EventSpec[] {
  return [
    turnStart(turn),
    userMessage(userText),
    stepStart(turn, 1),
    assistantMessage(agentText),
    stepEnd(turn, 1),
    turnEnd(turn),
  ]
}

/** Mirror the cordis `session/event` listener: deliver each appended event once. */
function feedAppend(
  observer: SessionTranscriptObserver,
  sessionId: string,
  base: readonly EventSpec[],
  added: readonly EventSpec[],
): void {
  const all = buildEvents([...base, ...added])
  for (let index = base.length; index < all.length; index++) {
    observer.handleEvent(sessionId, all.slice(0, index + 1), all[index]!)
  }
}

describe('SessionTranscriptObserver — delivery hooks (T6)', () => {
  it('fires onRewrite for compact/* and replace events, never for plain appends', () => {
    const rewrites: string[] = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: () => {},
      onRewrite: (sessionId) => rewrites.push(sessionId),
    })
    feedAppend(observer, 's1', [], [
      ...simpleTurn(1, 'hi', 'hello'),                                      // appends only → no rewrite
      compactStart(),                                                        // compact/* → rewrite
      userMessage('replaced prompt', { kind: 'user' }, { op: 'replace', startSeq: 1, endSeq: 3 }, [1, 3]), // surface replace → rewrite
      ...simpleTurn(2, 'next', 'reply'),                                     // appends → no rewrite
    ])
    expect(rewrites).toEqual(['s1', 's1'])
  })
})
