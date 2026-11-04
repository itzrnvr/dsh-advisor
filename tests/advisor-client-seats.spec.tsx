// @vitest-environment jsdom
/**
 * Client seat registrations (0.6.50).
 *
 * The advisor's chat surfaces, and WHERE they sit is a product decision the
 * user pushed on hard twice ("why below composer" → strip removed 0.6.49 →
 * "THEY SHOULD IMMEDIATELY RENDER INLINE ... IN BETWEEN STEPS" 0.6.50):
 *
 * - PRIMARY (inline live notes): a `advisor-note` chat-node DEFINITION via
 *   the conversation engine's public events.register, plus the keyed
 *   `conversation.chat.node` entry rendering the card at the event's own
 *   position — live, mid-turn, in arrival order.
 * - FALLBACK (no engine service — older shells): the
 *   `conversation.chat.turnTail` entry (notes grouped at the closed turn).
 *   The tail seat is registered at apply ALWAYS; the inline child disposes
 *   it when it activates (never both — and never a half-inline: a failed
 *   renderer registration withdraws the definition too).
 * - `conversation.composer.dock` — the next-prompt tip (always).
 * - `conversation.view` — the Advisor tab (always).
 *
 * The test invokes the REAL client plugin against a mocked slot registry /
 * engine and asserts the registration objects + disposer calls — not text
 * proximity.
 */

import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index'

/** What a seat registration declares. */
interface SeatDeclaration {
  name?: string
  id?: string
  order?: number
  key?: string
  entryKey?: string
}

/** One collected seat: the slot it was INJECTED into, plus its declaration. */
interface CollectedSeat {
  /** The slot the seat was injected into (ctx.slots.inject argument). */
  readonly injectedInto: string
  readonly declaration: SeatDeclaration
}

interface MockOutcome {
  registrations: CollectedSeat[]
  errors: string[]
  /** Definitions handed to uiConversation.events.register (when mocked). */
  definitions: unknown[]
  /** Whether the events.register disposer was called (half-failure rollback). */
  definitionDisposed: boolean
}

/** Run the client plugin against a mocked slot registry (+ optional engine). */
function collectRegistrations(options: {
  engine?: boolean
  /** Make the keyed node registration throw AFTER the definition landed. */
  failNodeSlot?: boolean
} = {}): MockOutcome {
  const registrations: CollectedSeat[] = []
  const errors: string[] = []
  const definitions: unknown[] = []
  let definitionDisposed = false
  const engine = options.engine === false
    ? undefined
    : {
        events: {
          register: (definition: unknown) => {
            definitions.push(definition)
            return () => {
              definitionDisposed = true
            }
          },
        },
      }
  const services: Record<string, unknown> = {
    // The plugin resolves its transport once at apply time.
    connection: { rpc: { call: async () => ({ ok: false }) } },
    ...(engine !== undefined ? { uiConversation: engine } : {}),
  }
  const ctx: Record<string, unknown> = {
    slots: {
      inject: (name: string, factory: () => unknown) => {
        if (options.failNodeSlot === true && name === 'conversation.chat.node') {
          throw new Error('mock: keyed slot rejected')
        }
        let collected: CollectedSeat | undefined
        try {
          // The real machinery accepts BOTH factory idioms: a generator
          // yielding the register result (the advisor's older entries) and a
          // plain function returning it (the reference plugin's chat.node
          // form, 0.6.51).
          const produced = factory()
          const raw = typeof (produced as Generator<unknown>)?.next === 'function'
            ? (produced as Generator<unknown>).next().value
            : produced
          const declaration = raw as SeatDeclaration | undefined
          if (declaration !== undefined && typeof declaration === 'object') {
            collected = { injectedInto: name, declaration }
            registrations.push(collected)
          }
        } catch (error) {
          errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
        // Real slots.inject returns a disposer; removing the collected entry
        // models its effect so the test can OBSERVE the tail retirement when
        // the inline surface activates.
        return () => {
          if (collected === undefined) return
          const index = registrations.indexOf(collected)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
      register: (declaration: SeatDeclaration) => {
        // Strict mirror of the live Slots contract (verified via
        // Slots.listSubTree): the keyed `conversation.chat.node` slot
        // requires `key` (the owner dispatches by node.kind under the SAME
        // string) and accepts only {name, key, locale}. An unknown field —
        // e.g. the `entryKey` this wiring once carried — must fail HERE, at
        // test time, instead of silently never rendering.
        if (declaration.name === 'conversation.chat.node') {
          if (typeof declaration.key !== 'string' || declaration.key.length === 0) {
            throw new Error('mock: conversation.chat.node registration requires "key" (string)')
          }
          for (const field of Object.keys(declaration)) {
            if (field !== 'name' && field !== 'key' && field !== 'locale') {
              throw new Error(`mock: unknown registration option "${field}" on conversation.chat.node`)
            }
          }
        }
        return declaration
      },
    },
    get: (key: string) => services[key],
    // Conditional child fiber: activates synchronously when every named
    // service is present — either in the service registry (uiConversation)
    // or as a context face (slots), mirroring the real scope-chain lookup.
    inject: (names: readonly string[], cb: (child: unknown) => void) => {
      if (names.every((name) => services[name] !== undefined || name in ctx)) {
        try {
          cb(proxied)
        } catch (error) {
          errors.push(`inject: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return () => {}
    },
    locale: {
      register: () => () => {},
      getLocale: () => ({ active: 'en' }),
    },
    on: () => () => {},
    remote: { $on: () => () => {} },
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
  // Child/root proxy: service properties resolve from the registry, faces
  // come from the mock itself.
  const proxied = new Proxy(ctx, {
    get: (target, key: string) => (key in target ? target[key] : services[key]),
  })
  apply(proxied as never)
  return { registrations, errors, definitions, definitionDisposed }
}

/** The tail seat entry currently collected (id-based), or undefined. */
function tailSeat(outcome: MockOutcome) {
  return outcome.registrations.find((r) => r.declaration.id === 'dsh-advisor#turn-tail')
}

describe('client seat registrations — inline live notes with tail fallback', () => {
  it('registers NOTHING into the input dock (the notes strip was removed, 0.6.49)', () => {
    const outcome = collectRegistrations()
    const strip = outcome.registrations.find((r) => r.declaration.id === 'dsh-advisor#notes-strip')
    expect(strip).toBeUndefined()
    const dock = outcome.registrations.filter((r) => r.injectedInto === 'conversation.input.dock')
    expect(dock).toEqual([])
  })

  it('with the engine: contributes the advisor-note definition + keyed node entry', () => {
    const outcome = collectRegistrations({ engine: true })
    expect(outcome.errors).toEqual([])
    expect(outcome.definitions).toHaveLength(1)
    const definition = outcome.definitions[0] as { kind?: string; target?: string }
    expect(definition.kind).toBe('advisor-note')
    expect(definition.target).toBe('chat')
    // The keyed entry carries `key` — the field the live slot contract
    // requires and the owner dispatches by (node.kind). The `entryKey` this
    // wiring once carried was the wrong field and rendered nothing.
    const nodeEntry = outcome.registrations.find((r) => r.declaration.key === 'advisor-note')
    expect(nodeEntry?.injectedInto).toBe('conversation.chat.node')
    expect(nodeEntry?.declaration.name).toBe('conversation.chat.node')
    expect(nodeEntry?.declaration.entryKey).toBeUndefined()
    // Never both: the tail seat registered at apply was DISPOSED when the
    // inline child activated (the mock disposer removes the collected entry).
    expect(tailSeat(outcome)).toBeUndefined()
  })

  it('without the engine (older shell): the turn tail stays, no node entry, no definition', () => {
    const outcome = collectRegistrations({ engine: false })
    expect(outcome.definitions).toHaveLength(0)
    expect(tailSeat(outcome)?.injectedInto).toBe('conversation.chat.turnTail')
    const nodeEntry = outcome.registrations.find((r) => r.declaration.key === 'advisor-note')
    expect(nodeEntry).toBeUndefined()
  })

  it('half-failure rollback: a rejected node slot withdraws the definition (no orphan JSON nodes)', () => {
    const outcome = collectRegistrations({ engine: true, failNodeSlot: true })
    expect(outcome.definitions).toHaveLength(1)
    // The definition disposer MUST have been called — an orphan advisor-note
    // node kind would render through the host's JSON fallback while the
    // tail stays mounted (double display in two shapes).
    expect(outcome.definitionDisposed).toBe(true)
    const nodeEntry = outcome.registrations.find((r) => r.declaration.key === 'advisor-note')
    expect(nodeEntry).toBeUndefined()
    // Rollback keeps the fallback: the tail seat stays mounted.
    expect(tailSeat(outcome)?.injectedInto).toBe('conversation.chat.turnTail')
  })

  it('keeps the next-prompt tip in the composer dock and the Advisor tab in the view roster', () => {
    const outcome = collectRegistrations({ engine: true })
    const tip = outcome.registrations.find((r) => r.declaration.id === 'dsh-advisor' && r.injectedInto === 'conversation.composer.dock')
    expect(tip).toBeDefined()
    const tab = outcome.registrations.find((r) => r.declaration.id === 'dsh-advisor#advisor-trajectory')
    expect(tab?.injectedInto).toBe('conversation.view')
  })
})
