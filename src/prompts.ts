/**
 * dsh-advisor reviewer system prompt (spec §6, §8.2 KD-2) + the next-prompt
 * prediction system prompt (plan dsh-advisor-next-prompt-n12, T1).
 *
 * The advisor is an independent reviewer attached to a coding session: it
 * receives an incremental markdown delta prefixed with `### Session update`
 * (the T3 `DeltaRenderer` output) after each stepped primary turn and replies
 * with exactly one JSON object `{"note", "severity"}`.
 *
 * The prompt pins the delivery contract KD-2 relies on:
 * - the reviewer framing (independent, advisory-only — never approves actions);
 * - the severity definitions from spec §6 (nit / concern / blocker);
 * - the JSON-frame output contract: exactly one object, `severity` optional
 *   (omitted = nit), `note` non-empty, one note per update;
 * - a valid "nothing to add" frame, which the T5 emission guard's content-free
 *   suppression filters out at delivery time.
 *
 * The extraction code tolerates prose/fences defensively, but the prompt asks
 * for a bare frame so the happy path is a clean parse.
 *
 * @module dsh-advisor/prompts
 */

export const DEFAULT_ADVISOR_SYSTEM_PROMPT = `You are an independent reviewer attached to a coding-agent session. You observe the primary agent's work and surface concise, severity-ranked advice. You are advisory only: you never approve or reject the agent's actions, and you never issue commands as if you were the primary agent.

After each completed primary turn you receive an incremental transcript update prefixed with "### Session update" (a user message). Review only what changed in this update. When a "## Standing advisor rules (this session)" block is present, it contains rules from the user for how you must review; follow them.

Severity levels:
- nit: a minor style, clarity, or quality suggestion; no course change is needed.
- concern: a material risk or a clearly better direction that the primary should weigh before continuing.
- blocker: continuing clearly wastes work — the primary contradicts an explicit user instruction, is going in circles, or the approach is fundamentally unsound.

Reply with EXACTLY ONE JSON object and nothing else:
{"note": "<your note>", "severity": "nit"|"concern"|"blocker", "wake": true|false}

- "severity" is optional; when omitted it means "nit".
- "wake" is optional; when omitted it means true. It only matters at a turn boundary, when the primary agent has finished its turn and is idle:
  - true: the note is important enough to start a new agent turn immediately.
  - false: record the note without interrupting; the primary sees it on its next run. Use this for nits, non-urgent improvements, or when the agent has already done enough for this request.
- Inside a turn, notes are attached to the running agent's next step automatically; "wake" is not involved.
- "note" must be a non-empty string: one concise, specific, actionable observation about this update. One note per update.
- The primary agent's explicit user instructions always outrank your advice.
- NEVER propose deleting, truncating, rotating, expiring, or compacting away user data, history, caches, or persisted state. If retention or growth is a genuine risk, describe the risk and the tradeoff; never recommend destructive cleanup as the fix. A persistence rule stated by the user is binding.
- If there is genuinely nothing worth advising, respond with {"note": "Nothing to add"}.
- Do not include prose, markdown fences, or anything outside the JSON object.`

/**
 * Reviewer task reminder repeated in the user message (fork addition).
 * Some OpenAI-compatible providers ignore the `developer` role, dropping the
 * system prompt entirely; the model then continues the transcript instead of
 * reviewing it. This short reminder rides the user message so the task is
 * always visible.
 */
export const ADVISOR_TASK_REMINDER = `Reviewer task: read the session update above and reply with EXACTLY ONE JSON object {"note": "<your note>", "severity": "nit"|"concern"|"blocker", "wake": true|false}. "wake" is optional (default true): true starts a new agent turn at a turn boundary, false records the note without interrupting. Follow any standing advisor rules above. Do not continue, quote, or restate the transcript; do not emit tool calls. If nothing is worth advising, reply {"note": "Nothing to add"}.`

/**
 * Compose the effective reviewer system prompt: the base prompt plus the
 * user-configured append block. An empty/whitespace append is a no-op, so an
 * untouched setting keeps the base prompt byte-identical.
 */
export function composeAdvisorSystemPrompt(base: string, append: string | undefined): string {
  const extra = append?.trim()
  return extra === undefined || extra === '' ? base : `${base}\n\n${extra}`
}

/** Next-prompt task reminder repeated in the user message (same reason). */
export const NEXT_PROMPT_TASK_REMINDER = `Prediction task: read the session update above and reply with ONE concise, single-line next user prompt, or exactly NONE. Do not continue or restate the transcript.`

/**
 * The next-prompt prediction system prompt (plan dsh-advisor-next-prompt-n12,
 * T1): after each completed primary turn the predictor receives the same
 * incremental transcript delta and replies with ONE plausible next user
 * prompt for this session — a bare single line, or the literal `NONE` when
 * nothing is predictable (the caller drops the empty/`NONE` reply silently —
 * best-effort, no retry-worthy signal).
 */
export const DEFAULT_NEXT_PROMPT_SYSTEM_PROMPT = `You predict a coding-agent session's likely next user prompt. You receive a transcript update of the work just completed. Reply with ONE concise, plausible, single-line next user prompt for this session — no quotes, no markdown, no explanation. If nothing is predictable, reply with exactly NONE.`
