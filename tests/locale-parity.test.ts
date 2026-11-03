/**
 * Locale table parity (fork fix, 0.6.46).
 *
 * This episode's root bug was MISLEADING COPY, and the component specs could
 * never catch it: their `t` mock returns the KEY, so the rendered string is
 * never asserted — in either language. A zh string that lagged its en
 * counterpart shipped unnoticed.
 *
 * The parity this pins:
 * - the en and zh tables carry the SAME key set (no half-translated table);
 * - every key the components ask for through `t('…')` exists in BOTH tables
 *   (a key added to one language only is a bug, not a gap);
 * - every table key is actually referenced somewhere (no dead copy that drifts
 *   out of use and rots).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const clientDir = resolve(repo, 'src/client')

/** Read the two locale tables as plain objects (the file is TS, so parse the keys). */
function localeKeys(source: string): Set<string> {
  const keys = new Set<string>()
  // The tables are object literals of `key: 'value'` entries.
  const pattern = /^\s{2}([A-Za-z][A-Za-z0-9]*):\s/gm
  let match = pattern.exec(source)
  while (match !== null) {
    keys.add(match[1]!)
    match = pattern.exec(source)
  }
  return keys
}

const localesSource = readFileSync(join(clientDir, 'locales.ts'), 'utf8')
const enBlock = localesSource.slice(localesSource.indexOf('export const en = {'))
const zhBlock = localesSource.slice(localesSource.indexOf('export const zh'))
const enKeys = localeKeys(enBlock.slice(0, enBlock.indexOf('export const zh')))
const zhKeys = localeKeys(zhBlock)

/**
 * Every locale key the client sources reference: direct `t('key')` calls AND
 * key names returned as string literals (helpers like `outcomeKey` hand the
 * key back to the renderer instead of calling `t` at the call site).
 */
function askedKeys(): Set<string> {
  const files = readdirSync(clientDir).filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'))
  const asked = new Set<string>()
  for (const name of files) {
    const source = readFileSync(join(clientDir, name), 'utf8')
    const direct = /\bt\('([A-Za-z][A-Za-z0-9]*)'/g
    let match = direct.exec(source)
    while (match !== null) {
      asked.add(match[1]!)
      match = direct.exec(source)
    }
    // Any quoted literal that IS a locale key counts as a reference.
    const literal = /'([A-Za-z][A-Za-z0-9]*)'/g
    match = literal.exec(source)
    while (match !== null) {
      if (enKeys.has(match[1]!)) asked.add(match[1]!)
      match = literal.exec(source)
    }
    // Property access on a locale table (`en.advisorTab`) counts too — the
    // tab label reads its key that way, and pruning it would silently break
    // the label while the test stayed green.
    const property = /\.([A-Za-z][A-Za-z0-9]*)/g
    match = property.exec(source)
    while (match !== null) {
      if (enKeys.has(match[1]!)) asked.add(match[1]!)
      match = property.exec(source)
    }
  }
  return asked
}

describe('locale tables — en/zh parity', () => {
  it('carries the same key set in both languages', () => {
    const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key)).sort()
    const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key)).sort()
    expect(missingInZh, 'keys present in en but missing in zh').toEqual([])
    expect(missingInEn, 'keys present in zh but missing in en').toEqual([])
    expect(enKeys.size).toBeGreaterThan(20)
  })

  it('has every key the components ask for in BOTH tables', () => {
    const asked = askedKeys()
    expect(asked.size, 'the components ask for keys').toBeGreaterThan(5)
    const missingInZh = [...asked].filter((key) => !zhKeys.has(key)).sort()
    const missingInEn = [...asked].filter((key) => !enKeys.has(key)).sort()
    expect(missingInZh, 'keys the components ask for but zh lacks').toEqual([])
    expect(missingInEn, 'keys the components ask for but en lacks').toEqual([])
  })

  it('has no dead keys (every table key is asked for somewhere)', () => {
    const asked = askedKeys()
    const dead = [...enKeys].filter((key) => !asked.has(key)).sort()
    expect(dead, 'locale keys nothing asks for (dead copy that drifts)').toEqual([])
  })
})
