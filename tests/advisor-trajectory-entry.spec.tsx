// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { AdvisorTrajectoryController } from '../src/client/advisor-trajectory-store'

function controllerWith(call: ReturnType<typeof vi.fn>): AdvisorTrajectoryController {
  return new AdvisorTrajectoryController('s1', { call } as never)
}

describe('AdvisorTrajectoryController.fetchEntry — failure modes (fork addition)', () => {
  it('returns undefined for an error result and for a payload without text', async () => {
    const failing = controllerWith(vi.fn().mockResolvedValue({ ok: false }))
    expect(await failing.fetchEntry(1)).toBeUndefined()

    const malformed = controllerWith(vi.fn().mockResolvedValue({ ok: true, value: { error: { tag: 'advisor/entry-unknown' } } }))
    expect(await malformed.fetchEntry(1)).toBeUndefined()
  })

  it('returns the text and reuses the per-at cache', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: { text: 'full text' } })
    const controller = controllerWith(call)
    expect(await controller.fetchEntry(42)).toBe('full text')
    expect(await controller.fetchEntry(42)).toBe('full text')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('/api', 'advisor/trajectoryEntry', { args: { sessionId: 's1', at: 42 } })
  })

  it('returns undefined when the transport throws', async () => {
    const throwing = controllerWith(vi.fn().mockRejectedValue(new Error('offline')))
    expect(await throwing.fetchEntry(7)).toBeUndefined()
  })
})