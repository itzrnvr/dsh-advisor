/**
 * Full-trace helpers (fork addition).
 *
 * The advisor's complete trace (prepared text + raw reply, or a compaction
 * summary) is retained per session in a bounded ring whose size differs from
 * the polled turn ring. Expansion therefore keys on the attempt's `at`
 * stable attempt id (NOT an array index, which would drift once either ring
 * wraps, and NOT a millisecond timestamp, which two attempts can share). This
 * module owns that lookup plus the text rendering so both are unit-testable.
 *
 * @module dsh-advisor/trace-entry
 */

import type { AdvisorTrace } from './advisor-runtime.js'

/**
 * Find one retained trace by its stable attempt id.
 * @param traces - the session's retained trace ring (oldest → newest).
 * @param id - the polled turn row's `id`.
 * @returns the matching trace, or undefined when it aged out.
 */
export function findTraceEntry(
  traces: readonly AdvisorTrace[] | undefined,
  id: number,
): AdvisorTrace | undefined {
  return traces?.find((trace) => trace.id === id)
}

/** Render one trace as the expandable full text the Advisor tab shows. */
export function renderTraceEntry(trace: AdvisorTrace): string {
  if (trace.kind === 'compaction') {
    return trace.error !== undefined
      ? `[Compaction failed]\n${trace.error}`
      : `[Compaction summary]\n${trace.summary ?? ''}`
  }
  const parts: string[] = []
  if (trace.error !== undefined) parts.push(`[Attempt failed]\n${trace.error}`)
  parts.push(`[Sent to the advisor]\n${trace.userText ?? '(not retained)'}`)
  if (trace.replyText !== undefined) parts.push(`[Raw reply]\n${trace.replyText}`)
  return parts.join('\n\n---\n\n')
}