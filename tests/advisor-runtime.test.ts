/**
 * T4 — advisor model call + note extraction + drain/backlog
 * (spec §2 S2, §4 mapping rows, §6 delivery semantics, §8.2 KD-2, §8.5 KD-5).
 *
 * Contract under test:
 * - `AdvisorRuntime` (per-session): `enqueue(delta)` queues a rendered transcript
 *   delta and asynchronously drains it — one `llm.stream` call per delta with
 *   `{ provider, model, system, messages: [user delta] }` (NO `maxTokens` —
 *   the 2026-10-18 user ruling removed the model-side budget; output is
 *   bounded at extraction by ADVISOR_NOTE_MAX_CHARS) and
 *   `purpose` left UNSET (KD-5). Extracted `{note, severity}` is handed to the
 *   `onNote` hook (the T5 emission guard wraps it).
 * - JSON-frame extraction (KD-2): first balanced `{…}` parsed, tolerant of
 *   surrounding prose/fences; `note` non-empty else drop+log; missing/invalid
 *   `severity` defaults to `nit`; no frame → drop+log, no model retry.
 * - Failure policy (KD-5): transient → 1 retry with a short backoff → drop;
 *   3 consecutive dropped deltas → flush the pending backlog; permanent errors
 *   (`invalid_request_error`, model-not-found, "is not supported when", a
 *   listed model this build cannot serve — `MODEL_UNSUPPORTED` /
 *   `CLIENT_UPGRADE_REQUIRED`) → halt with status; quota/rate-limit → pause
 *   (`quota_exhausted`), batch retained,
 *   no auto-resume timer; in-flight call aborted on dispose via the signal;
 *   never park the primary.
 * - Bounded backlog (spec §6): `maxQueued` (default 32) bounds the waiting
 *   queue; a delta enqueued while the queue is full is dropped at enqueue
 *   (drop-newest) with a `debug` log carrying `{ maxQueued }`, an in-flight
 *   delta does not count against the bound, and accepted deltas drain in FIFO
 *   order.
 * - No model call when the config is disabled (explicit gate, S4) — verified at
 *   the plugin `apply` level.
 *
 * Most tests drive the runtime directly with an injected fake `llm.stream`
 * (per the brief); one composed test registers a stub `LlmAdapter` on a real
 * `LlmRuntime` to prove the registration/dispatch path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
// The overlay shim (`export *`) forwards named exports but not the package
// default, so `LlmRuntime` (named export of @deepseek-ai/dsh-llm) is imported
// by name, not as the default.
import { LlmRuntime, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { AdvisorRuntime, ADVISOR_NOTE_MAX_CHARS, extractAdviceNote, extractProseFallbackNote } from '../src/advisor-runtime'
import type { AdvisorLlm, AdvisorRuntimeOptions, AdvisorRuntimeStatus, AdvisorTrace, AdvisorTurnRecord, AdviceNote } from '../src/advisor-runtime'
import type { Delta } from '../src/transcript'
import { apply } from '../src/index'
import type { AdvisorConfig } from '../src/config'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from '../src/prompts'

// n4 QC F-6: the single-reviewer guard is process-global; each test case
// composes a fresh harness, so the flag must reset between cases (production
// keeps the first-claim-wins behavior).
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
})


// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TEST_SYSTEM_PROMPT = 'You are an independent reviewer for a coding session.'

/** A rendered transcript delta (shape produced by T3's DeltaRenderer). */
const delta = (markdown: string): Delta => ({ markdown })

/**
 * Scripted fake for the runtime's `llm` option: records calls, replays responses.
 * `gate` = a releasable hang (settings-live `GatedAdapter` pattern): the stream
 * blocks until the gate resolves, then yields `chunks` — used to hold a delta
 * in flight while the backlog fills (spec §6 drop-newest tests).
 */
type FakeResponse =
  | { readonly chunks: readonly StreamChunk[] }
  | { readonly throw: Error }
  | { readonly hang: true }
  | { readonly gate: Promise<void>; readonly chunks: readonly StreamChunk[] }

/** An explicit declared efforts list (least → greatest, per dsh-llm). */
interface FakeEfforts {
  readonly efforts: readonly string[]
}

/**
 * Simulated model capability for {@link FakeLlm.resolveModelInfo}: 'off' =
 * deepseek-style declared efforts (default); 'none' = base adapter, no
 * reasoning metadata; 'throw' = resolution failure; {@link FakeEfforts} = any
 * explicit declared list (e.g. `['low', 'high']`, whose smallest entry is not
 * 'off').
 */
type FakeCapability = 'off' | 'none' | 'throw' | FakeEfforts

class FakeLlm {
  readonly calls: GenerateOptions[] = []

  constructor(
    private readonly responses: readonly FakeResponse[],
    /** See {@link FakeCapability}. Public + mutable: the no-latch test flips it mid-runtime. */
    public capability: FakeCapability = 'off',
  ) {}

  resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const capability = this.capability
    if (capability === 'throw') return Promise.reject(new Error('capability resolution failed'))
    const declared = capability === 'none' ? [] : capability === 'off' ? ['off', 'high'] : capability.efforts
    const base = { provider, id: model, name: model }
    if (declared.length === 0) return Promise.resolve(base)
    return Promise.resolve({
      ...base,
      reasoning: {
        efforts: declared.map((id) => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId(declared[0]!),
      },
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const response = this.responses[this.calls.length - 1]
    if (response === undefined) {
      throw new Error(`FakeLlm: unexpected stream call #${this.calls.length} (script exhausted)`)
    }
    if ('throw' in response) throw response.throw
    if ('hang' in response) {
      // A black-holed provider stream: never yields, never ends, never rejects —
      // and it ignores the abort signal. The drain must still un-wedge via the
      // call-level deadline (qc2 W-4 / qc3 W-1).
      return (async function* () {
        await new Promise<void>(() => {})
      })()
    }
    if ('gate' in response) {
      // A releasable hang: block on the gate, then replay the reply. Unlike the
      // black-hole `hang`, the blocked call completes once the test resolves
      // the gate, so the drain can finish and the backlog semantics can be
      // asserted end to end.
      return (async function* () {
        await response.gate
        yield * response.chunks
      })()
    }
    return streamOf(response.chunks)
  }
}

async function* streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield * chunks
}

/**
 * Fake whose `resolveModelInfo` honors the abort signal (dsh-llm's contract —
 * "signal - optional cancellation for adapter-owned asynchronous lookup"): the
 * FIRST resolution hangs until the passed signal aborts (rejecting with
 * AbortError); the SECOND resolves immediately with 'off'. This pins the
 * no-latch contract (n4 QC N-5): an aborted resolution is a failure, NOT a
 * definitive verdict, so the KD-5 retry re-resolves with a fresh deadline
 * instead of reusing a latched `undefined`. With NO signal (the pre-fix
 * behavior) the first resolution would hang forever — exactly the
 * wedged-drain failure the fix removes.
 */
class SignalBoundLlm {
  readonly resolveSignals: Array<AbortSignal | undefined> = []
  readonly calls: GenerateOptions[] = []
  private resolutions = 0

  constructor(private readonly reply: readonly StreamChunk[]) {}

  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.resolveSignals.push(signal)
    this.resolutions++
    if (this.resolutions === 1) {
      if (signal === undefined) return new Promise(() => {}) // no signal → hang forever
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('off'),
      },
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    return streamOf(this.reply)
  }
}

/** Chunk script for a successful text reply. */
const textReply = (text: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

/**
 * Chunk script for an empty reply — no text deltas, just the terminal finish
 * chunk (the completed-but-no-content class; constructible with either
 * finish reason).
 */
const emptyReply = (kind: 'stop' | 'max-tokens'): readonly StreamChunk[] => [
  { type: 'finish', reason: kind === 'stop' ? { kind: 'stop' } : { kind: 'max-tokens' } },
]

/** Chunk script for a terminal provider error. */
const errorReply = (failure: LlmFailure): readonly StreamChunk[] => [
  { type: 'finish', reason: { kind: 'error', failure } },
]

const transientFailure = (): LlmFailure => ({ message: 'upstream server error', code: 'SERVER' })
const quotaFailure = (): LlmFailure => ({
  message: 'insufficient_quota: you exceeded your current quota, please check your billing',
  code: 'QUOTA',
})
const permanentFailure = (): LlmFailure => ({
  message: "the model 'gpt-5' is not supported when using Codex with a ChatGPT account (invalid_request_error)",
  code: 'INVALID_REQUEST',
})
/**
 * dsh model-listing refusal (`@deepseek-ai/dsh-llm-deepseek`): a listed model
 * this build cannot serve, refused before network I/O. The account route has
 * thrown these since rc.2; rc.3's API-key route follows the official listing
 * too, which makes them reachable on the default provider.
 */
const refusalFailure = (code: 'MODEL_UNSUPPORTED' | 'CLIENT_UPGRADE_REQUIRED'): LlmFailure => ({
  message: code === 'MODEL_UNSUPPORTED'
    ? 'DeepSeek model "deepseek-v5" is not supported by DeepSeek Harness; current version is 0.2.1-rc.5'
    : 'DeepSeek model "deepseek-v5-next" requires DeepSeek Harness 99.0.0-alpha.1 or later; current version is 0.2.1-rc.5',
  code,
})

function makeRuntime(llm: AdvisorLlm, overrides: Partial<AdvisorRuntimeOptions> = {}): {
  runtime: AdvisorRuntime
  notes: AdviceNote[]
} {
  const notes: AdviceNote[] = []
  const runtime = new AdvisorRuntime({
    provider: 'test-provider',
    model: 'test-model',
    sessionId: 'sess-test' as SessionId,
    systemPrompt: TEST_SYSTEM_PROMPT,
    llm,
    onNote: (note) => { notes.push(note) },
    retryBackoffMs: 0,
    ...overrides,
  })
  return { runtime, notes }
}

// ---------------------------------------------------------------------------
// Drain — one llm.stream call per delta with the expected options
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — drain calls llm.stream once per delta with expected options', () => {
  it('enqueues the delta as a user message and emits the extracted note', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"extract the helper","severity":"concern"}') }])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('### Session update\n\n**user**: fix the bug'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'extract the helper', severity: 'concern' }])
    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    expect(options).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      system: TEST_SYSTEM_PROMPT,
      reasoningEffort: 'off',
    })
    // 2026-10-18 ruling: no model-side budget rides the call.
    expect('maxTokens' in options).toBe(false)
    // KD-5: purpose is a closed union and must be left unset for an advisor call.
    expect(options.purpose).toBeUndefined()
    expect('purpose' in options).toBe(false)
    expect(options.signal).toBeDefined()
    expect(options.messages).toHaveLength(1)
    const message = options.messages[0]!
    expect(message.role).toBe('user')
    expect(message.content[0]).toMatchObject({ type: 'text' })
    const direct = (message.content[0] as { text: string }).text
    expect(direct).toContain('Reviewer task:')
    expect(direct).toContain('### Session update\n\n**user**: fix the bug')
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })

  it('marks the trajectory record delivered=false when the delivery seam drops the note (no agent)', async () => {
    // Fork addition pin: an extracted note whose onNote callback reports the
    // delivery as dropped must surface as outcome 'note' with delivered:false
    // — the Advisor tab renders "not delivered", never a note the chat never
    // received as delivered.
    const llm = new FakeLlm([{ chunks: textReply('{"note":"dropped in transit"}') }])
    const records: AdvisorTurnRecord[] = []
    const { runtime } = makeRuntime(llm, {
      onNote: () => false,
      onTurn: (record) => { records.push(record) },
    })

    runtime.enqueue(delta('### Session update\n\n**user**: work'))
    await runtime.waitForDrain()

    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('note')
    expect(records[0]!.delivered).toBe(false)
    expect(records[0]!.note).toBe('dropped in transit')
  })

  it('marks the trajectory record delivered=true when the delivery seam lands the note', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"landed"}') }])
    const records: AdvisorTurnRecord[] = []
    const { runtime } = makeRuntime(llm, {
      onNote: () => true,
      onTurn: (record) => { records.push(record) },
    })

    runtime.enqueue(delta('### Session update\n\n**user**: work'))
    await runtime.waitForDrain()

    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('note')
    expect(records[0]!.delivered).toBe(true)
  })

  it('carries the owning conversation id on every advisor request', async () => {
    // OpenCode Go routes per conversation on `x-opencode-session` and rejects a
    // request without it; pi-ai derives that header from `sessionId`, so the
    // advisor call must carry the conversation it reviews.
    const llm = new FakeLlm([{ chunks: textReply('{"note":"looks fine"}') }])
    const { runtime } = makeRuntime(llm, { sessionId: 'session-abc' as SessionId })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]!.sessionId).toBe('session-abc')
  })

  it('calls the model once per delta, serialized per session', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second","severity":"blocker"}') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'blocker' },
    ])
    expect(llm.calls).toHaveLength(2)
    const textOf = (options: GenerateOptions): string => {
      const block = options.messages[options.messages.length - 1]!.content[0]!
      const raw = block.type === 'text' ? block.text : ''
      return raw.replace(/\n\n---\n(Reviewer|Prediction) task:[\s\S]*$/, '')
    }
    expect(textOf(llm.calls[0]!)).toBe('update one')
    expect(textOf(llm.calls[1]!)).toBe('update two')
  })

  it('exposes the configured default system prompt (KD-2 reviewer contract)', () => {
    for (const token of ['nit', 'concern', 'blocker', '{"note"', '"severity"']) {
      expect(DEFAULT_ADVISOR_SYSTEM_PROMPT).toContain(token)
    }
  })

  it('omits reasoningEffort when the model declares no reasoning capability (W-1 fallback — no UNSUPPORTED_REASONING_EFFORT)', async () => {
    // Base-adapter shape: resolveModel returns { provider, id, name } with NO
    // reasoning metadata (the pre-n4 non-deepseek path). The advisor call must
    // still succeed — the option is omitted and resolveCallFor materializes
    // the adapter default instead of throwing.
    const llm = new FakeLlm([{ chunks: textReply('{"note":"plain model works"}') }], 'none')
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('### Session update\n\n**user**: fix the bug'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'plain model works', severity: 'nit' }])
    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    expect(options).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      system: TEST_SYSTEM_PROMPT,
    })
    expect('reasoningEffort' in options).toBe(false)
    expect('maxTokens' in options).toBe(false)
  })

  it('a capability-resolution failure also omits reasoningEffort and never fails the call', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"resilient"}') }], 'throw')
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'resilient', severity: 'nit' }])
    expect(llm.calls).toHaveLength(1)
    expect('reasoningEffort' in llm.calls[0]!).toBe(false)
  })

  it('does not latch a resolution failure: a later definitive resolution re-advertises reasoningEffort', async () => {
    // First delta: the capability resolution throws — the failure is advisory
    // and must NOT be cached as a permanent no-'off' verdict. Second delta:
    // the same runtime, but the model now declares 'off' — the fresh
    // resolution re-advertises it (a latched `undefined` would drop
    // thinking-off for the runtime's lifetime).
    const llm = new FakeLlm(
      [
        { chunks: textReply('{"note":"first"}') },
        { chunks: textReply('{"note":"second"}') },
      ],
      'throw',
    )
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update one'))
    await runtime.waitForDrain()
    expect(notes).toEqual([{ note: 'first', severity: 'nit' }])
    expect(llm.calls).toHaveLength(1)
    expect('reasoningEffort' in llm.calls[0]!).toBe(false)

    llm.capability = 'off'
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
    ])
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]!.reasoningEffort).toBe(ReasoningEffortId('off'))
    // Closed whitelist on both calls (T2-style): call 0 has no reasoningEffort
    // (the failure is not a verdict), call 1 re-advertises 'off' after the
    // fresh resolution — same key set minus/plus reasoningEffort.
    expect(Object.keys(llm.calls[0]!).sort()).toEqual(['advisorInternal', 'messages', 'model', 'provider', 'sessionId', 'signal', 'system'])
    expect(Object.keys(llm.calls[1]!).sort()).toEqual(['advisorInternal', 'messages', 'model', 'provider', 'reasoningEffort', 'sessionId', 'signal', 'system'])
    // Zero tools contract: no advisor call ever carries a tools key.
    expect('tools' in llm.calls[0]!).toBe(false)
    expect('tools' in llm.calls[1]!).toBe(false)
  })

})

// ---------------------------------------------------------------------------
// Reasoning effort selection — plan dsh-advisor-reasoning-effort T1:
// RD-1 default = the model's SMALLEST declared effort; RD-2 a configured
// effort is capability-gated (declared → send it; mismatch → smallest + one
// warn per runtime); no reasoning metadata → omit the option entirely.
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — reasoning effort selection (plan dsh-advisor-reasoning-effort)', () => {
  it('defaults to the smallest declared effort when nothing is configured (RD-1)', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"default effort"}') }], { efforts: ['low', 'high'] })
    const { runtime } = makeRuntime(llm)

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(llm.calls[0]!.reasoningEffort).toBe(ReasoningEffortId('low'))
  })

  it('sends the configured effort when the model declares it', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"configured effort"}') }], { efforts: ['low', 'high'] })
    const { runtime } = makeRuntime(llm, { reasoningEffort: 'high' })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(llm.calls[0]!.reasoningEffort).toBe(ReasoningEffortId('high'))
  })

  it('falls back to the smallest declared effort and warns once per runtime when the configured effort is undeclared (RD-2)', async () => {
    const debug = vi.fn()
    const warn = vi.fn()
    const llm = new FakeLlm(
      [{ chunks: textReply('{"note":"first"}') }, { chunks: textReply('{"note":"second"}') }],
      { efforts: ['low', 'high'] },
    )
    const { runtime, notes } = makeRuntime(llm, { reasoningEffort: 'off', logger: { debug, warn } })

    runtime.enqueue(delta('update one'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
    ])
    // NEVER the undeclared id: both calls carry the smallest declared effort.
    expect(llm.calls.map((options) => options.reasoningEffort)).toEqual([
      ReasoningEffortId('low'),
      ReasoningEffortId('low'),
    ])
    // The mismatch is reported once per runtime, not once per call.
    const warnings = warn.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.startsWith('advisor: configured reasoningEffort'),
    )
    expect(warnings).toHaveLength(1)
  })

  it('treats an empty / whitespace-only configured effort as automatic (smallest declared, no warn)', async () => {
    const warn = vi.fn()
    const llm = new FakeLlm([{ chunks: textReply('{"note":"empty means auto"}') }], { efforts: ['low', 'high'] })
    const { runtime } = makeRuntime(llm, { reasoningEffort: '  ', logger: { debug: vi.fn(), warn } })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(llm.calls[0]!.reasoningEffort).toBe(ReasoningEffortId('low'))
    expect(warn).not.toHaveBeenCalled()
  })

  it('omits reasoningEffort when the model declares no reasoning metadata, even with a configured value', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"no metadata"}') }], 'none')
    const { runtime } = makeRuntime(llm, { reasoningEffort: 'high' })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect('reasoningEffort' in llm.calls[0]!).toBe(false)
  })

  it('reports the dropped configured effort ONCE when the model declares no efforts at all (no silent fallback)', async () => {
    // should-fix (PR #111): with an empty declared list the early return used
    // to skip the warn block, so an operator-pinned effort vanished without a
    // trace. The distinct message names the no-efforts cause (there is no
    // fallback effort to name) and rides the same once-per-runtime latch.
    const warn = vi.fn()
    const llm = new FakeLlm(
      [{ chunks: textReply('{"note":"first"}') }, { chunks: textReply('{"note":"second"}') }],
      'none',
    )
    const { runtime, notes } = makeRuntime(llm, { reasoningEffort: 'high', logger: { debug: vi.fn(), warn } })

    runtime.enqueue(delta('update one'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
    ])
    // The option stays omitted on both calls — the model declares nothing.
    expect(llm.calls.map((options) => 'reasoningEffort' in options)).toEqual([false, false])
    const warnings = warn.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.startsWith('advisor: configured reasoningEffort'),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]![0]).toContain('declares no reasoning efforts')
  })

  it('does not cache a resolution failure: the configured effort applies once the model resolves', async () => {
    const llm = new FakeLlm(
      [{ chunks: textReply('{"note":"first"}') }, { chunks: textReply('{"note":"second"}') }],
      'throw',
    )
    const { runtime } = makeRuntime(llm, { reasoningEffort: 'high' })

    runtime.enqueue(delta('update one'))
    await runtime.waitForDrain()
    expect('reasoningEffort' in llm.calls[0]!).toBe(false)

    llm.capability = { efforts: ['low', 'high'] }
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(llm.calls[1]!.reasoningEffort).toBe(ReasoningEffortId('high'))
  })
})

// ---------------------------------------------------------------------------
// AC-1 closed whitelist — every advisor GenerateOptions is a minimal start:
// exact key set, zero tools, single user delta (regression pin, T2)
// KD-6 (§8.6) regression pin
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — minimal request shape (AC-1 closed whitelist)', () => {
  it('sends a minimal request with capability off: exact key whitelist, zero tools, single user delta', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"minimal"}') }], 'off')
    const { runtime } = makeRuntime(llm)

    runtime.enqueue(delta('### Session update\n\n**user**: fix the bug'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    // Closed whitelist (AC-1): the exact sorted key set, nothing more.
    expect(Object.keys(options).sort()).toEqual(['advisorInternal', 'messages', 'model', 'provider', 'reasoningEffort', 'sessionId', 'signal', 'system'])
    // Zero-tools contract; no temperature/stop tuning; no purpose (KD-5).
    expect('tools' in options).toBe(false)
    expect('temperature' in options).toBe(false)
    expect('stop' in options).toBe(false)
    expect('purpose' in options).toBe(false)
    // 2026-10-18 ruling: no model-side token budget on any advisor call.
    expect('maxTokens' in options).toBe(false)
    // Single user delta with the configured system prompt.
    expect(options.messages).toHaveLength(1)
    expect(options.messages[0]!.role).toBe('user')
    expect(options.system).toBe(TEST_SYSTEM_PROMPT)
  })

  it('sends the same minimal request without reasoningEffort when the model has no reasoning capability', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"minimal"}') }], 'none')
    const { runtime } = makeRuntime(llm)

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    // Closed whitelist minus reasoningEffort (capability 'none' → not advertised).
    expect(Object.keys(options).sort()).toEqual(['advisorInternal', 'messages', 'model', 'provider', 'sessionId', 'signal', 'system'])
    expect('reasoningEffort' in options).toBe(false)
    expect('tools' in options).toBe(false)
    expect('temperature' in options).toBe(false)
    expect('stop' in options).toBe(false)
    expect('purpose' in options).toBe(false)
    // 2026-10-18 ruling: no model-side token budget on any advisor call.
    expect('maxTokens' in options).toBe(false)
    expect(options.messages).toHaveLength(1)
    expect(options.messages[0]!.role).toBe('user')
    expect(options.system).toBe(TEST_SYSTEM_PROMPT)
  })
})

// ---------------------------------------------------------------------------
// No model-side budget (2026-10-18 user ruling, superseding KD-I1) — the
// advisor call carries NO maxTokens; the adapter/model default applies
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — no model-side token budget (2026-10-18 ruling)', () => {
  it('never sends maxTokens on the advisor call (the adapter/model default applies)', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"no budget"}') }])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'no budget', severity: 'nit' }])
    expect(llm.calls).toHaveLength(1)
    expect('maxTokens' in llm.calls[0]!).toBe(false)
    expect(llm.calls[0]!.maxTokens).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Prose fallback (KD-I2, issue #102) — opt-in compat layer at the extraction
// call site: JSON frame priority unchanged, frame-less prose becomes a nit
// note ONLY when the flag is on
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — prose fallback (KD-I2, issue #102)', () => {
  const PROSE_REPLY = 'The helper in session.ts duplicates the retry loop — extract it into one place.'

  it('is off by default: a frame-less prose reply is dropped and counted as unparsed (default behavior unchanged)', async () => {
    const llm = new FakeLlm([
      { chunks: textReply(PROSE_REPLY) },
      { chunks: textReply('Second prose reply, also dropped while the flag is off.') },
    ])
    const { runtime, notes } = makeRuntime(llm, { logger: { debug: () => {}, warn: () => {} } })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([])
    expect(llm.calls).toHaveLength(2)
    expect(runtime.unparsedReplies).toBe(2)
    expect(runtime.emptyReplies).toBe(0)
    expect(runtime.lastUnparsedReplyAt).toBeTypeOf('number')
    expect(runtime.lastEmptyReplyAt).toBeUndefined()
  })

  it('proseFallback: true turns a frame-less prose reply into a nit note (guard-passed, onNote received)', async () => {
    const llm = new FakeLlm([{ chunks: textReply(PROSE_REPLY) }])
    const { runtime, notes } = makeRuntime(llm, { proseFallback: true })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: PROSE_REPLY, severity: 'nit' }])
    expect(runtime.unparsedReplies).toBe(0)
    expect(runtime.lastActivity).toBeTypeOf('number')
  })

  it('caps a long prose reply at ADVISOR_NOTE_MAX_CHARS with the truncation marker (same injection bound)', async () => {
    const longProse = `The module mixes concerns: ${'x'.repeat(ADVISOR_NOTE_MAX_CHARS + 500)}`
    const llm = new FakeLlm([{ chunks: textReply(longProse) }])
    const { runtime, notes } = makeRuntime(llm, { proseFallback: true })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('nit')
    expect(notes[0]!.note.length).toBe(ADVISOR_NOTE_MAX_CHARS)
    expect(notes[0]!.note.endsWith('…')).toBe(true)
  })

  it('strips a surrounding markdown fence from a fenced prose reply', async () => {
    const llm = new FakeLlm([{ chunks: textReply('```markdown\nThe retry loop is duplicated — extract it.\n```') }])
    const { runtime, notes } = makeRuntime(llm, { proseFallback: true })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'The retry loop is duplicated — extract it.', severity: 'nit' }])
  })

  it('prefers the JSON frame when the reply carries prose around a frame (frame priority unchanged)', async () => {
    const llm = new FakeLlm([{
      chunks: textReply(`Some prose around the frame.\n{"note":"from the frame","severity":"concern"}\nMore prose.`),
    }])
    const { runtime, notes } = makeRuntime(llm, { proseFallback: true })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'from the frame', severity: 'concern' }])
  })
})

// ---------------------------------------------------------------------------
// Drop counters (KD-I3, issue #102) — empty vs unparsed classification with
// timestamps and warn-once hints (KD-2 no-retry semantics unchanged: drops
// still return 'no-note' and never count toward the KD-5 consecutive streak)
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — drop counters (KD-I3, issue #102)', () => {
  it('starts at zero with no timestamps', () => {
    const llm = new FakeLlm([])
    const { runtime } = makeRuntime(llm)

    expect(runtime.emptyReplies).toBe(0)
    expect(runtime.unparsedReplies).toBe(0)
    expect(runtime.lastEmptyReplyAt).toBeUndefined()
    expect(runtime.lastUnparsedReplyAt).toBeUndefined()
  })

  it('counts an empty reply (finish stop) as empty — never unparsed, never prose even with fallback on', async () => {
    const llm = new FakeLlm([
      { chunks: emptyReply('stop') },
      { chunks: textReply('   ') },
    ])
    const { runtime, notes } = makeRuntime(llm, { proseFallback: true, logger: { debug: () => {}, warn: () => {} } })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    expect(notes).toEqual([]) // empty body is NOT prose (KD-I2)
    expect(runtime.emptyReplies).toBe(2)
    expect(runtime.unparsedReplies).toBe(0)
    expect(runtime.lastEmptyReplyAt).toBeTypeOf('number')
    expect(runtime.lastUnparsedReplyAt).toBeUndefined()
  })

  it('counts an empty reply with finish max-tokens as empty (the issue #102 reasoning-exhaustion case)', async () => {
    const llm = new FakeLlm([{ chunks: emptyReply('max-tokens') }])
    const { runtime } = makeRuntime(llm, { logger: { debug: () => {}, warn: () => {} } })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(runtime.emptyReplies).toBe(1)
    expect(runtime.unparsedReplies).toBe(0)
    expect(runtime.lastEmptyReplyAt).toBeTypeOf('number')
  })

  it('warns once per class with an actionable hint, then stays silent on repeats (KD-I3 warn-once)', async () => {
    const debug = vi.fn()
    const warn = vi.fn()
    const llm = new FakeLlm([
      { chunks: emptyReply('max-tokens') },
      { chunks: emptyReply('stop') },
      { chunks: textReply('prose reply without a frame') },
      { chunks: textReply('another prose reply without a frame') },
    ])
    const { runtime } = makeRuntime(llm, { logger: { debug, warn } })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    runtime.enqueue(delta('update three'))
    runtime.enqueue(delta('update four'))
    await runtime.waitForDrain()

    expect(runtime.emptyReplies).toBe(2)
    expect(runtime.unparsedReplies).toBe(2)
    // Exactly one warn per class, each carrying its condition hint (empty →
    // the model returned a completed response with no content; unparsed →
    // enable the fallback); repeats fall back to debug.
    const emptyWarns = warn.mock.calls.filter(([m]) => typeof m === 'string' && m.includes('empty reply dropped'))
    const unparsedWarns = warn.mock.calls.filter(([m]) => typeof m === 'string' && m.includes('consider enabling proseFallback'))
    expect(emptyWarns).toHaveLength(1)
    expect(unparsedWarns).toHaveLength(1)
    const emptyWarnPayload = emptyWarns[0]![1] as { finish?: string }
    expect(emptyWarnPayload.finish).toBe('max-tokens')
    // The old budget hint is gone everywhere (2026-10-18 ruling).
    expect(warn.mock.calls.some(([m]) => typeof m === 'string' && m.includes('maxTokens'))).toBe(false)
  })

  it('treats an EMPTY_RESPONSE failure as the empty-reply class: no retry, counted, no note (2026-10-18 ruling)', async () => {
    // Pre-ruling this code was classified TRANSIENT: retry once → drop, with
    // the drop invisible to the KD-I3 counters. Now one attempt, counted as
    // empty, no note delivered, runtime keeps running.
    const llm = new FakeLlm([
      { chunks: errorReply({ message: 'response completed with no content', code: 'EMPTY_RESPONSE' }) },
      { chunks: textReply('{"note":"next delta still drains"}') },
    ])
    const { runtime, notes } = makeRuntime(llm, { logger: { debug: () => {}, warn: () => {} } })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    // NOT retried: one call for the EMPTY_RESPONSE delta, one for the next.
    expect(llm.calls).toHaveLength(2)
    expect(notes).toEqual([{ note: 'next delta still drains', severity: 'nit' }])
    expect(runtime.emptyReplies).toBe(1)
    expect(runtime.unparsedReplies).toBe(0)
    expect(runtime.lastEmptyReplyAt).toBeTypeOf('number')
    expect(runtime.status()).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// extractProseFallbackNote — the KD-I2 cleanup (trim → strip surrounding
// fence → cap); exported so the tests pin the exact contract
// ---------------------------------------------------------------------------

describe('extractProseFallbackNote — prose cleanup (KD-I2, issue #102)', () => {
  it('trims surrounding whitespace and always yields a nit note', () => {
    expect(extractProseFallbackNote('  a real observation  ')).toEqual({
      note: 'a real observation',
      severity: 'nit',
    })
  })

  it('strips a surrounding markdown fence (with or without an info string)', () => {
    expect(extractProseFallbackNote('```text\nobservation inside a fence\n```')).toEqual({
      note: 'observation inside a fence',
      severity: 'nit',
    })
    expect(extractProseFallbackNote('```\nno info string\n```')).toEqual({
      note: 'no info string',
      severity: 'nit',
    })
  })

  it('keeps text whose fence is not surrounding (trailing prose after the closing fence)', () => {
    expect(extractProseFallbackNote('```\ninside\n``` trailing')).toEqual({
      note: '```\ninside\n``` trailing',
      severity: 'nit',
    })
  })

  it('caps at ADVISOR_NOTE_MAX_CHARS with the truncation marker', () => {
    const long = 'y'.repeat(ADVISOR_NOTE_MAX_CHARS + 500)
    const result = extractProseFallbackNote(long)
    expect(result).toBeDefined()
    expect(result!.note.length).toBe(ADVISOR_NOTE_MAX_CHARS)
    expect(result!.note.endsWith('…')).toBe(true)
    expect(result!.note.slice(0, ADVISOR_NOTE_MAX_CHARS - 1)).toBe('y'.repeat(ADVISOR_NOTE_MAX_CHARS - 1))
  })

  it('returns undefined for an empty, whitespace-only, or fence-only reply (NOT prose — KD-I3 empty drop)', () => {
    expect(extractProseFallbackNote('')).toBeUndefined()
    expect(extractProseFallbackNote('   \n  ')).toBeUndefined()
    expect(extractProseFallbackNote('```json\n```')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Delivery seam — a throwing onNote must never crash the drain (F1)
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — a throwing onNote is contained (F1)', () => {
  it('logs, continues the drain, and never rejects the kicker promise', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second","severity":"concern"}') },
    ])
    const { runtime } = makeRuntime(llm, {
      onNote: () => {
        throw new Error('delivery exploded')
      },
    })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    // The drain kicker (drainPromise) must resolve, not reject — an unhandled
    // rejection here would crash the process under Node ≥22/24 defaults.
    await expect(runtime.waitForDrain()).resolves.toBeUndefined()

    expect(llm.calls).toHaveLength(2) // the drain continued past both throws
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// JSON-frame extraction (KD-2)
// ---------------------------------------------------------------------------

describe('extractAdviceNote — JSON frame parsing (KD-2)', () => {
  it('parses a valid framed note with an explicit severity', () => {
    expect(extract('{"note":"check the loop","severity":"blocker"}')).toEqual({
      note: 'check the loop',
      severity: 'blocker',
    })
  })

  it('defaults a missing severity to nit', () => {
    expect(extract('{"note":"minor style point"}')).toEqual({ note: 'minor style point', severity: 'nit' })
  })

  it('defaults an invalid severity to nit', () => {
    expect(extract('{"note":"odd","severity":"critical"}')).toEqual({ note: 'odd', severity: 'nit' })
    expect(extract('{"note":"odd","severity":42}')).toEqual({ note: 'odd', severity: 'nit' })
  })

  it('is tolerant of surrounding prose and markdown fences', () => {
    expect(extract('```json\n{"note":"fenced","severity":"concern"}\n```')).toEqual({
      note: 'fenced',
      severity: 'concern',
    })
    expect(extract('Here is my review:\n{"note":"prose first"}')).toEqual({ note: 'prose first', severity: 'nit' })
  })

  it('skips an empty-note frame and accepts a later valid frame', () => {
    expect(extract('{"note":""}\n{"note":"the real note","severity":"concern"}')).toEqual({
      note: 'the real note',
      severity: 'concern',
    })
  })

  it('drops a whitespace-only note (drop + log, never crash)', () => {
    expect(extract('{"note":"   "}')).toBeUndefined()
  })

  it('drops a reply with no parseable frame (no model retry)', () => {
    expect(extract('no frame here')).toBeUndefined()
    expect(extract('{"note":')).toBeUndefined()
    expect(extract('[]')).toBeUndefined()
  })

  it('caps an over-long note at ADVISOR_NOTE_MAX_CHARS with a truncation marker (qc3 F-2)', () => {
    const longNote = 'x'.repeat(ADVISOR_NOTE_MAX_CHARS + 500)
    const result = extract(`{"note":"${longNote}","severity":"concern"}`)
    expect(result).toBeDefined()
    expect(result!.severity).toBe('concern')
    expect(result!.note.length).toBe(ADVISOR_NOTE_MAX_CHARS)
    expect(result!.note.endsWith('…')).toBe(true)
    expect(result!.note.slice(0, ADVISOR_NOTE_MAX_CHARS - 1)).toBe('x'.repeat(ADVISOR_NOTE_MAX_CHARS - 1))
  })

  it('keeps a note within the cap untouched', () => {
    expect(extract('{"note":"short note"}')).toEqual({ note: 'short note', severity: 'nit' })
  })
})

/** Local alias so the extraction tests read naturally. */
function extract(reply: string): AdviceNote | undefined {
  return extractAdviceNote(reply)
}

// ---------------------------------------------------------------------------
// Failure policy (KD-5) — transient retry, drop, flush, pause, halt
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — failure policy (KD-5)', () => {
  it('retries a transient failure once after the backoff, then drops the delta with the failure detail in the drop warn', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.fn()
      const debug = vi.fn()
      const llm = new FakeLlm([
        { throw: Object.assign(new Error('upstream blew up'), { code: 'SERVER' }) },
        { throw: Object.assign(new Error('upstream blew up again'), { code: 'SERVER' }) },
      ])
      const { runtime, notes } = makeRuntime(llm, { retryBackoffMs: 1_000, logger: { debug, warn } })

      runtime.enqueue(delta('first update'))
      // The capability resolution (resolveModelInfo) is an async pre-step, so
      // the first attempt lands after a microtask hop rather than synchronously.
      await vi.waitFor(() => expect(llm.calls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(llm.calls).toHaveLength(2)
      expect(notes).toEqual([])
      expect(runtime.pendingCount).toBe(0)
      expect(runtime.status()).toBe('running')
      // Failure visibility (2026-10-18): each failed attempt is logged with
      // the failure's code/message — warn on the first attempt, debug on the
      // retry — and the terminal drop warn carries the LAST failure's
      // code/message instead of a detail-less attempt count.
      const firstAttemptWarn = warn.mock.calls.find(([m]) => m === 'advisor: model call failed — retrying')
      expect(firstAttemptWarn).toBeTruthy()
      expect(firstAttemptWarn![1]).toMatchObject({ code: 'SERVER', message: 'upstream blew up' })
      const retryDebug = debug.mock.calls.find(([m]) => m === 'advisor: model call failed — retry exhausted')
      expect(retryDebug).toBeTruthy()
      expect(retryDebug![1]).toMatchObject({ code: 'SERVER', message: 'upstream blew up again' })
      const dropWarn = warn.mock.calls.find(([m]) => m === 'advisor: dropping delta after transient failures')
      expect(dropWarn).toBeTruthy()
      expect(dropWarn![1]).toMatchObject({
        attempts: 2,
        code: 'SERVER',
        message: 'upstream blew up again',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a failed delta (adapter throw) and continues with later deltas', async () => {
    const llm = new FakeLlm([
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { chunks: textReply('{"note":"recovered"}') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('bad update'))
    runtime.enqueue(delta('good update'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'recovered', severity: 'nit' }])
    expect(llm.calls).toHaveLength(3) // 2 attempts on the failed delta + 1 on the good one
    expect(runtime.status()).toBe('running')
  })

  it('flushes the pending backlog after 3 consecutive dropped deltas', async () => {
    const llm = new FakeLlm([
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { throw: new Error('server error') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    // Five deltas: the first three are dropped (each after its retry); the
    // third drop trips the flush, which clears the two still-queued deltas.
    for (let index = 1; index <= 5; index++) runtime.enqueue(delta(`update ${index}`))
    await runtime.waitForDrain()

    expect(notes).toEqual([])
    expect(llm.calls).toHaveLength(6) // 3 deltas × (attempt + retry); queued deltas never dispatched
    expect(runtime.pendingCount).toBe(0)
  })

  it('times out a hung stream (no chunk, no end, no error), drops it per KD-5, and the drain continues', async () => {
    // The first two calls hang forever (attempt + single retry); the third
    // succeeds. The call-level deadline must classify each hang as a transient
    // timeout → KD-5 retry(1) → drop — the drain is never wedged (qc2 W-4 /
    // qc3 W-1), even though the provider ignores the abort signal.
    const llm = new FakeLlm([
      { hang: true },
      { hang: true },
      { chunks: textReply('{"note":"recovered","severity":"concern"}') },
    ])
    const { runtime, notes } = makeRuntime(llm, { callTimeoutMs: 20 })

    runtime.enqueue(delta('hung update'))
    runtime.enqueue(delta('good update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(3) // hung attempt + hung retry + the recovered delta
    expect(notes).toEqual([{ note: 'recovered', severity: 'concern' }])
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })

  // KD-6 (§8.6) regression pin
  it('does not latch a deadline-aborted capability resolution — the retry re-resolves and delivers (n4 QC N-5)', async () => {
    const llm = new SignalBoundLlm(textReply('{"note":"resolution bounded"}'))
    const records: AdvisorTurnRecord[] = []
    const { runtime, notes } = makeRuntime(llm, { callTimeoutMs: 20, onTurn: (record) => records.push(record) })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    // Attempt 1: the deadline signal reached the capability resolution
    // (threaded through, N-5) and aborted it — a transient timeout, NOT a
    // definitive verdict. The abort is not cached, so the KD-5 retry
    // re-resolves with a fresh deadline instead of reusing a latched
    // `undefined`.
    expect(llm.resolveSignals).toHaveLength(2)
    expect(llm.resolveSignals[0]).toBeInstanceOf(AbortSignal)
    expect(llm.resolveSignals[0]!.aborted).toBe(true)
    expect(llm.resolveSignals[1]).toBeInstanceOf(AbortSignal)
    // The retry re-resolves with a FRESH, non-aborted signal — the abort was
    // not latched and is not reused (n4 QC N-5 / qc3 S-2).
    expect(llm.resolveSignals[1]!.aborted).toBe(false)
    // Attempt 2 re-resolved 'off' — the option is back on the retry, the note
    // is delivered, and the whole drain stayed deadline-bounded. The aborted
    // first attempt never started a doomed stream call: the preparation
    // deadline classified it as a transient timeout first, so only attempt 2
    // reaches the provider (one call, not two).
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]!.reasoningEffort).toBe(ReasoningEffortId('off'))
    expect(notes).toEqual([{ note: 'resolution bounded', severity: 'nit' }])
    // Attempt 1's failure is a TIMEOUT, which is what makes the retry correct.
    expect(records.some((record) => record.outcome === 'failure' && record.error?.startsWith('TIMEOUT'))).toBe(true)
    expect(runtime.status()).toBe('running')
  })

  it('a timeout is a transient failure: the single retry gets a fresh deadline and can succeed', async () => {
    // Attempt 1 hangs → timeout; the KD-5 retry (fresh deadline) succeeds.
    const llm = new FakeLlm([
      { hang: true },
      { chunks: textReply('{"note":"slow but recovered"}') },
    ])
    const { runtime, notes } = makeRuntime(llm, { callTimeoutMs: 20 })

    runtime.enqueue(delta('slow update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    expect(notes).toEqual([{ note: 'slow but recovered', severity: 'nit' }])
    expect(runtime.status()).toBe('running')
  })

  it('pauses on quota/rate-limit with the batch retained and no auto-resume', async () => {
    const llm = new FakeLlm([
      { chunks: errorReply(quotaFailure()) },
      { chunks: textReply('{"note":"after resume"}') },
      { chunks: textReply('{"note":"queued while paused"}') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('first'))
    await runtime.waitForDrain()
    expect(runtime.status()).toBe('quota_exhausted')
    expect(runtime.pendingCount).toBe(1) // the batch is requeued, not dropped
    expect(llm.calls).toHaveLength(1)

    // No auto-resume: new deltas queue up but no model call starts.
    runtime.enqueue(delta('second'))
    await Promise.resolve()
    expect(llm.calls).toHaveLength(1)
    expect(runtime.pendingCount).toBe(2)

    // Manual resume (T7 `/advisor on` path) drains the retained + queued batch.
    runtime.resume()
    await runtime.waitForDrain()
    expect(notes).toEqual([
      { note: 'after resume', severity: 'nit' },
      { note: 'queued while paused', severity: 'nit' },
    ])
    expect(llm.calls).toHaveLength(3) // quota call + retained batch + queued delta
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })

  it('halts on a permanent error and drops subsequent deltas without calling the model', async () => {
    const llm = new FakeLlm([{ chunks: errorReply(permanentFailure()) }])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('first'))
    await runtime.waitForDrain()
    expect(runtime.status()).toBe('halted')
    expect(notes).toEqual([])
    expect(llm.calls).toHaveLength(1)

    runtime.enqueue(delta('second'))
    await runtime.waitForDrain()
    expect(llm.calls).toHaveLength(1) // halted: never called again
    expect(runtime.pendingCount).toBe(0)
  })

  it.each(['MODEL_UNSUPPORTED', 'CLIENT_UPGRADE_REQUIRED'] as const)(
    'halts on the model-listing refusal %s instead of retrying it as transient',
    async (code) => {
      const llm = new FakeLlm([{ chunks: errorReply(refusalFailure(code)) }])
      const { runtime, notes } = makeRuntime(llm)

      runtime.enqueue(delta('first'))
      await runtime.waitForDrain()
      expect(runtime.status()).toBe('halted')
      expect(notes).toEqual([])
      expect(llm.calls).toHaveLength(1) // a refusal is not retryable
    },
  )
})

// ---------------------------------------------------------------------------
// Bounded backlog (spec §6) — drop-newest with a debug log when the queue is full
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — bounded backlog drop-newest (spec §6)', () => {
  /** Manually-resolvable promise — releases a gated `FakeLlm` stream on demand. */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  /** Delta markdown carried by one recorded `llm.stream` call (drain-test pattern). */
  const textOf = (options: GenerateOptions): string => {
    const block = options.messages[options.messages.length - 1]!.content[0]!
    const raw = block.type === 'text' ? block.text : ''
    return raw.replace(/\n\n---\n(Reviewer|Prediction) task:[\s\S]*$/, '')
  }

  it('drops the newest delta when the backlog is full, while a delta is in flight', async () => {
    // The first delta is held in flight on a releasable gate (the drain parks
    // on the stream's first `next()`), so the queue fills to `maxQueued`
    // deterministically — no wall-clock timing.
    const gate = deferred()
    const llm = new FakeLlm([
      { gate: gate.promise, chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second"}') },
      { chunks: textReply('{"note":"third"}') },
    ])
    const debug = vi.fn()
    const warn = vi.fn()
    const { runtime, notes } = makeRuntime(llm, { maxQueued: 2, logger: { debug, warn } })

    runtime.enqueue(delta('update one'))
    await vi.waitFor(() => expect(llm.calls).toHaveLength(1)) // dequeued + in flight
    expect(runtime.pendingCount).toBe(0)

    // The queue fills to maxQueued (2) while the first delta is still in flight.
    runtime.enqueue(delta('update two'))
    runtime.enqueue(delta('update three'))
    expect(runtime.pendingCount).toBe(2)

    // Backlog full → drop-newest: the next delta is refused at enqueue and
    // never dispatched to the model.
    runtime.enqueue(delta('update four'))
    expect(runtime.pendingCount).toBe(2)
    expect(llm.calls).toHaveLength(1)

    // Observability (spec §6): the drop is logged with the maxQueued payload.
    expect(debug).toHaveBeenCalledWith('advisor: enqueue dropped — backlog full', { maxQueued: 2 })

    // Release the in-flight call: the accepted deltas drain in FIFO order and
    // the dropped delta never appears.
    gate.resolve()
    await runtime.waitForDrain()

    expect([textOf(llm.calls[0]!), textOf(llm.calls[1]!), textOf(llm.calls[2]!)]).toEqual([
      'update one',
      'update two',
      'update three',
    ])
    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
      { note: 'third', severity: 'nit' },
    ])
    expect(llm.calls).toHaveLength(3)
    expect(runtime.pendingCount).toBe(0)
    expect(runtime.status()).toBe('running')
  })

  it('retains FIFO order for accepted deltas when the queue fills from capacity-1', async () => {
    // maxQueued 3: one delta in flight (gated) + three queued = the queue sits
    // at capacity; the next delta is dropped at enqueue; the accepted four
    // drain in enqueue order.
    const gate = deferred()
    const llm = new FakeLlm([
      { gate: gate.promise, chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second"}') },
      { chunks: textReply('{"note":"third"}') },
      { chunks: textReply('{"note":"fourth"}') },
    ])
    const { runtime } = makeRuntime(llm, { maxQueued: 3 })

    runtime.enqueue(delta('update one'))
    await vi.waitFor(() => expect(llm.calls).toHaveLength(1)) // in flight

    runtime.enqueue(delta('update two'))
    runtime.enqueue(delta('update three'))
    runtime.enqueue(delta('update four')) // queue reaches maxQueued (3)
    expect(runtime.pendingCount).toBe(3)
    runtime.enqueue(delta('update five')) // dropped — the queue is full
    expect(runtime.pendingCount).toBe(3)
    expect(llm.calls).toHaveLength(1)

    gate.resolve()
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(4)
    expect([
      textOf(llm.calls[0]!),
      textOf(llm.calls[1]!),
      textOf(llm.calls[2]!),
      textOf(llm.calls[3]!),
    ]).toEqual(['update one', 'update two', 'update three', 'update four'])
    expect(runtime.pendingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle — dispose aborts the in-flight call and stops the drain
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — dispose (KD-5 in-flight abort)', () => {
  /** Fake that suspends until the request signal aborts, then reports aborted. */
  class SignalAwaitingLlm {
    calls = 0
    readonly signals: AbortSignal[] = []

    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.calls++
      const signal = options.signal
      this.signals.push(signal!)
      return (async function* () {
        if (signal === undefined) throw new Error('expected an abort signal')
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
      })()
    }
  }

  it('aborts the in-flight call via the signal, clears the queue, and ignores later enqueues', async () => {
    const llm = new SignalAwaitingLlm()
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('in flight'))
    runtime.enqueue(delta('queued'))
    // Capability resolution is an async pre-step; the first delta's stream
    // call lands after a microtask hop, the second stays queued.
    await vi.waitFor(() => expect(llm.calls).toBe(1)) // first delta in flight, second still queued

    runtime.dispose()
    await runtime.waitForDrain()

    expect(llm.signals[0]!.aborted).toBe(true) // in-flight call aborted via the signal
    expect(runtime.pendingCount).toBe(0)       // queued delta cleared on dispose
    expect(notes).toEqual([])

    runtime.enqueue(delta('after dispose'))
    await runtime.waitForDrain()
    expect(llm.calls).toBe(1) // no new calls after dispose
  })
})

// ---------------------------------------------------------------------------
// Composed contexts — real LlmRuntime + stub adapter registration
// ---------------------------------------------------------------------------

class RecordingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string, _signal?: undefined): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('off') },
    })
  }

  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

describe('AdvisorRuntime — composed with a real LlmRuntime + registered adapter', () => {
  it('dispatches through ctx.llm.registerAdapter with the expected options', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter([...textReply('{"note":"registered adapter works"}')])
    ctx.llm.registerAdapter(['test-provider'], adapter)

    const notes: AdviceNote[] = []
    const runtime = new AdvisorRuntime({
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'sess-test' as SessionId,
      systemPrompt: TEST_SYSTEM_PROMPT,
      llm: ctx.llm,
      onNote: (note) => { notes.push(note) },
    })
    runtime.enqueue(delta('### Session update\n\n**agent**: wrote the tests'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'registered adapter works', severity: 'nit' }])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      system: TEST_SYSTEM_PROMPT,
      reasoningEffort: 'off',
    })
    expect('maxTokens' in adapter.requests[0]!).toBe(false)
    expect(adapter.requests[0]!.purpose).toBeUndefined()
    expect('purpose' in adapter.requests[0]!).toBe(false)
  })

  it('never starts a model call when the pair gate blocks (explicit gate, S4)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter([...textReply('{"note":"should never be called"}')])
    ctx.llm.registerAdapter(['test-provider'], adapter)

    // No config-level switch anymore (2026-09-26 — the row toggle is the
    // switch): a pairless entry resolves to disabled-with-reason, and the
    // gate drops every delta before a call could start.
    apply(ctx, { systemPrompt: '', maxDeltaMessages: 60 })

    // A full stepped turn would otherwise render a delta and dispatch a call.
    const events = buildEvents(minimalTurn())
    const session = { id: 's1', snapshotEvents: () => events } as unknown as Session
    for (const event of events) {
      ctx.emit('session/event', session, event)
    }
    expect(adapter.requests).toEqual([])
  })
})

/** Base-adapter stub: `resolveModel` returns NO reasoning metadata (W-1 path). */
class NoReasoningAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

describe('AdvisorRuntime — capability-gated reasoningEffort against a real LlmRuntime (W-1)', () => {
  it('a registered adapter WITHOUT reasoning metadata yields a note with no reasoningEffort sent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new NoReasoningAdapter([...textReply('{"note":"plain model works","severity":"nit"}')])
    ctx.llm.registerAdapter(['plain'], adapter)

    const notes: AdviceNote[] = []
    const runtime = new AdvisorRuntime({
      provider: 'plain',
      model: 'plain-model',
      sessionId: 'sess-test' as SessionId,
      systemPrompt: TEST_SYSTEM_PROMPT,
      llm: ctx.llm,
      onNote: (note) => { notes.push(note) },
    })
    runtime.enqueue(delta('### Session update\n\n**agent**: wrote the tests'))
    await runtime.waitForDrain()

    // The real LlmRuntime would throw UNSUPPORTED_REASONING_EFFORT if the
    // runtime sent an explicit effort for this model — the capability gate
    // omits it, resolveCallFor materializes nothing, and the note arrives.
    expect(notes).toEqual([{ note: 'plain model works', severity: 'nit' }])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'plain',
      model: 'plain-model',
      system: TEST_SYSTEM_PROMPT,
    })
    expect('maxTokens' in adapter.requests[0]!).toBe(false)
    expect('reasoningEffort' in adapter.requests[0]!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Synthetic session event builders (mirror of the transcript test fixtures)
// ---------------------------------------------------------------------------

interface EventSpec {
  type: string
  data: unknown
  surfaceOp?: string
}

function buildEvents(specs: readonly EventSpec[]): SessionEvent[] {
  return specs.map((spec, index) => {
    const event: Record<string, unknown> = {
      type: spec.type,
      seq: index,
      time: 1_000 + index,
      data: spec.data,
    }
    if (spec.surfaceOp !== undefined) event.surfaceOp = spec.surfaceOp
    return event as unknown as SessionEvent
  })
}

/** One standard stepped turn ending in a reviewable `completed` reason. */
function minimalTurn(): EventSpec[] {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'do the thing' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

// ---------------------------------------------------------------------------
// Append-only reviewer conversation (fork) — provider prefix-cache reuse
// ---------------------------------------------------------------------------

/** Text of the first content block of one request message. */
const textOfMessage = (message: { content: readonly unknown[] }): string => {
  const block = message.content[0] as { type: string; text?: string }
  return block.type === 'text' ? block.text ?? '' : ''
}

describe('AdvisorRuntime — append-only reviewer conversation', () => {
  it('sends system + history + the new turn, and earlier messages never change', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first note","severity":"nit"}') },
      { chunks: textReply('{"note":"second note","severity":"concern"}') },
    ])
    const { runtime } = makeRuntime(llm)

    runtime.enqueue(delta('first update'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('second update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    const first = llm.calls[0]!
    const second = llm.calls[1]!
    expect(first.messages).toHaveLength(1)
    // Turn 2 = turn 1 (untouched) + its assistant reply + the new turn.
    expect(second.messages).toHaveLength(3)
    expect(second.messages[0]).toBe(first.messages[0])
    expect(second.messages[1]!.role).toBe('assistant')
    expect(textOfMessage(second.messages[1]!)).toBe('{"note":"first note","severity":"nit"}')
    expect(second.messages[2]!.role).toBe('user')
    const newTurn = textOfMessage(second.messages[2]!)
    expect(newTurn).toContain('second update')
    expect(newTurn).not.toContain('first update')
  })

  it('stores a turn the extractor dropped, so history matches what the provider saw', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('not a JSON frame at all') },
      { chunks: textReply('{"note":"second"}') },
    ])
    const { runtime } = makeRuntime(llm)

    runtime.enqueue(delta('first update'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('second update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]!.messages).toHaveLength(3)
    expect(llm.calls[1]!.messages[1]!.role).toBe('assistant')
    expect(textOfMessage(llm.calls[1]!.messages[1]!)).toBe('not a JSON frame at all')
  })

})

// ---------------------------------------------------------------------------
// Append-only history edge cases + trajectory accounting (fork additions)
// ---------------------------------------------------------------------------

/** A text reply that also reports provider usage (cache fields included). */
const replyWithUsage = (
  text: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number },
): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'usage', usage },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('AdvisorRuntime — history edge cases and trajectory accounting', () => {
  it('stores nothing when the history budget is 0 (every review is cold)', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"one"}') },
      { chunks: textReply('{"note":"two"}') },
    ])
    const { runtime } = makeRuntime(llm, { historyMaxTokens: 0 })

    runtime.enqueue(delta('first update'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('second update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]!.messages).toHaveLength(1)
    expect(textOfMessage(llm.calls[1]!.messages[0]!)).toContain('second update')
  })

  it('stores a placeholder assistant turn for an empty reply (alternation preserved)', async () => {
    const llm = new FakeLlm([
      { chunks: emptyReply('stop') },
      { chunks: textReply('{"note":"second"}') },
    ])
    const { runtime } = makeRuntime(llm)

    runtime.enqueue(delta('first update'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('second update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    const second = llm.calls[1]!
    expect(second.messages).toHaveLength(3)
    expect(second.messages[1]!.role).toBe('assistant')
    expect(textOfMessage(second.messages[1]!)).toBe('(no reply)')
  })

  it('reports provider usage and cache reads to the trajectory sink', async () => {
    const turns: AdvisorTurnRecord[] = []
    const llm = new FakeLlm([
      {
        chunks: replyWithUsage('{"note":"check the cache","severity":"concern"}', {
          inputTokens: 400,
          outputTokens: 20,
          cacheReadTokens: 1600,
          cacheWriteTokens: 0,
          totalTokens: 2020,
        }),
      },
    ])
    const { runtime } = makeRuntime(llm, { onTurn: (record) => turns.push(record) })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(turns).toHaveLength(1)
    expect(turns[0]!.outcome).toBe('note')
    expect(turns[0]!.severity).toBe('concern')
    expect(turns[0]!.usage).toMatchObject({
      inputTokens: 400,
      outputTokens: 20,
      cacheReadTokens: 1600,
      totalTokens: 2020,
    })
    expect(turns[0]!.historyTokens).toBe(0)
  })

  it('reports a failed attempt with its error and no usage', async () => {
    const turns: AdvisorTurnRecord[] = []
    const llm = new FakeLlm([{ throw: new Error('boom') }])
    const { runtime } = makeRuntime(llm, { onTurn: (record) => turns.push(record) })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(turns.length).toBeGreaterThan(0)
    expect(turns[0]!.outcome).toBe('failure')
    expect(turns[0]!.error).toContain('boom')
    expect(turns[0]!.usage).toBeUndefined()
  })
})

describe('AdvisorRuntime — model-context clamp (fork addition)', () => {
  /** A FakeLlm whose capability lookup declares a small context window. */
  function llmWithWindow(contextWindow: number, defaultMaxTokens: number): FakeLlm {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"one"}') },
      { chunks: textReply('{"note":"two"}') },
    ])
    llm.resolveModelInfo = async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow },
      defaultMaxTokens,
    })
    return llm
  }


  it('keeps the configured budget when the model declares no window', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"one"}') },
      { chunks: textReply('{"note":"two"}') },
    ])
    const turns: AdvisorTurnRecord[] = []
    const { runtime } = makeRuntime(llm, { onTurn: (record) => turns.push(record) })

    runtime.enqueue(delta(`first ${'x'.repeat(1_200)}`))
    await runtime.waitForDrain()
    runtime.enqueue(delta(`second ${'x'.repeat(900)}`))
    await runtime.waitForDrain()

    // No declared context window → no clamp: the configured budget (1M) is
    // the only bound and the first exchange stays in history.
    expect(llm.calls[1]!.messages).toHaveLength(3)
    expect(turns.at(-1)!.historyTokens).toBeGreaterThan(0)
  })

})

describe('AdvisorRuntime — reviewed-turn attribution (fork addition)', () => {
  it('passes the delta turn to onNote', async () => {
    const received: Array<number | undefined> = []
    const llm = new FakeLlm([{ chunks: textReply('{"note":"x"}') }])
    const { runtime } = makeRuntime(llm, {
      onNote: (_note, turn) => { received.push(turn) },
    })

    runtime.enqueue({ ...delta('update'), turn: 7 })
    await runtime.waitForDrain()

    expect(received).toEqual([7])
  })
})

describe('AdvisorRuntime — standing session rules + wake flag (fork addition)', () => {
  it('prepends the rules block to the new user turn', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"x"}') }])
    const { runtime } = makeRuntime(llm, { rules: () => ['do not overshoot', 'be terse'] })
    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    const sent = textOfMessage(llm.calls[0]!.messages[0]!)
    expect(sent.startsWith('## Advisor instructions (live)')).toBe(true)
    expect(sent).toContain('1. [session] do not overshoot')
    expect(sent).toContain('2. [session] be terse')
  })

  it('reads the rule source live, so a new rule applies without rebuilding the runtime', async () => {
    const rules = ['first rule']
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"one"}') },
      { chunks: textReply('{"note":"two"}') },
    ])
    const { runtime } = makeRuntime(llm, { rules: () => rules })
    runtime.enqueue(delta('first'))
    await runtime.waitForDrain()
    rules.push('second rule')
    runtime.enqueue(delta('second'))
    await runtime.waitForDrain()

    const second = textOfMessage(llm.calls[1]!.messages.at(-1)!)
    expect(second).toContain('1. [session] first rule')
    expect(second).toContain('2. [session] second rule')
  })

  it('extracts an explicit wake flag; an absent/invalid flag stays undefined (legacy default)', () => {
    expect(extractAdviceNote('{"note":"x","wake":false}')?.wake).toBe(false)
    expect(extractAdviceNote('{"note":"x","wake":true}')?.wake).toBe(true)
    expect(extractAdviceNote('{"note":"x"}')?.wake).toBeUndefined()
    expect(extractAdviceNote('{"note":"x","wake":"no"}')?.wake).toBeUndefined()
  })

  it('renders every live layer with its scope label', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"x"}') }])
    const { runtime } = makeRuntime(llm, {
      layers: () => ({
        systemWide: 'system instruction',
        workspace: 'workspace instruction',
        session: 'session instruction',
        rules: [
          { scope: 'system', text: 'sys rule' },
          { scope: 'workspace', text: 'ws rule' },
          { scope: 'session', text: 'sess rule' },
        ],
      }),
    })
    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    const sent = textOfMessage(llm.calls[0]!.messages[0]!)
    expect(sent).toContain('## Advisor instructions (live)')
    expect(sent).toContain('### System-wide\nsystem instruction')
    expect(sent).toContain('### Workspace\nworkspace instruction')
    expect(sent).toContain('### Session\nsession instruction')
    expect(sent).toContain('1. [system] sys rule')
    expect(sent).toContain('2. [workspace] ws rule')
    expect(sent).toContain('3. [session] sess rule')
  })
})

describe('AdvisorRuntime — compaction (fork addition)', () => {
  it('compacts the old conversation and continues in a single user turn', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first note"}') },
      { chunks: textReply('Earlier advice: check the parser.') },
      { chunks: textReply('{"note":"second note"}') },
    ])
    const turns: AdvisorTurnRecord[] = []
    const { runtime } = makeRuntime(llm, { historyMaxTokens: 150, onTurn: (record) => turns.push(record) })

    runtime.enqueue(delta('first update'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('second update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(3)
    // Call 2 is the summarizer (its system prompt differs from the reviewer's).
    expect(llm.calls[1]!.system).toContain('compress')
    // Call 3 is the review, now carrying ONE user turn: summary + new delta.
    expect(llm.calls[2]!.messages).toHaveLength(1)
    const sent = textOfMessage(llm.calls[2]!.messages[0]!)
    expect(sent).toContain('[Compacted earlier reviewer conversation]')
    expect(sent).toContain('Earlier advice: check the parser.')
    // The tiny trigger leaves room only for the summary + tail, so the delta
    // head is folded into the summary (trim-tail rule) and the tail remains.
    expect(sent).toContain('[earlier part of this update is in the summary above]')
    // The delta's head was folded into the summary, not re-sent in full.
    expect(sent).not.toContain('second update')
    // The compaction attempt is its own Stats row.
    expect(turns.some((turn) => turn.kind === 'compaction' && turn.outcome === 'note')).toBe(true)
  })

  it('falls back to a cold reset when compaction fails, and the review still fires', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first note"}') },
      { chunks: emptyReply('stop') },
      { chunks: emptyReply('stop') },
      { chunks: textReply('{"note":"second note"}') },
    ])
    const turns: AdvisorTurnRecord[] = []
    const { runtime } = makeRuntime(llm, { historyMaxTokens: 150, onTurn: (record) => turns.push(record) })

    runtime.enqueue(delta('first update'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('second update'))
    await runtime.waitForDrain()

    // two failed summaries (retry once) then the review — the review fired.
    expect(llm.calls).toHaveLength(4)
    expect(llm.calls[3]!.messages).toHaveLength(1)
    expect(textOfMessage(llm.calls[3]!.messages[0]!)).not.toContain('[Compacted earlier reviewer conversation]')
    expect(turns.some((turn) => turn.kind === 'compaction' && turn.outcome === 'failure')).toBe(true)
    expect(turns.some((turn) => turn.outcome === 'note' && turn.kind !== 'compaction')).toBe(true)
  })
})

describe('AdvisorRuntime — compaction fits branch (fork addition)', () => {
  it('sends the whole delta with no partial marker when it fits after compaction', async () => {
    const big = 'z'.repeat(8_000)
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first note"}') },
      { chunks: textReply('Compact summary text.') },
      { chunks: textReply('{"note":"second note"}') },
    ])
    const turns: AdvisorTurnRecord[] = []
    const { runtime } = makeRuntime(llm, { historyMaxTokens: 4_000, onTurn: (record) => turns.push(record) })

    runtime.enqueue(delta(`first ${big}`))
    await runtime.waitForDrain()
    runtime.enqueue(delta(`second ${big}`))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(3)
    const sent = textOfMessage(llm.calls[2]!.messages[0]!)
    expect(sent).toContain('[Compacted earlier reviewer conversation]')
    expect(sent).toContain(`second ${big}`)
    expect(sent).not.toContain('[earlier part of this update is in the summary above]')
    // The Trajectory row carries the prepared text (summary + full delta).
    // The LAST review row is the compacted one.
    const reviewTurn = turns.filter((turn) => turn.kind !== 'compaction').at(-1)
    expect(reviewTurn?.userText).toContain('second')
    expect(reviewTurn?.userText).toContain('[Compacted earlier reviewer conversation]')
    // The compaction row carries the summary it produced.
    const compactionTurn = turns.find((turn) => turn.kind === 'compaction')
    expect(compactionTurn?.note).toContain('Compact summary text.')
  })
})

describe('AdvisorRuntime — reactive overflow (fork addition)', () => {
  it('compacts on the KD-5 retry instead of re-sending the identical request', async () => {
    const llm = new FakeLlm([
      { throw: new Error('maximum context length exceeded') },
      { chunks: textReply('Reactive compaction summary.') },
      { chunks: textReply('{"note":"after overflow"}') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('overflow update'))
    await runtime.waitForDrain()

    // attempt 1 overflowed, attempt 2 compacted, attempt 3 reviewed.
    expect(llm.calls).toHaveLength(3)
    expect(llm.calls[1]!.system).toContain('compress')
    const sent = textOfMessage(llm.calls[2]!.messages[0]!)
    expect(sent).toContain('[Compacted earlier reviewer conversation]')
    expect(sent).toContain('Reactive compaction summary.')
    // The delta itself still reaches the review (no fold-to-zero).
    expect(sent).toContain('overflow update')
    expect(notes.some((note) => note.note === 'after overflow')).toBe(true)
  })
})

describe('AdvisorRuntime — zero-room fold (fork addition)', () => {
  it('sends the summary and marker with an empty tail when no room remains', async () => {
    const llm = new FakeLlm([
      { chunks: textReply(`Summary ${'s'.repeat(2_000)}`) },
      { chunks: textReply('{"note":"folded"}') },
    ])
    const { runtime } = makeRuntime(llm, { historyMaxTokens: 50 })

    runtime.enqueue(delta('oversized first update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    const sent = textOfMessage(llm.calls[1]!.messages[0]!)
    expect(sent).toContain('[Compacted earlier reviewer conversation]')
    expect(sent).toContain('[earlier part of this update is in the summary above]')
    // No room for the tail: the delta must NOT be re-sent in full.
    expect(sent).not.toContain('oversized first update')
  })
})

describe('AdvisorRuntime — giant-delta summarizer input (fork addition)', () => {
  it('summarizes the delta HEAD and re-sends the TAIL, never losing both', async () => {
    const head = `HEADSTART ${'A'.repeat(59_990)}`
    const tail = `${'B'.repeat(139_990)} TAILEND`
    const llm = new FakeLlm([
      { chunks: textReply('Giant summary.') },
      { chunks: textReply('{"note":"after giant"}') },
    ])
    const { runtime, notes } = makeRuntime(llm, { historyMaxTokens: 1_000 })

    runtime.enqueue(delta(`${head}${tail}`))
    await runtime.waitForDrain()

    expect(llm.calls.length).toBeGreaterThanOrEqual(2)
    expect(llm.calls[0]!.system).toContain('compress')
    const summarizerInput = textOfMessage(llm.calls[0]!.messages[0]!)
    // Direction: the summarizer sees the HEAD (what the review will not re-send).
    expect(summarizerInput).toContain('HEADSTART')
    expect(summarizerInput).toContain('[newer part of this update omitted here; it will be re-sent with the review]')
    expect(summarizerInput).not.toContain('TAILEND')
    expect(summarizerInput.length).toBeLessThan(180_000)
    // The review re-sends the TAIL and carries the fold marker.
    const reviewInput = textOfMessage(llm.calls.at(-1)!.messages[0]!)
    expect(reviewInput).toContain('TAILEND')
    expect(reviewInput).not.toContain('HEADSTART')
    expect(reviewInput).toContain('[earlier part of this update is in the summary above]')
    // Compaction succeeded and the note was delivered.
    expect(notes.some((note) => note.note === 'after giant')).toBe(true)
  })
})

describe('AdvisorRuntime — cold-path convergence (fork addition)', () => {
  it('retries after an overflow in cold mode and still delivers the note', async () => {
    const llm = new FakeLlm([
      { throw: new Error('context length exceeded') },
      { chunks: textReply('{"note":"cold retry"}') },
    ])
    const { runtime, notes } = makeRuntime(llm, { historyMaxTokens: 0 })

    runtime.enqueue(delta('cold update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    expect(notes.some((note) => note.note === 'cold retry')).toBe(true)
  })
})

describe('AdvisorRuntime — full trace sink (fork addition)', () => {
  it('emits the complete prepared text and the raw reply', async () => {
    const traces: AdvisorTrace[] = []
    const llm = new FakeLlm([{ chunks: textReply('{"note":"trace note"}') }])
    const { runtime } = makeRuntime(llm, { onTrace: (trace) => traces.push(trace) })

    runtime.enqueue(delta('full trace update'))
    await runtime.waitForDrain()

    expect(traces).toHaveLength(1)
    expect(traces[0]!.kind).toBe('review')
    expect(traces[0]!.userText).toContain('full trace update')
    expect(traces[0]!.replyText).toContain('{"note":"trace note"}')
  })

  it('emits a compaction summary trace row', async () => {
    const traces: AdvisorTrace[] = []
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"one"}') },
      { chunks: textReply('Compacted summary.') },
      { chunks: textReply('{"note":"two"}') },
    ])
    const turns: AdvisorTurnRecord[] = []
    const { runtime } = makeRuntime(llm, { historyMaxTokens: 150, onTrace: (trace) => traces.push(trace), onTurn: (record) => turns.push(record) })

    runtime.enqueue(delta('first update'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('second update'))
    await runtime.waitForDrain()

    const compaction = traces.find((trace) => trace.kind === 'compaction')
    expect(compaction?.summary).toContain('Compacted summary.')
    // Expand lookups key on the SAME at as the polled turn row (start time).
    const compactionTurn = turns.find((turn) => turn.kind === 'compaction')
    expect(compaction?.id).toBe(compactionTurn?.id)
    expect(compaction?.at).toBe(compactionTurn?.at)
  })
})

describe('AdvisorRuntime — token estimate calibration (fork addition)', () => {
  it('calibrates tokensPerChar from provider usage and clamps it', async () => {
    const llm = new FakeLlm([
      {
        chunks: [
          { type: 'text-delta', index: 0, text: '{"note":"calibrated"}' },
          // Absurdly high prompt tokens for the chars sent → clamps to 1.5.
          { type: 'usage', usage: { inputTokens: 100_000, outputTokens: 5 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
      },
    ])
    const { runtime } = makeRuntime(llm)
    expect(runtime.estimatedTokensPerChar).toBe(0.25)
    runtime.enqueue(delta('calibration update'))
    await runtime.waitForDrain()
    expect(runtime.estimatedTokensPerChar).toBe(1.5)
  })
})

describe('AdvisorRuntime — evidence-based window guess (fork addition)', () => {
  it('caps the guess from a trigger-sized failure without over-shrinking', async () => {
    const llm = new FakeLlm([
      { throw: new Error('maximum context length exceeded') },
      { chunks: textReply('Compact summary.') },
      { chunks: textReply('{"note":"after huge"}') },
    ])
    const { runtime } = makeRuntime(llm)
    // ~320k chars → ~80k estimated tokens; 80% is ~64k, equal to the guess.
    runtime.enqueue(delta('x'.repeat(320_000)))
    await runtime.waitForDrain()
    expect(runtime.assumedContextTokens).toBe(64_000)
  })

  it('shrinks the guess to the observed size for a small failing request', async () => {
    const llm = new FakeLlm([
      { throw: new Error('maximum context length exceeded') },
      { chunks: textReply('Compact summary.') },
      { chunks: textReply('{"note":"after small"}') },
    ])
    const { runtime } = makeRuntime(llm)
    runtime.enqueue(delta('y'.repeat(2_000)))
    await runtime.waitForDrain()
    // ~560 estimated tokens × 0.8 ≈ 450 → floor of 4k.
    expect(runtime.assumedContextTokens).toBe(4_096)
  })
})
