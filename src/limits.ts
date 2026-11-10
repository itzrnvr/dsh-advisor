/**
 * Shared numeric limits (fork additions) used by both halves of the bundle.
 *
 * The reviewer-history budget appears in the config schema default, the
 * resolver arms, the gateway fallback, the runtime default, and the client
 * store's initial snapshot. One constant keeps those from drifting — the
 * client must not import `config.ts` (it would drag schemastery into the
 * browser bundle), so this module stays dependency-free.
 *
 * @module dsh-advisor/limits
 */

/**
 * Default append-only reviewer-history budget in ESTIMATED tokens (~4 chars
 * per token). It is an upper bound, not a target: the runtime clamps the
 * effective budget to the reviewer model's declared context window (75% of
 * the request budget after the output reserve), so a 128k model resets far
 * below this number.
 */
export const DEFAULT_HISTORY_MAX_TOKENS = 1_000_000

/** Default turn-clock cadence: review every completed turn. */
export const DEFAULT_REVIEW_EVERY_TURNS = 1

/**
 * Default step-clock cadence: review every 5 completed model steps inside a
 * turn (the 4–6 band the operator asked for: frequent enough to correct
 * mid-task, sparse enough that reviews never outpace real work).
 */
export const DEFAULT_REVIEW_EVERY_STEPS = 5

/**
 * Default prompt-cache warm window in seconds (0 = off).
 *
 * Reviews are step-gated: the gate runs inside `agent/pre-step`, so a long tool
 * execution emits no review at all. A provider prefix cache expires on its own
 * TTL (300 s on DashScope), and the next review then re-writes the whole
 * history instead of reading it. 240 s stays inside a 300 s TTL with margin.
 */
export const DEFAULT_CACHE_WARM_SECONDS = 240