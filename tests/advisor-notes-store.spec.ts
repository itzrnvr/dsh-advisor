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

  it('re-arms a dismissed strip when a newer UNTAGGED concern arrives', async () => {
    const untagged = { ...NOTE, turn: undefined }
    const call = vi.fn()
      .mockResolvedValueOnce(payload([untagged]))
      .mockResolvedValueOnce(payload([untagged, { ...untagged, at: 2_000, severity: 'concern' }]))
    const controller = new AdvisorNotesController('s1', { call } as never)

    await controller.fetch()
    controller.dismiss()
    expect(controller.store.getSnapshot().dismissed).toBe(true)

    await controller.fetch()
    // Interrupting advice the user has not seen lifts the dismiss.
    expect(controller.store.getSnapshot().dismissed).toBe(false)
  })

  it('keeps the strip dismissed when the newer concern is turn-TAGGED (tails own it)', async () => {
    const untagged = { ...NOTE, turn: undefined }
    const call = vi.fn()
      .mockResolvedValueOnce(payload([untagged]))
      .mockResolvedValueOnce(payload([untagged, { ...NOTE, at: 2_000, severity: 'concern', turn: 4 }]))
    const controller = new AdvisorNotesController('s1', { call } as never)

    await controller.fetch()
    controller.dismiss()
    await controller.fetch()
    // A tagged note renders in its turn tail — resurrecting the strip for it
    // would pop a dismissed surface that then renders null.
    expect(controller.store.getSnapshot().dismissed).toBe(true)
  })

  it('keeps the strip dismissed for a newer untagged NIT (only interrupting advice re-arms)', async () => {
    const untagged = { ...NOTE, turn: undefined }
    const call = vi.fn()
      .mockResolvedValueOnce(payload([untagged]))
      .mockResolvedValueOnce(payload([untagged, { ...untagged, at: 2_000 }]))
    const controller = new AdvisorNotesController('s1', { call } as never)

    await controller.fetch()
    controller.dismiss()
    await controller.fetch()
    expect(controller.store.getSnapshot().dismissed).toBe(true)
  })
})