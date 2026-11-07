/**
 * Layered advisor prompt memory (fork addition, 2026-11-07).
 *
 * Three scopes feed every review:
 * - **system-wide** — the plugin-row `systemPromptAppend` (profile config);
 * - **workspace** — this file, keyed by the session's `header.cwd`;
 * - **session** — the durable per-session overrides (`src/commands.ts`).
 *
 * Two kinds of content per layer: a free-text *prompt* and discrete *rules*.
 * The runtime renders the non-empty layers as a "## Advisor instructions"
 * block prepended to the NEW reviewer turn, never to the system prompt or an
 * earlier history entry. That keeps the provider prefix cache valid while a
 * live change takes effect on the very next review; a new session reads the
 * same live state from its first review.
 *
 * Storage: `$DSH_ADVISOR_DATA_DIR/prompt-layers.json` (else the standard
 * advisor data dir). Writes are atomic; NOTHING is ever auto-deleted — a
 * workspace entry survives an emptied prompt so the user's history of
 * decisions is not silently rewritten. A corrupt/missing file reads as empty.
 *
 * @module dsh-advisor/prompt-store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { advisorDataDir } from './persist.js'

/** One workspace's stored layer. */
export interface WorkspacePromptLayer {
  /** Free-text workspace instruction ('' = none). */
  readonly prompt: string
  /** Discrete workspace rules, oldest → newest. */
  readonly rules: readonly string[]
}

/** The on-disk shape (plain JSON; every field optional on read). */
interface PromptLayersFile {
  readonly globalRules?: readonly string[]
  readonly workspaces?: Record<string, { readonly prompt?: string; readonly rules?: readonly string[] }>
}

/** Normalized workspace key (case/slash-insensitive on Windows). */
export function workspaceKey(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const trimmed = cwd.trim()
  if (trimmed === '') return undefined
  return process.platform === 'win32'
    ? trimmed.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : trimmed.replace(/\/+$/, '')
}

/** Test suites must never touch the live profile's memory. */
function mutedForTests(explicit: boolean): boolean {
  return !explicit && process.env.VITEST !== undefined
}

/**
 * Durable profile/workspace prompt layers. The in-memory state is loaded once
 * per instance and rewritten atomically after every mutation; the file is
 * never pruned.
 */
export class PromptLayerStore {
  private readonly file: string
  private readonly muted: boolean
  private globalRules: string[]
  private workspaces: Record<string, { prompt: string; rules: string[] }>
  private loaded = false

  constructor(dir?: string) {
    const location = dir ?? advisorDataDir()
    this.file = join(location, 'prompt-layers.json')
    this.muted = mutedForTests(dir !== undefined || (process.env.DSH_ADVISOR_DATA_DIR ?? '') !== '')
    this.globalRules = []
    this.workspaces = {}
  }

  /** The profile-wide rules (copy). */
  globalRulesList(): readonly string[] {
    this.ensureLoaded()
    return [...this.globalRules]
  }

  /** One workspace's layer (empty when absent or unknown). */
  workspace(cwd: string | undefined): WorkspacePromptLayer {
    this.ensureLoaded()
    const key = workspaceKey(cwd)
    const entry = key === undefined ? undefined : this.workspaces[key]
    return {
      prompt: entry?.prompt ?? '',
      rules: entry?.rules === undefined ? [] : [...entry.rules],
    }
  }

  /** Replace the workspace free-text prompt ('' keeps the entry, cleared). */
  setWorkspacePrompt(cwd: string | undefined, text: string): void {
    const key = workspaceKey(cwd)
    if (key === undefined) return
    this.ensureLoaded()
    const entry = this.workspaces[key] ?? { prompt: '', rules: [] }
    this.workspaces[key] = { ...entry, prompt: text }
    this.save()
  }

  /** Append one profile-wide rule. */
  addGlobalRule(text: string): void {
    this.ensureLoaded()
    this.globalRules.push(text)
    this.save()
  }

  /** Replace one profile-wide rule by index. @returns whether it existed. */
  updateGlobalRule(index: number, text: string): boolean {
    this.ensureLoaded()
    if (!Number.isInteger(index) || index < 0 || index >= this.globalRules.length) return false
    this.globalRules[index] = text
    this.save()
    return true
  }

  /** Delete one profile-wide rule by index. @returns whether it existed. */
  deleteGlobalRule(index: number): boolean {
    this.ensureLoaded()
    if (!Number.isInteger(index) || index < 0 || index >= this.globalRules.length) return false
    this.globalRules.splice(index, 1)
    this.save()
    return true
  }

  /** Append one workspace rule. */
  addWorkspaceRule(cwd: string | undefined, text: string): void {
    const key = workspaceKey(cwd)
    if (key === undefined) return
    this.ensureLoaded()
    const entry = this.workspaces[key] ?? { prompt: '', rules: [] }
    this.workspaces[key] = { ...entry, rules: [...entry.rules, text] }
    this.save()
  }

  /** Replace one workspace rule by index. */
  updateWorkspaceRule(cwd: string | undefined, index: number, text: string): boolean {
    const key = workspaceKey(cwd)
    if (key === undefined) return false
    this.ensureLoaded()
    const entry = this.workspaces[key]
    if (entry === undefined || !Number.isInteger(index) || index < 0 || index >= entry.rules.length) return false
    const rules = [...entry.rules]
    rules[index] = text
    this.workspaces[key] = { ...entry, rules }
    this.save()
    return true
  }

  /** Delete one workspace rule by index. */
  deleteWorkspaceRule(cwd: string | undefined, index: number): boolean {
    const key = workspaceKey(cwd)
    if (key === undefined) return false
    this.ensureLoaded()
    const entry = this.workspaces[key]
    if (entry === undefined || !Number.isInteger(index) || index < 0 || index >= entry.rules.length) return false
    const rules = [...entry.rules]
    rules.splice(index, 1)
    this.workspaces[key] = { ...entry, rules }
    this.save()
    return true
  }

  /** The file backing this store (diagnostics/tests). */
  fileForDiagnostics(): string {
    return this.file
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (this.muted) return
    let parsed: PromptLayersFile
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as PromptLayersFile
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    if (Array.isArray(parsed.globalRules)) {
      this.globalRules = parsed.globalRules.filter((rule): rule is string => typeof rule === 'string')
    }
    if (parsed.workspaces !== undefined && parsed.workspaces !== null && typeof parsed.workspaces === 'object') {
      for (const [key, value] of Object.entries(parsed.workspaces)) {
        if (value === null || typeof value !== 'object') continue
        this.workspaces[key] = {
          prompt: typeof value.prompt === 'string' ? value.prompt : '',
          rules: Array.isArray(value.rules)
            ? value.rules.filter((rule): rule is string => typeof rule === 'string')
            : [],
        }
      }
    }
  }

  private save(): void {
    if (this.muted) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const body: PromptLayersFile = {
        globalRules: this.globalRules,
        workspaces: this.workspaces,
      }
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.file)
    } catch {
      // Best-effort: a failed write must never fail a review or a panel save.
    }
  }
}