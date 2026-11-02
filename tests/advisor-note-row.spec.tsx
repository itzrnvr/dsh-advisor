// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { AdvisorNoteRow, installAdvisorNoteNode } from '../src/client/advisor-note-node'

/** A minimal fake client context capturing the definition and slot writes. */
function fakeClient() {
  const definitions: any[] = []
  const registrations: any[] = []
  const ctx: any = {
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    uiConversation: {
      events: {
        register: (definition: unknown) => {
          definitions.push(definition)
          return () => {}
        },
      },
    },
    slots: {
      inject: (_name: string, callback: () => Iterable<() => void>) => {
        for (const dispose of callback()) void dispose
        return () => {}
      },
      register: (options: unknown) => {
        registrations.push(options)
        return () => {}
      },
    },
  }
  return { ctx, definitions, registrations }
}

const longText = 'The reviewer wrote a long note. '.repeat(90).trim()

describe('AdvisorNoteRow — in-chat note rendering (fork addition)', () => {
  it('renders the full note body (no clamp, no truncation) and the severity marker', () => {
    const { container } = render(
      <AdvisorNoteRow
        node={{ id: 'n1', data: { text: longText, severity: 'concern', at: 1793596800000 } }}
        t={(key) => key}
      />,
    )
    const row = container.querySelector('[data-advisor-note]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain(longText)
    expect(row!.textContent).toContain('concern')
    expect(row!.textContent).toContain('notesTitle')
  })

  it('renders nothing without node data', () => {
    const { container } = render(<AdvisorNoteRow node={{ id: 'n1' }} />)
    expect(container.textContent).toBe('')
  })

  it('keeps the newline structure of the note (pre-wrap content)', () => {
    const text = 'first line\nsecond line\n  indented'
    const { container } = render(
      <AdvisorNoteRow node={{ data: { text, severity: 'nit', at: Date.now() } }} />,
    )
    expect(container.textContent).toContain('first line\nsecond line\n  indented')
  })
})

describe('installAdvisorNoteNode — event definition and slot wiring', () => {
  it('registers a visible custom chat node kind in the keyed chat-node slot', () => {
    const { ctx, definitions, registrations } = fakeClient()
    installAdvisorNoteNode(ctx)
    expect(definitions).toHaveLength(1)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      name: 'conversation.chat.node',
      key: 'dsh-advisor:note',
      locale: 'settings.advisor',
    })
  })

  it('claims only advisor-source user messages, exclusively', () => {
    const { ctx, definitions } = fakeClient()
    installAdvisorNoteNode(ctx)
    const definition = definitions[0]

    const advisorEvent = {
      type: 'user/message',
      surfaceOp: 'append',
      seq: 105,
      time: 1793596800000,
      data: {
        id: 'm1',
        content: [{ type: 'text', text: '[advisor:concern] stop and reread the plan' }],
        source: { kind: 'advisor' },
      },
    }
    expect(definition.match(advisorEvent)).toEqual({ id: 'm1', role: 'start', exclusive: true })

    const humanEvent = {
      ...advisorEvent,
      data: { ...advisorEvent.data, source: { kind: 'user' } },
    }
    expect(definition.match(humanEvent)).toBeNull()
    expect(definition.match({ ...advisorEvent, type: 'assistant/message' })).toBeNull()
    expect(definition.match({ ...advisorEvent, surfaceOp: 'replace' })).toBeNull()
  })

  it('parses the note and anchors the node at the reviewed turn end', () => {
    const { ctx, definitions } = fakeClient()
    installAdvisorNoteNode(ctx)
    const definition = definitions[0]
    const event = {
      type: 'user/message',
      surfaceOp: 'append',
      seq: 105,
      time: 1793596800000,
      data: {
        id: 'm1',
        content: [{ type: 'text', text: '[advisor:nit] a small naming nit' }],
        source: { kind: 'advisor' },
      },
    }
    const state = definition.start({}, { event }, {})
    expect(state).toEqual({ text: 'a small naming nit', severity: 'nit', at: 1793596800000 })

    const node = definition.buildViewNode({
      key: 'k1',
      id: 'm1',
      state,
      start: { event, location: { step: { step: 1 }, turn: { start: { seq: 100 } } } },
    })
    expect(node).toMatchObject({
      kind: 'dsh-advisor:note',
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 99.99,
      data: state,
    })
  })
})