// @vitest-environment jsdom
/**
 * Client seat registrations (fork fix, 0.6.43).
 *
 * The advisor occupies four seats, and WHERE they sit is a product decision
 * the user pushed on hard ("why below composer"):
 *
 * - `conversation.chat.turnTail`  — the note cards at the end of the turn a
 *   note reviewed (in the message flow, closed turns only);
 * - `conversation.input.dock`     — the LIVE notes of the still-running turn
 *   (no turn tail exists yet), in the host's zone row ABOVE the composer
 *   card's input. The old seat, `conversation.composer.dock`, put them BELOW
 *   the composer card, where they pushed the composer up the screen;
 * - `conversation.composer.dock`  — the next-prompt tip (a composer
 *   affordance — it stays);
 * - `conversation.view`           — the Advisor tab.
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

describe('client seat registrations — the live notes sit ABOVE the composer', () => {
  it('registers the notes strip into the input dock (above the composer card)', () => {
    const { registrations, errors } = collectRegistrations()
    const strip = registrations.find((r) => r.declaration.id === 'dsh-advisor#notes-strip')
    expect(strip, `notes strip seat (mock errors: ${errors.join(' | ')})`).toBeDefined()
    // INJECTED into the input dock — the zone row ABOVE the composer card's
    // input — not the composer dock, which renders BELOW the card and pushed
    // the composer up the screen.
    expect(strip!.injectedInto).toBe('conversation.input.dock')
    expect(strip!.declaration.name).toBe('conversation.input.dock')
    expect(strip!.declaration.order).toBe(30)
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
