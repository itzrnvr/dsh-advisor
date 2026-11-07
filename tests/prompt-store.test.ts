import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptLayerStore, workspaceKey } from '../src/prompt-store'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-advisor-layers-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('PromptLayerStore — durable profile/workspace layers', () => {
  it('round-trips the workspace prompt and both rule scopes across instances', () => {
    const dir = tempDir()
    const cwd = 'C:\\work\\proj'
    const store = new PromptLayerStore(dir)
    store.setWorkspacePrompt(cwd, 'workspace instructions')
    store.addGlobalRule('global one')
    store.addWorkspaceRule(cwd, 'workspace one')

    const reloaded = new PromptLayerStore(dir)
    expect(reloaded.globalRulesList()).toEqual(['global one'])
    expect(reloaded.workspace(cwd)).toEqual({
      prompt: 'workspace instructions',
      rules: ['workspace one'],
    })
  })

  it('updates and deletes rules by index', () => {
    const store = new PromptLayerStore(tempDir())
    store.addGlobalRule('a')
    store.addGlobalRule('b')
    expect(store.updateGlobalRule(0, 'A')).toBe(true)
    expect(store.deleteGlobalRule(1)).toBe(true)
    expect(store.globalRulesList()).toEqual(['A'])
    expect(store.updateGlobalRule(9, 'x')).toBe(false)
    expect(store.deleteGlobalRule(-1)).toBe(false)

    store.addWorkspaceRule('C:\\w', 'w1')
    store.addWorkspaceRule('C:\\w', 'w2')
    expect(store.updateWorkspaceRule('C:\\w', 1, 'W2')).toBe(true)
    expect(store.deleteWorkspaceRule('C:\\w', 0)).toBe(true)
    expect(store.workspace('C:\\w').rules).toEqual(['W2'])
  })

  it('keeps an emptied workspace entry instead of deleting state', () => {
    const dir = tempDir()
    const store = new PromptLayerStore(dir)
    store.setWorkspacePrompt('C:\\w', 'something')
    store.setWorkspacePrompt('C:\\w', '')
    expect(new PromptLayerStore(dir).workspace('C:\\w')).toEqual({ prompt: '', rules: [] })
  })

  it('normalizes Windows workspace keys (case and trailing separators)', () => {
    const key = workspaceKey('C:\\Work\\Proj\\')
    expect(key).toBe('c:\\work\\proj')
    if (process.platform === 'win32') {
      const store = new PromptLayerStore(tempDir())
      store.setWorkspacePrompt('C:\\Work\\Proj', 'x')
      expect(store.workspace('c:\\work\\proj\\').prompt).toBe('x')
    }
  })

  it('reads a corrupt file as empty and keeps writes best-effort', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'prompt-layers.json'), '{ nope', 'utf8')
    const store = new PromptLayerStore(dir)
    expect(store.globalRulesList()).toEqual([])
    expect(store.workspace('C:\\w')).toEqual({ prompt: '', rules: [] })
  })
})