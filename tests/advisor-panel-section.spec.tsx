// @vitest-environment jsdom
/**
 * Session Panel section (fork addition, 2026-11-07) — the advisor's four
 * prompt surfaces contributed to `dsh.sessionInspector.panel`.
 *
 * Contract under test:
 * ① visibility gating: the panel renders EVERY registration, so the section
 *    returns null while another section is selected (and renders when the
 *    selection is its own id or empty).
 * ② session binding: it acts on the session the panel reports
 *    (`useSessionId` / `getSessionId` owner props) and fetches
 *    `/api/advisor/getPromptState` for exactly that session.
 * ③ the four surfaces render from the host state, and the rules list shows
 *    every scope with its label.
 * ④ no session bound → a plain notice, no writes offered.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { AdvisorPanelSection } from '../src/client/advisor-panel-section'
import type { AdvisorPanelSectionProps } from '../src/client/advisor-panel-section'

afterEach(cleanup)

/** One scripted RPC: records the call and settles the newest waiter. */
class ScriptedRpc {
  calls: Array<{ channel: string; method: string; args: unknown }> = []
  private resolvers: Array<(result: RpcResult<unknown>) => void> = []

  call(channel: string, method: string, payload: { args: unknown }): Promise<RpcResult<unknown>> {
    this.calls.push({ channel, method, args: payload.args })
    return new Promise((resolve) => { this.resolvers.push(resolve) })
  }

  settle(result: RpcResult<unknown>): void {
    this.resolvers.shift()?.(result)
  }

  find(method: string): { channel: string; method: string; args: unknown } | undefined {
    return this.calls.find((call) => call.method === method)
  }
}

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

const STATE = {
  state: {
    systemWide: 'system instruction',
    workspace: 'workspace instruction',
    session: 'session instruction',
    workspaceKnown: true,
    rules: [
      { scope: 'system', index: 0, text: 'sys rule' },
      { scope: 'workspace', index: 0, text: 'ws rule' },
      { scope: 'session', index: 0, text: 'sess rule' },
    ],
  },
}

interface Harness {
  rpc: ScriptedRpc
  props: AdvisorPanelSectionProps
  setSelection: (id: string | null) => void
  setSession: (id: string | undefined) => void
}

function harness(overrides: Partial<AdvisorPanelSectionProps> = {}): Harness {
  const rpc = new ScriptedRpc()
  let selection: string | null = 'advisor'
  let sessionId: string | undefined = 'sess-1'
  const listeners = new Set<() => void>()
  const props: AdvisorPanelSectionProps = {
    rpc: rpc as unknown as ClientConnectionRpc,
    useSelection: () => selection,
    useSessionId: () => sessionId,
    getSessionId: () => sessionId,
    ...overrides,
  }
  return {
    rpc,
    props,
    setSelection: (id) => {
      selection = id
      for (const listener of listeners) listener()
    },
    setSession: (id) => {
      sessionId = id
      for (const listener of listeners) listener()
    },
  }
}

describe('AdvisorPanelSection (dsh.sessionInspector.panel)', () => {
  it('hides while another section is selected, renders when it is selected', async () => {
    const { rpc, props } = harness()
    const { rerender, container } = render(<AdvisorPanelSection {...props} />)

    // Selected: fetches the session state and renders the surfaces.
    expect(rpc.find('advisor/getPromptState')).toBeTruthy()
    expect(rpc.find('advisor/getPromptState')!.args).toEqual({ sessionId: 'sess-1' })
    rpc.settle(ok(STATE))
    await waitFor(() => { expect(container.textContent).toContain('System-wide append') })

    // Another section selected: the body is gone (the panel renders every
    // registration, so visibility is the section's job).
    const other: AdvisorPanelSectionProps = { ...props, useSelection: () => 'other', getSessionId: () => 'sess-1' }
    rerender(<AdvisorPanelSection {...other} />)
    expect(container.textContent).toBe('')

    // Empty selection: every section is visible again.
    const all: AdvisorPanelSectionProps = { ...props, useSelection: () => null, getSessionId: () => 'sess-1' }
    rerender(<AdvisorPanelSection {...all} />)
    expect(container.textContent).toContain('System-wide append')
  })

  it('renders all four surfaces and every rule scope from the host state', async () => {
    const { rpc, props } = harness()
    render(<AdvisorPanelSection {...props} />)
    rpc.settle(ok(STATE))

    await waitFor(() => {
      expect(screen.getByLabelText('System-wide append')).toHaveProperty('value', 'system instruction')
    })
    expect(screen.getByLabelText('Workspace prompt')).toHaveProperty('value', 'workspace instruction')
    expect(screen.getByLabelText('Session instructions')).toHaveProperty('value', 'session instruction')
    expect(screen.getByText('Active rules')).toBeTruthy()
    expect(screen.getByText('sys rule')).toBeTruthy()
    expect(screen.getByText('ws rule')).toBeTruthy()
    expect(screen.getByText('sess rule')).toBeTruthy()
  })

  it('notices an unbound session and offers no editor', async () => {
    const { props } = harness({ useSessionId: () => undefined, getSessionId: () => undefined })
    const { container } = render(<AdvisorPanelSection {...props} />)
    expect(container.textContent).toContain('No session')
    expect(screen.queryByLabelText('System-wide append')).toBeNull()
  })
})