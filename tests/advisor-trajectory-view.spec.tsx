// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, fireEvent, within } from '@testing-library/react'
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
    controller: { start: vi.fn(), stop: vi.fn() },
    hooks: { snapshot: {} },
    t: (key: string) => key,
    useSnapshot: (selector: (value: AdvisorTrajectoryState) => unknown) => selector(forState),
  } as unknown as ViewProps
}

describe('AdvisorTrajectoryView — two-tab Advisor page (fork addition)', () => {
  it('renders delta, note and compaction rows in the Trajectory tab', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DELTA TEXT', note: 'NOTE TEXT' }),
      turn({ at: 1_793_596_801_000, kind: 'compaction', note: 'SUMMARY TEXT' }),
    ]))} />)

    expect(view.container.textContent).toContain('DELTA TEXT')
    expect(view.container.textContent).toContain('NOTE TEXT')
    expect(view.container.textContent).toContain('SUMMARY TEXT')
    // Role labels distinguish the rows.
    expect(view.container.textContent).toContain('trajRoleUser')
    expect(view.container.textContent).toContain('trajRoleAdvisor')
  })

  it('switches to the Stats tab and shows the aggregate tiles', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DELTA TEXT', note: 'NOTE TEXT' }),
    ]))} />)

    fireEvent.click(within(view.container).getByText('trajTabStats'))
    expect(view.container.textContent).toContain('trajCacheHit')
    expect(view.container.textContent).toContain('trajStatsHint')
    expect(view.container.textContent).not.toContain('DELTA TEXT')
  })

  it('shows a failed compaction with its error text', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'compaction', outcome: 'failure', error: 'compaction failed — reset' }),
    ]))} />)

    expect(view.container.textContent).toContain('compaction failed — reset')
  })

  it('marks a not-delivered note in the Trajectory tab and hides the mark once delivered', () => {
    const dropped = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DROPPED', note: 'NOTE A', delivered: false }),
    ]))} />)
    // Trajectory tab (default): the outcome row for a note whose delivery
    // seam reported dropped shows the not-delivered marker.
    expect(dropped.container.textContent).toContain('trajNotDelivered')

    const landed = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'LANDED', note: 'NOTE B', delivered: true }),
      turn({ kind: 'review', at: 1_793_596_802_000, userText: 'UNSET', note: 'NOTE C' }),
    ]))} />)
    // Delivered=true and the legacy undefined flag both render without the mark.
    expect(landed.container.textContent).not.toContain('trajNotDelivered')
  })

  it('marks a not-delivered note on the Stats rowHead too', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([
      turn({ kind: 'review', userText: 'DROPPED', note: 'NOTE A', delivered: false }),
    ]))} />)

    fireEvent.click(within(view.container).getByText('trajTabStats'))
    expect(view.container.textContent).toContain('trajNotDelivered')
  })

  it('shows the empty state when no calls exist', () => {
    const view = render(<AdvisorTrajectoryView {...props(state([]))} />)
    expect(view.container.textContent).toContain('trajEmpty')
  })
})