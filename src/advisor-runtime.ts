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
 * The drain itself is async and self-bounded; since 0.6.48 the primary loop
 * may deliberately WAIT on it between steps (the pre-step review gate in
 * `index.ts` calls {@link AdvisorRuntime.waitQuiet}) — everything else stays
 * fire-and-forget, and a failing advisor can only drop its own backlog.
 *
 * @module dsh-advisor/advisor-runtime
 */

import { createAssistantMessage, createUserMessage, isQuotaExceededError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ADVISOR_TASK_REMINDER } from './prompts.js'
import { DEFAULT_HISTORY_MAX_TOKENS } from './limits.js'
import {
  ADVISOR_COMPACTION_LABEL,
  compactConversation,
  renderCompactableConversation,
} from './advisor-compact.js'
import type { CompactableMessage, CompactConversationResult } from './advisor-compact.js'
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
  /**
   * Wake decision (fork addition): `true`/undefined = at a turn boundary the
   * note starts a new agent turn; `false` = record the note without waking
   * (the primary sees it on its next run). Ignored inside a pre-step hold,
   * where the note is committed into the running step.
   */
  readonly wake?: boolean
}

/**
 * Per-session advisor runtime status surface for T7 `/advisor status`.
 *
 * T4 sets `running` | `quota_exhausted` | `halted`; `disabled` is the
 * config-gate state callers report for a runtime-less session (`index.ts`
 * returns early when the resolved config is disabled; the runtime is never
 * constructed in that state).
 */
export type AdvisorRuntimeStatus = 'running' | 'quota_exhausted' | 'halted' | 'disabled'

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
/** One entry of the FULL advisor trace (fork addition; expand-on-demand). */
export interface AdvisorTrace {
  /** Stable attempt id, matching the polled turn row. */
  readonly id: number
  readonly at: number
  readonly kind: 'review' | 'compaction'
  /** Exact user text sent (review) — the full delta, or summary + tail. */
  readonly userText?: string
  /** Raw model reply (review), before note extraction. */
  readonly replyText?: string
  /** Compaction summary (compaction rows). */
  readonly summary?: string
  readonly error?: string
}

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
  /**
   * Standing session rules (fork addition): read fresh on every review and
   * prepended to the update text as a "## Standing advisor rules" block.
   * Reading live keeps `/advisor rule` changes immediate; prepending to the
   * NEW user turn (never the system prompt or earlier history) keeps the
   * provider prefix cache intact.
   */
  readonly rules?: () => readonly string[]
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
   * Returns whether the note was actually delivered to the primary agent
   * (the delivery channel resolved) — false (or a throw, contained upstream)
   * marks the attempt as note-not-delivered on the trajectory.
   */
  readonly onNote: (note: AdviceNote, turn?: number) => boolean | void
  /**
   * Optional per-attempt trajectory sink (fork addition). Called once for
   * every completed model attempt — notes, silent reviews, failures and
   * aborts — for the Advisor tab and the cache-hit readout. Never throws into
   * the drain (contained by the runtime).
   */
  readonly onTurn?: (record: AdvisorTurnRecord) => void
  /**
   * Optional FULL-trace sink (fork addition): the complete prepared user text
   * and the raw reply, per review attempt, plus compaction summaries. The
   * host keeps these in a bounded per-session ring and serves them on demand —
   * they are deliberately NOT part of the polled turn payload.
   */
  readonly onTrace?: (trace: AdvisorTrace) => void
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
 * Marker for the compaction fold: the start of this update lives in the
 * summary above, so "truncated" would be inaccurate.
 */
const DELTA_HEAD_FOLD_MARKER = '[earlier part of this update is in the summary above]'
/**
 * Tells the SUMMARIZER that it is seeing the part the review will NOT re-send:
 * the newer part was omitted here and will be carried by the review itself.
 */
const SUMMARIZER_OMIT_MARKER = '[newer part of this update omitted here; it will be re-sent with the review]'
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
  /** Stable attempt id (fork addition) — keys the expand lookup. */
  readonly id: number
  /** Which call this row describes (fork addition); absent = review. */
  readonly kind?: 'review' | 'compaction'
  /** Bounded text of the delta actually sent (user row for the Advisor tab). */
  readonly userText?: string
  /** Severity of an accepted note. */
  readonly severity?: AdviceNote['severity']
  /** Accepted note body (possibly capped). */
  readonly note?: string
  /**
   * Whether the accepted note actually reached the primary agent (fork
   * addition). Absent on non-note outcomes; `false` marks a note the
   * emission guard suppressed, the delivery dropped, or a delivery seam
   * threw — so the Advisor tab never reads an undelivered note as delivered.
   */
  readonly delivered?: boolean
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
    const trimmed = note.trim()
    if (looksLikeTranscript(trimmed)) continue // transcript echo, not advice
    return {
      note: trimmed.length > ADVISOR_NOTE_MAX_CHARS
        ? `${trimmed.slice(0, ADVISOR_NOTE_MAX_CHARS - 1)}…`
        : trimmed,
      severity: severity === 'concern' || severity === 'blocker' ? severity : 'nit',
      // Fork addition: an explicit boolean is honored; absent/anything else
      // means the legacy default (wake at a turn boundary).
      wake: typeof record.wake === 'boolean' ? record.wake : undefined,
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
  | { readonly kind: 'note'; readonly note: AdviceNote; readonly delivered: boolean }
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
  /** Live standing-rule source (see {@link AdvisorRuntimeOptions.rules}). */
  private readonly rules: () => readonly string[]
  private readonly proseFallback: boolean
  /** Configured effort id, normalized: `undefined` = automatic (smallest declared). */
  private readonly reasoningEffort: string | undefined
  private readonly retryBackoffMs: number
  private readonly callTimeoutMs: number
  private readonly maxQueued: number
  private readonly llm: AdvisorLlm
  private readonly guard: EmissionGuard
  private readonly onNote: (note: AdviceNote, turn?: number) => boolean | void
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
   * reports one. Clamps the reviewer-history budget and sizes the
   * compaction window BEFORE a request would exceed the model's real limit —
   * otherwise a long session's history crosses the limit and every review
   * fails, even though the configured token budget (default 1M) has not
   * been reached.
   */
  private modelContextTokens: number | undefined
  /** One-shot latch: the model-info lookup already ran (success or definitive absence). */
  private modelInfoResolved = false
  /** The cached model-info result (shared by the effort gate and the context clamp). */
  private modelInfo: LlmResolvedModelInfo | undefined
  /**
   * History tokens actually sent on the last attempt (post context fit), for
   * the trajectory row. `undefined` before the first call.
   */
  private lastSentHistoryTokens: number | undefined
  /** Exact user text sent on the last attempt (bounded for the trajectory tab). */
  private lastSentUserText = ''
  /** Raw reply text of the last attempt (full trace, not the parsed note). */
  private lastFullReply = ''
  /** Monotonic attempt id, shared by the polled row and its full trace. */
  private traceSeq = 0
  /**
   * Estimated tokens per character, calibrated from provider-reported usage
   * after every call (fork addition). Starts at the 4-chars/token convention;
   * CJK/code content reports a higher ratio and the estimate follows.
   */
  private tokensPerChar = 0.25
  /** Reactive net: a provider overflow asks the next attempt to compact first. */
  private forceCompact = false
  /**
   * Conservative window guess for the reactive path when the adapter declares
   * no context: starts at 64k and halves on each consecutive overflow, so the
   * summarizer itself cannot be sized far above the real limit.
   */
  // Design fact: the evidence cap only ever shrinks this guess; it never grows
  // back within a runtime. A too-small guess costs continuity (more frequent
  // compactions), never correctness, so no growth policy is implemented.
  private compactionWindowGuess = 64_000
  /** Estimated tokens of the last request actually sent (failure evidence). */
  private lastRequestEstimateTokens = 0

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
  /** Optional full-trace sink (expand-on-demand text, not the polled payload). */
  private readonly onTrace: ((trace: AdvisorTrace) => void) | undefined
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
    this.rules = options.rules ?? (() => [])
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
    this.onTrace = options.onTrace
    this.llm = options.llm
    this.guard = options.guard ?? createEmissionGuard()
    this.onNote = options.onNote
    this.logger = options.logger ?? console
  }

  /** Current per-session status (T7 `/advisor status` surface). */
  status(): AdvisorRuntimeStatus {
    return this.state
  }

  /** Diagnostic: the assumed window when the adapter declares none. */
  get assumedContextTokens(): number {
    return this.compactionWindowGuess
  }

  /** Exposed for tests: the calibrated chars→tokens ratio. */
  get estimatedTokensPerChar(): number {
    return this.tokensPerChar
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

  /**
   * True when the runtime holds no review work: the queue is empty and no
   * drain is running. The pre-step review gate (`index.ts`) waits on this.
   */
  idle(): boolean {
    return this.queue.length === 0 && !this.draining
  }

  /**
   * Wait until this runtime is quiet — every queued review has completed and
   * its notes went through `onNote` — or until the wait is RELEASED: the bound
   * expires, `signal` aborts, the runtime is disposed, or the drain is parked
   * (quota pause / halt — a parked backlog can never deliver before the next
   * prompt, and the primary must not wait on it). The pre-step review gate
   * holds the primary loop with this call; an advisory reviewer may delay a
   * step but never wedge it, so every exit except `'quiet'` means "proceed,
   * the note did not make this step" (fail-open). Bounded polling, no waiter
   * plumbing; the default bound is one call deadline (`callTimeoutMs`).
   */
  async waitQuiet(signal?: AbortSignal, capMs?: number): Promise<'quiet' | 'released'> {
    const cap = capMs ?? this.callTimeoutMs
    const startedAt = Date.now()
    for (;;) {
      if (this.disposed || this.state !== 'running' || signal?.aborted === true) return 'released'
      if (this.idle()) return 'quiet'
      if (Date.now() - startedAt >= cap) return 'released'
      await Promise.race([
        this.drainPromise ?? Promise.resolve(),
        sleep(Math.min(100, cap)),
      ])
    }
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
    const id = ++this.traceSeq
    const record: AdvisorTurnRecord = {
      id,
      at: startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: result.kind,
      deltaChars,
      // Bounded user text for the Trajectory tab's user row. This is a PREVIEW:
      // the full delta is not retained, so expansion is not offered; a cut
      // preview is visibly marked.
      ...(this.lastSentUserText.length === 0 ? {} : {
        userText: this.lastSentUserText.length > 8_000
          ? `${this.lastSentUserText.slice(0, 8_000)}…[truncated]`
          : this.lastSentUserText,
      }),
      // Truthful post-fit value: a context shed inside the call empties the
      // history, so the pre-call count would overstate what was re-sent.
      historyTokens: this.lastSentHistoryTokens ?? historyTokens,
      systemChars: this.systemPrompt.length,
      ...(result.kind === 'note'
        ? { severity: result.note.severity, note: result.note.note, delivered: result.delivered }
        : {}),
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
    // Full trace (expand-on-demand): exact prepared text + raw reply.
    this.emitTrace({
      id,
      at: startedAt,
      kind: 'review',
      ...(this.lastSentUserText.length === 0 ? {} : { userText: this.lastSentUserText }),
      ...(this.lastFullReply.length === 0 ? {} : { replyText: this.lastFullReply }),
      ...(result.kind === 'failure' ? { error: `${result.failure.code}: ${result.failure.message}` } : {}),
    })
    return result
  }

  /** One model call: build options, stream text, extract the note (KD-2). */
  private async callModelOnce(delta: Delta): Promise<CallResult> {
    let text = ''
    let finish: FinishReason | undefined
    this.lastUsage = undefined
    this.lastSentHistoryTokens = undefined
    this.lastSentUserText = ''
    this.lastFullReply = ''
    // Preparation (capability lookup + compaction) runs under its OWN deadline,
    // fused with dispose; the review stream gets a fresh deadline afterwards, so
    // a slow summary cannot consume the review call's budget.
    let deadlineSignal: AbortSignal = this.controller.signal
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
      let reasoningEffort: ReasoningEffortId | undefined
      let preparationTimedOut = false
      {
        using preparation = deadline(this.controller.signal, this.callTimeoutMs, ADVISOR_CALL_TIMEOUT)
        reasoningEffort = await this.resolveReasoningEffort(preparation.signal)
        // Fork addition: compact-and-continue when the stored conversation plus
        // this delta would cross the trigger. The result is ONE user turn
        // (summary + newest content), preserving strict alternation.
        userText = await this.prepareUserText(userText, preparation.signal)
        preparationTimedOut = timeoutOf(preparation.signal, ADVISOR_CALL_TIMEOUT) !== undefined
      }
      if (preparationTimedOut) {
        // Classified against the PREPARATION signal: a hung lookup/compaction
        // is the same transient timeout class the review stream produces.
        return {
          kind: 'failure',
          failure: { message: `advisor preparation timed out after ${this.callTimeoutMs}ms`, code: 'TIMEOUT' },
        }
      }
      this.lastSentUserText = userText
      this.lastSentHistoryTokens = this.historyTokens
      this.lastRequestEstimateTokens = this.estimateTextTokens(this.systemPrompt)
        + this.historyTokens + this.estimateTextTokens(userText)
      // Review deadline starts HERE, after preparation.
      using reviewDeadline = deadline(this.controller.signal, this.callTimeoutMs, ADVISOR_CALL_TIMEOUT)
      deadlineSignal = reviewDeadline.signal
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
      const failure = normalizeFailure(error)
      if (this.isContextOverflow(failure.message)) this.forceCompact = true
      return { kind: 'failure', failure }
    }
    if (finish === undefined) {
      return { kind: 'failure', failure: { message: 'advisor stream ended without a finish chunk', code: 'UNKNOWN' } }
    }
    if (finish.kind === 'error') {
      if (this.isContextOverflow(finish.failure.message)) this.forceCompact = true
      return { kind: 'failure', failure: finish.failure }
    }
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
    // Calibrate the chars→tokens estimate from what the provider reported on
    // THIS request: input + cache reads + cache writes over the characters we
    // sent. Keeps CJK/code sessions from undercounting and leaning on the
    // reactive overflow net.
    const promptChars = this.systemPrompt.length + this.historyChars + userText.length
    const promptTokens = (this.lastUsage?.inputTokens ?? 0)
      + (this.lastUsage?.cacheReadTokens ?? 0)
      + (this.lastUsage?.cacheWriteTokens ?? 0)
    if (promptChars > 0 && promptTokens > 0) {
      this.tokensPerChar = Math.min(1.5, Math.max(0.2, promptTokens / promptChars))
    }
    this.lastFullReply = text
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
    let delivered = false
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
        delivered = this.onNote(note, delta.turn) === true
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
      // and the note still counts as extracted (but not delivered).
      this.logger.warn('advisor: emission guard or delivery callback threw — contained', { error })
    }
    return { kind: 'note', note, delivered }
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
    // Standing session rules ride the NEW user turn, not the system prompt and
    // not an earlier history entry: the provider prefix (system + history) is
    // untouched, so the cache still matches, and the rules are always the most
    // recent instruction before the update — the position that gets followed.
    const rules = this.rules()
    const rulesBlock = rules.length === 0
      ? ''
      : `## Standing advisor rules (this session)\n${rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}\n\n`
    // Task reminder AFTER the delta: the last instruction wins, and
    // "above" points at the transcript. A prefix reminder was followed
    // unreliably on code-heavy deltas (the model continued the code).
    return `${rulesBlock}${delta.markdown}\n\n---\n${ADVISOR_TASK_REMINDER}`
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
   * Budget behavior (fork addition): the stored conversation has no hard reset
   * here — the NEXT request compacts it (summary + continue) when it would
   * cross the configured threshold or the model's window. `historyMaxTokens: 0`
   * keeps no context at all: every review is cold.
   */
  private appendHistory(userText: string, userMessage: AdvisorHistoryMessage, replyText: string): void {
    if (this.historyMaxTokens <= 0) {
      this.resetHistory()
      return
    }
    const hasReply = replyText.trim().length > 0
    const replyBody = hasReply ? replyText : EMPTY_REPLY_PLACEHOLDER
    const sizeChars = userText.length + replyBody.length
    const sizeTokens = this.estimateTextTokens(userText) + this.estimateTextTokens(replyBody)
    this.history.push(userMessage)
    this.history.push(createAssistantMessage({
      content: [{ type: 'text', text: replyBody }],
      source: { provider: this.provider, model: this.model },
    }))
    this.historyChars += sizeChars
    this.historyTokens += sizeTokens
  }

  /**
   * Estimated tokens for one text, calibrated from the provider's reported
   * usage after each call (`tokensPerChar`), so CJK/code content does not
   * silently undercount and cross the model's window.
   */
  private estimateTextTokens(text: string): number {
    return Math.ceil(text.length * this.tokensPerChar)
  }

  /**
   * When to compact: the configured threshold, clamped to 85% of the model's
   * declared window when known. 0 = never keep context (every review cold).
   */
  private compactionTriggerTokens(): number {
    if (this.historyMaxTokens <= 0) return 0
    // Only a DECLARED window caps the configured threshold. An undeclared window
    // must not override the user's 1M setting on big models: compaction stays
    // reactive there (observed overflow), and the reactive path sizes from the
    // conservative guess.
    const byWindow = this.modelContextTokens === undefined
      ? undefined
      : Math.floor(this.modelContextTokens * 0.85)
    return byWindow === undefined ? this.historyMaxTokens : Math.min(this.historyMaxTokens, byWindow)
  }

  /** The stored conversation as compactable messages. */
  private historyConversation(): CompactableMessage[] {
    const out: CompactableMessage[] = []
    for (const message of this.history) {
      const text = (message.content as readonly { type: string; text?: string }[])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('')
      if (text.length > 0) out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', text })
    }
    return out
  }

  /** Drop the stored reviewer conversation. */
  private resetHistory(): void {
    this.history.length = 0
    this.historyChars = 0
    this.historyTokens = 0
  }

  /**
   * Make the next request fit its budget (fork addition): when the stored
   * conversation + the new delta would cross the compaction trigger, summarize
   * the old part with the SAME reviewer route and continue from
   * `summary + newest content` in a SINGLE user turn — strict
   * user/assistant alternation is preserved (the summary is not a second
   * message beside the kept turns).
   *
   * One compaction call, retried once; a failed compaction falls back to a
   * cold reset so the review still fires instead of being silently dropped.
   */
  private async prepareUserText(userText: string, signal: AbortSignal): Promise<string> {
    const force = this.forceCompact
    this.forceCompact = false
    // Uniform evidence-based cap: the failed request's own size bounds the real
    // window. Runs BEFORE the cold path, so a cold-config session converges on
    // its retry instead of re-sending the identical oversized request.
    if (force && this.modelContextTokens === undefined && this.lastRequestEstimateTokens > 0) {
      this.compactionWindowGuess = Math.max(
        4_096,
        Math.min(this.compactionWindowGuess, Math.floor(this.lastRequestEstimateTokens * 0.8)),
      )
    }
    if (this.historyMaxTokens <= 0) {
      this.resetHistory()
      // Cold-review config still has to survive one oversized delta: keep the
      // newest part, sized from the KNOWN window (tokens), not a fixed char
      // cap that a CJK ratio can blow past.
      if (!force) return userText
      // Size the trim from the KNOWN window, or the conservative halving guess
      // when the adapter declares none (a fixed 200k chars can exceed a real
      // 128k limit under a calibrated CJK ratio).
      const trimWindow = this.modelContextTokens ?? this.compactionWindowGuess
      const maxChars = Math.max(1_000, Math.floor(
        (trimWindow * 0.8 - this.estimateTextTokens(this.systemPrompt)) / this.tokensPerChar,
      ))
      return this.trimToChars(userText, maxChars)
    }
    const trigger = this.compactionTriggerTokens()
    const estimated = this.estimateTextTokens(this.systemPrompt) + this.historyTokens + this.estimateTextTokens(userText)
    if (!force && estimated <= trigger) return userText
    return await this.compactAndContinue(userText, trigger, signal)
  }

  /** Keep the newest `maxChars` of a delta, with a visible partial marker. */
  private trimToChars(userText: string, maxChars: number): string {
    if (userText.length <= maxChars) return userText
    const marker = `${DELTA_TRUNCATION_MARKER}\n\n`
    const keep = Math.max(0, maxChars - marker.length)
    return `${marker}${keep === 0 ? '' : userText.slice(-keep)}`
  }

  /** One compact-and-continue pass over the stored conversation + the delta. */
  private async compactAndContinue(userText: string, trigger: number, signal: AbortSignal): Promise<string> {
    const startedAt = Date.now()
    const window = this.modelContextTokens ?? this.compactionWindowGuess
    // Trim-first rule for the summarizer itself: its input must fit ITS window
    // with room for the summary (the same discipline as the review call).
    const inputCharsMax = Math.max(1_000, Math.floor((window * 0.6) / this.tokensPerChar))
    const historyText = renderCompactableConversation(this.historyConversation())
    // The review re-sends the delta's TAIL and the fold marker says the head is
    // in the summary — so the summarizer must see the HEAD (the part the review
    // will not carry). If the delta alone exceeds the cap, summarize its head
    // and drop the rest from the summarizer input with a visible marker; the
    // remaining cap, if any, is filled with the NEWEST history.
    const deltaHead = userText.length <= inputCharsMax
      ? userText
      : `${userText.slice(0, Math.max(0, inputCharsMax - SUMMARIZER_OMIT_MARKER.length - 4))}\n\n${SUMMARIZER_OMIT_MARKER}`
    const historyRoom = Math.max(0, inputCharsMax - deltaHead.length)
    const historyPart = historyRoom === 0
      ? ''
      : historyText.length <= historyRoom
        ? historyText
        : historyText.slice(-historyRoom)
    const input = historyPart.length > 0 ? `${historyPart}\n\n${deltaHead}` : deltaHead
    const run = (): Promise<CompactConversationResult | undefined> => compactConversation({
      llm: this.llm,
      provider: this.provider,
      model: this.model,
      sessionId: this.sessionId,
      input,
      // Own budget fused with dispose (not the review's deadline): a slow
      // summary must not consume the review call's timeout.
      signal: this.controller.signal,
      timeoutMs: this.callTimeoutMs,
      logger: this.logger,
    })
    let result = await run()
    if (result === undefined) result = await run()
    const at = Date.now()
    const id = ++this.traceSeq
    // Post-compaction review budget: the configured trigger, but never more
    // than the conservative window guess when the adapter declared none.
    const reviewBudget = this.modelContextTokens === undefined
      ? Math.min(trigger, Math.floor(this.compactionWindowGuess * 0.8))
      : trigger
    if (result === undefined) {
      // Cold-reset fallback: the review must still fire.
      this.resetHistory()
      this.recordCompaction(startedAt, at, undefined, true, id)
      this.emitTrace({ id, at: startedAt, kind: 'compaction', error: 'compaction failed — reviewer conversation reset' })
      const budget = reviewBudget - this.estimateTextTokens(this.systemPrompt)
      const maxChars = Math.max(0, Math.floor(budget / this.tokensPerChar))
      const marker = `${DELTA_TRUNCATION_MARKER}\n\n`
      if (userText.length <= maxChars) return userText
      const keep = Math.max(0, maxChars - marker.length)
      return `${marker}${keep === 0 ? '' : userText.slice(-keep)}`
    }
    this.resetHistory()
    this.recordCompaction(startedAt, at, result.usage, false, id, result.summary)
    this.emitTrace({ id, at: startedAt, kind: 'compaction', summary: result.summary })
    const label = `${ADVISOR_COMPACTION_LABEL}\n${result.summary}`
    const headMarker = `${DELTA_HEAD_FOLD_MARKER}\n\n`
    // The marker itself spends budget: subtract it before sizing the tail.
    const budget = reviewBudget
      - this.estimateTextTokens(this.systemPrompt)
      - this.estimateTextTokens(label)
      - this.estimateTextTokens(headMarker)
    const maxChars = Math.max(0, Math.floor(budget / this.tokensPerChar))
    // Whole delta fits: no partial marker, nothing is missing.
    if (userText.length <= maxChars) return `${label}\n\n---\n\n${userText}`
    const keep = Math.max(0, maxChars)
    this.logger.debug('advisor: delta head folded into the compaction summary', {
      omittedChars: userText.length - keep,
    })
    // slice(-0) returns the WHOLE string — send an empty tail instead.
    return `${label}\n\n---\n\n${headMarker}${keep === 0 ? '' : userText.slice(-keep)}`
  }

  /** One Stats row for a compaction attempt (visible, never folded into a review row). */
  private emitTrace(trace: AdvisorTrace): void {
    try {
      this.onTrace?.(trace)
    } catch (error) {
      this.logger.debug('advisor: trace sink threw — contained', { error })
    }
  }

  private recordCompaction(
    startedAt: number,
    at: number,
    usage: TokenUsage | undefined,
    failed: boolean,
    id: number,
    summary?: string,
  ): void {
    const record: AdvisorTurnRecord = {
      id,
      at: startedAt,
      durationMs: Math.max(0, at - startedAt),
      outcome: failed ? 'failure' : 'note',
      kind: 'compaction',
      deltaChars: 0,
      historyTokens: 0,
      systemChars: this.systemPrompt.length,
      // The summary the compaction produced, so its row is inspectable.
      ...(summary === undefined ? {} : { note: summary.slice(0, 2_000) }),
      ...(failed ? { error: 'compaction failed — reviewer conversation reset' } : {}),
      ...(usage === undefined ? {} : {
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
          ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
          ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        },
      }),
    }
    try {
      this.onTurn?.(record)
    } catch (error) {
      this.logger.debug('advisor: trajectory sink threw on compaction — contained', { error })
    }
  }

  /** Provider overflow classification for the reactive compact-and-retry net. */
  private isContextOverflow(message: string): boolean {
    return /context length|context window|too many tokens|maximum context|reduce the length|input is too long|prompt is too long/i.test(message)
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
   * the reasoning efforts and the declared context window come from this one
   * lookup. It is shared by the effort gate and the context clamp so the
   * clamp does not depend on the reasoning path succeeding. Only a THROW is
   * retried; a resolved-but-empty answer is definitive, so a non-conforming
   * adapter cannot make this spin forever.
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
