/**
 * Per-session advisor runtime (spec §2 S2, §4 mapping rows, §6, §8.2 KD-2,
 * §8.5 KD-5) — the "advisor model call + note extraction + drain/backlog"
 * core.
 *
 * One {@link AdvisorRuntime} exists per session (created on `agent/created` or
 * lazily on the first stepped `turn/end`, disposed on `agent/disposed` /
 * `session/disposed` — wired in `index.ts`). It owns:
 *
 * - a FIFO queue of pending transcript deltas (bounded — spec §6 "bounded
 *   backlog"; drop-newest when full);
 * - a serialized async drain loop: one `llm.stream` call per delta with
 *   `{ provider, model, sessionId, system, messages: [...history, newTurn] }`
 *   and `purpose` left UNSET (KD-5 — an advisor call is an ordinary
 *   conversation request, so it carries the owning conversation's id). The
 *   history is append-only: each completed exchange pushes the exact user
 *   turn and the exact assistant reply, so every request is a strict
 *   byte-prefix extension of the previous one and the provider's prompt cache
 *   can reuse it (fork addition; bounded by {@link ADVISOR_HISTORY_MAX_CHARS},
 *   reset wholesale on overflow — never trimmed). NO
 *   `maxTokens` is sent (2026-10-18 user ruling, superseding the KD-I1
 *   budget: on OpenAI-compatible APIs `max_tokens` caps reasoning + content
 *   together, so with thinking models the budget intermittently starved the
 *   final content — the adapter/model default applies instead, and the only
 *   output bound is the extraction-side cap {@link ADVISOR_NOTE_MAX_CHARS});
 * - a call-level deadline on every `llm.stream` call (dsh-timeout `deadline`,
 *   fused with the dispose signal and raced per chunk): a hung provider stream
 *   times out instead of wedging the drain, and a timeout is a transient
 *   failure (KD-5 retry → drop);
 * - KD-2 JSON-frame extraction: the first balanced `{…}` in the reply is
 *   parsed (tolerant of prose/fences), `note` must be non-empty (else
 *   drop+log), `severity` missing/invalid defaults to `nit`, no parse retry;
 *   the KD-I2 prose fallback (issue #102, opt-in — see
 *   {@link extractProseFallbackNote}) lets a reply that yields no valid
 *   frame note through as a nit note when the `proseFallback` option is on —
 *   no parseable frame at all, or frames whose note is empty/invalid; the
 *   JSON frame keeps priority (a usable frame note blocks the fallback), and
 *   the default (off) preserves the KD-2 drop semantics;
 * - KD-I3 drop visibility (issue #102): a completed call whose reply yields
 *   no note is classified — EMPTY (body empty after trim — the completed-but-
 *   no-content class, including an `EMPTY_RESPONSE` failure: the model
 *   returned a completed response with no content) vs UNPARSED (text present,
 *   no parseable frame, fallback off/rescued nothing) — counted with
 *   timestamps and warn-once hints, readable via the `emptyReplies` /
 *   `unparsedReplies` / `lastEmptyReplyAt` / `lastUnparsedReplyAt` getters
 *   (the T7 `/advisor status` surface);
 * - the KD-5 failure policy: transient → 1 retry with a short backoff → drop;
 *   3 consecutive dropped deltas → flush the pending backlog (never stall);
 *   permanent errors (`invalid_request_error`, model-not-found, "is not
 *   supported when", a listed model this build cannot serve —
 *   `MODEL_UNSUPPORTED` / `CLIENT_UPGRADE_REQUIRED`) → halt the session's
 *   advisor; quota/rate-limit → pause
 *   (`quota_exhausted`), batch retained, no auto-resume timer; the in-flight
 *   call is aborted on dispose via the `signal`. `halted` is terminal in
 *   place — the command layer rebuilds the runtime (dispose + recreate); a
 *   `quota_exhausted` runtime resumes via {@link AdvisorRuntime.resume}.
 *
 * The runtime never parks the primary loop: everything is fire-and-forget
 * async and a failing advisor can only drop its own backlog.
 *
 * @module dsh-advisor/advisor-runtime
 */

import { createAssistantMessage, createUserMessage, isQuotaExceededError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ADVISOR_TASK_REMINDER } from './prompts.js'
import { DEFAULT_HISTORY_MAX_TOKENS } from './limits.js'
import { EMPTY_RESPONSE_CODE, INVALID_CREDENTIAL_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmFailure,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { createEmissionGuard } from './emission-guard.js'
import type { EmissionGuard } from './emission-guard.js'
import type { Delta } from './transcript.js'

declare module '@deepseek-ai/dsh-llm' {
  interface GenerateOptions {
    /**
     * Internal marker (fork addition): this request is the advisor's private
     * review call, not primary-agent output. Stream-interception plugins
     * (TTSR stream rules) must skip these — the reviewer's own wording is not
     * the user's transcript and must never be rewritten or retried by a rule.
     * Model-hidden: adapters never send it to a provider.
     */
    readonly advisorInternal?: true
  }
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Severity vocabulary (spec §6) carried by every delivered advice note. */
export type AdviceSeverity = 'nit' | 'concern' | 'blocker'

/** One extracted advice note, fed to the T5 emission guard for delivery. */
export interface AdviceNote {
  readonly note: string
  readonly severity: AdviceSeverity
  /** Optional reviewer decision to wake the primary agent (fork addition). */
  readonly wake?: boolean
}

/**
 * Per-session runtime status surface for T7 `/advisor status`.
 *
 * T4 sets `running` | `quota_exhausted` | `halted`; `paused` is reserved for
 * explicit pause semantics and `disabled` for the config gate — the runtime is
 * never constructed in either state (`index.ts` returns early when the resolved
 * config is disabled).
 */
export type AdvisorRuntimeStatus = 'running' | 'paused' | 'quota_exhausted' | 'halted' | 'disabled'

/** Minimal `ctx.llm` surface the runtime drives (satisfied by `LlmRuntime`). */
export interface AdvisorLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  /**
   * Optional capability query (LlmRuntime exposes it; injected fakes may not).
   * Used to capability-gate `reasoningEffort` (qc2 W-1 / qc1 W-1 / qc3 F-3;
   * plan dsh-advisor-reasoning-effort RD-1/RD-2): the dsh LlmRuntime rejects
   * an explicit effort for any model whose adapter does not declare it, so the
   * runtime resolves the model's declared efforts (`reasoning.efforts`, least
   * → greatest) and sends the configured id only when the model declares it —
   * otherwise the smallest declared effort, or no option at all when the model
   * declares none. Absent method → the option is omitted and `resolveCallFor`
   * materializes the adapter default.
   */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

/** Logger seam (cordis `ctx.logger('advisor')` satisfies it; console works too). */
export interface AdvisorRuntimeLogger {
  debug(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Options for one per-session {@link AdvisorRuntime}. */
export interface AdvisorRuntimeOptions {
  /** Resolved provider route (the explicit gate guarantees it when enabled). */
  readonly provider: string
  /** Resolved model id (the explicit gate guarantees it when enabled). */
  readonly model: string
  /**
   * Owning conversation's session id. Every advisor request carries it so
   * provider-level routing headers keyed on the conversation are emitted
   * (OpenCode / OpenCode Go reject requests without `x-opencode-session`).
   * Required: a runtime always reviews one conversation, and the only
   * construction site is the per-session `ensureRuntime` in `index.ts`.
   */
  readonly sessionId: SessionId
  /** System prompt sent with every advisor call (config override or KD-2 default). */
  readonly systemPrompt: string
  /** Backoff for the single transient retry (KD-5); default 1000ms. */
  readonly retryBackoffMs?: number
  /**
   * Call-level deadline for one `llm.stream` call (qc2 W-4 / qc3 W-1): a hung
   * provider stream (no chunk, no end, no error) times out instead of wedging
   * this session's drain. A timeout is classified as a transient failure —
   * KD-5 retry(1) → drop. Default 60000ms.
   */
  readonly callTimeoutMs?: number
  /** Bounded backlog (spec §6); default 32 — drop-newest with a log when full. */
  readonly maxQueued?: number
  /**
   * Opt-in prose fallback (KD-I2, issue #102): when true, a completed call
   * whose reply has text but yields NO valid note from its JSON frames — no
   * parseable frame at all, or frames whose note is empty/invalid — delivers
   * the cleaned prose body ({@link extractProseFallbackNote}: trim → strip a
   * surrounding fence → cap) as a `nit` note through the normal
   * guard/delivery pipeline. Default false — the KD-2 drop semantics stay
   * byte-identical.
   */
  readonly proseFallback?: boolean
  /**
   * Configured reasoning effort (plan dsh-advisor-reasoning-effort RD-1/RD-2,
   * config key `reasoningEffort` threaded through by `index.ts`): a
   * model-declared effort id. Absent/empty = AUTOMATIC — the runtime sends the
   * smallest effort the resolved model declares. A value the model does not
   * declare falls back to that smallest effort with one `warn` per runtime;
   * an undeclared effort is never sent. No reasoning metadata → the option is
   * omitted entirely.
   */
  readonly reasoningEffort?: string
  /**
   * Append-only reviewer-history budget in estimated tokens (fork addition,
   * config key `historyMaxTokens`; default 1,000,000). When the next exchange
   * would cross it the whole conversation is reset — never trimmed, because a
   * trim rewrites the cached prefix at the cut. 0 disables history entirely.
   */
  readonly historyMaxTokens?: number
  /** The llm service (`ctx.llm`); injectable for tests. */
  readonly llm: AdvisorLlm
  /**
   * The T5 emission guard gating extracted notes before delivery. Defaults to
   * a fresh {@link createEmissionGuard} (per-runtime lifetime — a new guard
   * per session); injectable for tests.
   */
  readonly guard?: EmissionGuard
  /**
   * Invoked once per extracted note that passes the T5 emission guard
   * (accepted = delivered to T6; suppressed notes are dropped silently).
   */
  readonly onNote: (note: AdviceNote) => void
  /**
   * Optional per-attempt trajectory sink (fork addition). Called once for
   * every completed model attempt — notes, silent reviews, failures and
   * aborts — for the Advisor tab and the cache-hit readout. Never throws into
   * the drain (contained by the runtime).
   */
  readonly onTurn?: (record: AdvisorTurnRecord) => void
  readonly logger?: AdvisorRuntimeLogger
}

/**
 * One extracted note's length cap (qc3 F-2 / qc2 S-1): a verbose/rogue advisor
 * reply must not inject an unbounded user-role message into the primary
 * session. Truncated with a '…' marker. The KD-I2 prose fallback note is
 * capped by the same bound.
 *
 * Supersession note (2026-10-18 user ruling, retiring the KD-I1/KD-6/KD-2
 * budget chain): the model-side token budget (`maxTokens`, the former
 * `ADVISOR_MAX_TOKENS` = 768) is REMOVED entirely — on OpenAI-compatible
 * APIs `max_tokens` caps reasoning + content together, so with thinking
 * models the budget intermittently starved the final content (empty reply →
 * EMPTY_RESPONSE → misclassified transient → silent delta drops). This cap
 * at extraction is now the ONLY output bound: how much the model thinks or
 * writes is the model's business (thinking blocks are discarded); what gets
 * injected into the primary session is bounded here. Latency stays bounded
 * by the 60 s call deadline (`callTimeoutMs`).
 */
export const ADVISOR_NOTE_MAX_CHARS = 4_000

const DEFAULT_RETRY_BACKOFF_MS = 1_000
const DEFAULT_MAX_QUEUED = 32
/** Whole-call deadline for one `llm.stream` (qc2 W-4 / qc3 W-1); see `callTimeoutMs`. */
const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** Capability-owned code stamped onto the deadline's TimeoutReason. */
const ADVISOR_CALL_TIMEOUT = 'ADVISOR_CALL_TIMEOUT'
/** Transient retries after the first attempt (KD-5: retry(1) → drop). */
const MAX_TRANSIENT_ATTEMPTS = 1
/** Consecutive dropped deltas after which the pending backlog is flushed (KD-5). */
const MAX_CONSECUTIVE_DROPS = 3
/**
 * Default budget for the append-only reviewer conversation, in ESTIMATED
 * tokens (fork addition; configurable through `historyMaxTokens`). One
 * million is the "keep the session's history" default: it is far above any
 * turn count a normal session reaches, so the reset below is a safety valve
 * rather than a routine event. Crossing the budget RESETS the conversation
 * wholesale (never trims): trimming rewrites the prefix at the cut and forces
 * a full re-prefill, which is the cost the history exists to remove.
 */
const ADVISOR_HISTORY_MAX_TOKENS_DEFAULT = DEFAULT_HISTORY_MAX_TOKENS
/**
 * Non-empty assistant placeholder stored for a completed call whose reply had
 * no text (an EMPTY_RESPONSE). The turn WAS part of what the provider saw, so
 * dropping it would both desync the stored conversation and leave two
 * consecutive user messages in the next request — a shape strict
 * user/assistant-alternation providers reject as a 400.
 */
const EMPTY_REPLY_PLACEHOLDER = '(no reply)'
/**
 * Marker prepended when one reviewed delta alone exceeds the model's request
 * budget. The TAIL is kept (the newest work is what matters); the reviewer is
 * told the earlier part was cut.
 */
const DELTA_TRUNCATION_MARKER = '[earlier session update truncated to fit the model context]'
/**
 * Rough token estimate for the history budget: ~4 characters per token for
 * prose and code. Exact counts are model-specific; this number only decides
 * when the conversation starts over, so an approximation is the right trade.
 */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Provider-reported accounting for one advisor call (cache fields optional). */
export interface AdvisorTurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly totalTokens?: number
}

/**
 * One entry of the advisor's own trajectory (fork addition; served to the
 * Advisor tab by `/api/advisor/trajectory`). One record per model ATTEMPT —
 * a retry is its own entry — so the tab can show exactly what each call paid.
 */
export interface AdvisorTurnRecord {
  /** Epoch-ms when the attempt started. */
  readonly at: number
  /** Wall-clock duration of the attempt. */
  readonly durationMs: number
  /** What the attempt produced. */
  readonly outcome: 'note' | 'no-note' | 'failure' | 'aborted'
  /** Severity of an accepted note. */
  readonly severity?: AdviceNote['severity']
  /** Accepted note body (possibly capped). */
  readonly note?: string
  /** Characters of the reviewed transcript delta. */
  readonly deltaChars: number
  /** Estimated history tokens BEFORE this call (what the provider re-read). */
  readonly historyTokens: number
  /** Characters in the system prompt. */
  readonly systemChars: number
  /** Provider-reported usage; absent when the call failed before usage. */
  readonly usage?: AdvisorTurnUsage
  /** Failure detail (`code: message`) for a failed attempt. */
  readonly error?: string
}

// ---------------------------------------------------------------------------
// KD-2 — JSON-frame note extraction
// ---------------------------------------------------------------------------

/**
 * Yield every top-level balanced `{…}` region of `text`, skipping braces
 * inside string literals so a quoted `{`/`}` never corrupts the balance.
 */
function* balancedObjects(text: string): Generator<string> {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (start < 0) {
        start = index
        depth = 1
      } else {
        depth++
      }
    } else if (char === '}') {
      if (start >= 0 && --depth === 0) {
        yield text.slice(start, index + 1)
        start = -1
      }
    }
  }
}

/**
 * Extract one {@link AdviceNote} from the advisor's reply (KD-2).
 *
 * Locates the first balanced `{…}` object (tolerant of surrounding prose and
 * markdown fences), parses it, and validates: `note` must be a non-empty
 * string after trim (else drop), `severity` missing/invalid defaults to
 * `nit`. A reply with no parseable frame returns `undefined` — the caller
 * drops + logs, and there is NO retry for parse failures (the retry budget is
 * reserved for transport errors, KD-2). The note is capped at
 * {@link ADVISOR_NOTE_MAX_CHARS} with a '…' marker (qc3 F-2 — a rogue reply
 * must not translate into an unbounded injection into the primary session;
 * since the 2026-10-18 ruling this cap is the ONLY output bound). Never
 * throws.
 */
/**
 * Reject replies that continue or quote the transcript instead of reviewing
 * it (fork addition). This happens when a provider drops the system prompt
 * (unsupported `developer` role): the model keeps writing the conversation.
 * Such text must never be delivered as advice.
 */
function looksLikeTranscript(text: string): boolean {
  return /^\s*-\s*tool call:/im.test(text)
    || /\*\*(user|agent)\*\*:/i.test(text)
    || /<tool_call>/i.test(text)
    || /\[tool result\]/i.test(text)
    || /###\s*Session update/i.test(text)
}

export function extractAdviceNote(reply: string): AdviceNote | undefined {
  for (const frame of balancedObjects(reply)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      continue // not JSON — try the next balanced region
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const note = record.note
    if (typeof note !== 'string' || note.trim().length === 0) continue // KD-2: drop empty note
    const severity = record.severity
    const wake = record.wake === true ? true : record.wake === false ? false : undefined
    const trimmed = note.trim()
    if (looksLikeTranscript(trimmed)) continue // transcript echo, not advice
    return {
      note: trimmed.length > ADVISOR_NOTE_MAX_CHARS
        ? `${trimmed.slice(0, ADVISOR_NOTE_MAX_CHARS - 1)}…`
        : trimmed,
      severity: severity === 'concern' || severity === 'blocker' ? severity : 'nit',
      ...(wake === undefined ? {} : { wake }),
    }
  }
  return undefined
}

/**
 * A reply fully wrapped in ONE markdown fence: an opening fence line (with or
 * without an info string) and a closing fence at the very end. Trailing prose
 * after the closing fence means the fence is not surrounding — no match.
 */
const SURROUNDING_FENCE_PATTERN = /^```[^\n]*\n([\s\S]*?)\n?```$/

/**
 * The KD-I2 prose fallback cleanup (issue #102; opt-in — see
 * {@link AdvisorRuntimeOptions.proseFallback}). Frozen-spec supersession
 * note: the strict KD-2 JSON-frame requirement stays the DEFAULT — this
 * function is applied at the extraction call site ONLY when
 * {@link extractAdviceNote} extracted no valid note (no parseable frame, or
 * every frame's note empty/invalid) AND the flag is on, so a reply whose
 * frame yields a usable note still delivers that note.
 *
 * Cleanup: trim → strip ONE surrounding markdown fence (an unterminated or
 * non-surrounding fence is kept as-is) → cap at {@link ADVISOR_NOTE_MAX_CHARS}
 * with a '…' marker (the same injection bound as {@link extractAdviceNote} —
 * the only output bound). An empty result (whitespace-only reply, fence-only
 * reply) is NOT
 * prose: the caller classifies it as an EMPTY drop (KD-I3), never as an
 * unparsed/prose case. Severity is always `nit` — prose carries no structured
 * severity. Never throws.
 */
export function extractProseFallbackNote(reply: string): AdviceNote | undefined {
  const match = SURROUNDING_FENCE_PATTERN.exec(reply.trim())
  const text = (match?.[1] ?? reply).trim()
  if (text.length === 0) return undefined
  if (looksLikeTranscript(text)) return undefined
  return {
    note: text.length > ADVISOR_NOTE_MAX_CHARS
      ? `${text.slice(0, ADVISOR_NOTE_MAX_CHARS - 1)}…`
      : text,
    severity: 'nit',
  }
}

// ---------------------------------------------------------------------------
// KD-5 — failure classification
// ---------------------------------------------------------------------------

type FailureClass = 'transient' | 'quota' | 'permanent' | 'empty'

/**
 * omp's permanent-rejection wording (see the advisor runtime it ports): a
 * request the provider refuses outright for this advisor configuration — no
 * retry can fix it. Halting avoids re-attempting on every new delta forever.
 */
const PERMANENT_FAILURE_PATTERN = /invalid_request_error|model[_ ]not[_ ]found|is not supported when|does not exist/i

/**
 * Classify one provider failure per KD-5 (quota/rate-limit → pause, permanent
 * → halt).
 *
 * `EMPTY_RESPONSE` is the empty-reply class (2026-10-18 ruling, superseding
 * its old transient treatment): the model returned a completed response with
 * no content — retrying reproduces the same empty completion, so the caller
 * does NOT retry; it counts into the KD-I3 empty-reply counters and returns
 * the no-note outcome (visible on `/advisor status` instead of a silent
 * transient drop).
 */
function classifyFailure(failure: LlmFailure): FailureClass {
  if (failure.code === EMPTY_RESPONSE_CODE) return 'empty'
  if (
    failure.code === QUOTA_EXCEEDED_CODE
    || failure.code === 'RATE_LIMIT'
    || isQuotaExceededError(failure.message)
  ) {
    return 'quota'
  }
  // dsh model-listing refusals: the build cannot serve a listed model, decided
  // before network I/O — no retry can fix it. The account route has thrown
  // these since rc.2; rc.3's API-key route follows the official listing too,
  // which puts them on the default provider path.
  if (
    failure.code === INVALID_CREDENTIAL_CODE
    || failure.code === 'NO_ADAPTER'
    || failure.code === 'MODEL_UNSUPPORTED'
    || failure.code === 'CLIENT_UPGRADE_REQUIRED'
    || PERMANENT_FAILURE_PATTERN.test(failure.message)
  ) {
    return 'permanent'
  }
  return 'transient'
}

/** Minimal provider-neutral failure snapshot from a thrown value. */
function normalizeFailure(value: unknown): LlmFailure {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code
    return {
      message: value.message,
      code: typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN',
    }
  }
  return { message: String(value), code: 'UNKNOWN' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Race one async-iterator demand against a deadline signal: resolve with the
 * iterator's next result, or `'aborted'` when the signal aborts first. A
 * provider error rejects through the race (the caller classifies it). This is
 * what makes a hung stream (no chunk, no end, no error) terminable even when
 * the provider ignores the abort signal — the runtime never depends on the
 * provider honoring `signal` (qc2 W-4 / qc3 W-1).
 */
function raceIteratorNext<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise<IteratorResult<T> | 'aborted'>((resolve, reject) => {
    const onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => {
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
  })
}

// ---------------------------------------------------------------------------
// AdvisorRuntime
// ---------------------------------------------------------------------------

/** Outcome of processing one delta through {@link AdvisorRuntime.processDelta}. */
type ProcessResult =
  | { readonly kind: 'note' }
  | { readonly kind: 'no-note' }  // model call succeeded but the reply carried no valid note (KD-2 drop)
  | { readonly kind: 'drop' }     // transient failure exhausted the retry budget
  | { readonly kind: 'requeue' }  // quota pause — the batch is retained
  | { readonly kind: 'halt' }     // permanent error — the session's advisor stops
  | { readonly kind: 'aborted' }  // dispose aborted the in-flight call

/** Result of one {@link AdvisorRuntime.callModel} attempt. */
type CallResult =
  | { readonly kind: 'note'; readonly note: AdviceNote }
  | { readonly kind: 'no-note' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failure'; readonly failure: LlmFailure }

/** One message of the append-only reviewer conversation. */
type AdvisorHistoryMessage =
  | ReturnType<typeof createUserMessage>
  | ReturnType<typeof createAssistantMessage>

/**
 * Outcome of the one-shot model-capability lookup (fork addition):
 * `resolved` (an adapter may legitimately resolve no metadata — definitive),
 * `unavailable` (no capability API on this runtime), or `failed` (throw /
 * abort — nothing is latched, so the next call retries both the effort gate
 * and the context clamp together).
 */
type ModelInfoLookup =
  | { readonly status: 'resolved'; readonly info: LlmResolvedModelInfo | undefined }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' }

/**
 * Per-session advisor runtime: queue deltas, async drain, `llm.stream` call,
 * JSON-frame note extraction, and the KD-5 failure policy. All async work is
 * fire-and-forget — the primary loop is never parked.
 */
export class AdvisorRuntime {
  private readonly provider: string
  private readonly model: string
  /** Owning conversation's session id; see {@link AdvisorRuntimeOptions.sessionId}. */
  private readonly sessionId: SessionId
  private readonly systemPrompt: string
  private readonly proseFallback: boolean
  /** Configured effort id, normalized: `undefined` = automatic (smallest declared). */
  private readonly reasoningEffort: string | undefined
  private readonly retryBackoffMs: number
  private readonly callTimeoutMs: number
  private readonly maxQueued: number
  private readonly llm: AdvisorLlm
  private readonly guard: EmissionGuard
  private readonly onNote: (note: AdviceNote) => void
  private readonly logger: AdvisorRuntimeLogger
  private readonly controller = new AbortController()
  /**
   * Per-(provider, model) declared-efforts cache (qc2 W-1 / qc1 W-1 / qc3 F-3;
   * plan dsh-advisor-reasoning-effort): resolving the model's declared efforts
   * on EVERY advisor call would add an adapter round-trip per delta; one
   * resolution per (provider, model) per runtime suffices — the route is
   * pinned for the runtime's lifetime. The cached value is the declared
   * `reasoning.efforts` list (empty = the model declares no reasoning
   * metadata), and ONLY definitive verdicts are cached: a resolution failure
   * (throw or deadline abort) is never cached, so the next call resolves
   * afresh.
   */
  private readonly reasoningEffortCache = new Map<string, readonly LlmReasoningEffortInfo[]>()
  /** One-shot latch for the undeclared-configured-effort warn line (log-once per runtime). */
  private reasoningEffortWarned = false
  /**
   * The resolved model's declared context window (tokens), when the adapter
   * reports one. Used to clamp the reviewer-history budget and to shed history
   * BEFORE a request would exceed the window — otherwise a long session's
   * history crosses the model's real limit and every review fails, even though
   * the configured token budget (default 1M) has not been reached.
   */
  private modelContextTokens: number | undefined
  /**
   * The adapter's default per-request output cap (tokens) when it declares
   * one — the reserve subtracted from the context window before any history
   * is allowed. Absent falls back to 20% of the window.
   */
  private modelOutputReserve: number | undefined
  /** One-shot latch: the model-info lookup already ran (success or definitive absence). */
  private modelInfoResolved = false
  /** The cached model-info result (shared by the effort gate and the context clamp). */
  private modelInfo: LlmResolvedModelInfo | undefined
  /**
   * History tokens actually sent on the last attempt (post context fit), for
   * the trajectory row. `undefined` before the first call.
   */
  private lastSentHistoryTokens: number | undefined

  /**
   * Append-only reviewer conversation: the EXACT user turn sent and the exact
   * assistant reply received, in order. Every later request carries this same
   * byte sequence unchanged, so the provider's prefix-based prompt cache can
   * reuse the whole conversation instead of re-reading it — only the new turn
   * is billed at the full rate. Entries are never edited or re-rendered after
   * being appended: any change to an earlier message moves the divergence
   * point to the front and forces a full re-prefill.
   */
  private readonly history: AdvisorHistoryMessage[] = []
  /** Total characters stored in {@link history}. */
  private historyChars = 0
  /** Estimated tokens stored in {@link history} (the maintenance budget). */
  private historyTokens = 0
  /** Configured history budget in estimated tokens (default 1M). */
  private readonly historyMaxTokens: number
  /** Optional per-attempt trajectory sink (Advisor tab). */
  private readonly onTurn: ((record: AdvisorTurnRecord) => void) | undefined
  /** Usage reported by the most recent `llm.stream` attempt (cache fields included). */
  private lastUsage: TokenUsage | undefined

  private readonly queue: Delta[] = []
  private state: AdvisorRuntimeStatus = 'running'
  private draining = false
  private disposed = false
  private consecutiveDrops = 0
  private drainPromise: Promise<void> | undefined
  /** Epoch-ms of the last note accepted by the emission guard (T7 status). */
  private lastActivityAt: number | undefined
  /**
   * KD-I3 drop counters (issue #102): EMPTY vs UNPARSED no-note drops with
   * their last-occurrence timestamps — the "advisor is running but never
   * speaks" visibility surface (T2 renders them on `/advisor status`). Only
   * COMPLETED model calls are classified here; transport drops stay in the
   * KD-5 consecutive-drop path.
   */
  private emptyReplyCount = 0
  private unparsedReplyCount = 0
  private lastEmptyReplyTimestamp: number | undefined
  private lastUnparsedReplyTimestamp: number | undefined
  /** Warn-once latches, one per drop class per runtime (KD-I3). */
  private emptyReplyWarned = false
  private unparsedReplyWarned = false

  constructor(options: AdvisorRuntimeOptions) {
    this.provider = options.provider
    this.model = options.model
    this.sessionId = options.sessionId
    this.systemPrompt = options.systemPrompt
    this.proseFallback = options.proseFallback ?? false
    // Empty/whitespace = automatic, identical to an absent option: the config
    // snapshot already normalizes it, and re-checking here keeps a direct
    // construction from sending '' or warning about a blank value.
    this.reasoningEffort = options.reasoningEffort?.trim() || undefined
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED
    this.historyMaxTokens = options.historyMaxTokens ?? ADVISOR_HISTORY_MAX_TOKENS_DEFAULT
    this.onTurn = options.onTurn
    this.llm = options.llm
    this.guard = options.guard ?? createEmissionGuard()
    this.onNote = options.onNote
    this.logger = options.logger ?? console
  }

  /** Current per-session status (T7 `/advisor status` surface). */
  status(): AdvisorRuntimeStatus {
    return this.state
  }

  /**
   * Effective reviewer-history budget in estimated tokens (fork addition):
   * the configured value, clamped to the reviewer model's declared context
   * window once that is known. Exposed for the Advisor tab so an early reset
   * is legible, not mistaken for a malfunction.
   */
  get effectiveHistoryBudget(): number {
    return this.historyBudgetTokens()
  }

  /** Number of deltas waiting to be drained (bounded by `maxQueued`). */
  get pendingCount(): number {
    return this.queue.length
  }

  /**
   * T7 `/advisor status` surface — epoch-ms of the last note accepted by the
   * emission guard, or `undefined` before the first accepted note.
   */
  get lastActivity(): number | undefined {
    return this.lastActivityAt
  }

  /**
   * KD-I3 (issue #102) — replies dropped because the body was empty after
   * trim, or the call came back `EMPTY_RESPONSE` (the model returned a
   * completed response with no content — counted here since the 2026-10-18
   * ruling). Read-only status outlet, same style as
   * `pendingCount`/`lastActivity`.
   */
  get emptyReplies(): number {
    return this.emptyReplyCount
  }

  /**
   * KD-I3 (issue #102) — replies dropped because no valid note was extracted
   * (no parseable JSON frame, or frames whose note is empty/invalid) and the
   * prose fallback delivered nothing (`proseFallback` off, or on with an
   * empty cleanup result). Read-only status outlet.
   */
  get unparsedReplies(): number {
    return this.unparsedReplyCount
  }

  /** KD-I3 — epoch-ms of the last EMPTY-reply drop, `undefined` before the first. */
  get lastEmptyReplyAt(): number | undefined {
    return this.lastEmptyReplyTimestamp
  }

  /** KD-I3 — epoch-ms of the last UNPARSED-reply drop, `undefined` before the first. */
  get lastUnparsedReplyAt(): number | undefined {
    return this.lastUnparsedReplyTimestamp
  }

  /**
   * Queue one rendered transcript delta (from the T3 observer's `onDelta`).
   * While `quota_exhausted`, deltas queue up (bounded) but the drain is never
   * auto-restarted (KD-5 — no auto-resume timer); while `halted`/disposed they
   * are dropped with a log. Never throws, never parks the caller.
   */
  enqueue(delta: Delta): void {
    if (this.disposed) {
      this.logger.debug('advisor: enqueue ignored — runtime disposed')
      return
    }
    if (this.state === 'halted') {
      this.logger.debug('advisor: enqueue ignored — advisor halted')
      return
    }
    if (this.queue.length >= this.maxQueued) {
      // simplify: FIFO queue with drop-newest when full. A full queue means the
      // advisor is far behind; the newest delta is the most redundant. A
      // coalescing batch (omp-style) would be the upgrade path.
      this.logger.debug('advisor: enqueue dropped — backlog full', { maxQueued: this.maxQueued })
      return
    }
    this.queue.push(delta)
    if (this.state === 'quota_exhausted') return // paused: retain, never auto-resume
    this.kickDrain()
  }

  /** Abort the in-flight call and stop the drain (wiring: session/agent disposed). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort('advisor disposed')
    this.queue.length = 0
    this.consecutiveDrops = 0
  }

  /**
   * Manual resume after a quota pause (T7 `/advisor on`); no-op when halted/
   * disposed — a halted runtime is terminal in place and is recovered by the
   * command layer via dispose-and-recreate (qc1/qc2/qc3 W-1/I-4), never
   * resumed here.
   */
  resume(): void {
    if (this.disposed || this.state === 'halted') return
    this.state = 'running'
    this.kickDrain()
  }

  /**
   * KD-5 reset trigger: a compaction / surface rewrite clears the emission
   * guard's dedupe history and per-update latch — the session state is being
   * rewritten, so the old note history no longer applies (a note already
   * advised before the rewrite may legitimately be advised again). The wiring
   * (`index.ts` onRewrite) calls this alongside the delivery cooldown reset.
   */
  resetGuard(): void {
    this.guard.reset()
  }

  /** Resolve once the current drain run settles (test/integration hook). */
  async waitForDrain(): Promise<void> {
    await this.drainPromise
  }

  private kickDrain(): void {
    if (this.draining || this.disposed) return
    if (this.state === 'quota_exhausted' || this.state === 'halted') return
    this.drainPromise = this.drain().catch((error) => {
      // Defense in depth: the drain is fire-and-forget, so a rejection here
      // would be an unhandled promise rejection (process crash under Node
      // ≥22/24 defaults). A failing advisor may only drop its own backlog —
      // per-batch errors stay contained inside callModel.
      this.logger.warn('advisor: drain loop failed — contained', { error })
    })
  }

  /** Serialized drain loop: process the queue one delta at a time. */
  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (
        !this.disposed
        && this.queue.length > 0
        && this.state !== 'quota_exhausted'
        && this.state !== 'halted'
      ) {
        const delta = this.queue.shift()!
        switch ((await this.processDelta(delta)).kind) {
          case 'note':
          case 'no-note':
            // A completed model call breaks the failure streak — extraction
            // failures (KD-2 drops) are output-quality issues, not transport
            // failures, and do not count toward the 3-drop flush.
            this.consecutiveDrops = 0
            break
          case 'drop':
            this.consecutiveDrops++
            if (this.consecutiveDrops >= MAX_CONSECUTIVE_DROPS) this.flushBacklog()
            break
          case 'requeue':
            this.queue.unshift(delta) // quota pause: batch retained for a later resume
            return
          case 'halt':
            this.flushBacklog() // halted: drop any still-pending backlog
            return
          case 'aborted':
            return
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** KD-5: clear the pending backlog after consecutive failures (never stall). */
  private flushBacklog(): void {
    this.consecutiveDrops = 0
    if (this.queue.length === 0) return
    const flushed = this.queue.length
    this.queue.length = 0
    this.logger.warn('advisor: flushed pending backlog after consecutive failures', { flushed })
  }

  /** Process one delta: attempt + single retry (transient), classify terminal failures. */
  private async processDelta(delta: Delta): Promise<ProcessResult> {
    // One advisor model cycle per delta: the emission guard's one-note-per-
    // update latch resets here, so each processed delta may deliver one note
    // again (spec §6; the reset point is the drain's per-delta boundary).
    this.guard.beginUpdate()
    let lastFailure: LlmFailure | undefined
    for (let attempt = 0; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (this.disposed) return { kind: 'aborted' }
        await sleep(this.retryBackoffMs)
        if (this.disposed) return { kind: 'aborted' }
      }
      const result = await this.callModel(delta)
      if (result.kind === 'note' || result.kind === 'no-note' || result.kind === 'aborted') return result
      switch (classifyFailure(result.failure)) {
        case 'quota':
          this.state = 'quota_exhausted'
          this.logger.warn('advisor: quota/rate-limit reached — paused, batch retained', { failure: result.failure })
          return { kind: 'requeue' }
        case 'permanent':
          this.state = 'halted'
          this.logger.warn('advisor: permanent model error — halted', { failure: result.failure })
          return { kind: 'halt' }
        case 'empty':
          // EMPTY_RESPONSE is NOT transient (2026-10-18): retrying would
          // reproduce the same empty completion. Count it into the KD-I3
          // empty-reply counters and return the no-note outcome — the drop
          // becomes visible on `/advisor status` instead of riding the
          // transient retry-and-drop path.
          this.recordEmptyReply(undefined, result.failure)
          return { kind: 'no-note' }
        case 'transient':
          // Failure visibility (2026-10-18): every failed attempt is logged
          // with the failure's code/message — warn on the first attempt,
          // debug on the retry — so the failure class is diagnosable beyond
          // the terminal drop line.
          lastFailure = result.failure
          if (attempt === 0) {
            this.logger.warn('advisor: model call failed — retrying', { code: result.failure.code, message: result.failure.message })
          } else {
            this.logger.debug('advisor: model call failed — retry exhausted', { code: result.failure.code, message: result.failure.message })
          }
          break // retry once (the loop's next iteration)
      }
    }
    this.logger.warn('advisor: dropping delta after transient failures', {
      attempts: MAX_TRANSIENT_ATTEMPTS + 1,
      ...(lastFailure === undefined ? {} : { code: lastFailure.code, message: lastFailure.message }),
    })
    return { kind: 'drop' }
  }

  /**
   * One model call with trajectory accounting: times the attempt, captures
   * the provider-reported usage, and reports one {@link AdvisorTurnRecord}
   * for the Advisor tab — notes, silent reviews, failures and aborts alike.
   * A retry is a separate call, so each entry shows exactly what that attempt
   * paid.
   */
  private async callModel(delta: Delta): Promise<CallResult> {
    const startedAt = Date.now()
    const historyTokens = this.historyTokens
    const deltaChars = delta.markdown.length
    const result = await this.callModelOnce(delta)
    const usage = this.lastUsage
    const record: AdvisorTurnRecord = {
      at: startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: result.kind,
      deltaChars,
      // Truthful post-fit value: a context shed inside the call empties the
      // history, so the pre-call count would overstate what was re-sent.
      historyTokens: this.lastSentHistoryTokens ?? historyTokens,
      systemChars: this.systemPrompt.length,
      ...(result.kind === 'note' ? { severity: result.note.severity, note: result.note.note } : {}),
      ...(result.kind === 'failure'
        ? { error: `${result.failure.code}: ${result.failure.message}` }
        : {}),
      ...(usage === undefined ? {} : {
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
          ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
          ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
          ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        },
      }),
    }
    try {
      this.onTurn?.(record)
    } catch (error) {
      // The trajectory sink is observational: it must never break the drain.
      this.logger.debug('advisor: trajectory sink threw — contained', { error })
    }
    return result
  }

  /** One model call: build options, stream text, extract the note (KD-2). */
  private async callModelOnce(delta: Delta): Promise<CallResult> {
    let text = ''
    let finish: FinishReason | undefined
    this.lastUsage = undefined
    this.lastSentHistoryTokens = undefined
    // Call-level deadline (dsh-timeout): fuses the runtime's dispose signal
    // with a whole-call timer. The fused signal is passed to the provider
    // (AbortSignal honored) AND raced per chunk below, so a hung stream cannot
    // wedge the drain even when the provider ignores the signal. A timeout is
    // a transient failure — KD-5 retry(1) → drop (qc2 W-4 / qc3 W-1).
    using deadlineHandle = deadline(this.controller.signal, this.callTimeoutMs, ADVISOR_CALL_TIMEOUT)
    const deadlineSignal = deadlineHandle.signal
    // The new turn, built ONCE: the exact same message object goes into the
    // request and into the append-only history after the call succeeds, so
    // what is stored is byte-identical to what the provider saw. Both are
    // assigned inside the try (the context fit runs after the model's window
    // resolves); appendHistory below only runs after a successful stream.
    let userText = this.userTextFor(delta)
    let userMessage: ReturnType<typeof createUserMessage> | undefined
    try {
      // Capability-gate `reasoningEffort` (qc2 W-1 / qc1 W-1 / qc3 F-3):
      // resolve the model's declared efforts ONCE per (provider, model) and
      // send the configured id when the model declares it, else the smallest
      // declared effort; never fail the call on a resolution error (the
      // option is simply omitted). The resolution is bounded by the call
      // deadline (n4 QC N-5): the fused signal is threaded through, so a hung
      // adapter capability lookup that honors cancellation aborts with the
      // call instead of wedging the drain ahead of the deadline-guarded
      // stream loop.
      const reasoningEffort = await this.resolveReasoningEffort(deadlineSignal)
      // Fork addition: fit the request inside the declared context window
      // BEFORE sending it. History is shed wholesale (never trimmed) and the
      // delta is tail-truncated only when it alone would not fit.
      this.fitHistoryToContext(userText)
      userText = this.fitDeltaToContext(userText)
      this.lastSentHistoryTokens = this.historyTokens
      userMessage = createUserMessage({
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      })
      const stream = this.llm.stream(this.buildOptions(userMessage, deadlineSignal, reasoningEffort))
      const iterator = stream[Symbol.asyncIterator]()
      for (;;) {
        const next = await raceIteratorNext(iterator, deadlineSignal)
        if (next === 'aborted') {
          // Best-effort teardown of a provider that may still be mid-flight;
          // never await a hung teardown (it may never settle).
          iterator.return?.().catch(() => {})
          if (timeoutOf(deadlineSignal, ADVISOR_CALL_TIMEOUT) !== undefined) {
            return {
              kind: 'failure',
              failure: { message: `advisor call timed out after ${this.callTimeoutMs}ms`, code: 'TIMEOUT' },
            }
          }
          return { kind: 'aborted' } // dispose aborted the in-flight call
        }
        if (next.done) break
        const chunk = next.value
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'usage') this.lastUsage = chunk.usage
        else if (chunk.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      return { kind: 'failure', failure: normalizeFailure(error) }
    }
    if (finish === undefined) {
      return { kind: 'failure', failure: { message: 'advisor stream ended without a finish chunk', code: 'UNKNOWN' } }
    }
    if (finish.kind === 'error') return { kind: 'failure', failure: finish.failure }
    if (finish.kind === 'aborted') {
      // Our own dispose aborts the in-flight call; a provider-side abort is a
      // terminal failure like any other. A deadline timeout surfaced as a
      // provider abort (rather than through the per-chunk race) is still the
      // transient timeout case — KD-5 retry once → drop.
      if (timeoutOf(deadlineSignal, ADVISOR_CALL_TIMEOUT) !== undefined) {
        return {
          kind: 'failure',
          failure: { message: `advisor call timed out after ${this.callTimeoutMs}ms`, code: 'TIMEOUT' },
        }
      }
      if (this.disposed || this.controller.signal.aborted) return { kind: 'aborted' }
      return { kind: 'failure', failure: finish.failure }
    }
    // The call completed: make the exchange part of the append-only
    // conversation BEFORE extraction. A reply the emission guard later
    // suppresses, or that yields no note, is still a turn the provider saw —
    // omitting it would desync the stored history from the model's own view
    // and change every later request's prefix.
    this.appendHistory(userText, userMessage, text)
    // stop | max-tokens | tool-calls: extract from the collected text (KD-2;
    // no retry on parse failures — the frame must simply be absent/valid).
    // KD-I3 drop classification (issue #102): an EMPTY trimmed reply is an
    // empty drop (the completed-but-no-content class; the model-side token
    // budget that used to starve it is gone — 2026-10-18 ruling); a reply
    // with text but no parseable frame
    // is an unparsed drop unless the opt-in prose fallback rescues it. Both
    // classes are counted with a timestamp and warn once per runtime, so
    // "the advisor is running but never speaks" is discoverable instead of
    // debug-only. Drops still return 'no-note': KD-2 extraction failures are
    // output-quality issues, not transport failures (no KD-5 retry, no
    // consecutive-drop counting).
    let note = extractAdviceNote(text)
    if (note === undefined) {
      if (text.trim().length === 0) {
        this.recordEmptyReply(finish)
        return { kind: 'no-note' }
      }
      // KD-I2 prose fallback (opt-in, default off): the JSON frame keeps
      // priority — only when NO frame yields a usable note (an empty- or
      // invalid-note frame included) AND the flag is on does the cleaned
      // prose body become a nit note and re-enter the normal guard/delivery
      // pipeline below. With the flag off the reply is dropped exactly as
      // before (default behavior unchanged).
      if (this.proseFallback) note = extractProseFallbackNote(text)
      if (note === undefined) {
        this.recordUnparsedReply()
        return { kind: 'no-note' }
      }
    }
    try {
      // The T5 emission guard sits between extraction and delivery: only
      // accepted notes reach the delivery callback (T6). Suppression is
      // silent — the caller cannot tell an accepted from a suppressed note,
      // and a guard failure must never crash the drain (T4 F1 containment).
      if (this.guard.accept(note)) {
        // T7: timestamp the moment a note is accepted for delivery (before
        // onNote, so a throwing delivery seam cannot lose the activity
        // record) — surfaced by `/advisor status` as "last activity".
        this.lastActivityAt = Date.now()
        this.onNote(note)
      } else {
        this.logger.debug('advisor: note suppressed by emission guard', {
          note: note.note,
          severity: note.severity,
        })
      }
    } catch (error) {
      // The emission guard / delivery seam must never crash the drain: log
      // and continue. The model call itself succeeded — this is not a
      // transport failure, so retry/drop/quota/halt semantics are untouched
      // and the note still counts as extracted.
      this.logger.warn('advisor: emission guard or delivery callback threw — contained', { error })
    }
    return { kind: 'note', note }
  }

  /**
   * KD-I3: count + timestamp an EMPTY-reply drop and warn ONCE per runtime
   * with the condition hint; repeats fall back to a debug line. Two sources
   * feed the SAME counters (2026-10-18 ruling): a completed stream whose
   * trimmed body is empty (the finish reason rides along — `max-tokens` vs
   * `stop` is the budget-vs-genuinely-empty tell), and an `EMPTY_RESPONSE`
   * failure (the model returned a completed response with no content — never
   * retried; the failure detail rides along instead of a finish reason).
   */
  private recordEmptyReply(finish?: FinishReason, failure?: LlmFailure): void {
    this.emptyReplyCount++
    this.lastEmptyReplyTimestamp = Date.now()
    const detail = {
      ...(finish === undefined ? {} : { finish: finish.kind }),
      ...(failure === undefined ? {} : { code: failure.code, message: failure.message }),
    }
    if (this.emptyReplyWarned) {
      this.logger.debug('advisor: empty reply dropped', detail)
      return
    }
    this.emptyReplyWarned = true
    this.logger.warn(
      'advisor: empty reply dropped — the model returned a completed response with no content',
      detail,
    )
  }

  /**
   * KD-I3: count + timestamp an UNPARSED-reply drop and warn ONCE per runtime
   * with the fix hint (enable the prose fallback); repeats fall back to the
   * original KD-2 debug line.
   */
  private recordUnparsedReply(): void {
    this.unparsedReplyCount++
    this.lastUnparsedReplyTimestamp = Date.now()
    if (this.unparsedReplyWarned) {
      this.logger.debug('advisor: reply yielded no note — dropped (no parseable non-empty JSON note in the reply)')
      return
    }
    this.unparsedReplyWarned = true
    this.logger.warn(
      'advisor: reply yielded no note — dropped (no parseable non-empty JSON note in the reply); consider enabling proseFallback',
    )
  }

  /** The exact user-message text for one review; stored verbatim in history. */
  private userTextFor(delta: Delta): string {
    // Task reminder AFTER the delta: the last instruction wins, and
    // "above" points at the transcript. A prefix reminder was followed
    // unreliably on code-heavy deltas (the model continued the code).
    return `${delta.markdown}\n\n---\n${ADVISOR_TASK_REMINDER}`
  }

  /**
   * Append one completed exchange to the reviewer conversation. Called for
   * EVERY successful model call — including a reply that later yields no note
   * or is suppressed by the emission guard — because the provider processed
   * that turn and the stored conversation must match what it saw.
   *
   * An empty reply (EMPTY_RESPONSE) stores a non-empty placeholder assistant
   * turn instead of nothing: dropping it would desync the stored conversation
   * AND leave two consecutive user messages, which strict
   * user/assistant-alternation providers reject as a 400.
   *
   * Budget behavior: crossing the configured token budget clears the
   * conversation and starts over. Trimming the oldest turns in place is
   * deliberately not an option: it rewrites the prefix at the cut and makes
   * the provider re-prefill everything after it, which is the cost this
   * history exists to remove. One cold call after a reset is cheaper.
   */
  private appendHistory(userText: string, userMessage: AdvisorHistoryMessage, replyText: string): void {
    const budget = this.historyBudgetTokens()
    // 0 = history disabled (either configured 0, or a context so small that
    // history cannot fit): nothing is stored, so every review starts cold.
    if (budget <= 0) {
      this.history.length = 0
      this.historyChars = 0
      this.historyTokens = 0
      return
    }
    const hasReply = replyText.trim().length > 0
    const replyBody = hasReply ? replyText : EMPTY_REPLY_PLACEHOLDER
    const sizeChars = userText.length + replyBody.length
    const sizeTokens = estimateTokens(sizeChars)
    if (this.historyTokens + sizeTokens > budget) {
      this.history.length = 0
      this.historyChars = 0
      this.historyTokens = 0
      this.logger.debug('advisor: reviewer history reset (budget)', {
        maxTokens: budget,
        configuredMaxTokens: this.historyMaxTokens,
        incomingTokens: sizeTokens,
      })
    }
    this.history.push(userMessage)
    this.history.push(createAssistantMessage({
      content: [{ type: 'text', text: replyBody }],
      source: { provider: this.provider, model: this.model },
    }))
    this.historyChars += sizeChars
    this.historyTokens += sizeTokens
  }

  /**
   * Tokens a single request may spend BEFORE the reply: the declared context
   * window minus the output reserve (the adapter's default cap, else 20% of
   * the window) minus a 5% safety margin. `undefined` when the model declares
   * no window — the configured budget is then the only bound.
   */
  private promptBudgetTokens(): number | undefined {
    const context = this.modelContextTokens
    if (context === undefined || context <= 0) return undefined
    const reserve = this.modelOutputReserve ?? Math.ceil(context * 0.2)
    return Math.max(0, context - reserve - Math.ceil(context * 0.05))
  }

  /** Effective reviewer-history budget: configured, clamped to 75% of the prompt budget. */
  private historyBudgetTokens(): number {
    if (this.historyMaxTokens <= 0) return 0
    const promptBudget = this.promptBudgetTokens()
    if (promptBudget === undefined) return this.historyMaxTokens
    return Math.min(this.historyMaxTokens, Math.floor(promptBudget * 0.75))
  }

  /**
   * Self-heal before a request (fork addition): if the system prompt + stored
   * history + this turn's delta would exceed the model's request budget, drop
   * the history NOW. Sending it would fail the call (context overflow), retry
   * once, and drop the review — whereas shedding history makes the review
   * succeed, just cold. The configured 1M-token budget alone cannot prevent
   * this: a 128k-context model overflows long before 1M.
   */
  private fitHistoryToContext(userText: string): void {
    const promptBudget = this.promptBudgetTokens()
    if (promptBudget === undefined || this.historyTokens === 0) return
    const estimatedPrompt = this.historyTokens + estimateTokens(this.systemPrompt.length + userText.length)
    if (estimatedPrompt <= promptBudget) return
    this.history.length = 0
    this.historyChars = 0
    this.historyTokens = 0
    this.logger.debug('advisor: reviewer history reset (model context)', {
      provider: this.provider,
      model: this.model,
      contextTokens: this.modelContextTokens,
      promptBudget,
      estimatedPrompt,
    })
  }

  /**
   * Tail-truncate one delta that alone (system prompt + delta, history already
   * shed) exceeds the request budget. The newest work is kept, and a visible
   * marker tells the reviewer the update is partial — otherwise it would
   * silently judge a tail-cut transcript as if it were the whole turn.
   */
  private fitDeltaToContext(userText: string): string {
    const promptBudget = this.promptBudgetTokens()
    if (promptBudget === undefined) return userText
    const available = promptBudget - estimateTokens(this.systemPrompt.length) - this.historyTokens
    const maxChars = Math.max(0, available * 4)
    if (userText.length <= maxChars) return userText
    const marker = `${DELTA_TRUNCATION_MARKER}\n\n`
    const keep = Math.max(0, maxChars - marker.length)
    this.logger.debug('advisor: delta truncated to fit the model context', {
      provider: this.provider,
      model: this.model,
      contextTokens: this.modelContextTokens,
      promptBudget,
      deltaChars: userText.length,
      keptChars: keep,
    })
    return `${marker}${keep === 0 ? '' : userText.slice(-keep)}`
  }

  private buildOptions(
    userMessage: ReturnType<typeof createUserMessage>,
    signal: AbortSignal,
    reasoningEffort: ReasoningEffortId | undefined,
  ): GenerateOptions {
    return {
      provider: this.provider,
      model: this.model,
      system: this.systemPrompt,
      // The conversation this review belongs to. Providers that route per
      // conversation on a request header — OpenCode Go's `x-opencode-session`
      // — refuse a request without it, so the advisor call carries the owning
      // session id.
      sessionId: this.sessionId,
      // Append-only reviewer conversation: system + history + the new turn.
      // The history is the exact sequence of earlier requests/replies, never
      // re-rendered, so each call is a strict extension of the previous
      // prefix and the provider cache can reuse it.
      messages: [...this.history, userMessage],
      // Reasoning effort (plan dsh-advisor-reasoning-effort RD-1/RD-2): the
      // advisor's job is a short structured note, so the SMALLEST thinking
      // weight the resolved model declares is the default — reasoning-heavy
      // replies starve the JSON frame (n4 root-cause: deepseek-v4-flash is a
      // reasoning model and with the default 256-token budget its reasoning
      // stream consumed everything, the text output came back EMPTY
      // (finish: max-tokens), and KD-2 dropped every reply).
      // `resolveReasoningEffort` capability-gates the value (qc2 W-1 / qc1 W-1
      // / qc3 F-3): the configured id when the model declares it, else the
      // smallest declared effort, else nothing at all — never an effort the
      // model does not declare (the dsh LlmRuntime would reject it with
      // UNSUPPORTED_REASONING_EFFORT, silently killing the advisor for
      // non-deepseek models — pre-n4 these worked because no effort was sent).
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      // NO `maxTokens` (2026-10-18 user ruling, superseding the KD-I1 chain):
      // on OpenAI-compatible APIs max_tokens caps reasoning + content
      // TOGETHER, so with thinking models a budget intermittently starved
      // the final content (empty reply → EMPTY_RESPONSE → silent drops).
      // The adapter/model default applies; the only output bound is the
      // extraction-side cap ADVISOR_NOTE_MAX_CHARS, and latency stays
      // bounded by the call deadline.
      signal,
      // Fork addition: marks this as the reviewer's private call so stream
      // rules (TTSR) never intercept, rewrite, or retry it. Declared through
      // module augmentation above; adapters never forward it on the wire.
      advisorInternal: true,
      // KD-5: `purpose` is a closed union ('compaction' | 'session-title'); an
      // advisor call is an ordinary conversation request and leaves it unset.
    }
  }

  /**
   * Resolve the model's capability metadata ONCE per runtime (fork addition):
   * reasoning efforts, declared context window, and the adapter's default
   * output cap all come from this one lookup. It is shared by the effort gate
   * and the context clamp so the clamp does not depend on the reasoning path
   * succeeding. Only a THROW is retried; a resolved-but-empty answer is
   * definitive, so a non-conforming adapter cannot make this spin forever.
   */
  private async ensureModelInfo(signal?: AbortSignal): Promise<ModelInfoLookup> {
    if (this.modelInfoResolved) return { status: 'resolved', info: this.modelInfo }
    if (this.llm.resolveModelInfo === undefined) {
      this.modelInfoResolved = true
      return { status: 'unavailable' }
    }
    try {
      const info = await this.llm.resolveModelInfo(this.provider, this.model, signal)
      this.modelInfo = info
      this.modelContextTokens = info?.context?.contextWindow
      this.modelOutputReserve = info?.defaultMaxTokens
      this.modelInfoResolved = true
      return { status: 'resolved', info }
    } catch {
      return { status: 'failed' }
    }
  }

  /**
   * Resolve the `reasoningEffort` option for this call (plan
   * dsh-advisor-reasoning-effort RD-1/RD-2; capability-gate from qc2 W-1 /
   * qc1 W-1 / qc3 F-3): the configured id when the resolved model declares it,
   * otherwise the SMALLEST declared effort (`efforts[0]` — dsh-llm orders the
   * list least → greatest), and `undefined` (the option is omitted, so
   * `resolveCallFor` materializes the adapter default) when the model declares
   * no reasoning metadata at all. An id the model does not declare is NEVER
   * sent — the dsh LlmRuntime would reject it with
   * UNSUPPORTED_REASONING_EFFORT and silently kill the advisor for that model.
   *
   * The declared efforts are cached per (provider, model) — one resolution per
   * runtime, never per call — but ONLY definitive verdicts are cached: a
   * resolution failure (unknown route, adapter throw, or a deadline abort —
   * n4 QC N-5) is advisory and returns `undefined` WITHOUT caching, so a
   * transient failure retries the resolution on the next call instead of
   * latching "no reasoning efforts" for the runtime's lifetime. The optional
   * `signal` (the call's deadline signal) is threaded into `resolveModelInfo`,
   * whose contract allows adapter-owned asynchronous lookup with cancellation
   * — a hung lookup that honors the signal aborts with the call deadline
   * instead of wedging the drain.
   *
   * A configured id the model does not declare (a leftover after switching
   * models) falls back to the smallest declared effort and is reported ONCE
   * per runtime (`reasoningEffortWarned`); a model that declares no reasoning
   * metadata at all omits the option and reports the unsent configured value
   * with a distinct message, under the same once-per-runtime latch.
   */
  private async resolveReasoningEffort(signal?: AbortSignal): Promise<ReasoningEffortId | undefined> {
    const key = `${this.provider}\u0000${this.model}`
    let efforts = this.reasoningEffortCache.get(key)
    if (efforts === undefined) {
      // One model-info lookup per runtime (fork addition): the reasoning
      // efforts AND the context window/output reserve come from the SAME
      // resolution, cached for the runtime's lifetime — never a fresh lookup
      // per review. A failed lookup is not latched (the next call retries);
      // a model that declares no reasoning metadata — or an absent capability
      // API — caches the definitive empty list.
      const lookup = await this.ensureModelInfo(signal)
      if (lookup.status === 'failed') {
        // Adapter throw or deadline abort: the call proceeds without the
        // option, and the failure is NOT cached (the next call retries).
        return undefined
      }
      efforts = lookup.status === 'resolved' ? (lookup.info?.reasoning?.efforts ?? []) : []
      this.reasoningEffortCache.set(key, efforts)
    }
    const smallest = efforts[0]
    if (smallest === undefined) {
      // A configured value that cannot be sent because the model declares no
      // reasoning metadata at all is the same invisible drift the undeclared-id
      // warn below closes — reported ONCE per runtime with a DISTINCT message
      // (there is no fallback effort to name).
      if (this.reasoningEffort !== undefined && !this.reasoningEffortWarned) {
        this.reasoningEffortWarned = true
        this.logger.warn(
          'advisor: configured reasoningEffort is not sent — the model declares no reasoning efforts',
          { provider: this.provider, model: this.model, configured: this.reasoningEffort },
        )
      }
      return undefined
    }
    const configured = this.reasoningEffort
    if (configured === undefined) return smallest.id
    const declared = efforts.find((entry) => entry.id === ReasoningEffortId(configured))
    if (declared !== undefined) return declared.id
    if (!this.reasoningEffortWarned) {
      this.reasoningEffortWarned = true
      this.logger.warn(
        'advisor: configured reasoningEffort is not declared by the model — using the smallest declared effort',
        { provider: this.provider, model: this.model, configured, fallback: smallest.id },
      )
    }
    return smallest.id
  }
}
