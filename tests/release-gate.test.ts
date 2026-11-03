/**
 * Release gate contract (fork fix, 0.6.46).
 *
 * A commit must never land while the tree is red. The failure this pins: the
 * gate steps were chained with `;` in a shell one-liner, so a failing
 * typecheck did not stop the chain and a commit landed with a RED suite —
 * only noticed by reading the tail of the output afterwards. The fix is
 * structural: the gate lives in package.json as `&&`-chained scripts, and a
 * commit script that runs the gate FIRST and only commits when it passed.
 *
 * The rule this test encodes: every gate step must be joined with `&&`
 * (never `;`), the commit must come AFTER the gate, and the order must be
 * typecheck → test → build.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const pkg = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}

describe('release gate — a red tree can never land a commit', () => {
  it('chains the gate steps with && (a failing step stops the chain)', () => {
    const gate = pkg.scripts?.gate
    expect(gate, 'pkg.scripts.gate exists').toBeDefined()
    expect(gate, 'the gate never chains with ;').not.toContain(';')
    expect(gate).toContain('&&')
    // Order: typecheck → test → build.
    const typecheckAt = gate!.indexOf('typecheck')
    const testAt = gate!.indexOf('test')
    const buildAt = gate!.indexOf('build')
    expect(typecheckAt).toBeGreaterThan(-1)
    expect(testAt).toBeGreaterThan(typecheckAt)
    expect(buildAt).toBeGreaterThan(testAt)
  })

  it('gates the commit through the cross-platform wrapper (message in, gate first)', () => {
    const commit = pkg.scripts?.['gate:commit']
    expect(commit, 'pkg.scripts.gate:commit exists').toBeDefined()
    // A package script cannot pass a message through (extra args are appended
    // to the whole line), so the commit runs a wrapper that reads argv.
    expect(commit).toContain('scripts/gate-commit.mjs')
    expect(commit).not.toContain(';')
    expect(commit).not.toMatch(/chore: gated commit/)
  })

  it('the wrapper runs the gate steps as separate commands and needs a message', () => {
    const wrapper = readFileSync(resolve(repo, 'scripts/gate-commit.mjs'), 'utf8')
    // The gate steps run as separate spawns (each aborting on failure), not as
    // one ';'-chained shell line.
    expect(wrapper).toContain("run('pnpm', ['typecheck'])")
    expect(wrapper).toContain("run('pnpm', ['test'])")
    expect(wrapper).toContain("run('pnpm', ['build'])")
    expect(wrapper).toContain("run('git', ['add', '-A'])")
    // The MESSAGE cannot travel through a package-script argument: pnpm runs
    // scripts through cmd.exe on Windows, which splits a multi-line argument at
    // the newline — a multi-paragraph rationale silently landed as its first
    // line. So git receives it through a FILE.
    expect(wrapper).toContain("run('git', ['commit', '-F', messageFile])")
    expect(wrapper).toContain('writeFileSync(messageFile')
    // The message is mandatory — every commit in this repo documents its change.
    expect(wrapper).toMatch(/message\.length === 0/)
    expect(wrapper).toContain('process.exit(2)')
  })

  it('keeps the single-purpose scripts themselves fail-fast', () => {
    for (const name of ['typecheck', 'build'] as const) {
      const script = pkg.scripts?.[name]
      expect(script, `pkg.scripts.${name} exists`).toBeDefined()
      expect(script!, `pkg.scripts.${name} never chains with ;`).not.toContain(';')
      expect(script!).toContain('&&')
    }
  })
})
