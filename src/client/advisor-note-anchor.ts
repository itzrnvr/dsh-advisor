/**
 * Pure placement math for the advisor note chat row (fork addition) — kept in
 * its own module so it can be unit-tested without pulling the component's CSS
 * import or the client React runtime.
 */

/**
 * The render position for one note: place it at the end of the turn it
 * reviewed. The inbox (`agent.inject` / `agent.steer`) is drained at the next
 * turn's first pre-step, so the note's event seq is after that turn's new
 * user message; a hair before the turn/start puts it back at the previous
 * turn's end. Mid-turn notes (a non-first step) keep their real position.
 * @param eventSeq - the note event's own sequence number.
 * @param location - the conversation location resolved for that event.
 * @returns the sortable anchor sequence.
 */
export function reviewedAnchor(eventSeq: number, location: unknown): number {
  const loc = location as {
    step?: { step?: number }
    turn?: { start?: { seq?: number } }
  } | undefined
  const turnStart = loc?.turn?.start?.seq
  if (loc?.step?.step !== 1 || typeof turnStart !== 'number' || turnStart <= 0) return eventSeq
  return turnStart - 0.01
}