// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import { AdvisorNoteRow } from '../src/client/advisor-note-node'

const longText = 'The reviewer wrote a long note. '.repeat(90).trim()

describe('AdvisorNoteRow — collapsible note card (fork addition)', () => {
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

  it('collapses and expands the body from the header toggle', () => {
    const text = 'a body that must disappear when collapsed'
    const { container } = render(
      <AdvisorNoteRow node={{ data: { text, severity: 'nit', at: Date.now() } }} t={(key) => key} />,
    )
    const scoped = within(container)
    expect(container.textContent).toContain(text)

    fireEvent.click(scoped.getByRole('button', { name: 'notesCollapse' }))
    expect(container.textContent).not.toContain(text)
    expect(scoped.getByRole('button', { name: 'notesExpand' }).getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(scoped.getByRole('button', { name: 'notesExpand' }))
    expect(container.textContent).toContain(text)
  })

  it('shows the committed summary instead of the body when collapsed (dsh-ttsr pattern)', () => {
    // The committed message carries a one-line account (source.summary) — the
    // same field dsh-ttsr uses — so a collapsed row still says what the note
    // was about instead of going blank.
    const { container } = render(
      <AdvisorNoteRow
        node={{ data: { text: 'the long body', severity: 'concern', at: Date.now(), summary: '[concern] short account' } }}
        t={(key) => key}
        defaultCollapsed
      />,
    )
    expect(container.textContent).toContain('[concern] short account')
    expect(container.textContent).not.toContain('the long body')
  })
})