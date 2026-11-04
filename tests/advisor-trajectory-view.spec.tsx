// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { AdvisorTrajectoryView } from '../src/client/advisor-trajectory-view'
import type {
  AdvisorTrajectoryState,
  AdvisorTrajectoryTurn,
} from '../src/client/advisor-trajectory-store'

// The spec program has no global setup file: unmount between cases so a
// later query can never match a previous case's DOM.
afterEach(() => { cleanup() })

const turn = (overrides: Partial<AdvisorTrajectoryTurn>): AdvisorTrajectoryTurn => ({
  id: 1,
  at: 1_793_596_800_000,
  durationMs: 12,
  outcome: 'note',
  deltaChars: 10,
  historyTokens: 0,
  systemChars: 100,
  ...overrides,
})

const state = (turns: AdvisorTrajectoryTurn[]): AdvisorTrajectoryState => ({
  status: 'ready',
  turns,
  enabled: true,
  runtimeStatus: 'running',
  historyMaxTokens: 1_000_000,
  provider: 'p',
  model: 'm',
})

type ViewProps = Parameters<typeof AdvisorTrajectoryView>[0]

function props(forState: AdvisorTrajectoryState): ViewProps {
  return {
    sessionId: 's1',
    controller: { start: vi.fn(), stop: vi.fn(), fetchEntry: vi.fn(async () => undefined) },
    hooks: { snapshot: {} },
    t: (key: string) => key,
    useSnapshot: (selector: (value: AdvisorTrajectoryState) => unknown) => selector(forState),
  } as unknown as ViewProps
}

/** The ledger row that carries one visible text slot. */
function rowFor(container: HTMLElement, text: string): HTMLElement {
  const node = within(container).getByText(text)
  const row = node.closest('tr')
  if (row === null) throw new Error(`no ledger row for "${text}"`)
  return row
}

describe('AdvisorTrajectoryView — Trajectory-shaped advisor ledger (fork addition)', () => {
  it('renders prompt, note and compaction rows with kind chips', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DELTA TEXT', note: 'NOTE TEXT' }),
      turn({ id: 2, at: 1_793_596_801_000, kind: 'compaction', note: 'SUMMARY TEXT' }),
    ]))} />)

    expect(view.container.textContent).toContain('DELTA TEXT')
    expect(view.container.textContent).toContain('NOTE TEXT')
    expect(view.container.textContent).toContain('SUMMARY TEXT')
    // The chips identify the three row kinds.
    expect(view.container.textContent).toContain('trajKindPrompt')
    expect(view.container.textContent).toContain('trajKindNote')
    expect(view.container.textContent).toContain('trajKindCompaction')
  })

  it('shows the aggregate strip instead of a Stats tab', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DELTA TEXT', note: 'NOTE TEXT' }),
    ]))} />)

    expect(view.container.textContent).toContain('trajCalls')
    expect(view.container.textContent).toContain('trajCacheHit')
    expect(view.container.textContent).toContain('trajHistoryBudget')
    expect(view.container.textContent).not.toContain('trajTabStats')
  })

  it('opens the inspector for the clicked record and exposes the attempt fields', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DELTA TEXT', note: 'NOTE TEXT' }),
    ]))} />)

    fireEvent.click(rowFor(view.container, 'NOTE TEXT'))

    expect(view.container.querySelector('aside')).not.toBeNull()
    expect(view.container.textContent).toContain('trajTabOverview')
    expect(view.container.textContent).toContain('trajFieldPrompt')
    expect(view.container.textContent).toContain('trajFieldCached')
    expect(view.container.textContent).toContain('trajFieldOutput')
  })

  it('collapses every multi-row attempt from the toolbar', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DELTA TEXT', note: 'NOTE TEXT' }),
    ]))} />)

    fireEvent.click(within(view.container).getByLabelText('trajCollapseAttempts'))

    expect(view.container.textContent).toContain('trajCollapsedRows')
    expect(view.container.textContent).not.toContain('DELTA TEXT')
  })

  it('filters the ledger from the search field', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ id: 1, kind: 'review', userText: 'FIRST DELTA', note: 'FIRST NOTE' }),
      turn({ id: 2, at: 1_793_596_801_000, kind: 'review', userText: 'SECOND DELTA', note: 'SECOND NOTE' }),
    ]))} />)

    const input = view.container.querySelector('input[type="search"]')
    if (input === null) throw new Error('no search input')
    fireEvent.change(input, { target: { value: 'second' } })

    expect(view.container.textContent).toContain('SECOND NOTE')
    expect(view.container.textContent).not.toContain('FIRST NOTE')
  })

  it('marks a not-delivered note and keeps the scope footer', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DROPPED', note: 'NOTE A', delivered: false }),
    ]))} />)

    expect(view.container.textContent).toContain('trajNotDelivered')
    expect(view.container.textContent).toContain('trajScope')
  })

  it('shows the empty state when no calls exist', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([]))} />)
    expect(view.container.textContent).toContain('trajEmpty')
  })

  it('shows a failed compaction with its error text', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'compaction', outcome: 'failure', error: 'compaction failed — reset' }),
    ]))} />)

    expect(view.container.textContent).toContain('compaction failed — reset')
  })

  it('toggles the duration mode from the toolbar', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([turn({ kind: 'review', note: 'NOTE' })]))} />)
    const button = within(view.container).getByRole('button', { name: 'trajDuration' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })
})