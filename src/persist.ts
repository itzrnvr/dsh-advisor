/**
 * Durable advisor state (fork addition).
 *
 * The reviewer's own history used to be memory-only: a plugin reinstall or a
 * host restart emptied the Advisor tab even though the session itself was
 * untouched. This module persists the two things the tab needs:
 *
 * - per-session model attempts (tokens, cache reads, duration, outcome) and
 *   their full traces, appended to one JSONL file per session;
 * - the per-session advisor overrides (`on|off` + pinned model pair), in one
 *   JSON snapshot.
 *
 * Everything here is best-effort: a failed write must never fail a review, and
 * a corrupt file must degrade to "no history" rather than throw. Bounds match
 * the in-memory rings (80 attempts, 40 traces) and the file is compacted once
 * it grows past a size ceiling.
 *
 * Location: `$DSH_ADVISOR_DATA_DIR`, else `$DSH_HOME/advisor`, else
 * `~/.dsh/advisor`.
 *
 * Disk cost, stated plainly: NOTHING is ever deleted automatically. Session
 * files append forever (each record is written once), the snapshot keeps every
 * session that ever held an override, and there is no retention window, size
 * cap, or compaction that drops records. `load` returns only the newest 80
 * attempts / 40 traces for display, but the older lines stay on disk. Disk
 * usage grows with usage by design; removing files is a manual choice reserved
 * for the user.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AdvisorTrace } from './advisor-runtime.js'
import type { AdvisorPersistedState } from './commands.js'
import type { AdvisorTurnView } from './gateway.js'

/** Root directory for every durable advisor artifact. */
export function advisorDataDir(): string {
  const explicit = process.env.DSH_ADVISOR_DATA_DIR
  if (explicit !== undefined && explicit !== '') return explicit
  const home = process.env.DSH_HOME
  if (home !== undefined && home !== '') return join(home, 'advisor')
  return join(homedir(), '.dsh', 'advisor')
}

/** One persisted line: an attempt row or its full trace. */
interface StoredLine {
  readonly t: 'turn' | 'trace'
  readonly v: unknown
}

/** Whether a parsed value looks like an attempt row. */
function isTurn(value: unknown): value is AdvisorTurnView {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; at?: unknown; durationMs?: unknown; outcome?: unknown }
  return typeof candidate.id === 'number'
    && typeof candidate.at === 'number'
    && typeof candidate.durationMs === 'number'
    && typeof candidate.outcome === 'string'
}

/** Whether a parsed value looks like a retained trace. */
function isTrace(value: unknown): value is AdvisorTrace {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; at?: unknown; kind?: unknown }
  return typeof candidate.id === 'number'
    && typeof candidate.at === 'number'
    && typeof candidate.kind === 'string'
}

/** Keep a session id safe as a file name. */
function sanitize(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** Options for {@link AttemptStore}. */
export interface AttemptStoreOptions {
  /** Directory holding one JSONL file per session. */
  readonly dir?: string
  /** Maximum attempts returned by `load` (matches the memory ring). */
  readonly maxTurns?: number
  /** Maximum traces returned by `load` (display window; nothing is deleted). */
  readonly maxTraces?: number
}

/** Whether a caller named an explicit location (test suites do). */
function explicitDir(optionsDir: string | undefined): boolean {
  return optionsDir !== undefined || (process.env.DSH_ADVISOR_DATA_DIR ?? '') !== ''
}

/** Test suites must never touch the live profile's advisor state. */
function mutedForTests(locationExplicit: boolean): boolean {
  return !locationExplicit && process.env.VITEST !== undefined
}

/** Retained trace text on disk (the in-memory copy keeps the full 200k). */
const TRACE_DISK_MAX_CHARS = 32_000

/** Durable per-session attempt + trace history. */
export class AttemptStore {
  private readonly dir: string
  private readonly maxTurns: number
  private readonly maxTraces: number
  private readonly muted: boolean

  constructor(options: AttemptStoreOptions = {}) {
    this.dir = options.dir ?? join(advisorDataDir(), 'sessions')
    this.maxTurns = options.maxTurns ?? 80
    this.maxTraces = options.maxTraces ?? 40
    this.muted = mutedForTests(explicitDir(options.dir))
  }

  /** Read one session's persisted history (bounded, order-preserving). */
  load(sessionId: string): { turns: AdvisorTurnView[]; traces: AdvisorTrace[] } {
    if (this.muted) return { turns: [], traces: [] }
    let text: string
    try {
      text = readFileSync(this.fileFor(sessionId), 'utf8')
    } catch {
      return { turns: [], traces: [] }
    }
    const turns: AdvisorTurnView[] = []
    const traces: AdvisorTrace[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let parsed: StoredLine
      try {
        parsed = JSON.parse(line) as StoredLine
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object') continue
      if (parsed.t === 'turn' && isTurn(parsed.v)) turns.push(parsed.v)
      else if (parsed.t === 'trace' && isTrace(parsed.v)) traces.push(parsed.v)
    }
    return {
      turns: turns.slice(-this.maxTurns),
      traces: traces.slice(-this.maxTraces),
    }
  }

  /** Append one attempt row; never throws. */
  appendTurn(sessionId: string, turn: AdvisorTurnView): void {
    this.append(sessionId, { t: 'turn', v: turn })
  }

  /** Append one retained trace; never throws. */
  appendTrace(sessionId: string, trace: AdvisorTrace): void {
    const cap = (value: string | undefined): string | undefined =>
      value === undefined ? undefined : value.slice(0, TRACE_DISK_MAX_CHARS)
    const userText = cap(trace.userText)
    const replyText = cap(trace.replyText)
    const summary = cap(trace.summary)
    this.append(sessionId, {
      t: 'trace',
      v: {
        id: trace.id,
        at: trace.at,
        kind: trace.kind,
        ...(userText === undefined ? {} : { userText }),
        ...(replyText === undefined ? {} : { replyText }),
        ...(summary === undefined ? {} : { summary }),
        ...(trace.error === undefined ? {} : { error: trace.error }),
      },
    })
  }

  /** The JSONL file backing one session (exposed for diagnostics/tests). */
  fileFor(sessionId: string): string {
    return join(this.dir, `${sanitize(sessionId)}.jsonl`)
  }

  private append(sessionId: string, line: StoredLine): void {
    if (this.muted) return
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = this.fileFor(sessionId)
      appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
    } catch {
      // Best-effort: losing history is better than failing a review.
    }
  }
}

/**
 * Durable per-session advisor overrides. The in-memory store owns the
 * semantics; this only reads/writes its snapshot. The snapshot is never
 * pruned: every session that ever held an override stays in the file.
 */
export class SessionStateStore {
  private readonly file: string
  private readonly muted: boolean

  constructor(dir?: string) {
    const location = dir ?? advisorDataDir()
    this.file = join(location, 'session-state.json')
    this.muted = mutedForTests(explicitDir(dir))
  }

  /** Read the last written snapshot; a missing/corrupt file means empty. */
  load(): AdvisorPersistedState {
    if (this.muted) return { sessions: {} }
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return { sessions: {} }
    }
    try {
      const parsed = JSON.parse(text) as AdvisorPersistedState
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
        return { sessions: {} }
      }
      return parsed
    } catch {
      return { sessions: {} }
    }
  }

  /** Atomically replace the snapshot; never throws. */
  save(state: AdvisorPersistedState): void {
    if (this.muted) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.file)
    } catch {
      // Best-effort: a failed snapshot keeps the previous file.
    }
  }
}