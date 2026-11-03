import { describe, expect, it } from 'vitest'
import { resolveTrajectoryEntry } from '../src/gateway'
import type { AdvisorTrajectoryFace } from '../src/gateway'

const face = (result = { text: 'full text' }): AdvisorTrajectoryFace => ({
  getTrajectory: () => ({ error: { tag: 'advisor/unavailable', message: 'unused' } }) as never,
  getTrajectoryEntry: () => result,
})

describe('resolveTrajectoryEntry — endpoint validation (fork addition)', () => {
  it('rejects a missing session id and a bad timestamp', () => {
    expect(resolveTrajectoryEntry(face(), '', 1)).toMatchObject({ error: { tag: 'advisor/rejected' } })
    expect(resolveTrajectoryEntry(face(), 's', -1)).toMatchObject({ error: { tag: 'advisor/rejected' } })
    expect(resolveTrajectoryEntry(face(), 's', 1.5)).toMatchObject({ error: { tag: 'advisor/rejected' } })
  })

  it('answers unavailable without an elected owner', () => {
    expect(resolveTrajectoryEntry(undefined, 's', 1)).toMatchObject({ error: { tag: 'advisor/unavailable' } })
  })

  it('passes through the owner text and its entry-unknown error', () => {
    expect(resolveTrajectoryEntry(face(), 's', 1)).toEqual({ text: 'full text' })
    const unknown = { error: { tag: 'advisor/entry-unknown', message: 'nope' } } as const
    expect(resolveTrajectoryEntry(face(unknown as never), 's', 2)).toEqual(unknown)
  })
})