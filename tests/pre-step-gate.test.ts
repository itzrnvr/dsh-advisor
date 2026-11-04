/**
 * 0.6.48 — the PRE-STEP REVIEW GATE (src/index.ts `agent/pre-step` listener).
 *
 * The load-bearing wiring of the release: the host awaits this waterfall
 * before every model step, so when the step clock is due the gate triggers
 * the review of the just-completed window and HOLDS the step until the note
 * is delivered. Composition mirrors tests/integration.test.ts (real cordis
 * `Context` + real `LlmRuntime` + stub adapter + fake agent/session), and the
 * gate is driven through a real `ctx.waterfall('agent/pre-step', …)` dispatch
 * with the exact payload the host's fused dispatcher delivers (agent,
 * messages, turn, step, signal + the default enter decision as `next`).
 *
 * Pins:
 * 1. due + waterfall → the note COMMITTED to the session log while held
 *    (the channel that makes it join THIS step's model request), never
 *    steered, and the default decision passes through untouched;
 * 2. hold released after the waterfall — the next review (turn clock here)
 *    delivers via STEER, proving `release` ran;
 * 3. not due → zero model calls, zero holds, decision passthrough;
 * 4. user cancel (turn signal abort) releases the hold while the provider
 *    stream is stuck — the step is never parked past its poll boundary, and
 *    the late note steers (no stale hold);
 * 5. disabled session (no runtime) consumes the clock without holding and
 *    without a model call — and never throws through the waterfall.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as advisorPlugin from '../src/index'
import type { AdvisorConfig } from '../src/config'

// The reviewer role is claimed process-globally (n4 QC F-6); every test
// composes a fresh harness, so the flag resets between cases.
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
})

// ---------------------------------------------------------------------------
// Stub adapter
// ---------------------------------------------------------------------------

class StubAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string, _signal?: undefined): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('off') },
    })
  }

  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ReadonlyArray<readonly StreamChunk[]>) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.script[this.requests.length - 1]
    if (reply === undefined) {
      throw new Error(`StubAdapter: script exhausted after ${this.requests.length} calls`)
    }
    yield * reply
  }
}

/** Adapter whose stream hangs until `release()` — the stuck-provider case. */
class HangingAdapter extends StubAdapter {
  private gate: { resolve: () => void } | undefined

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const adapter = this
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        // One chunk, then hang before the finish chunk: the runtime's
        // per-chunk race keeps waiting (far below its call deadline) — only
        // the gate release / abort can end the hold.
        yield { type: 'text-delta', index: 0, text: '{"note":"late note","severity":"concern"}' }
        await new Promise<void>((resolve) => {
          adapter.gate = { resolve }
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }

  release(): void {
    this.gate?.resolve()
  }
}

const textReply = (text: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

// ---------------------------------------------------------------------------
// Composed harness
// ---------------------------------------------------------------------------

function fullConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    systemPrompt: '',
    maxDeltaMessages: 60,
    nextPrompt: false,
    reviewEverySteps: 1,
    reviewEveryTurns: 1,
    ...overrides,
  }
}

async function composeHarness(
  config: Partial<AdvisorConfig>,
  replies: ReadonlyArray<readonly StreamChunk[]>,
  adapter: LlmAdapter = new StubAdapter(replies),
): Promise<{ ctx: Context; adapter: StubAdapter; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['stub'], adapter)
  ctx.provide('sessions', {} as never)
  ctx.provide('agents', { get: () => undefined } as never)
  const fiber = await ctx.plugin(advisorPlugin, fullConfig(config))
  return { ctx, adapter: adapter as unknown as StubAdapter, dispose: () => fiber.dispose() }
}

/** One session log shared by the fake agent and the emitted `session/event`. */
function makeLiveSession(id = 's1'): {
  session: Session
  agent: Agent
  commit: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  log: SessionEvent[]
} {
  const log: SessionEvent[] = []
  const commit = vi.fn()
  // ONE object serves both roles: the `session/event` tuple's session (id +
  // snapshotEvents) and the agent's session (the delivery append target).
  const session = { id, append: commit, snapshotEvents: () => log } as unknown as Session
  const steer = vi.fn()
  const agent = { id, session, steer } as unknown as Agent
  return { session, agent, commit, steer, log }
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

/** Feed one synthetic event into the live log AND the composed observer. */
function feed(ctx: Context, live: { session: Session; log: SessionEvent[] }, event: Record<string, unknown>): void {
  const built = { ...event, seq: live.log.length, time: 1_000 + live.log.length } as unknown as SessionEvent
  live.log.push(built)
  ctx.emit('session/event', live.session, built)
}

const turnStart = (turn: number): Record<string, unknown> => ({ type: 'turn/start', data: { turn } })
const stepStart = (turn: number, step: number): Record<string, unknown> => ({ type: 'step/start', data: { turn, step } })
const stepEnd = (turn: number, step: number): Record<string, unknown> => ({ type: 'step/end', data: { turn, step } })
const turnEnd = (turn: number): Record<string, unknown> => ({
  type: 'turn/end',
  data: { turn, reason: { kind: 'completed' } },
})
const userMessage = (value: string): Record<string, unknown> => ({
  type: 'user/message',
  data: { id: MessageId(`user-${value}`), role: 'user', content: [text(value)], source: { kind: 'user' } },
  surfaceOp: 'append',
})
const assistantMessage = (value: string): Record<string, unknown> => ({
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: {
      id: MessageId(`assistant-${value}`),
      role: 'assistant',
      content: [text(value)],
      source: { kind: 'model', provider: 'stub', model: 'stub-model' },
    },
  },
  surfaceOp: 'append',
})

/**
 * Dispatch the host's pre-step waterfall exactly like `agentEvents(ctx, agent)
 * .waterfall('agent/pre-step', …)` does: fused payload (agent injected) + the
 * default enter decision as the final `next` handler. The cast bridges the
 * test-side fusion: the host's Events tuple declares the payload WITHOUT the
 * `agent` key (the real dispatcher injects it through `agentEvents`), so the
 * typed overloads would reject our literal — cordis itself only forwards the
 * object it receives.
 */
function dispatchPreStep(
  ctx: Context,
  agent: Agent,
  position: { turn: number; step: number },
  signal: AbortSignal,
): Promise<{ kind: string; messages: readonly unknown[] }> {
  const decision = { kind: 'enter', messages: [] as UserMessage[] }
  const payload = { agent, messages: [] as UserMessage[], ...position, signal }
  const waterfall = ctx.waterfall as unknown as (
    name: string,
    payload: unknown,
    ...rest: readonly unknown[]
  ) => Promise<{ kind: string; messages: readonly unknown[] }>
  return waterfall('agent/pre-step', payload, () => Promise.resolve(decision))
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('pre-step review gate (0.6.48)', () => {
  it('holds the due step, commits the note INTO the held step, and passes the decision through', async () => {
    const { ctx, adapter, dispose } = await composeHarness(
      { provider: 'stub', model: 'stub-model' },
      [
        [...textReply('{"note":"gated note","severity":"concern"}')],
        [...textReply('{"note":"after gate nit","severity":"nit"}')],
      ],
    )
    const live = makeLiveSession('s1')
    ctx.emit('agent/created', { agent: live.agent, source: 'startup' })

    // One completed step → the step clock is due at the NEXT pre-step.
    feed(ctx, live, turnStart(1))
    feed(ctx, live, userMessage('go'))
    feed(ctx, live, stepStart(1, 1))
    feed(ctx, live, assistantMessage('a1'))
    feed(ctx, live, stepEnd(1, 1))

    // The host proposes step 2: the waterfall awaits the review.
    const ac = new AbortController()
    const result = await dispatchPreStep(ctx, live.agent, { turn: 1, step: 2 }, ac.signal)

    // Decision passthrough: the gate never rewrites the enter decision.
    expect(result.kind).toBe('enter')
    expect(result.messages).toEqual([])
    // The review ran, and its note COMMITTED while held — the held step's own
    // request derives the appended user/message from the session surface.
    expect(adapter.requests).toHaveLength(1)
    expect(live.commit).toHaveBeenCalledTimes(1)
    expect(live.commit.mock.calls[0]![0]).toBe('user/message')
    expect(live.commit.mock.calls[0]![2]).toEqual({ surfaceOp: 'append' })
    const message = live.commit.mock.calls[0]![1] as UserMessage
    expect(message.content).toEqual([{ type: 'text', text: '[advisor:concern] gated note' }])
    // Nothing steered while held — the gate path never touches the inbox.
    expect(live.steer).not.toHaveBeenCalled()

    // Release proof: close the turn (turn clock review, nothing held now) —
    // the second note must STEER.
    feed(ctx, live, stepStart(1, 2))
    feed(ctx, live, assistantMessage('a2'))
    feed(ctx, live, stepEnd(1, 2))
    feed(ctx, live, turnEnd(1))
    await vi.waitFor(() => expect(live.steer).toHaveBeenCalledTimes(1))
    expect(live.commit).toHaveBeenCalledTimes(1)
    const steered = live.steer.mock.calls[0]![0] as UserMessage
    expect(steered.content).toEqual([{ type: 'text', text: '[advisor:nit] after gate nit' }])

    await dispose()
  })

  it('not due → zero model calls, zero holds, instant passthrough', async () => {
    const { ctx, adapter, dispose } = await composeHarness(
      { provider: 'stub', model: 'stub-model' },
      [[...textReply('{"note":"never","severity":"nit"}')]],
    )
    const live = makeLiveSession('s1')
    ctx.emit('agent/created', { agent: live.agent, source: 'startup' })

    // A step started but never completed → nothing due, nothing to review.
    feed(ctx, live, turnStart(1))
    feed(ctx, live, userMessage('go'))
    feed(ctx, live, stepStart(1, 1))

    const ac = new AbortController()
    const result = await dispatchPreStep(ctx, live.agent, { turn: 1, step: 2 }, ac.signal)
    expect(result.kind).toBe('enter')
    expect(adapter.requests).toHaveLength(0)
    expect(live.commit).not.toHaveBeenCalled()
    expect(live.steer).not.toHaveBeenCalled()

    await dispose()
  })

  it('reviewEverySteps 0 → the gate never fires', async () => {
    const { ctx, adapter, dispose } = await composeHarness(
      { provider: 'stub', model: 'stub-model', reviewEverySteps: 0 },
      [[...textReply('{"note":"never","severity":"nit"}')]],
    )
    const live = makeLiveSession('s1')
    ctx.emit('agent/created', { agent: live.agent, source: 'startup' })

    feed(ctx, live, turnStart(1))
    feed(ctx, live, userMessage('go'))
    feed(ctx, live, stepStart(1, 1))
    feed(ctx, live, assistantMessage('a1'))
    feed(ctx, live, stepEnd(1, 1))
    feed(ctx, live, stepStart(1, 2))
    feed(ctx, live, stepEnd(1, 2))

    const ac = new AbortController()
    const result = await dispatchPreStep(ctx, live.agent, { turn: 1, step: 3 }, ac.signal)
    expect(result.kind).toBe('enter')
    expect(adapter.requests).toHaveLength(0)

    await dispose()
  })

  it('turn-signal abort releases the hold while the provider stream is stuck; the late note steers', async () => {
    const hanging = new HangingAdapter([])
    const { ctx, dispose } = await composeHarness(
      { provider: 'stub', model: 'stub-model' },
      [],
      hanging,
    )
    const live = makeLiveSession('s1')
    ctx.emit('agent/created', { agent: live.agent, source: 'startup' })

    feed(ctx, live, turnStart(1))
    feed(ctx, live, userMessage('go'))
    feed(ctx, live, stepStart(1, 1))
    feed(ctx, live, assistantMessage('a1'))
    feed(ctx, live, stepEnd(1, 1))

    const ac = new AbortController()
    const dispatched = dispatchPreStep(ctx, live.agent, { turn: 1, step: 2 }, ac.signal)
    // Cancel while the review is mid-flight: the gate must not park the step
    // behind a stuck provider. waitQuiet polls at ≤100 ms granularity.
    setTimeout(() => ac.abort(), 10)
    const result = await dispatched
    expect(result.kind).toBe('enter')
    // Nothing delivered yet (the stream still hangs; the hold is off).
    expect(live.commit).not.toHaveBeenCalled()
    expect(live.steer).not.toHaveBeenCalled()

    // The late completion delivers via STEER — a leaked hold flag would have
    // committed it into a surface no one is waiting for.
    hanging.release()
    await vi.waitFor(() => expect(live.steer).toHaveBeenCalledTimes(1))
    expect(live.commit).not.toHaveBeenCalled()

    await dispose()
  })

  it('disabled session (no runtime) consumes the clock without a hold or a call', async () => {
    // No provider/model pair: the S4 gate blocks every runtime — the gate
    // must still consume the due window (no re-offer at every step) and must
    // never hold or wait.
    const { ctx, adapter, dispose } = await composeHarness({}, [[...textReply('{"note":"never","severity":"nit"}')]])
    const live = makeLiveSession('s1')
    ctx.emit('agent/created', { agent: live.agent, source: 'startup' })

    feed(ctx, live, turnStart(1))
    feed(ctx, live, userMessage('go'))
    feed(ctx, live, stepStart(1, 1))
    feed(ctx, live, assistantMessage('a1'))
    feed(ctx, live, stepEnd(1, 1))

    const ac = new AbortController()
    const result = await dispatchPreStep(ctx, live.agent, { turn: 1, step: 2 }, ac.signal)
    expect(result.kind).toBe('enter')
    expect(adapter.requests).toHaveLength(0)
    expect(live.commit).not.toHaveBeenCalled()
    expect(live.steer).not.toHaveBeenCalled()

    // The clock was consumed: a second dispatch does nothing either.
    const result2 = await dispatchPreStep(ctx, live.agent, { turn: 1, step: 3 }, ac.signal)
    expect(result2.kind).toBe('enter')
    expect(adapter.requests).toHaveLength(0)

    await dispose()
  })
})
