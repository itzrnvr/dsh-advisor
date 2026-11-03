// @vitest-environment jsdom
/**
 * Advisor notes strip (fork addition) — the dock entry below the composer.
 * Pins the two load-bearing behaviors:
 * - it owns exactly the TURN-LESS notes (turn === undefined): a turn-tagged
 *   note renders in its turn's tail and must never duplicate here;
 * - rows render COLLAPSED by default (the composer must not be pushed up by
 *   a wall of expanded note bodies) and expand on toggle;
 * - the dismiss state hides the strip for the page lifetime.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, fireEvent, within } from '@testing-library/react'
import { AdvisorNotesStrip } from '../src/client/advisor-notes-strip'
import type { AdvisorNotesController, AdvisorNotesState } from '../src/client/advisor-notes-store'

// The spec program has no global setup file: unmount between cases so a
// later query can never match a previous case's DOM.
afterEach(() => { cleanup() })

const note = (at: number, turn?: number) => ({
  at,
  severity: 'concern' as const,
  text: `note body ${at}`,
  channel: 'commit' as const,
  ...(turn === undefined ? {} : { turn }),
})

const state = (notes: readonly unknown[], overrides: Partial<AdvisorNotesState> = {}): AdvisorNotesState => ({
  status: 'ready',
  notes: notes as AdvisorNotesState['notes'],
  enabled: true,
  runtimeStatus: 'running',
  expanded: false,
  dismissed: false,
  ...overrides,
})

type StripProps = Parameters<typeof AdvisorNotesStrip>[0]

function props(forState: AdvisorNotesState, controller?: Partial<AdvisorNotesController>): StripProps {
  return {
    sessionId: 's1',
    controller: {
      start: vi.fn(),
      stop: vi.fn(),
      toggleExpanded: vi.fn(),
      dismiss: vi.fn(),
      ...controller,
    } as unknown as AdvisorNotesController,
    hooks: { snapshot: {} },
    t: (key: string, params?: Record<string, string | number>) => (
      key === 'notesMore' ? `+${String(params?.count)} more` : key
    ),
    useSnapshot: (selector: (value: AdvisorNotesState) => unknown) => selector(forState),
  } as unknown as StripProps
}

describe('AdvisorNotesStrip — dock entry below the composer (fork fix)', () => {
  it('renders null when every note is turn-tagged (the tails own them)', () => {
    const view = render(<AdvisorNotesStrip {...props(state([note(1, 3), note(2, 4)]))} />)
    expect(view.container.textContent).toBe('')
  })

  it('shows turn-less notes collapsed by default — bodies hidden until expanded', () => {
    const view = render(<AdvisorNotesStrip {...props(state([note(1), note(2)]))} />)

    // The strip itself and the header rows are visible…
    expect(view.container.textContent).toContain('notesTitle')
    // …but the note BODIES are not: rows start collapsed so the composer
    // below/above is never displaced by expanded note text.
    expect(view.container.textContent).not.toContain('note body 1')
    expect(view.container.textContent).not.toContain('note body 2')
    expect(within(view.container).getAllByText('notesExpand')).toHaveLength(2)
  })

  it('expands a row on toggle, revealing that note body only', () => {
    const view = render(<AdvisorNotesStrip {...props(state([note(1), note(2)]))} />)

    fireEvent.click(within(view.container).getAllByText('notesExpand')[0]!)
    expect(view.container.textContent).toContain('note body 1')
    // The other row stays collapsed.
    expect(view.container.textContent).not.toContain('note body 2')
  })

  it('caps the shown rows and counts the hidden remainder', () => {
    const view = render(<AdvisorNotesStrip {...props(state([note(1), note(2), note(3), note(4), note(5)]))} />)

    // Only the newest 3 render; the older 2 collapse into '+N more'.
    expect(within(view.container).getAllByText('notesExpand')).toHaveLength(3)
    expect(view.container.textContent).toContain('+2 more')
  })

  it('renders null once dismissed', () => {
    const view = render(<AdvisorNotesStrip {...props(state([note(1)], { dismissed: true }))} />)
    expect(view.container.textContent).toBe('')
  })
})
