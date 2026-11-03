/**
 * Advisor conversation compaction (fork addition).
 *
 * The reviewer is a long-lived session of its own: it keeps the deltas it has
 * already reviewed plus its own notes, so every review is an append-only
 * extension. When that conversation no longer fits the reviewer model (or the
 * configured compaction threshold), the OLD PART is summarized and the
 * conversation continues from `summary + newest content` — the same
 * compact-and-continue policy the main session uses.
 *
 * The summarizer is the same reviewer route (no second model configuration)
 * and one ordinary model call with `advisorInternal` set, so stream rules
 * never touch it.
 *
 * Failure discipline mirrors `AdvisorRuntime.callModelOnce`: a whole-call
 * deadline, a per-chunk race so a provider that ignores the abort signal
 * cannot wedge the drain, and `aborted` treated as failure (never as a
 * partial summary).
 *
 * @module dsh-advisor/advisor-compact
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

/** Capability-owned code stamped onto the compaction deadline's TimeoutReason. */
export const ADVISOR_COMPACT_TIMEOUT = 'ADVISOR_COMPACT_TIMEOUT'

/** Whole-call deadline for one compaction call (mirrors the review default). */
export const DEFAULT_COMPACT_TIMEOUT_MS = 60_000

/** Label the reviewer sees in front of a compaction summary. */
export const ADVISOR_COMPACTION_LABEL = '[Compacted earlier reviewer conversation]'

/** System prompt for the summarizer call. */
export const ADVISOR_COMPACT_SYSTEM_PROMPT = [
  'You compress a code reviewer\'s own conversation so it can continue in a smaller context.',
  'Preserve, in compact prose: what the agent was doing, the advice already given (severity and substance), unresolved issues, and any user preferences or constraints that still apply.',
  'Drop repeated or superseded advice, tool chatter, and verbatim transcript text.',
  'Write a single self-contained summary. No preamble, no headings, no JSON.',
].join(' ')

/** One message of the conversation being compacted. */
export interface CompactableMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Render a conversation as summarizer input. */
export function renderCompactableConversation(messages: readonly CompactableMessage[]): string {
  return messages
    .map((message) => `${message.role === 'user' ? 'REVIEW UPDATE' : 'REVIEWER NOTE'}:\n${message.text}`)
    .join('\n\n')
}

/** Minimal llm seam the summarizer needs (satisfied by `ctx.llm`). */
export interface CompactorLlm {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: readonly unknown[]
    sessionId?: SessionId
    signal?: AbortSignal
    advisorInternal?: true
  }): AsyncIterable<StreamChunk>
}

export interface CompactConversationInput {
  readonly llm: CompactorLlm
  readonly provider: string
  readonly model: string
  readonly sessionId: SessionId
  readonly input: string
  /** Aborting signal from the runtime (dispose); fused with the deadline. */
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly logger?: { debug(message: string, detail?: unknown): void }
}

/** One summarizer result: the text plus the provider's token accounting. */
export interface CompactConversationResult {
  readonly summary: string
  readonly usage?: TokenUsage
}

/**
 * Race one iterator step against the fused signal, so a hung provider stream
 * is abandoned at the deadline instead of wedging the caller.
 */
async function raceNext<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | 'aborted'> {
  if (signal.aborted) return 'aborted'
  return await new Promise<IteratorResult<T> | 'aborted'>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    iterator.next().then(
      (result) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Summarize one already-trimmed slice of the reviewer conversation.
 *
 * The caller owns sizing: it must pass input that fits the summarizer's own
 * context (trim-first rule), because this function does not know the window.
 *
 * @returns the summary text plus usage, or `undefined` when the call failed,
 *   timed out, was aborted, or produced no text — the caller's fallback is a
 *   cold reset, never a silently dropped review.
 */
export async function compactConversation(
  options: CompactConversationInput,
): Promise<CompactConversationResult | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS
  using deadlineHandle = deadline(options.signal ?? new AbortController().signal, timeoutMs, ADVISOR_COMPACT_TIMEOUT)
  const signal = deadlineSignalOf(deadlineHandle)
  let text = ''
  let usage: TokenUsage | undefined
  let failed = false
  try {
    const stream = options.llm.stream({
      provider: options.provider,
      model: options.model,
      system: ADVISOR_COMPACT_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Conversation to compact:\n\n${options.input}` }],
        source: { kind: 'user' },
      }],
      sessionId: options.sessionId,
      signal,
      advisorInternal: true,
    })
    const iterator = stream[Symbol.asyncIterator]()
    for (;;) {
      const next = await raceNext(iterator, signal)
      if (next === 'aborted') {
        iterator.return?.().catch(() => {})
        failed = true
        break
      }
      if (next.done) break
      const chunk = next.value
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        failed = true
        break
      }
    }
  } catch {
    failed = true
  }
  const summary = text.trim()
  if (failed || summary.length === 0) {
    options.logger?.debug('advisor: compaction produced no summary', {
      failed,
      chars: summary.length,
      timedOut: timeoutOf(signal, ADVISOR_COMPACT_TIMEOUT) !== undefined,
    })
    return undefined
  }
  return { summary, ...(usage === undefined ? {} : { usage }) }
}

/** The deadline handle's fused signal (kept separate so `using` scopes cleanly). */
function deadlineSignalOf(handle: { readonly signal: AbortSignal }): AbortSignal {
  return handle.signal
}