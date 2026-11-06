import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttemptStore, SessionStateStore } from '../src/persist'
import type { AdvisorTurnView } from '../src/gateway'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-advisor-persist-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const turn = (id: number): AdvisorTurnView => ({
  id,
  at: 1_000 + id,
  durationMs: 5,
  outcome: 'note',
  deltaChars: 1,
  historyTokens: 2,
  systemChars: 3,
})

describe('AttemptStore — durable advisor attempts', () => {
  it('round-trips attempts and traces through disk', () => {
    const store = new AttemptStore({ dir: tempDir() })
    store.appendTurn('s1', turn(1))
    store.appendTrace('s1', { id: 1, at: 1_001, kind: 'review', userText: 'delta', replyText: 'reply' })

    const loaded = store.load('s1')
    expect(loaded.turns).toHaveLength(1)
    expect(loaded.turns[0]?.id).toBe(1)
    expect(loaded.traces[0]?.userText).toBe('delta')
  })

  it('bounds the history to the newest entries', () => {
    const store = new AttemptStore({ dir: tempDir(), maxTurns: 2 })
    for (const id of [1, 2, 3]) store.appendTurn('s1', turn(id))
    expect(store.load('s1').turns.map((entry) => entry.id)).toEqual([2, 3])
  })

  it('skips corrupt lines instead of failing the whole file', () => {
    const store = new AttemptStore({ dir: tempDir() })
    store.appendTurn('s1', turn(1))
    writeFileSync(
      store.fileFor('s1'),
      `not json\n${JSON.stringify({ t: 'turn', v: turn(2) })}\n`,
      'utf8',
    )
    expect(store.load('s1').turns.map((entry) => entry.id)).toEqual([2])
  })
})

describe('SessionStateStore — durable /advisor overrides', () => {
  it('returns empty state when nothing was written', () => {
    expect(new SessionStateStore(tempDir()).load()).toEqual({ sessions: {} })
  })

  it('round-trips enable flags and model pins', () => {
    const dir = tempDir()
    const store = new SessionStateStore(dir)
    store.save({
      sessions: {
        s1: { enabled: true, at: 10 },
        s2: { model: { provider: 'p', model: 'm' }, at: 20 },
      },
    })
    const loaded = new SessionStateStore(dir).load()
    expect(loaded.sessions.s1?.enabled).toBe(true)
    expect(loaded.sessions.s2?.model).toEqual({ provider: 'p', model: 'm' })
  })

  it('treats a corrupt snapshot as empty', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'session-state.json'), '{ nope', 'utf8')
    expect(new SessionStateStore(dir).load()).toEqual({ sessions: {} })
  })

  it('round-trips standing session rules', () => {
    const dir = tempDir()
    new SessionStateStore(dir).save({
      sessions: { s1: { rules: ['do not overshoot', 'be terse'], at: 30 } },
    })
    expect(new SessionStateStore(dir).load().sessions.s1?.rules).toEqual(['do not overshoot', 'be terse'])
  })
})