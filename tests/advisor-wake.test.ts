import { describe, expect, it } from 'vitest'
import { extractAdviceNote, extractProseFallbackNote, ADVISOR_NOTE_MAX_CHARS } from '../src/advisor-runtime'

describe('reviewer wake decision (fork addition)', () => {
  it('parses an explicit wake: true', () => {
    expect(extractAdviceNote('{"note":"stop and fix the plan","severity":"concern","wake":true}')).toEqual({
      note: 'stop and fix the plan',
      severity: 'concern',
      wake: true,
    })
  })

  it('parses an explicit wake: false', () => {
    expect(extractAdviceNote('{"note":"minor naming nit","severity":"nit","wake":false}')).toEqual({
      note: 'minor naming nit',
      severity: 'nit',
      wake: false,
    })
  })

  it('omits wake when the reviewer does not decide (severity default applies)', () => {
    const note = extractAdviceNote('{"note":"a blocker","severity":"blocker"}')
    expect(note).toEqual({ note: 'a blocker', severity: 'blocker' })
    expect('wake' in (note ?? {})).toBe(false)
  })

  it('ignores a non-boolean wake value', () => {
    expect(extractAdviceNote('{"note":"x","wake":"yes"}')).toEqual({ note: 'x', severity: 'nit' })
  })

  it('prose fallback never carries a wake decision', () => {
    expect(extractProseFallbackNote('plain prose advice')).toEqual({ note: 'plain prose advice', severity: 'nit' })
  })
})

describe('transcript-echo guard (fork: provider without developer-role support)', () => {
  it('rejects a JSON note that quotes the transcript', () => {
    expect(extractAdviceNote(JSON.stringify({
      note: '- tool call: pwsh({"command":"dir"})\n\n**user**: [tool result] ok',
      severity: 'nit',
    }))).toBeUndefined()
  })

  it('rejects a JSON note that restates the session update', () => {
    expect(extractAdviceNote(JSON.stringify({
      note: '### Session update\n\n**user**: fix the bug',
    }))).toBeUndefined()
  })

  it('rejects a prose reply that is a transcript continuation', () => {
    expect(extractProseFallbackNote('- tool call: pwsh({"command":"dir"})')).toBeUndefined()
    expect(extractProseFallbackNote('**agent**: I updated the file')).toBeUndefined()
  })

  it('still accepts a genuine review note', () => {
    expect(extractAdviceNote('{"note":"The retry loop hides the provider error; log it once."}'))
      .toEqual({ note: 'The retry loop hides the provider error; log it once.', severity: 'nit' })
  })
})

describe('note body bound (fork: readable full notes)', () => {
  it('keeps notes up to the 4000-char bound intact', () => {
    const body = 'y'.repeat(ADVISOR_NOTE_MAX_CHARS)
    const note = extractAdviceNote(JSON.stringify({ note: body }))
    expect(note?.note).toBe(body)
    expect(note?.note.endsWith('…')).toBe(false)
  })

  it('still truncates beyond the bound with the marker', () => {
    const note = extractAdviceNote(JSON.stringify({ note: 'z'.repeat(ADVISOR_NOTE_MAX_CHARS + 10) }))
    expect(note?.note.length).toBe(ADVISOR_NOTE_MAX_CHARS)
    expect(note?.note.endsWith('…')).toBe(true)
  })
})