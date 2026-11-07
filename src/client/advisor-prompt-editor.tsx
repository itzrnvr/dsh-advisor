/**
 * Session panel — prompts & rules tab (fork addition, 2026-11-07).
 *
 * Edits the three live instruction layers (profile append / workspace /
 * session) and the active-rule list. The host reads the four surfaces
 * together; every write returns the refreshed state, so this component never
 * invents a merge. Changes are read by the reviewer on its NEXT call through
 * the new user turn — no system-prompt rewrite, no KV-cache invalidation.
 *
 * The rules list is the scope-aware view of all active rules: each row shows
 * its scope badge and supports inline edit/delete; the add row picks a scope
 * (workspace is disabled when the session has no cwd).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AdvisorKey } from './locales.ts'
import type {
  AdvisorPromptMenuState,
  AdvisorPromptScope,
  AdvisorSessionPromptController,
} from './advisor-prompt-store.ts'
import styles from './advisor-session.module.css'

/** Props: the per-session controller, the current snapshot, and the locale seat. */
export interface AdvisorPromptEditorProps {
  readonly controller: AdvisorSessionPromptController
  readonly state: AdvisorPromptMenuState
  readonly t: (key: AdvisorKey) => string
}

/** Scope labels reuse the rule-scope copy. */
function scopeKey(scope: AdvisorPromptScope): AdvisorKey {
  return scope === 'system'
    ? 'promptRuleScopeSystem'
    : scope === 'workspace'
      ? 'promptRuleScopeWorkspace'
      : 'promptRuleScopeSession'
}

/** One labeled textarea + its own Save (enabled only when it differs from the host). */
function LayerEditor(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly serverValue: string
  readonly disabled: boolean
  readonly rows: number
  readonly onChange: (value: string) => void
  readonly onSave: () => void
  readonly t: (key: AdvisorKey) => string
}): ReactNode {
  const dirty = props.value !== props.serverValue
  return (
    <div className={styles.editorField}>
      <label className={styles.editorLabel} htmlFor={props.id}>{props.label}</label>
      <textarea
        id={props.id}
        className={styles.editorTextarea}
        rows={props.rows}
        value={props.value}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(event) => { props.onChange(event.target.value) }}
      />
      <div className={styles.editorFoot}>
        <span className={styles.editorHint}>{props.hint}</span>
        <button
          type="button"
          className={styles.smallButtonPrimary}
          disabled={props.disabled || !dirty}
          onClick={props.onSave}
        >
          {props.t('promptSave')}
        </button>
      </div>
    </div>
  )
}

/** The prompts & rules tab body. */
export function AdvisorPromptEditor(props: AdvisorPromptEditorProps): ReactNode {
  const { controller, state, t } = props
  const view = state.state

  const [systemWide, setSystemWide] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [session, setSession] = useState('')
  const [ruleScope, setRuleScope] = useState<AdvisorPromptScope>('session')
  const [ruleText, setRuleText] = useState('')
  const [editing, setEditing] = useState<{ scope: AdvisorPromptScope; index: number } | null>(null)
  const [editingText, setEditingText] = useState('')
  const seededRef = useRef(false)

  // Seed once when the first host snapshot arrives (the panel's open refresh).
  // A later write already matches the user's draft, so it is not re-seeded.
  useEffect(() => {
    if (view === null || seededRef.current) return
    seededRef.current = true
    setSystemWide(view.systemWide)
    setWorkspace(view.workspace)
    setSession(view.session)
  }, [view])

  if (state.unavailable) {
    return <p className={styles.notice} role="status">{t('promptUnavailable')}</p>
  }
  if (view === null) {
    return (
      <p className={styles.mutedLine} role="status">
        {state.phase === 'loading' ? t('promptLoading') : t('promptUnavailable')}
      </p>
    )
  }

  const disabled = state.pending
  const busy = state.pending

  const saveLayer = (layer: AdvisorPromptScope, text: string): void => {
    void controller.setLayer(layer, text)
  }

  const saveRule = (): void => {
    if (editing === null || editingText.trim() === '') return
    void controller.updateRule(editing.scope, editing.index, editingText.trim())
    setEditing(null)
    setEditingText('')
  }

  return (
    <div className={styles.promptEditor}>
      {state.error === null ? null : <p className={styles.error} role="status">{state.error}</p>}

      <LayerEditor
        id="advisor-layer-system"
        label={t('promptSystemWide')}
        hint={t('promptSystemWideHint')}
        value={systemWide}
        serverValue={view.systemWide}
        disabled={disabled}
        rows={3}
        onChange={setSystemWide}
        onSave={() => { saveLayer('system', systemWide) }}
        t={t}
      />
      <LayerEditor
        id="advisor-layer-workspace"
        label={t('promptWorkspace')}
        hint={view.workspaceKnown ? t('promptWorkspaceHint') : t('promptNoWorkspace')}
        value={workspace}
        serverValue={view.workspace}
        disabled={disabled || !view.workspaceKnown}
        rows={3}
        onChange={setWorkspace}
        onSave={() => { saveLayer('workspace', workspace) }}
        t={t}
      />
      <LayerEditor
        id="advisor-layer-session"
        label={t('promptSession')}
        hint={t('promptSessionHint')}
        value={session}
        serverValue={view.session}
        disabled={disabled}
        rows={3}
        onChange={setSession}
        onSave={() => { saveLayer('session', session) }}
        t={t}
      />

      <div className={styles.rulesSection}>
        <div className={styles.sectionTitle}>{t('promptRules')}</div>
        {view.rules.length === 0
          ? <p className={styles.mutedLine}>{t('promptRulesEmpty')}</p>
          : (
              <ul className={styles.ruleList}>
                {view.rules.map((rule) => {
                  const isEditing = editing !== null && editing.scope === rule.scope && editing.index === rule.index
                  return (
                    <li key={`${rule.scope}:${rule.index}`} className={styles.ruleRow}>
                      <span className={styles.ruleScope}>{t(scopeKey(rule.scope))}</span>
                      {isEditing
                        ? (
                            <>
                              <input
                                className={styles.ruleInput}
                                value={editingText}
                                disabled={busy}
                                onChange={(event) => { setEditingText(event.target.value) }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') { event.preventDefault(); saveRule() }
                                  if (event.key === 'Escape') { setEditing(null); setEditingText('') }
                                }}
                                aria-label={t('promptRuleText')}
                              />
                              <button type="button" className={styles.smallButtonPrimary} disabled={busy} onClick={saveRule}>
                                {t('promptRuleSave')}
                              </button>
                              <button
                                type="button"
                                className={styles.smallButton}
                                disabled={busy}
                                onClick={() => { setEditing(null); setEditingText('') }}
                              >
                                {t('promptRuleCancel')}
                              </button>
                            </>
                          )
                        : (
                            <>
                              <span className={styles.ruleText}>{rule.text}</span>
                              <button
                                type="button"
                                className={styles.smallButton}
                                disabled={busy}
                                onClick={() => { setEditing({ scope: rule.scope, index: rule.index }); setEditingText(rule.text) }}
                              >
                                {t('promptRuleEdit')}
                              </button>
                              <button
                                type="button"
                                className={styles.smallButton}
                                disabled={busy}
                                onClick={() => { void controller.deleteRule(rule.scope, rule.index) }}
                              >
                                {t('promptRuleDelete')}
                              </button>
                            </>
                          )}
                    </li>
                  )
                })}
              </ul>
            )}
        <div className={styles.ruleAdd}>
          <select
            className={styles.ruleSelect}
            value={ruleScope}
            disabled={busy}
            onChange={(event) => { setRuleScope(event.target.value as AdvisorPromptScope) }}
            aria-label={t('promptRuleScopeSession')}
          >
            <option value="session">{t('promptRuleScopeSession')}</option>
            <option value="workspace" disabled={!view.workspaceKnown}>{t('promptRuleScopeWorkspace')}</option>
            <option value="system">{t('promptRuleScopeSystem')}</option>
          </select>
          <input
            className={styles.ruleInput}
            value={ruleText}
            disabled={busy}
            placeholder={t('promptRuleText')}
            onChange={(event) => { setRuleText(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && ruleText.trim() !== '') {
                event.preventDefault()
                void controller.addRule(ruleScope, ruleText.trim())
                setRuleText('')
              }
            }}
            aria-label={t('promptRuleText')}
          />
          <button
            type="button"
            className={styles.smallButton}
            disabled={busy || ruleText.trim() === ''}
            onClick={() => {
              void controller.addRule(ruleScope, ruleText.trim())
              setRuleText('')
            }}
          >
            {t('promptRuleAdd')}
          </button>
        </div>
      </div>
    </div>
  )
}