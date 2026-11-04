// @vitest-environment jsdom
/**
 * Client seat registrations (0.6.49).
 *
 * The advisor occupies THREE seats:
 *
 * - `conversation.chat.turnTail`  — the note cards at the end of the turn a
 *   note reviewed (in the message flow, closed turns only);
 * - `conversation.composer.dock`  — the next-prompt tip (a composer
 *   affordance — it stays);
 * - `conversation.view`           — the Advisor tab.
 *
 * The above-composer LIVE notes strip (`conversation.input.dock`, the
 * 0.6.43–0.6.48 seat) is REMOVED per the 2026-11-04 user ruling ("why is
 * there an expandable advisor tab above the composer. Remove that"). Notes
 * now surface in the chat flow alone: an open turn's notes appear under that
 * turn the moment it closes (the notes derivation re-attributes them from
 * `turn === undefined` to the closing turn — the one-owner rule).
 *
 * The test invokes the REAL client plugin against a mocked slot registry and
 * asserts the registration objects — not a text proximity check, which an
 * unrelated string could satisfy.
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index'

/** What a seat registration declares. */
interface SeatDeclaration {
  name?: string
  id?: string
  order?: number
}

/** One collected seat: the slot it was INJECTED into, plus its declaration. */
interface CollectedSeat {
  /** The slot the seat was injected into (ctx.slots.inject argument). */
  readonly injectedInto: string
  readonly declaration: SeatDeclaration
}

/** Run the client plugin against a mocked slot registry and collect the seats. */
function collectRegistrations(): { registrations: CollectedSeat[]; errors: string[] } {
  const registrations: CollectedSeat[] = []
  const errors: string[] = []
  const services: Record<string, unknown> = {
    // The plugin resolves its transport once at apply time.
    connection: { rpc: { call: async () => ({ ok: false }) } },
  }
  const ctx = {
    slots: {
      // The plugin registers through ctx.slots.inject(name, generator) — the
      // generator yields ctx.slots.register(declaration).
      inject: (name: string, factory: () => Generator<unknown>) => {
        try {
          const declaration = factory().next().value as SeatDeclaration | undefined
          if (declaration !== undefined && typeof declaration === 'object') {
            // Keep the INJECTED slot next to the declaration: a seat can
            // declare one name while being injected into another.
            registrations.push({ injectedInto: name, declaration })
          }
        } catch (error) {
          errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
        return () => {}
      },
      register: (declaration: SeatDeclaration) => declaration,
    },
    get: (key: string) => services[key],
    effect: (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        errors.push(`effect: ${error instanceof Error ? error.message : String(error)}`)
      }
      return () => {}
    },
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  }
  apply(ctx as never)
  return { registrations, errors }
}

describe('client seat registrations — no advisor surface above the composer', () => {
  it('registers NOTHING into the input dock (the notes strip was removed, 0.6.49)', () => {
    const { registrations } = collectRegistrations()
    const strip = registrations.find((r) => r.declaration.id === 'dsh-advisor#notes-strip')
    expect(strip).toBeUndefined()
    const dock = registrations.filter((r) => r.injectedInto === 'conversation.input.dock')
    expect(dock).toEqual([])
  })

  it('keeps the next-prompt tip in the composer dock', () => {
    const { registrations, errors } = collectRegistrations()
    // The bundle id is shared by the session-header action and the
    // composer-dock tip, so the seat is what distinguishes them.
    const tip = registrations.find((r) => r.declaration.id === 'dsh-advisor' && r.injectedInto === 'conversation.composer.dock')
    expect(tip, `next-prompt tip seat (mock errors: ${errors.join(' | ')})`).toBeDefined()
  })

  it('keeps the note cards in the turn tail and the Advisor tab in the view roster', () => {
    const { registrations } = collectRegistrations()
    const tail = registrations.find((r) => r.declaration.id === 'dsh-advisor#turn-tail')
    expect(tail?.injectedInto).toBe('conversation.chat.turnTail')
    const tab = registrations.find((r) => r.declaration.id === 'dsh-advisor#advisor-trajectory')
    expect(tab?.injectedInto).toBe('conversation.view')
  })
})
