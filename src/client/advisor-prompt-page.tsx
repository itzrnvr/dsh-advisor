/**
 * Advisor settings page (fork addition, 2026-11-07) — the Settings-page
 * `settings.section` editor for the reviewer's system prompt, modelled on the
 * operator's Global AGENTS.md panel (same card / editor / Save-Discard-Reload
 * rhythm). The Plugins-page bundle card remains the place for the route,
 * cadence, and the rest of the config; this page is the focused prompt editor
 * users actually look for under Settings.
 *
 * Data path: the host gateway (`/api/advisor/get` + `/api/advisor/set`) — the
 * same channel the card's store uses. Two fields:
 * - `systemPrompt`  — a full override; empty means the built-in reviewer prompt;
 * - `systemPromptAppend` — text appended after the base prompt on every review.
 *
 * The append field is the cache-safe knob: it composes the prompt at runtime
 * construction, so it never rewrites an existing session's history. A saved
 * override rebuilds the reviewer runtime once (system prompts are construction
 * constants); the next review uses it.
 */

import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import styles from './advisor-prompt-page.module.css'

/** The slice of the resolved advisor config this page reads/writes. */
interface AdvisorPromptConfig {
  readonly enabled?: boolean
  readonly systemPrompt?: string
  readonly systemPromptAppend?: string
}

/** One host snapshot, normalized to plain strings. */
interface PromptSnapshot {
  readonly enabled: boolean
  readonly systemPrompt: string
  readonly systemPromptAppend: string
}

/** Props the slot factory passes (the connection's generic RPC caller). */
export interface AdvisorPromptPageProps {
  readonly rpc: ClientConnectionRpc
}

function snapshotOf(config: AdvisorPromptConfig | undefined): PromptSnapshot {
  return {
    enabled: config?.enabled === true,
    systemPrompt: typeof config?.systemPrompt === 'string' ? config.systemPrompt : '',
    systemPromptAppend: typeof config?.systemPromptAppend === 'string' ? config.systemPromptAppend : '',
  }
}

async function readPrompt(rpc: ClientConnectionRpc): Promise<PromptSnapshot> {
  const result = await rpc.call('/api', 'advisor/get', { args: {} })
  if (!result.ok) throw new Error(result.error.message)
  return snapshotOf((result.value as { config?: AdvisorPromptConfig }).config)
}

/**
 * The Settings-page editor. One card, two textareas, an explicit status line,
 * and Save/Discard/Reload — the same interaction contract as the Global
 * AGENTS.md page (Ctrl/Cmd+S saves, a failed save leaves the draft intact).
 */
export function AdvisorPromptPage({ rpc }: AdvisorPromptPageProps) {
  const [snapshot, setSnapshot] = useState<PromptSnapshot | null>(null)
  const [override, setOverride] = useState('')
  const [append, setAppend] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const apply = useCallback((next: PromptSnapshot) => {
    setSnapshot(next)
    setOverride(next.systemPrompt)
    setAppend(next.systemPromptAppend)
    setError(null)
    setNotice(null)
  }, [])

  const load = useCallback(async (announce = false) => {
    setLoading(true)
    setError(null)
    try {
      const next = await readPrompt(rpc)
      apply(next)
      if (announce) setNotice('Reloaded from the host.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [apply, rpc])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = snapshot !== null
    && (override !== snapshot.systemPrompt || append !== snapshot.systemPromptAppend)

  const save = useCallback(async () => {
    if (snapshot === null || saving || !dirty) return
    const patch: Record<string, string> = {}
    if (override !== snapshot.systemPrompt) patch.systemPrompt = override
    if (append !== snapshot.systemPromptAppend) patch.systemPromptAppend = append
    if (Object.keys(patch).length === 0) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const result = await rpc.call('/api', 'advisor/set', { args: { patch } })
      if (!result.ok) throw new Error(result.error.message)
      apply(snapshotOf((result.value as { config?: AdvisorPromptConfig }).config))
      setNotice('Saved. The next review uses the new prompt.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [append, apply, dirty, override, rpc, saving, snapshot])

  const discard = useCallback(() => {
    if (snapshot === null) return
    setOverride(snapshot.systemPrompt)
    setAppend(snapshot.systemPromptAppend)
    setError(null)
    setNotice(null)
  }, [snapshot])

  const useBuiltIn = useCallback(() => {
    setOverride('')
    setNotice('Override cleared in the draft — Save to switch back to the built-in prompt.')
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }, [save])

  if (loading && snapshot === null) {
    return (
      <div className={styles.root}>
        <div className={styles.skeleton}>Loading the advisor prompt…</div>
      </div>
    )
  }

  if (snapshot === null) {
    return (
      <div className={styles.root}>
        <p className={styles.lead}>
          The advisor prompt editor could not reach the host gateway.
        </p>
        {error === null ? null : <div className={styles.bannerError}>{error}</div>}
        <button type="button" className={styles.button} onClick={() => void load()}>Retry</button>
      </div>
    )
  }

  const status = dirty ? 'Unsaved changes' : 'In sync'
  const badge = override.trim() === '' ? 'built-in prompt' : 'custom prompt'

  return (
    <div className={styles.root}>
      <p className={styles.lead}>
        The reviewer attached to every session. The override replaces the built-in reviewer
        prompt; the append is added after it on every review. Both are profile-wide — each
        session still owns its on/off switch and model pin.
      </p>
      <div className={styles.card}>
        <div className={styles.head}>
          <div className={styles.headMain}>
            <div className={styles.title}>Advisor system prompt</div>
            <div className={styles.subtitle}>
              Applies to this profile; the next review picks up a saved change.
            </div>
          </div>
          <span className={styles.badge}>{badge}</span>
          <span className={styles.badge}>{snapshot.enabled ? 'enabled' : 'disabled'}</span>
        </div>

        {error === null ? null : <div className={styles.bannerError}>{error}</div>}
        {notice === null ? null : <div className={styles.bannerInfo}>{notice}</div>}

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <label className={styles.label} htmlFor="advisor-prompt-override">System prompt override</label>
            <button type="button" className={styles.link} onClick={useBuiltIn} disabled={saving}>
              Use built-in prompt
            </button>
          </div>
          <textarea
            id="advisor-prompt-override"
            className={styles.editor}
            value={override}
            spellCheck={false}
            disabled={saving}
            onChange={(event) => { setOverride(event.target.value) }}
            onKeyDown={onKeyDown}
            aria-label="Advisor system prompt override"
            placeholder="Leave empty to use the built-in reviewer prompt."
          />
          <p className={styles.hint}>
            A full replacement for the built-in reviewer prompt. Leave empty to inherit it.
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="advisor-prompt-append">Append to system prompt</label>
          <textarea
            id="advisor-prompt-append"
            className={styles.editor}
            value={append}
            spellCheck={false}
            disabled={saving}
            onChange={(event) => { setAppend(event.target.value) }}
            onKeyDown={onKeyDown}
            aria-label="Advisor system prompt append"
            placeholder="Extra reviewer rules added after the base prompt, e.g. do not overshoot; do not ask the agent to do more than the user asked."
          />
          <p className={styles.hint}>
            Added after the prompt on every review. This is the cache-safe place for
            standing rules — earlier reviewer turns are never rewritten.
          </p>
        </div>

        <div className={styles.foot}>
          <div className={styles.meta}>
            <div><strong>{status}</strong> · {override.length} override chars · {append.length} append chars</div>
            <div>{snapshot.enabled ? 'The reviewer is enabled for new sessions.' : 'The reviewer is currently disabled; the prompt is stored for when it is enabled.'}</div>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              disabled={saving || !dirty}
              onClick={discard}
            >
              Discard
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={saving}
              onClick={() => void load(true)}
            >
              Reload
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
      <p className={styles.note}>
        Saving the override rebuilds the reviewer runtime once; the append is composed at
        construction too. Neither rewrites the primary session's history, so provider
        KV-cache prefixes stay reusable.
      </p>
    </div>
  )
}