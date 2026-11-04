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
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
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
  /** Maximum traces returned by `load`. */
  readonly maxTraces?: number
  /** File size that triggers a compaction, in bytes. */
  readonly maxBytes?: number
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
  private readonly maxBytes: number
  private readonly muted: boolean

  constructor(options: AttemptStoreOptions = {}) {
    this.dir = options.dir ?? join(advisorDataDir(), 'sessions')
    this.maxTurns = options.maxTurns ?? 80
    this.maxTraces = options.maxTraces ?? 40
    this.maxBytes = options.maxBytes ?? 4_000_000
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
      this.compactIfNeeded(sessionId, file)
    } catch {
      // Best-effort: losing history is better than failing a review.
    }
  }

  private compactIfNeeded(sessionId: string, file: string): void {
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (size <= this.maxBytes) return
    const { turns, traces } = this.load(sessionId)
    // Drop traces first, then fall back to the newest half of the attempts:
    // a compaction must actually get the file under the ceiling, otherwise
    // every later attempt would re-read and re-write the whole file.
    const candidates: StoredLine[][] = [
      [
        ...turns.map((v) => ({ t: 'turn' as const, v })),
        ...traces.map((v) => ({ t: 'trace' as const, v })),
      ],
      turns.map((v) => ({ t: 'turn' as const, v })),
      turns.slice(-Math.max(1, Math.floor(this.maxTurns / 2))).map((v) => ({ t: 'turn' as const, v })),
      // Last resort: an empty file is always under the ceiling, so one
      // compaction can never leave a file that re-compacts on every append.
      [],
    ]
    let payload = ''
    for (const lines of candidates) {
      payload = lines.map((entry) => JSON.stringify(entry)).join('\n')
      if (payload !== '') payload += '\n'
      if (Buffer.byteLength(payload, 'utf8') <= this.maxBytes) break
    }
    const temporary = `${file}.tmp`
    writeFileSync(temporary, payload, 'utf8')
    renameSync(temporary, file)
  }
}

/** Snapshot entry ceiling: keeps the file (and boot memory) bounded. */
const MAX_SESSION_ENTRIES = 2_000

/**
 * Durable per-session advisor overrides. The in-memory store owns the
 * semantics; this only reads/writes its snapshot.
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
      return prune(parsed)
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
      writeFileSync(temporary, `${JSON.stringify(prune(state), null, 2)}\n`, 'utf8')
      renameSync(temporary, this.file)
    } catch {
      // Best-effort: a failed snapshot keeps the previous file.
    }
  }
}

/** Keep only the newest {@link MAX_SESSION_ENTRIES} override entries. */
function prune(state: AdvisorPersistedState): AdvisorPersistedState {
  const entries = Object.entries(state.sessions)
  if (entries.length <= MAX_SESSION_ENTRIES) return state
  entries.sort((left, right) => (right[1]?.at ?? 0) - (left[1]?.at ?? 0))
  return { sessions: Object.fromEntries(entries.slice(0, MAX_SESSION_ENTRIES)) }
}