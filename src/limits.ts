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

/** Default step-clock cadence: review every 3 completed model steps inside a turn. */
export const DEFAULT_REVIEW_EVERY_STEPS = 3