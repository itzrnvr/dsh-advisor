// @vitest-environment jsdom
/**
 * Advisor turn-tail row (fork addition) — pins the shared note card's default
 * in the message flow: turn-tail rows render EXPANDED (full note body), while
 * turn tails pass defaultCollapsed so their rows open header-only. The
 * two seats must not drift: a collapsed-default regression here would hide
 * delivered advice behind a toggle in the flow.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, fireEvent, within } from '@testing-library/react'
import { AdvisorTurnTail } from '../src/client/advisor-turn-tail'
import type { AdvisorNotesController, AdvisorNotesState } from '../src/client/advisor-notes-store'

afterEach(() => { cleanup() })

const note = (at: number, turn?: number) => ({
  at,
  severity: 'concern' as const,
  text: `note body ${at}`,
  channel: 'commit' as const,
  ...(turn === undefined ? {} : { turn }),
})

const state = (notes: readonly unknown[]): AdvisorNotesState => ({
  status: 'ready',
  notes: notes as AdvisorNotesState['notes'],
  enabled: true,
  runtimeStatus: 'running',
})

type TailProps = Parameters<typeof AdvisorTurnTail>[0]

function props(forState: AdvisorNotesState, turn: number): TailProps {
  return {
    turn: { turn },
    seq: 1,
    sessionId: 's1',
    controller: { start: vi.fn(), stop: vi.fn() } as unknown as AdvisorNotesController,
    hooks: { snapshot: {} },
    t: (key: string, params?: Record<string, string | number>) => (
      key === 'notesMore'
        ? `+${String(params?.count)} more`
        : key === 'notesEarlier'
          ? `+${String(params?.count)} earlier`
          : key
    ),
    useSnapshot: (selector: (value: AdvisorNotesState) => unknown) => selector(forState),
  } as unknown as TailProps
}

describe('AdvisorTurnTail — inline note rows at the reviewed turn', () => {
  it('renders this turn\'s notes expanded by default (full body visible)', () => {
    const view = render(<AdvisorTurnTail {...props(state([note(1, 3), note(2, 4)]), 3)} />)

    // Only turn 3's note renders here, and its body is visible without any
    // toggle — the flow is the permanent home of a delivered note.
    expect(view.container.textContent).toContain('note body 1')
    expect(view.container.textContent).not.toContain('note body 2')
    expect(view.container.textContent).toContain('notesCollapse')
  })

  it('renders null for a turn with no notes', () => {
    const view = render(<AdvisorTurnTail {...props(state([note(1, 3)]), 7)} />)
    expect(view.container.textContent).toBe('')
  })

  it('shows the newest window of a heavy turn, chronologically, older ones behind a reveal', () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((at) => note(at, 3))
    const view = render(<AdvisorTurnTail {...props(state(many), 3)} />)

    // The newest window stays visible — those are the notes the user just
    // watched arrive in the open turn — so a 57-note turn cannot become a
    // wall in the flow. Order inside the window stays chronological
    // (oldest → newest), and the older notes wait behind the reveal above.
    const bodies = within(view.container).getAllByText(/note body /).map((el) => el.textContent)
    expect(bodies).toEqual(['note body 3', 'note body 4', 'note body 5', 'note body 6', 'note body 7'])
    expect(view.container.textContent).not.toContain('note body 1')
    // The reveal sits ABOVE the cards (the hidden notes are older).
    fireEvent.click(within(view.container).getByText('+2 earlier'))
    const all = within(view.container).getAllByText(/note body /).map((el) => el.textContent)
    expect(all).toEqual(['note body 1', 'note body 2', 'note body 3', 'note body 4', 'note body 5', 'note body 6', 'note body 7'])
  })
})
