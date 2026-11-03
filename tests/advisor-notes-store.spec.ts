/**
 * Notes controller change guard (fork addition): a repeated identical poll
 * must publish nothing, so mounted turn tails never re-render on the 4 s
 * cadence (the visible jumping/glitching), while a changed payload publishes.
 */

import { describe, expect, it, vi } from 'vitest'
import { AdvisorNotesController } from '../src/client/advisor-notes-store'

function payload(notes: readonly unknown[]): { ok: true; value: unknown } {
  return {
    ok: true,
    value: { notes, enabled: true, runtimeStatus: 'running', provider: 'p', model: 'm' },
  }
}

const NOTE = {
  at: 1_000,
  severity: 'nit',
  text: 'consider the cache',
  channel: 'commit',
  turn: 1,
}

describe('AdvisorNotesController — poll change guard', () => {
  it('publishes once for identical payloads and again when the payload changes', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(payload([NOTE]))
      .mockResolvedValueOnce(payload([NOTE]))
      .mockResolvedValueOnce(payload([NOTE, { ...NOTE, at: 2_000, text: 'second' }]))
    const controller = new AdvisorNotesController('s1', { call } as never)

    await controller.fetch()
    const loaded = controller.store.getSnapshot()
    expect(loaded.status).toBe('ready')
    expect(loaded.notes).toHaveLength(1)

    const publishes: number[] = []
    const unsubscribe = controller.store.subscribe(() => { publishes.push(1) })

    await controller.fetch()
    // Identical poll: no notification, same snapshot identity.
    expect(publishes).toEqual([])
    expect(controller.store.getSnapshot()).toBe(loaded)

    await controller.fetch()
    expect(publishes).toEqual([1])
    expect(controller.store.getSnapshot().notes).toHaveLength(2)
    unsubscribe()
  })
})