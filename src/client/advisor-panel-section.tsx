/**
 * Session Panel section (fork addition, 2026-11-07) — the advisor's four
 * prompt surfaces contributed to the operator's Session Panel
 * (`@local/dsh-session-inspector`, slot `dsh.sessionInspector.panel`).
 *
 * The panel is a root-scoped list slot whose owner passes
 * `{ useSelection, select, useSessionId, getSessionId }`. This section:
 * - hides itself while another section is selected (the panel renders EVERY
 *   registration, so a section must gate its own visibility);
 * - binds the `AdvisorSessionPromptController` to the session the panel is
 *   currently acting on, refetching when that session changes;
 * - renders {@link AdvisorPromptEditor} — system-wide append, workspace
 *   prompt, session instructions, and the editable rule list.
 *
 * It is the ONLY editor for these surfaces: the advisor's own header action
 * stays the model-pin control. Every write is read back from the host by the
 * controller, so the panel never shows a merge the reviewer will not see.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { AdvisorPromptEditor } from './advisor-prompt-editor.tsx'
import { AdvisorSessionPromptController } from './advisor-prompt-store.ts'
import type { AdvisorPromptMenuState } from './advisor-prompt-store.ts'
import { en, type AdvisorKey } from './locales.ts'
import styles from './advisor-session.module.css'

/** The section's own id (matches the registration key and the nav row). */
export const ADVISOR_PANEL_SECTION_ID = 'advisor'

/** Owner props the Session Panel passes to every section. */
export interface AdvisorPanelSectionInjected {
  /** Current selection (null = no selection; every section is visible). */
  readonly useSelection?: () => string | null
  /** Select another section by id. */
  readonly select?: (id: string) => void
  /** The session the panel is acting on (hook; undefined when none). */
  readonly useSessionId?: () => string | undefined
  /** Synchronous read of the same session id. */
  readonly getSessionId?: () => string | undefined
}

/** Props this component additionally carries (locale seat + the RPC seam). */
export interface AdvisorPanelSectionProps extends AdvisorPanelSectionInjected {
  readonly rpc: ClientConnectionRpc
  readonly t?: (key: AdvisorKey, params?: Record<string, string | number>) => string
}

/** Selector-hook stand-in over the controller's snapshot source. */
function useControllerSnapshot(
  store: { getSnapshot(): AdvisorPromptMenuState; subscribe(fn: () => void): () => void },
): AdvisorPromptMenuState {
  const [state, setState] = useState<AdvisorPromptMenuState>(() => store.getSnapshot())
  useEffect(() => {
    setState(store.getSnapshot())
    return store.subscribe(() => { setState(store.getSnapshot()) })
  }, [store])
  return state
}

/**
 * The Session Panel's advisor section. Renders only while it is the selected
 * section, and only when the panel is bound to a live session.
 */
export function AdvisorPanelSection(props: AdvisorPanelSectionProps): ReactNode {
  const { rpc, useSelection, useSessionId, getSessionId } = props
  const t = props.t ?? ((key: AdvisorKey) => en[key] ?? key)

  // The panel renders every registration; visibility is the section's job.
  const selected = useSelection?.() ?? null
  const sessionId = useSessionId?.() ?? getSessionId?.()

  // One controller per session binding — a late response for a previous
  // session can never mutate the state of the current one.
  const controller = useMemo(
    () => (sessionId === undefined ? undefined : new AdvisorSessionPromptController(sessionId, rpc)),
    [sessionId, rpc],
  )
  const state = useControllerSnapshot(controller?.store ?? EMPTY_STORE)

  // Fetch on bind: the first render of a session's section, and every switch.
  useEffect(() => {
    if (controller === undefined) return
    void controller.refresh()
  }, [controller])

  if (selected !== null && selected !== ADVISOR_PANEL_SECTION_ID) return null

  if (sessionId === undefined) {
    return <p className={styles.mutedLine} role="status">{t('panelNoSession')}</p>
  }

  return (
    <div className={styles.panelSection}>
      <p className={styles.panelHeading}>{t('sessionTabPrompts')}</p>
      <p className={styles.mutedLine}>{t('panelSectionHint')}</p>
      <AdvisorPromptEditor controller={controller!} state={state} t={t} />
    </div>
  )
}

/** The pre-fetch snapshot (the editor renders its loading line from it). */
const EMPTY_STATE: AdvisorPromptMenuState = {
  phase: 'idle',
  state: null,
  error: null,
  pending: false,
  unavailable: false,
}

/** Stable empty source so an unbound section never re-subscribes per render. */
const EMPTY_STORE = {
  getSnapshot: (): AdvisorPromptMenuState => EMPTY_STATE,
  subscribe: (): (() => void) => () => {},
}